const PESOS = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0,
});

const PESOS_EXACTO = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
});

export function pesos(monto: number | { toString(): string }, exacto = false): string {
  const n = typeof monto === 'number' ? monto : Number(monto.toString());
  return (exacto ? PESOS_EXACTO : PESOS).format(n);
}

const FECHA = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
const FECHA_HORA = new Intl.DateTimeFormat('es-MX', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function fecha(f: Date | null | undefined): string {
  return f ? FECHA.format(f) : '—';
}

export function fechaHora(f: Date | null | undefined): string {
  return f ? FECHA_HORA.format(f) : '—';
}

/** Para inputs type="date", que solo aceptan AAAA-MM-DD. */
export function paraInput(f: Date | null | undefined): string {
  return f ? f.toISOString().slice(0, 10) : '';
}
