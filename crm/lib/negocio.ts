import { Prisma, type Rol } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Reglas de negocio del despacho. Viven aquí y no en los formularios, porque
 * son las mismas se disparen desde donde se disparen (pantalla, importación
 * o, mañana, una API).
 */

type Actor = { id: string };

async function auditar(
  tx: Prisma.TransactionClient,
  entidad: string,
  entidadId: string,
  accion: string,
  usuarioId: string,
  detalle?: Prisma.InputJsonValue
) {
  await tx.auditoria.create({
    data: { entidad, entidadId, accion, usuarioId, detalle },
  });
}

// ── Entrevista de valoración ──────────────────────────────────────

/**
 * Un contacto inicial NO es prospecto. Solo se vuelve prospecto calificado
 * cuando la entrevista resulta viable — ese es el orden que pidió el despacho
 * y el motivo de que la venta se cree aquí y no en la captura del cliente.
 *
 * Si resulta no viable, el contacto se archiva y no ensucia el embudo: no
 * cuenta como prospecto perdido, porque nunca llegó a ser prospecto.
 */
export async function registrarEntrevista(
  leadId: string,
  resultado: 'VIABLE' | 'NO_VIABLE' | 'REQUIERE_INFO',
  notas: string | null,
  montoEstimado: number | null,
  actor: Actor
) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { venta: true },
    });

    await tx.lead.update({
      where: { id: leadId },
      data: { resultadoEntrevista: resultado, notasEntrevista: notas, fechaEntrevista: new Date() },
    });

    if (resultado === 'NO_VIABLE') {
      await tx.cliente.update({ where: { id: lead.clienteId }, data: { archivado: true } });
      await auditar(tx, 'Lead', leadId, 'entrevista_no_viable', actor.id);
      return { venta: null, archivado: true };
    }

    if (resultado === 'REQUIERE_INFO') {
      await auditar(tx, 'Lead', leadId, 'entrevista_requiere_info', actor.id);
      return { venta: null, archivado: false };
    }

    // Viable: pasa a prospecto calificado. Si ya se había calificado antes,
    // no se duplica la venta.
    if (lead.venta) return { venta: lead.venta, archivado: false };

    const venta = await tx.venta.create({
      data: {
        clienteId: lead.clienteId,
        leadId: lead.id,
        tipoTramiteId: lead.tipoTramiteId,
        vendedorId: lead.vendedorId,
        montoTotal: new Prisma.Decimal(montoEstimado ?? 0),
        etapa: 'PROSPECTO_CALIFICADO',
      },
    });
    await tx.historialEtapa.create({
      data: {
        ventaId: venta.id,
        etapaAnterior: 'ENTREVISTA_VALORACION',
        etapaNueva: 'PROSPECTO_CALIFICADO',
        usuarioId: actor.id,
      },
    });
    await auditar(tx, 'Venta', venta.id, 'creada_por_entrevista_viable', actor.id);
    return { venta, archivado: false };
  });
}

// ── Pipeline comercial ────────────────────────────────────────────

export type DatosCierre = {
  montoTotal: number;
  abogadoId?: string | null;
  plantillaComisionId?: string | null;
  cuotas: { fechaPactada: Date; monto: number; esInicial?: boolean }[];
};

/**
 * Mover una venta de etapa. Dos salidas tienen consecuencias:
 *  - CERRADO_PERDIDO exige motivo (catálogo).
 *  - CERRADO_GANADO desencadena expediente, checklist, plan de pagos y
 *    comisiones, todo en la misma transacción: o queda completo, o no queda.
 */
export async function moverEtapaVenta(
  ventaId: string,
  etapaNueva: Prisma.VentaUpdateInput['etapa'] & string,
  actor: Actor,
  extra?: { motivoPerdidaId?: string | null; cierre?: DatosCierre }
) {
  return prisma.$transaction(async (tx) => {
    const venta = await tx.venta.findUniqueOrThrow({
      where: { id: ventaId },
      include: { caso: true },
    });
    if (venta.etapa === etapaNueva) return venta;

    if (etapaNueva === 'CERRADO_PERDIDO' && !extra?.motivoPerdidaId) {
      throw new Error('Para cerrar como perdida hay que indicar el motivo de pérdida.');
    }
    if (etapaNueva === 'CERRADO_GANADO' && !extra?.cierre) {
      throw new Error('Para cerrar como ganada hay que capturar el monto y el plan de pagos.');
    }

    const actualizada = await tx.venta.update({
      where: { id: ventaId },
      data: {
        etapa: etapaNueva,
        motivoPerdidaId: etapaNueva === 'CERRADO_PERDIDO' ? extra?.motivoPerdidaId : null,
        fechaCierre:
          etapaNueva === 'CERRADO_GANADO' || etapaNueva === 'CERRADO_PERDIDO' ? new Date() : null,
        montoTotal:
          etapaNueva === 'CERRADO_GANADO' && extra?.cierre
            ? new Prisma.Decimal(extra.cierre.montoTotal)
            : undefined,
      },
    });

    // El historial se escribe solo: nadie captura estas fechas a mano.
    await tx.historialEtapa.create({
      data: { ventaId, etapaAnterior: venta.etapa, etapaNueva, usuarioId: actor.id },
    });
    await auditar(tx, 'Venta', ventaId, `etapa:${venta.etapa}->${etapaNueva}`, actor.id);

    if (etapaNueva === 'CERRADO_GANADO' && extra?.cierre && !venta.caso) {
      await abrirExpediente(tx, actualizada, extra.cierre, actor);
    }

    return actualizada;
  });
}

/** Todo lo que nace al ganar una venta (secciones 6, 7.3, 7.4 y 7.5). */
async function abrirExpediente(
  tx: Prisma.TransactionClient,
  venta: { id: string; tipoTramiteId: string; montoTotal: Prisma.Decimal; vendedorId: string },
  cierre: DatosCierre,
  actor: Actor
) {
  const plantilla = await tx.tipoTramite.findUniqueOrThrow({
    where: { id: venta.tipoTramiteId },
    include: {
      etapas: { orderBy: { orden: 'asc' } },
      documentos: { orderBy: { orden: 'asc' } },
    },
  });

  const caso = await tx.caso.create({
    data: {
      ventaId: venta.id,
      tipoTramiteId: venta.tipoTramiteId,
      etapaActualId: plantilla.etapas[0]?.id ?? null,
      abogadoId: cierre.abogadoId ?? null,
      // La dependencia se captura después, cuando se sabe dónde se presentará.
      // No se hereda del domicilio del cliente: son datos independientes.
      documentos: {
        create: plantilla.documentos.map((d) => ({
          plantillaId: d.id,
          nombre: d.nombre,
          estatus: 'PENDIENTE' as const,
        })),
      },
    },
  });

  if (plantilla.etapas[0]) {
    await tx.historialEtapa.create({
      data: { casoId: caso.id, etapaNueva: plantilla.etapas[0].nombre, usuarioId: actor.id },
    });
  }

  // Plan de pagos: cuota inicial + N sucesivas, tal como se pactaron.
  if (cierre.cuotas.length) {
    await tx.cuota.createMany({
      data: cierre.cuotas.map((c, i) => ({
        ventaId: venta.id,
        numero: i + 1,
        esInicial: c.esInicial ?? i === 0,
        fechaPactada: c.fechaPactada,
        monto: new Prisma.Decimal(c.monto),
      })),
    });
  }

  await aplicarPlantillaComision(tx, venta, cierre.plantillaComisionId ?? null, actor);
  await auditar(tx, 'Caso', caso.id, 'expediente_abierto', actor.id, { ventaId: venta.id });
  return caso;
}

// ── Comisiones ────────────────────────────────────────────────────

/**
 * Cada participante cobra su porcentaje DIRECTO sobre el total de la venta.
 * No es una bolsa que se reparte entre todos: si el vendedor tiene 10%, el
 * operador 5% y el director 3%, cada uno recibe eso del total, y los
 * porcentajes no tienen por qué sumar 100.
 *
 * El monto se congela al calcularse, junto con la versión de la plantilla:
 * cambiar la plantilla mañana no debe mover ni un peso de lo ya calculado.
 */
export async function aplicarPlantillaComision(
  tx: Prisma.TransactionClient,
  venta: { id: string; montoTotal: Prisma.Decimal; vendedorId: string },
  plantillaId: string | null,
  actor: Actor
) {
  const plantilla = plantillaId
    ? await tx.plantillaComision.findUnique({ where: { id: plantillaId }, include: { items: true } })
    : await tx.plantillaComision.findFirst({
        where: { esPredeterminada: true, activa: true },
        include: { items: true },
      });
  if (!plantilla) return [];

  const asignados = new Map<Rol, string>();
  asignados.set('VENDEDOR', venta.vendedorId);

  const director = await tx.usuario.findFirst({ where: { rol: 'DIRECTOR', activo: true } });
  if (director) asignados.set('DIRECTOR', director.id);

  const caso = await tx.caso.findUnique({ where: { ventaId: venta.id } });
  if (caso?.abogadoId) asignados.set('ABOGADO', caso.abogadoId);

  const creadas = [];
  for (const item of plantilla.items) {
    const participanteId = asignados.get(item.rol);
    // Si el caso todavía no tiene abogado asignado, esa comisión se crea
    // después, al asignarlo. Mejor eso que inventar un participante.
    if (!participanteId) continue;

    const monto = venta.montoTotal.mul(item.porcentaje).div(100);
    creadas.push(
      await tx.comision.upsert({
        where: {
          ventaId_participanteId_rol: { ventaId: venta.id, participanteId, rol: item.rol },
        },
        update: {},
        create: {
          ventaId: venta.id,
          participanteId,
          rol: item.rol,
          porcentaje: item.porcentaje,
          montoCalculado: monto,
          plantillaOrigenId: plantilla.id,
          versionPlantilla: plantilla.version,
        },
      })
    );
  }
  await auditar(tx, 'Venta', venta.id, 'comisiones_generadas', actor.id, {
    plantilla: plantilla.nombre,
    version: plantilla.version,
  });
  return creadas;
}

// ── Pipeline legal ────────────────────────────────────────────────

/**
 * Cambio de etapa del caso. La fecha de presentación ante la autoridad no se
 * captura: se deduce del momento en que el caso entra a la etapa marcada como
 * "presentación" en la plantilla de su tipo de trámite.
 */
export async function moverEtapaCaso(casoId: string, etapaNuevaId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const caso = await tx.caso.findUniqueOrThrow({
      where: { id: casoId },
      include: { etapaActual: true },
    });
    const etapaNueva = await tx.etapaPlantilla.findUniqueOrThrow({ where: { id: etapaNuevaId } });

    if (etapaNueva.tipoTramiteId !== caso.tipoTramiteId) {
      throw new Error('Esa etapa pertenece a otro tipo de trámite.');
    }
    if (caso.etapaActualId === etapaNuevaId) return caso;

    const actualizado = await tx.caso.update({
      where: { id: casoId },
      data: {
        etapaActualId: etapaNuevaId,
        // Solo la primera vez que se presenta: si el caso regresa y vuelve a
        // entrar a la etapa, la fecha original no se pisa.
        fechaPresentacion:
          etapaNueva.esPresentacion && !caso.fechaPresentacion ? new Date() : undefined,
      },
    });

    await tx.historialEtapa.create({
      data: {
        casoId,
        etapaAnterior: caso.etapaActual?.nombre ?? null,
        etapaNueva: etapaNueva.nombre,
        usuarioId: actor.id,
      },
    });
    await auditar(tx, 'Caso', casoId, `etapa:${caso.etapaActual?.nombre ?? '—'}->${etapaNueva.nombre}`, actor.id);
    return actualizado;
  });
}

// ── Interacciones y seguimientos ──────────────────────────────────

/**
 * Registrar una llamada/mensaje y, en el mismo movimiento, el próximo
 * seguimiento pactado ("llámenme en 15 días"). El seguimiento genera su cita
 * en la agenda: no se captura dos veces (sección 9).
 */
export async function registrarInteraccion(
  clienteId: string,
  datos: {
    medio: 'LLAMADA' | 'WHATSAPP' | 'CORREO' | 'PRESENCIAL';
    resultado: string;
    seguimiento?: { fecha: Date; motivo: string; responsableId: string } | null;
  },
  actor: Actor
) {
  return prisma.$transaction(async (tx) => {
    const interaccion = await tx.interaccion.create({
      data: { clienteId, medio: datos.medio, resultado: datos.resultado, usuarioId: actor.id },
    });

    if (datos.seguimiento) {
      const cliente = await tx.cliente.findUniqueOrThrow({ where: { id: clienteId } });
      const seguimiento = await tx.proximoSeguimiento.create({
        data: {
          clienteId,
          fecha: datos.seguimiento.fecha,
          motivo: datos.seguimiento.motivo,
          responsableId: datos.seguimiento.responsableId,
        },
      });
      await tx.cita.create({
        data: {
          clienteId,
          titulo: `Seguimiento: ${cliente.nombre}`,
          inicio: datos.seguimiento.fecha,
          tipo: 'SEGUIMIENTO_SALIENTE',
          modalidad: 'PRESENCIAL',
          responsableId: datos.seguimiento.responsableId,
          seguimientoId: seguimiento.id,
        },
      });
    }
    return interaccion;
  });
}

// ── Presupuestos ──────────────────────────────────────────────────

export type LineaConcepto = { descripcion: string; monto: number };
export type LineaPago = { descripcion: string; fechaPropuesta: Date; monto: number };

/**
 * Folio legible del presupuesto: P-2026-0007. El consecutivo se reinicia cada
 * año, que es como el despacho los va a referir por teléfono.
 */
async function siguienteFolio(tx: Prisma.TransactionClient): Promise<string> {
  const anio = new Date().getFullYear();
  const ultimo = await tx.presupuesto.findFirst({
    where: { folio: { startsWith: `P-${anio}-` } },
    orderBy: { folio: 'desc' },
  });
  const consecutivo = ultimo ? Number(ultimo.folio.split('-')[2]) + 1 : 1;
  return `P-${anio}-${String(consecutivo).padStart(4, '0')}`;
}

export async function crearPresupuesto(
  ventaId: string,
  datos: {
    conceptos: LineaConcepto[];
    pagos: LineaPago[];
    validoHasta: Date | null;
    condiciones: string | null;
    notas: string | null;
  },
  actor: Actor
) {
  return prisma.$transaction(async (tx) => {
    const folio = await siguienteFolio(tx);
    const presupuesto = await tx.presupuesto.create({
      data: {
        folio,
        ventaId,
        validoHasta: datos.validoHasta,
        condiciones: datos.condiciones,
        notas: datos.notas,
        creadoPorId: actor.id,
        conceptos: {
          create: datos.conceptos.map((c, i) => ({
            descripcion: c.descripcion,
            monto: new Prisma.Decimal(c.monto),
            orden: i + 1,
          })),
        },
        pagos: {
          create: datos.pagos.map((p, i) => ({
            numero: i + 1,
            descripcion: p.descripcion || null,
            fechaPropuesta: p.fechaPropuesta,
            monto: new Prisma.Decimal(p.monto),
          })),
        },
      },
    });
    await auditar(tx, 'Presupuesto', presupuesto.id, `creado:${folio}`, actor.id);
    return presupuesto;
  });
}

/** Marca el presupuesto como entregado al cliente y adelanta la venta. */
export async function enviarPresupuesto(presupuestoId: string, actor: Actor) {
  const presupuesto = await prisma.presupuesto.findUniqueOrThrow({
    where: { id: presupuestoId },
    include: { venta: true },
  });
  if (presupuesto.estatus === 'ACEPTADO') {
    throw new Error('Ese presupuesto ya fue aceptado.');
  }

  await prisma.presupuesto.update({
    where: { id: presupuestoId },
    data: { estatus: 'ENVIADO', fechaEnvio: new Date() },
  });

  // La venta refleja lo que pasó: ya hay propuesta con el cliente.
  const etapasPrevias = ['PROSPECTO_CALIFICADO', 'CONTACTADO', 'CONSULTA_AGENDADA'];
  if (etapasPrevias.includes(presupuesto.venta.etapa)) {
    await moverEtapaVenta(presupuesto.ventaId, 'PROPUESTA_ENVIADA', actor);
  }
  return presupuesto;
}

/**
 * El cliente aprobó: se cierra la venta como ganada y los pagos propuestos se
 * vuelven el plan de pagos real. Así se le cobra exactamente lo que se le
 * prometió, sin recapturar nada y sin margen para que difieran.
 */
export async function aceptarPresupuesto(
  presupuestoId: string,
  actor: Actor,
  extra: { abogadoId?: string | null; plantillaComisionId?: string | null }
) {
  const presupuesto = await prisma.presupuesto.findUniqueOrThrow({
    where: { id: presupuestoId },
    include: { conceptos: true, pagos: { orderBy: { numero: 'asc' } }, venta: true },
  });
  if (presupuesto.estatus === 'ACEPTADO') return presupuesto;
  if (!presupuesto.pagos.length) {
    throw new Error('El presupuesto no tiene pagos propuestos: no se puede convertir en plan de pagos.');
  }

  const total = presupuesto.conceptos.reduce((t, c) => t + Number(c.monto), 0);

  await prisma.presupuesto.update({
    where: { id: presupuestoId },
    data: { estatus: 'ACEPTADO', fechaRespuesta: new Date(), motivoRechazo: null },
  });

  // Los demás presupuestos de la misma venta quedan descartados: solo uno
  // puede ser el acuerdo vigente.
  await prisma.presupuesto.updateMany({
    where: { ventaId: presupuesto.ventaId, id: { not: presupuestoId }, estatus: { in: ['BORRADOR', 'ENVIADO'] } },
    data: { estatus: 'RECHAZADO', fechaRespuesta: new Date(), motivoRechazo: 'Se aprobó otro presupuesto' },
  });

  await moverEtapaVenta(presupuesto.ventaId, 'CERRADO_GANADO', actor, {
    cierre: {
      montoTotal: total,
      abogadoId: extra.abogadoId ?? null,
      plantillaComisionId: extra.plantillaComisionId ?? null,
      cuotas: presupuesto.pagos.map((p) => ({
        fechaPactada: p.fechaPropuesta,
        monto: Number(p.monto),
      })),
    },
  });

  return presupuesto;
}

export async function rechazarPresupuesto(presupuestoId: string, motivo: string, actor: Actor) {
  const presupuesto = await prisma.presupuesto.update({
    where: { id: presupuestoId },
    data: { estatus: 'RECHAZADO', fechaRespuesta: new Date(), motivoRechazo: motivo || null },
  });
  await prisma.auditoria.create({
    data: {
      entidad: 'Presupuesto',
      entidadId: presupuestoId,
      accion: 'rechazado',
      usuarioId: actor.id,
      detalle: { motivo },
    },
  });
  return presupuesto;
}
