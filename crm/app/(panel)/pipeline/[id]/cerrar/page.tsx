import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { pesos } from '@/lib/formato';
import { Boton, BotonEnlace, Campo, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { cerrarGanada } from '../../acciones';

export const metadata = { title: 'Cerrar venta ganada — CRM' };

/** Filas del plan de pagos que se ofrecen de entrada; las vacías se ignoran. */
const FILAS_CUOTA = 6;

export default async function Cerrar({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; suma?: string }>;
}) {
  const { id } = await params;
  const { error, suma } = await searchParams;
  const sesion = await exigir('ventas', 'editar');

  const [venta, abogados, plantillas] = await Promise.all([
    prisma.venta.findFirst({
      where: { AND: [{ id }, filtroVentas(sesion)] },
      include: { cliente: true, tipoTramite: true },
    }),
    prisma.usuario.findMany({ where: { rol: 'ABOGADO', activo: true }, orderBy: { nombre: 'asc' } }),
    prisma.plantillaComision.findMany({
      where: { activa: true },
      include: { items: true },
      orderBy: { nombre: 'asc' },
    }),
  ]);
  if (!venta) notFound();

  const predeterminada = plantillas.find((p) => p.esPredeterminada) ?? plantillas[0];

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/pipeline" estilo="suave">Cancelar</BotonEnlace>}>
        Cerrar venta ganada
      </TituloSeccion>

      <Tarjeta className="max-w-3xl p-6">
        <p className="mb-5 text-sm text-suave">
          Al guardar se abre automáticamente el expediente de{' '}
          <strong>{venta.cliente.nombre}</strong> ({venta.tipoTramite.nombre}), con su checklist de
          documentos, su plan de pagos y el reparto de comisiones.
        </p>

        {error && (
          <p className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error === 'monto' && 'Captura el monto total de la venta.'}
            {error === 'cuotas' && 'Captura al menos una cuota con fecha y monto.'}
            {error === 'suma' &&
              `Las cuotas suman ${pesos(Number(suma ?? 0))} y no coinciden con el monto total.`}
          </p>
        )}

        <form action={cerrarGanada} className="space-y-6">
          <input type="hidden" name="ventaId" value={venta.id} />

          <div className="grid gap-5 sm:grid-cols-3">
            <Campo etiqueta="Monto total de la venta" requerido>
              <input
                name="montoTotal"
                type="number"
                min="1"
                step="0.01"
                required
                defaultValue={Number(venta.montoTotal) || undefined}
                className={claseInput}
              />
            </Campo>
            <Campo etiqueta="Abogado / operador" ayuda="Se puede asignar después.">
              <select name="abogadoId" className={claseInput} defaultValue="">
                <option value="">Sin asignar</option>
                {abogados.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo etiqueta="Plantilla de comisiones">
              <select
                name="plantillaComisionId"
                className={claseInput}
                defaultValue={predeterminada?.id ?? ''}
              >
                {plantillas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} ({p.items.map((i) => `${i.rol.toLowerCase()} ${i.porcentaje}%`).join(', ')})
                  </option>
                ))}
              </select>
            </Campo>
          </div>

          <div>
            <h2 className="text-sm font-bold text-tinta">Plan de pagos</h2>
            <p className="mb-3 text-xs text-tenue">
              Primera fila = cuota inicial. Deja vacías las filas que no uses. La suma debe coincidir
              con el monto total.
            </p>

            <div className="space-y-2">
              {Array.from({ length: FILAS_CUOTA }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="w-20 text-xs font-semibold text-tenue">
                    {i === 0 ? 'Inicial' : `Cuota ${i + 1}`}
                  </span>
                  <input
                    type="date"
                    name="fechaPactada"
                    aria-label={`Fecha de la cuota ${i + 1}`}
                    className={claseInput}
                  />
                  <input
                    type="number"
                    name="montoCuota"
                    min="0"
                    step="0.01"
                    placeholder="Monto"
                    aria-label={`Monto de la cuota ${i + 1}`}
                    className={claseInput}
                  />
                </div>
              ))}
            </div>
          </div>

          <Boton type="submit">Cerrar venta y abrir expediente</Boton>
        </form>
      </Tarjeta>
    </>
  );
}
