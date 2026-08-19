'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { EtapaComercial } from '@prisma/client';
import { exigir } from '@/lib/sesion';
import { prisma } from '@/lib/prisma';
import { filtroVentas } from '@/lib/permisos';
import { moverEtapaVenta, registrarEntrevista } from '@/lib/negocio';

/** Nadie mueve una venta que no le corresponde, venga de donde venga la petición. */
async function ventaPropia(ventaId: string) {
  const sesion = await exigir('ventas', 'editar');
  const venta = await prisma.venta.findFirst({
    where: { AND: [{ id: ventaId }, filtroVentas(sesion)] },
  });
  if (!venta) redirect('/sin-permiso');
  return { sesion, venta };
}

export async function moverVenta(datos: FormData) {
  const ventaId = String(datos.get('ventaId'));
  const etapa = String(datos.get('etapa')) as EtapaComercial;
  const { sesion } = await ventaPropia(ventaId);

  // Los dos cierres piden datos extra, así que se hacen en su propia pantalla.
  if (etapa === 'CERRADO_GANADO') redirect(`/pipeline/${ventaId}/cerrar`);
  if (etapa === 'CERRADO_PERDIDO') redirect(`/pipeline/${ventaId}/perder`);

  await moverEtapaVenta(ventaId, etapa, sesion);
  revalidatePath('/pipeline');
}

export async function cerrarPerdida(datos: FormData) {
  const ventaId = String(datos.get('ventaId'));
  const motivoPerdidaId = String(datos.get('motivoPerdidaId') ?? '');
  const { sesion } = await ventaPropia(ventaId);

  if (!motivoPerdidaId) redirect(`/pipeline/${ventaId}/perder?error=motivo`);

  await moverEtapaVenta(ventaId, 'CERRADO_PERDIDO', sesion, { motivoPerdidaId });
  revalidatePath('/pipeline');
  redirect('/pipeline');
}

export async function cerrarGanada(datos: FormData) {
  const ventaId = String(datos.get('ventaId'));
  const { sesion } = await ventaPropia(ventaId);

  const montoTotal = Number(datos.get('montoTotal'));
  const abogadoId = String(datos.get('abogadoId') ?? '') || null;
  const plantillaComisionId = String(datos.get('plantillaComisionId') ?? '') || null;

  // El plan de pagos llega como filas paralelas: fecha[] y monto[].
  const fechas = datos.getAll('fechaPactada').map(String).filter(Boolean);
  const montos = datos.getAll('montoCuota').map((m) => Number(m));
  const cuotas = fechas
    .map((f, i) => ({ fechaPactada: new Date(f), monto: montos[i] ?? 0, esInicial: i === 0 }))
    .filter((c) => c.monto > 0 && !Number.isNaN(c.fechaPactada.getTime()));

  if (!montoTotal || montoTotal <= 0) redirect(`/pipeline/${ventaId}/cerrar?error=monto`);
  if (!cuotas.length) redirect(`/pipeline/${ventaId}/cerrar?error=cuotas`);

  const suma = cuotas.reduce((t, c) => t + c.monto, 0);
  // Diferencias de centavos son normales al partir un total; una diferencia
  // mayor casi siempre es un error de captura, y conviene atajarlo aquí.
  if (Math.abs(suma - montoTotal) > 1) {
    redirect(`/pipeline/${ventaId}/cerrar?error=suma&suma=${suma}`);
  }

  await moverEtapaVenta(ventaId, 'CERRADO_GANADO', sesion, {
    cierre: { montoTotal, abogadoId, plantillaComisionId, cuotas },
  });

  revalidatePath('/pipeline');
  revalidatePath('/casos');
  redirect(`/pipeline?cerrada=${ventaId}`);
}

export async function guardarEntrevista(datos: FormData) {
  const sesion = await exigir('ventas', 'editar');
  const leadId = String(datos.get('leadId'));
  const resultado = String(datos.get('resultado')) as 'VIABLE' | 'NO_VIABLE' | 'REQUIERE_INFO';
  const notas = String(datos.get('notas') ?? '') || null;
  const montoEstimado = Number(datos.get('montoEstimado')) || null;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...(sesion.rol === 'VENDEDOR' ? { vendedorId: sesion.id } : {}) },
  });
  if (!lead) redirect('/sin-permiso');

  await registrarEntrevista(leadId, resultado, notas, montoEstimado, sesion);
  revalidatePath('/pipeline');
  redirect('/pipeline');
}
