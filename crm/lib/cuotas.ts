import type { Cuota } from '@prisma/client';

/**
 * Estatus de una cuota del plan de pagos.
 *
 * No se guarda en la base a propósito: depende de la fecha de hoy, así que
 * cualquier valor almacenado se volvería mentira al día siguiente sin que
 * nadie tocara el registro. Se calcula aquí, en un solo lugar, y todo el
 * sistema (ficha, cobros, reportes y alertas) lo consume de esta función.
 */
export type EstatusCuota = 'PAGADO' | 'VENCIDO' | 'POR_VENCER' | 'AL_CORRIENTE';

export const ETIQUETA_CUOTA: Record<EstatusCuota, string> = {
  PAGADO: 'Pagado',
  VENCIDO: 'Vencido',
  POR_VENCER: 'Por vencer',
  AL_CORRIENTE: 'Al corriente',
};

/** Ventana de aviso previo, en días. Configurable desde el motor de alertas. */
export const DIAS_POR_VENCER = 7;

/** Compara solo la fecha del calendario: la hora del día no debe influir. */
function aDiaCalendario(f: Date): number {
  return Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate());
}

export function diasHastaVencimiento(fechaPactada: Date, hoy: Date = new Date()): number {
  const MS_DIA = 86_400_000;
  return Math.round((aDiaCalendario(fechaPactada) - aDiaCalendario(hoy)) / MS_DIA);
}

export function estatusCuota(
  cuota: Pick<Cuota, 'fechaPactada' | 'pagadoEn'>,
  hoy: Date = new Date(),
  diasPorVencer: number = DIAS_POR_VENCER
): EstatusCuota {
  if (cuota.pagadoEn) return 'PAGADO';

  const dias = diasHastaVencimiento(cuota.fechaPactada, hoy);
  if (dias < 0) return 'VENCIDO';
  if (dias <= diasPorVencer) return 'POR_VENCER';
  return 'AL_CORRIENTE';
}

/** Resumen de cobranza de un conjunto de cuotas, en pesos. */
export function resumenCobranza(
  cuotas: Pick<Cuota, 'fechaPactada' | 'pagadoEn' | 'monto'>[],
  hoy: Date = new Date()
) {
  const cero = { total: 0, pagado: 0, vencido: 0, porVencer: 0, alCorriente: 0 };
  return cuotas.reduce((acc, c) => {
    const monto = Number(c.monto);
    acc.total += monto;
    switch (estatusCuota(c, hoy)) {
      case 'PAGADO': acc.pagado += monto; break;
      case 'VENCIDO': acc.vencido += monto; break;
      case 'POR_VENCER': acc.porVencer += monto; break;
      default: acc.alCorriente += monto;
    }
    return acc;
  }, cero);
}

/** Lo que falta por cobrar: todo lo que no tiene pago registrado. */
export function saldoPendiente(
  cuotas: Pick<Cuota, 'fechaPactada' | 'pagadoEn' | 'monto'>[],
  hoy: Date = new Date()
): number {
  const r = resumenCobranza(cuotas, hoy);
  return r.total - r.pagado;
}
