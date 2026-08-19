'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { MedioContacto } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import {
  aceptarPresupuesto, crearPresupuesto, enviarPresupuesto, enviarPresupuestoPorCorreo,
  rechazarPresupuesto, type LineaConcepto, type LineaPago,
} from '@/lib/negocio';

/** Nadie toca el presupuesto de una venta que no le corresponde. */
async function ventaPropia(ventaId: string) {
  const sesion = await exigir('ventas', 'editar');
  const venta = await prisma.venta.findFirst({ where: { AND: [{ id: ventaId }, filtroVentas(sesion)] } });
  if (!venta) redirect('/sin-permiso');
  return { sesion, venta };
}

async function presupuestoPropio(presupuestoId: string) {
  const presupuesto = await prisma.presupuesto.findUniqueOrThrow({ where: { id: presupuestoId } });
  const { sesion } = await ventaPropia(presupuesto.ventaId);
  return { sesion, presupuesto };
}

/**
 * Normaliza un texto de varias líneas. Los navegadores envían los saltos como
 * CRLF y el retorno de carro se dibujaba como un carácter suelto en el PDF.
 */
function textoMultilinea(valor: FormDataEntryValue | null): string | null {
  return String(valor ?? '').replace(/\r\n?/g, '\n').trim() || null;
}

/** Lee las filas paralelas de conceptos y pagos que envía el formulario. */
function leerLineas(datos: FormData) {
  const conceptos: LineaConcepto[] = datos
    .getAll('conceptoDescripcion')
    .map((d, i) => ({
      descripcion: String(d).trim(),
      monto: Number(datos.getAll('conceptoMonto')[i] ?? 0),
    }))
    .filter((c) => c.descripcion && c.monto > 0);

  const pagos: LineaPago[] = datos
    .getAll('pagoFecha')
    .map((f, i) => ({
      descripcion: String(datos.getAll('pagoDescripcion')[i] ?? '').trim(),
      fechaPropuesta: new Date(String(f)),
      monto: Number(datos.getAll('pagoMonto')[i] ?? 0),
    }))
    .filter((p) => p.monto > 0 && !Number.isNaN(p.fechaPropuesta.getTime()));

  return { conceptos, pagos };
}

export async function nuevoPresupuesto(datos: FormData) {
  const ventaId = String(datos.get('ventaId'));
  const { sesion } = await ventaPropia(ventaId);
  const { conceptos, pagos } = leerLineas(datos);

  const volver = (error: string) => redirect(`/presupuestos/nuevo?venta=${ventaId}&error=${error}`);
  if (!conceptos.length) volver('conceptos');
  if (!pagos.length) volver('pagos');

  const total = conceptos.reduce((t, c) => t + c.monto, 0);
  const sumaPagos = pagos.reduce((t, p) => t + p.monto, 0);
  // Si los pagos no suman el total, el cliente firmaría una cosa y se le
  // cobraría otra. Se ataja aquí, antes de que exista el documento.
  if (Math.abs(total - sumaPagos) > 1) volver('descuadre');

  const validoHasta = String(datos.get('validoHasta') ?? '');
  const presupuesto = await crearPresupuesto(
    ventaId,
    {
      conceptos,
      pagos,
      validoHasta: validoHasta ? new Date(validoHasta) : null,
      condiciones: textoMultilinea(datos.get('condiciones')),
      notas: textoMultilinea(datos.get('notas')),
    },
    sesion
  );

  revalidatePath('/pipeline');
  redirect(`/presupuestos/${presupuesto.id}`);
}

export async function marcarEnviado(datos: FormData) {
  const id = String(datos.get('presupuestoId'));
  const { sesion } = await presupuestoPropio(id);
  const medio = (String(datos.get('medio') ?? 'CORREO') as MedioContacto);
  await enviarPresupuesto(id, medio, sesion);
  const presupuesto = await prisma.presupuesto.findUniqueOrThrow({
    where: { id },
    include: { venta: true },
  });
  revalidatePath(`/presupuestos/${id}`);
  revalidatePath('/pipeline');
  revalidatePath(`/clientes/${presupuesto.venta.clienteId}`);
}

/** Manda el presupuesto al correo del cliente, con el PDF adjunto. */
export async function enviarPorCorreo(datos: FormData) {
  const id = String(datos.get('presupuestoId'));
  const { sesion } = await presupuestoPropio(id);

  const resultado = await enviarPresupuestoPorCorreo(id, sesion);

  revalidatePath(`/presupuestos/${id}`);
  revalidatePath('/pipeline');
  if (!resultado.enviado) {
    // El motivo real viaja en la URL: sin él, quien pulsó el botón no sabe si
    // falta configurar el correo o si el cliente no tiene dirección.
    redirect(`/presupuestos/${id}?error=${encodeURIComponent(resultado.motivo ?? 'No se pudo enviar.')}`);
  }
  redirect(`/presupuestos/${id}?enviado=${encodeURIComponent(resultado.destinatario ?? '')}`);
}

export async function aprobarPresupuesto(datos: FormData) {
  const id = String(datos.get('presupuestoId'));
  const { sesion, presupuesto } = await presupuestoPropio(id);

  try {
    await aceptarPresupuesto(id, sesion, {
      abogadoId: String(datos.get('abogadoId') ?? '') || null,
      plantillaComisionId: String(datos.get('plantillaComisionId') ?? '') || null,
    });
  } catch (e) {
    const motivo = e instanceof Error ? e.message : 'No se pudo aprobar el presupuesto.';
    redirect(`/presupuestos/${id}?error=${encodeURIComponent(motivo)}`);
  }

  const venta = await prisma.venta.findUniqueOrThrow({ where: { id: presupuesto.ventaId } });
  revalidatePath(`/presupuestos/${id}`);
  revalidatePath('/pipeline');
  revalidatePath('/casos');
  redirect(`/clientes/${venta.clienteId}?pestana=pagos`);
}

export async function declinarPresupuesto(datos: FormData) {
  const id = String(datos.get('presupuestoId'));
  const { sesion } = await presupuestoPropio(id);
  await rechazarPresupuesto(id, String(datos.get('motivo') ?? '').trim(), sesion);
  revalidatePath(`/presupuestos/${id}`);
  revalidatePath('/pipeline');
}
