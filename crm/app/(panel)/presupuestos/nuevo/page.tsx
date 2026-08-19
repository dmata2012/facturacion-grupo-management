import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { paraInput } from '@/lib/formato';
import { Aviso, Boton, BotonEnlace, Campo, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { nuevoPresupuesto } from '../acciones';

export const metadata = { title: 'Nuevo presupuesto — CRM' };

const FILAS_CONCEPTO = 6;
const FILAS_PAGO = 6;

const ERRORES: Record<string, string> = {
  conceptos: 'Captura al menos un concepto con su importe.',
  pagos: 'Captura al menos un pago con fecha e importe.',
  descuadre: 'Los pagos propuestos no suman el total de los conceptos. Si no cuadran, el cliente aprobaría una cifra y se le cobraría otra.',
};

/** Sugerencia de fecha para las cuotas: hoy, +30 días, +60… */
function enDias(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return paraInput(d);
}

export default async function NuevoPresupuesto({
  searchParams,
}: {
  searchParams: Promise<{ venta?: string; error?: string }>;
}) {
  const { venta: ventaId, error } = await searchParams;
  const sesion = await exigir('ventas', 'editar');
  if (!ventaId) notFound();

  const venta = await prisma.venta.findFirst({
    where: { AND: [{ id: ventaId }, filtroVentas(sesion)] },
    include: { cliente: true, tipoTramite: true, vendedor: true },
  });
  if (!venta) notFound();

  return (
    <>
      <TituloSeccion
        etiqueta="Comercial"
        accion={<BotonEnlace href="/pipeline" estilo="suave">Cancelar</BotonEnlace>}
      >
        Presupuesto para {venta.cliente.nombre}
      </TituloSeccion>

      {error && <Aviso>{ERRORES[error] ?? 'Revisa los datos capturados.'}</Aviso>}

      <Tarjeta className="max-w-4xl p-6">
        <dl className="mb-6 grid gap-4 border-b border-borde pb-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-tenue">Cliente</dt>
            <dd className="text-sm font-semibold text-tinta">{venta.cliente.nombre}</dd>
            <dd className="text-xs text-suave">
              {venta.cliente.nacionalidad} · {venta.cliente.ciudad}, {venta.cliente.estado}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-tenue">Trámite solicitado</dt>
            <dd className="text-sm font-semibold text-tinta">{venta.tipoTramite.nombre}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-tenue">Atiende</dt>
            <dd className="text-sm font-semibold text-tinta">{venta.vendedor.nombre}</dd>
          </div>
        </dl>

        <form action={nuevoPresupuesto} className="space-y-7">
          <input type="hidden" name="ventaId" value={venta.id} />

          <section>
            <h2 className="text-sm font-bold text-tinta">Conceptos</h2>
            <p className="mb-3 text-xs text-tenue">
              Desglosa qué incluye el servicio: honorarios, derechos de gobierno, gestoría. El
              cliente ve por qué paga lo que paga. Deja vacías las filas que no uses.
            </p>
            <div className="space-y-2">
              {Array.from({ length: FILAS_CONCEPTO }).map((_, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <input
                    name="conceptoDescripcion"
                    placeholder={i === 0 ? 'Honorarios profesionales' : 'Concepto'}
                    aria-label={`Concepto ${i + 1}`}
                    className={`${claseInput} min-w-52 flex-1`}
                  />
                  <input
                    name="conceptoMonto"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Importe"
                    aria-label={`Importe del concepto ${i + 1}`}
                    className={`${claseInput} w-40`}
                  />
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-bold text-tinta">Pagos propuestos</h2>
            <p className="mb-3 text-xs text-tenue">
              Deben sumar exactamente el total de los conceptos. Al aceptarse el presupuesto, estos
              pagos se convierten en el plan de cobranza del caso.
            </p>
            <div className="space-y-2">
              {Array.from({ length: FILAS_PAGO }).map((_, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="w-16 text-xs font-semibold text-tenue">
                    {i === 0 ? 'Inicial' : `Pago ${i + 1}`}
                  </span>
                  <input
                    name="pagoDescripcion"
                    placeholder={i === 0 ? 'Anticipo a la firma' : 'Descripción'}
                    aria-label={`Descripción del pago ${i + 1}`}
                    className={`${claseInput} min-w-40 flex-1`}
                  />
                  <input
                    type="date"
                    name="pagoFecha"
                    defaultValue={i === 0 ? paraInput(new Date()) : i === 1 ? enDias(30) : ''}
                    aria-label={`Fecha del pago ${i + 1}`}
                    className={`${claseInput} w-44`}
                  />
                  <input
                    name="pagoMonto"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Importe"
                    aria-label={`Importe del pago ${i + 1}`}
                    className={`${claseInput} w-36`}
                  />
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-5 sm:grid-cols-2">
            <Campo etiqueta="Válido hasta" ayuda="Hasta cuándo se sostiene este precio.">
              <input type="date" name="validoHasta" defaultValue={enDias(15)} className={claseInput} />
            </Campo>
          </div>

          <Campo
            etiqueta="Condiciones del servicio"
            ayuda="Lo que el cliente lee antes de aprobar: qué incluye, qué no, y qué se espera de él."
          >
            <textarea
              name="condiciones"
              rows={4}
              className={claseInput}
              defaultValue={
                'El precio incluye la integración y presentación del expediente ante la autoridad migratoria.\n' +
                'No incluye derechos de terceros, traducciones ni apostillas, salvo que se indique en los conceptos.\n' +
                'Los tiempos de resolución dependen de la autoridad y no son atribuibles al despacho.'
              }
            />
          </Campo>

          <Campo etiqueta="Notas internas" ayuda="No aparecen en el documento del cliente.">
            <textarea name="notas" rows={2} className={claseInput} />
          </Campo>

          <Boton type="submit">Generar presupuesto</Boton>
        </form>
      </Tarjeta>
    </>
  );
}
