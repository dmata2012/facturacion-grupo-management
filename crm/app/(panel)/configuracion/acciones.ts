'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type CanalAlerta, type Rol } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';

/**
 * Configuración del sistema: catálogos, plantillas, alertas y usuarios.
 *
 * Dos cuidados recorren todo este archivo:
 *  - Nada que esté en uso se borra. Un tipo de trámite con expedientes o una
 *    etapa por la que pasa un caso no se eliminan: se desactivan. La base lo
 *    impediría de todos modos, pero con un error incomprensible, y en el caso
 *    de las etapas ni siquiera lo impediría: pondría NULL y el caso quedaría
 *    sin etapa sin que nadie se enterara.
 *  - Cambiar una plantilla de comisión no toca lo ya calculado. Cada cambio
 *    sube la versión; las comisiones existentes guardan su porcentaje y su
 *    monto congelados.
 */

function texto(datos: FormData, campo: string): string {
  return String(datos.get(campo) ?? '').trim();
}

function volver(ruta: string, error?: string): never {
  revalidatePath(ruta);
  redirect(error ? `${ruta}?error=${error}` : ruta);
}

async function registrar(entidad: string, entidadId: string, accion: string, usuarioId: string) {
  await prisma.auditoria.create({ data: { entidad, entidadId, accion, usuarioId } });
}

// ══ Tipos de trámite ═══════════════════════════════════════════

export async function crearTipoTramite(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver('/configuracion/tramites', 'nombre');

  try {
    const tipo = await prisma.tipoTramite.create({ data: { nombre } });
    // Un tipo de trámite sin etapas deja los expedientes sin pipeline, así que
    // se copian las de otro tipo existente como punto de partida editable.
    const modelo = await prisma.tipoTramite.findFirst({
      where: { id: { not: tipo.id } },
      include: { etapas: { orderBy: { orden: 'asc' } } },
    });
    if (modelo?.etapas.length) {
      await prisma.etapaPlantilla.createMany({
        data: modelo.etapas.map((e) => ({
          tipoTramiteId: tipo.id,
          nombre: e.nombre,
          orden: e.orden,
          esPresentacion: e.esPresentacion,
        })),
      });
    }
    await registrar('TipoTramite', tipo.id, 'creado', sesion.id);
    revalidatePath('/configuracion/tramites');
    redirect(`/configuracion/tramites/${tipo.id}`);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/tramites', 'duplicado');
    }
    throw e;
  }
}

export async function renombrarTipoTramite(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver(`/configuracion/tramites/${id}`, 'nombre');

  try {
    await prisma.tipoTramite.update({ where: { id }, data: { nombre } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver(`/configuracion/tramites/${id}`, 'duplicado');
    }
    throw e;
  }
  await registrar('TipoTramite', id, 'renombrado', sesion.id);
  volver(`/configuracion/tramites/${id}`);
}

export async function alternarTipoTramite(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const tipo = await prisma.tipoTramite.findUniqueOrThrow({ where: { id } });
  await prisma.tipoTramite.update({ where: { id }, data: { activo: !tipo.activo } });
  await registrar('TipoTramite', id, tipo.activo ? 'desactivado' : 'activado', sesion.id);
  volver('/configuracion/tramites');
}

export async function borrarTipoTramite(datos: FormData) {
  const sesion = await exigir('configuracion', 'eliminar');
  const id = texto(datos, 'id');

  // Solo se borra lo que nunca se usó. Con un solo registro que lo apunte, se
  // desactiva en su lugar: el historial del despacho no se toca.
  const [leads, ventas, casos] = await Promise.all([
    prisma.lead.count({ where: { tipoTramiteId: id } }),
    prisma.venta.count({ where: { tipoTramiteId: id } }),
    prisma.caso.count({ where: { tipoTramiteId: id } }),
  ]);
  if (leads + ventas + casos > 0) volver('/configuracion/tramites', 'en-uso');

  await prisma.tipoTramite.delete({ where: { id } });
  await registrar('TipoTramite', id, 'borrado', sesion.id);
  volver('/configuracion/tramites');
}

// ══ Etapas de la plantilla ═════════════════════════════════════

export async function agregarEtapa(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const tipoTramiteId = texto(datos, 'tipoTramiteId');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver(`/configuracion/tramites/${tipoTramiteId}`, 'nombre');

  const ultima = await prisma.etapaPlantilla.findFirst({
    where: { tipoTramiteId },
    orderBy: { orden: 'desc' },
  });
  const etapa = await prisma.etapaPlantilla.create({
    data: { tipoTramiteId, nombre, orden: (ultima?.orden ?? 0) + 1 },
  });
  await registrar('EtapaPlantilla', etapa.id, 'creada', sesion.id);
  volver(`/configuracion/tramites/${tipoTramiteId}`);
}

export async function renombrarEtapa(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const nombre = texto(datos, 'nombre');
  const etapa = await prisma.etapaPlantilla.findUniqueOrThrow({ where: { id } });
  if (nombre) {
    await prisma.etapaPlantilla.update({ where: { id }, data: { nombre } });
    await registrar('EtapaPlantilla', id, 'renombrada', sesion.id);
  }
  volver(`/configuracion/tramites/${etapa.tipoTramiteId}`);
}

/** Marca cuál etapa cuenta como presentación ante la autoridad. Solo una por
 *  tipo de trámite: de ella sale la fecha de presentación de cada caso. */
export async function marcarPresentacion(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const etapa = await prisma.etapaPlantilla.findUniqueOrThrow({ where: { id } });

  await prisma.$transaction([
    prisma.etapaPlantilla.updateMany({
      where: { tipoTramiteId: etapa.tipoTramiteId },
      data: { esPresentacion: false },
    }),
    prisma.etapaPlantilla.update({ where: { id }, data: { esPresentacion: true } }),
  ]);
  await registrar('EtapaPlantilla', id, 'marcada_presentacion', sesion.id);
  volver(`/configuracion/tramites/${etapa.tipoTramiteId}`);
}

export async function moverEtapa(datos: FormData) {
  await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const direccion = texto(datos, 'direccion'); // 'arriba' | 'abajo'

  const etapa = await prisma.etapaPlantilla.findUniqueOrThrow({ where: { id } });
  const vecina = await prisma.etapaPlantilla.findFirst({
    where: {
      tipoTramiteId: etapa.tipoTramiteId,
      orden: direccion === 'arriba' ? { lt: etapa.orden } : { gt: etapa.orden },
    },
    orderBy: { orden: direccion === 'arriba' ? 'desc' : 'asc' },
  });
  if (!vecina) volver(`/configuracion/tramites/${etapa.tipoTramiteId}`);

  // El par (tipo, orden) es único, así que el intercambio directo chocaría:
  // primero se aparta una a un orden que nadie usa.
  await prisma.$transaction([
    prisma.etapaPlantilla.update({ where: { id: etapa.id }, data: { orden: -1 } }),
    prisma.etapaPlantilla.update({ where: { id: vecina.id }, data: { orden: etapa.orden } }),
    prisma.etapaPlantilla.update({ where: { id: etapa.id }, data: { orden: vecina.orden } }),
  ]);
  volver(`/configuracion/tramites/${etapa.tipoTramiteId}`);
}

export async function borrarEtapa(datos: FormData) {
  const sesion = await exigir('configuracion', 'eliminar');
  const id = texto(datos, 'id');
  const etapa = await prisma.etapaPlantilla.findUniqueOrThrow({ where: { id } });

  // Si algún caso está parado en esta etapa, borrarla lo dejaría sin etapa sin
  // aviso: la base pondría NULL en silencio.
  const enUso = await prisma.caso.count({ where: { etapaActualId: id } });
  if (enUso > 0) volver(`/configuracion/tramites/${etapa.tipoTramiteId}`, 'etapa-en-uso');

  await prisma.etapaPlantilla.delete({ where: { id } });
  await registrar('EtapaPlantilla', id, 'borrada', sesion.id);
  volver(`/configuracion/tramites/${etapa.tipoTramiteId}`);
}

// ══ Documentos de la plantilla ═════════════════════════════════

export async function agregarDocumento(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const tipoTramiteId = texto(datos, 'tipoTramiteId');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver(`/configuracion/tramites/${tipoTramiteId}`, 'nombre');

  const ultimo = await prisma.documentoPlantilla.findFirst({
    where: { tipoTramiteId },
    orderBy: { orden: 'desc' },
  });
  try {
    const doc = await prisma.documentoPlantilla.create({
      data: {
        tipoTramiteId,
        nombre,
        orden: (ultimo?.orden ?? 0) + 1,
        requiereVigencia: datos.get('requiereVigencia') === 'on',
      },
    });
    await registrar('DocumentoPlantilla', doc.id, 'creado', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver(`/configuracion/tramites/${tipoTramiteId}`, 'doc-duplicado');
    }
    throw e;
  }
  volver(`/configuracion/tramites/${tipoTramiteId}`);
}

export async function editarDocumento(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const nombre = texto(datos, 'nombre');
  const doc = await prisma.documentoPlantilla.findUniqueOrThrow({ where: { id } });

  await prisma.documentoPlantilla.update({
    where: { id },
    data: {
      nombre: nombre || doc.nombre,
      requiereVigencia: datos.get('requiereVigencia') === 'on',
    },
  });
  await registrar('DocumentoPlantilla', id, 'editado', sesion.id);
  volver(`/configuracion/tramites/${doc.tipoTramiteId}`);
}

export async function borrarDocumento(datos: FormData) {
  const sesion = await exigir('configuracion', 'eliminar');
  const id = texto(datos, 'id');
  const doc = await prisma.documentoPlantilla.findUniqueOrThrow({ where: { id } });

  // Los expedientes ya abiertos conservan su copia del documento, con su
  // archivo: quitarlo de la plantilla solo afecta a los expedientes futuros.
  await prisma.documentoPlantilla.delete({ where: { id } });
  await registrar('DocumentoPlantilla', id, 'borrado', sesion.id);
  volver(`/configuracion/tramites/${doc.tipoTramiteId}`);
}

// ══ Catálogos simples ══════════════════════════════════════════

export async function crearOrigen(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver('/configuracion/catalogos', 'nombre');
  try {
    const o = await prisma.origenProspecto.create({ data: { nombre } });
    await registrar('OrigenProspecto', o.id, 'creado', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/catalogos', 'duplicado');
    }
    throw e;
  }
  volver('/configuracion/catalogos');
}

export async function alternarOrigen(datos: FormData) {
  await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const o = await prisma.origenProspecto.findUniqueOrThrow({ where: { id } });
  await prisma.origenProspecto.update({ where: { id }, data: { activo: !o.activo } });
  volver('/configuracion/catalogos');
}

export async function crearMotivo(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver('/configuracion/catalogos', 'nombre');
  try {
    const m = await prisma.motivoPerdida.create({ data: { nombre } });
    await registrar('MotivoPerdida', m.id, 'creado', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/catalogos', 'duplicado');
    }
    throw e;
  }
  volver('/configuracion/catalogos');
}

export async function alternarMotivo(datos: FormData) {
  await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const m = await prisma.motivoPerdida.findUniqueOrThrow({ where: { id } });
  await prisma.motivoPerdida.update({ where: { id }, data: { activo: !m.activo } });
  volver('/configuracion/catalogos');
}

export async function crearMetodoPago(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver('/configuracion/catalogos', 'nombre');
  try {
    const m = await prisma.metodoPago.create({ data: { nombre, orden: 50 } });
    await registrar('MetodoPago', m.id, 'creado', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/catalogos', 'duplicado');
    }
    throw e;
  }
  volver('/configuracion/catalogos');
}

export async function alternarMetodoPago(datos: FormData) {
  await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const m = await prisma.metodoPago.findUniqueOrThrow({ where: { id } });
  await prisma.metodoPago.update({ where: { id }, data: { activo: !m.activo } });
  volver('/configuracion/catalogos');
}

// ══ Plantillas de comisión ═════════════════════════════════════

const ROLES_COMISION: Rol[] = ['VENDEDOR', 'ABOGADO', 'DIRECTOR', 'ASISTENTE', 'CONTADOR'];

/**
 * Guarda los porcentajes de una plantilla y sube su versión. Las comisiones ya
 * calculadas no se tocan: guardan su porcentaje y su monto congelados, además
 * de la versión con la que se calcularon.
 */
export async function guardarPlantillaComision(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const plantilla = await prisma.plantillaComision.findUniqueOrThrow({
    where: { id },
    include: { items: true },
  });

  const nuevos = ROLES_COMISION.map((rol) => ({
    rol,
    porcentaje: Number(datos.get(`porcentaje-${rol}`) ?? 0),
  })).filter((i) => i.porcentaje > 0);

  const cambio =
    nuevos.length !== plantilla.items.length ||
    nuevos.some((n) => {
      const previo = plantilla.items.find((i) => i.rol === n.rol);
      return !previo || Number(previo.porcentaje) !== n.porcentaje;
    });

  await prisma.$transaction([
    prisma.plantillaComisionItem.deleteMany({ where: { plantillaId: id } }),
    ...nuevos.map((n) =>
      prisma.plantillaComisionItem.create({
        data: { plantillaId: id, rol: n.rol, porcentaje: new Prisma.Decimal(n.porcentaje) },
      })
    ),
    prisma.plantillaComision.update({
      where: { id },
      data: { version: cambio ? plantilla.version + 1 : plantilla.version },
    }),
  ]);
  await registrar('PlantillaComision', id, `guardada_v${plantilla.version + (cambio ? 1 : 0)}`, sesion.id);
  volver('/configuracion/comisiones');
}

export async function crearPlantillaComision(datos: FormData) {
  const sesion = await exigir('configuracion', 'crear');
  const nombre = texto(datos, 'nombre');
  if (!nombre) volver('/configuracion/comisiones', 'nombre');
  try {
    const p = await prisma.plantillaComision.create({ data: { nombre } });
    await registrar('PlantillaComision', p.id, 'creada', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/comisiones', 'duplicado');
    }
    throw e;
  }
  volver('/configuracion/comisiones');
}

export async function marcarPredeterminada(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  await prisma.$transaction([
    prisma.plantillaComision.updateMany({ data: { esPredeterminada: false } }),
    prisma.plantillaComision.update({ where: { id }, data: { esPredeterminada: true, activa: true } }),
  ]);
  await registrar('PlantillaComision', id, 'marcada_predeterminada', sesion.id);
  volver('/configuracion/comisiones');
}

// ══ Motor de alertas ═══════════════════════════════════════════

export async function guardarAlerta(datos: FormData) {
  const sesion = await exigir('configuracion', 'editar');
  const id = texto(datos, 'id');
  const destinatarios = datos.getAll('destinatarios').map(String) as Rol[];

  await prisma.configAlerta.update({
    where: { id },
    data: {
      activa: datos.get('activa') === 'on',
      diasAnticipacion: Math.max(0, Number(datos.get('diasAnticipacion') ?? 0)),
      canal: texto(datos, 'canal') as CanalAlerta,
      destinatarios,
      notificarCliente: datos.get('notificarCliente') === 'on',
    },
  });
  await registrar('ConfigAlerta', id, 'guardada', sesion.id);
  volver('/configuracion/alertas');
}

// ══ Usuarios ═══════════════════════════════════════════════════

export async function crearUsuario(datos: FormData) {
  const sesion = await exigir('usuarios', 'crear');
  const nombre = texto(datos, 'nombre');
  const correo = texto(datos, 'correo').toLowerCase();
  const rol = texto(datos, 'rol') as Rol;
  const password = String(datos.get('password') ?? '');

  if (!nombre || !correo) volver('/configuracion/usuarios', 'faltan');
  if (password.length < 8) volver('/configuracion/usuarios', 'password-corta');

  try {
    const u = await prisma.usuario.create({
      data: { nombre, correo, rol, passwordHash: await bcrypt.hash(password, 10) },
    });
    await registrar('Usuario', u.id, 'creado', sesion.id);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      volver('/configuracion/usuarios', 'correo-duplicado');
    }
    throw e;
  }
  volver('/configuracion/usuarios');
}

export async function cambiarRol(datos: FormData) {
  const sesion = await exigir('usuarios', 'editar');
  const id = texto(datos, 'id');
  const rol = texto(datos, 'rol') as Rol;

  // Sin dirección nadie puede volver a entrar a configuración ni a reportes.
  if (rol !== 'DIRECTOR') {
    const directores = await prisma.usuario.count({
      where: { rol: 'DIRECTOR', activo: true, id: { not: id } },
    });
    if (directores === 0) volver('/configuracion/usuarios', 'ultimo-director');
  }

  await prisma.usuario.update({ where: { id }, data: { rol } });
  await registrar('Usuario', id, `rol:${rol}`, sesion.id);
  volver('/configuracion/usuarios');
}

export async function alternarUsuario(datos: FormData) {
  const sesion = await exigir('usuarios', 'editar');
  const id = texto(datos, 'id');
  const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id } });

  if (usuario.activo) {
    // Un usuario no se borra nunca: queda en el historial de cada cambio que
    // hizo. Se desactiva, y con eso deja de poder entrar.
    if (id === sesion.id) volver('/configuracion/usuarios', 'auto-desactivar');
    if (usuario.rol === 'DIRECTOR') {
      const otros = await prisma.usuario.count({
        where: { rol: 'DIRECTOR', activo: true, id: { not: id } },
      });
      if (otros === 0) volver('/configuracion/usuarios', 'ultimo-director');
    }
  }

  await prisma.usuario.update({ where: { id }, data: { activo: !usuario.activo } });
  await registrar('Usuario', id, usuario.activo ? 'desactivado' : 'activado', sesion.id);
  volver('/configuracion/usuarios');
}

export async function restablecerPassword(datos: FormData) {
  const sesion = await exigir('usuarios', 'editar');
  const id = texto(datos, 'id');
  const password = String(datos.get('password') ?? '');
  if (password.length < 8) volver('/configuracion/usuarios', 'password-corta');

  await prisma.usuario.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(password, 10) },
  });
  await registrar('Usuario', id, 'password_restablecida', sesion.id);
  volver('/configuracion/usuarios', 'password-lista');
}
