'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Modalidad } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroCasos } from '@/lib/permisos';
import { aplicarPlantillaComision, moverEtapaCaso } from '@/lib/negocio';

async function casoPropio(casoId: string, accion: 'ver' | 'editar' = 'editar') {
  const sesion = await exigir('casos', accion);
  const caso = await prisma.caso.findFirst({ where: { AND: [{ id: casoId }, filtroCasos(sesion)] } });
  if (!caso) redirect('/sin-permiso');
  return { sesion, caso };
}

export async function cambiarEtapaCaso(datos: FormData) {
  const casoId = String(datos.get('casoId'));
  const etapaId = String(datos.get('etapaId'));
  const { sesion } = await casoPropio(casoId);

  await moverEtapaCaso(casoId, etapaId, sesion);
  revalidatePath('/casos');
  revalidatePath(`/casos/${casoId}`);
}

export async function guardarDatosCaso(datos: FormData) {
  const casoId = String(datos.get('casoId'));
  const { sesion, caso } = await casoPropio(casoId);

  const abogadoId = String(datos.get('abogadoId') ?? '') || null;
  const fechaResolucion = String(datos.get('fechaTentativaResolucion') ?? '');

  await prisma.caso.update({
    where: { id: casoId },
    data: {
      // La dependencia es independiente del domicilio del cliente: se captura
      // a mano y el sistema nunca la deduce de la ubicación.
      dependencia: String(datos.get('dependencia') ?? '').trim() || null,
      oficina: String(datos.get('oficina') ?? '').trim() || null,
      modalidad: (String(datos.get('modalidad') ?? '') as Modalidad) || null,
      abogadoId,
      fechaTentativaResolucion: fechaResolucion ? new Date(fechaResolucion) : null,
    },
  });

  // Si el abogado se asigna después del cierre, su comisión se genera ahora
  // con la misma plantilla que se usó en la venta.
  if (abogadoId && abogadoId !== caso.abogadoId) {
    const venta = await prisma.venta.findUniqueOrThrow({ where: { id: caso.ventaId } });
    const previa = await prisma.comision.findFirst({ where: { ventaId: venta.id } });
    await prisma.$transaction((tx) =>
      aplicarPlantillaComision(tx, venta, previa?.plantillaOrigenId ?? null, sesion)
    );
  }

  revalidatePath(`/casos/${casoId}`);
}

/**
 * Confirma o retira la entrega de un documento del checklist.
 *
 * El despacho no guarda el archivo: registra que el cliente ya lo entregó,
 * junto con quién lo revisó y cuándo. Si después aparece una duda sobre ese
 * documento, se sabe a quién preguntarle.
 */
export async function confirmarDocumento(datos: FormData) {
  const documentoId = String(datos.get('documentoId'));
  const documento = await prisma.documento.findUniqueOrThrow({ where: { id: documentoId } });
  const { sesion } = await casoPropio(documento.casoId);

  const entregado = datos.get('entregado') === 'on';

  await prisma.documento.update({
    where: { id: documentoId },
    data: entregado
      ? { estatus: 'ENTREGADO', confirmadoPorId: sesion.id, fechaEntrega: new Date() }
      : // Al volver a pendiente se limpia la confirmación: dejarla diría que
        // alguien lo revisó cuando el documento ya no está entregado.
        { estatus: 'PENDIENTE', confirmadoPorId: null, fechaEntrega: null },
  });

  await prisma.auditoria.create({
    data: {
      entidad: 'Documento',
      entidadId: documentoId,
      accion: entregado ? 'entregado' : 'pendiente',
      usuarioId: sesion.id,
      detalle: { documento: documento.nombre },
    },
  });

  await revalidarExpediente(documento.casoId);
}

/** Vigencia y nota del renglón, que se capturan aparte de la casilla. */
export async function guardarDetalleDocumento(datos: FormData) {
  const documentoId = String(datos.get('documentoId'));
  const documento = await prisma.documento.findUniqueOrThrow({ where: { id: documentoId } });
  await casoPropio(documento.casoId);

  const vigencia = String(datos.get('fechaVigencia') ?? '');
  await prisma.documento.update({
    where: { id: documentoId },
    data: {
      fechaVigencia: vigencia ? new Date(vigencia) : null,
      observacion: String(datos.get('observacion') ?? '').trim() || null,
    },
  });

  await revalidarExpediente(documento.casoId);
}

/** El checklist se ve en dos pantallas: ambas deben refrescarse. */
async function revalidarExpediente(casoId: string) {
  const caso = await prisma.caso.findUniqueOrThrow({
    where: { id: casoId },
    include: { venta: true },
  });
  revalidatePath(`/casos/${casoId}`);
  revalidatePath('/casos');
  revalidatePath(`/clientes/${caso.venta.clienteId}`);
}
