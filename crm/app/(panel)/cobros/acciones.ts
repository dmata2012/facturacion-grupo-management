'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';

/** Registrar el pago de una cuota. Solo con esto la cuota queda "pagada":
 *  el estatus no se captura, se deduce de esta fecha (lib/cuotas.ts). */
export async function registrarPago(datos: FormData) {
  const sesion = await exigir('cobros', 'editar');
  const cuotaId = String(datos.get('cuotaId'));
  const fecha = String(datos.get('fechaPago') ?? '');

  const cuota = await prisma.cuota.update({
    where: { id: cuotaId },
    data: {
      pagadoEn: fecha ? new Date(fecha) : new Date(),
      metodoPagoId: String(datos.get('metodoPagoId') ?? '') || null,
    },
    include: { venta: true, metodoPago: true },
  });

  await prisma.auditoria.create({
    data: {
      entidad: 'Cuota',
      entidadId: cuotaId,
      accion: 'pago_registrado',
      usuarioId: sesion.id,
      detalle: { monto: cuota.monto.toString(), metodo: cuota.metodoPago?.nombre ?? null },
    },
  });

  revalidatePath('/cobros');
  revalidatePath(`/clientes/${cuota.venta.clienteId}`);
}

export async function cancelarPago(datos: FormData) {
  const sesion = await exigir('cobros', 'editar');
  const cuotaId = String(datos.get('cuotaId'));

  const cuota = await prisma.cuota.update({
    where: { id: cuotaId },
    data: { pagadoEn: null, metodoPagoId: null },
    include: { venta: true },
  });
  await prisma.auditoria.create({
    data: { entidad: 'Cuota', entidadId: cuotaId, accion: 'pago_cancelado', usuarioId: sesion.id },
  });

  revalidatePath('/cobros');
  revalidatePath(`/clientes/${cuota.venta.clienteId}`);
}

/** Cada participante se paga por separado: esto toca una sola comisión. */
export async function pagarComision(datos: FormData) {
  const sesion = await exigir('comisiones', 'editar');
  const comisionId = String(datos.get('comisionId'));

  const comision = await prisma.comision.update({
    where: { id: comisionId },
    data: { estatus: 'PAGADA', fechaPago: new Date() },
    include: { venta: true },
  });
  await prisma.auditoria.create({
    data: {
      entidad: 'Comision',
      entidadId: comisionId,
      accion: 'comision_pagada',
      usuarioId: sesion.id,
      detalle: { monto: comision.montoCalculado.toString() },
    },
  });

  revalidatePath('/cobros');
  revalidatePath(`/clientes/${comision.venta.clienteId}`);
}
