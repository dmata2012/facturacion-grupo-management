import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { fecha, pesos } from '@/lib/formato';
import {
  Boton, BotonEnlace, Campo, Insignia, Tarjeta, TituloSeccion, claseInput, type Tono,
} from '@/componentes/ui';
import { aprobarPresupuesto, declinarPresupuesto, marcarEnviado } from '../acciones';

const MEDIO: Record<string, string> = {
  CORREO: 'por correo',
  WHATSAPP: 'por WhatsApp',
  PRESENCIAL: 'en persona',
  LLAMADA: 'por teléfono',
};

const ETIQUETA: Record<string, { texto: string; tono: Tono }> = {
  BORRADOR: { texto: 'Borrador', tono: 'neutro' },
  ENVIADO: { texto: 'Enviado al cliente', tono: 'info' },
  ACEPTADO: { texto: 'Aceptado', tono: 'exito' },
  RECHAZADO: { texto: 'Rechazado', tono: 'alerta' },
};

export default async function VerPresupuesto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sesion = await exigir('ventas');

  const presupuesto = await prisma.presupuesto.findFirst({
    where: { AND: [{ id }, { venta: filtroVentas(sesion) }] },
    include: {
      conceptos: { orderBy: { orden: 'asc' } },
      pagos: { orderBy: { numero: 'asc' } },
      creadoPor: true,
      venta: { include: { cliente: true, tipoTramite: true, vendedor: true, caso: true } },
    },
  });
  if (!presupuesto) notFound();

  const [abogados, plantillas] = await Promise.all([
    prisma.usuario.findMany({ where: { rol: 'ABOGADO', activo: true }, orderBy: { nombre: 'asc' } }),
    prisma.plantillaComision.findMany({ where: { activa: true }, orderBy: { nombre: 'asc' } }),
  ]);

  const total = presupuesto.conceptos.reduce((t, c) => t + Number(c.monto), 0);
  const estado = ETIQUETA[presupuesto.estatus];
  const cerrado = presupuesto.estatus === 'ACEPTADO' || presupuesto.estatus === 'RECHAZADO';
  const predeterminada = plantillas.find((p) => p.esPredeterminada) ?? plantillas[0];

  return (
    <>
      <TituloSeccion
        etiqueta="Comercial"
        accion={
          <div className="flex flex-wrap gap-2">
            <BotonEnlace href={`/presupuestos/${presupuesto.id}/pdf`} estilo="suave">
              Descargar PDF
            </BotonEnlace>
            <BotonEnlace href={`/clientes/${presupuesto.venta.clienteId}`} estilo="suave">
              Ficha del cliente
            </BotonEnlace>
          </div>
        }
      >
        Presupuesto {presupuesto.folio}
      </TituloSeccion>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-suave">
        <Insignia tono={estado.tono}>
          {estado.texto}
          {presupuesto.medioEnvio && ` ${MEDIO[presupuesto.medioEnvio]}`}
        </Insignia>
        <span>{presupuesto.venta.cliente.nombre}</span>
        <span>· {presupuesto.venta.tipoTramite.nombre}</span>
        {presupuesto.validoHasta && <span>· válido hasta {fecha(presupuesto.validoHasta)}</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* El documento tal como lo verá el cliente. */}
        <Tarjeta className="p-6">
          <table className="w-full text-sm">
            <thead className="border-b border-borde text-left text-xs uppercase tracking-wide text-tenue">
              <tr>
                <th className="pb-2">Concepto</th>
                <th className="pb-2 text-right">Importe</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borde">
              {presupuesto.conceptos.map((c) => (
                <tr key={c.id}>
                  <td className="py-2.5">{c.descripcion}</td>
                  <td className="py-2.5 text-right">{pesos(c.monto, true)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-tinta">
                <td className="pt-3 text-sm font-bold">Total</td>
                <td className="pt-3 text-right text-lg font-extrabold text-tinta">{pesos(total)}</td>
              </tr>
            </tfoot>
          </table>

          <h2 className="mt-7 mb-2 text-sm font-bold text-tinta">Pagos propuestos</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-borde">
              {presupuesto.pagos.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 font-semibold">{p.numero === 1 ? 'Inicial' : `Pago ${p.numero}`}</td>
                  <td className="py-2 text-suave">{p.descripcion}</td>
                  <td className="py-2 text-suave">{fecha(p.fechaPropuesta)}</td>
                  <td className="py-2 text-right font-semibold">{pesos(p.monto, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {presupuesto.condiciones && (
            <>
              <h2 className="mt-7 mb-2 text-sm font-bold text-tinta">Condiciones</h2>
              <p className="whitespace-pre-line text-sm text-suave">{presupuesto.condiciones}</p>
            </>
          )}

          {presupuesto.notas && (
            <div className="mt-6 rounded-sm border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <strong>Nota interna (no aparece en el PDF):</strong> {presupuesto.notas}
            </div>
          )}
        </Tarjeta>

        <div className="space-y-5">
          <Tarjeta className="p-5">
            <h2 className="mb-3 text-sm font-bold text-tinta">Seguimiento</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-tenue">Elaborado</dt>
                <dd>{fecha(presupuesto.creadoEn)}</dd>
              </div>
              {presupuesto.creadoPor && (
                <div className="flex justify-between gap-2">
                  <dt className="text-tenue">Por</dt>
                  <dd>{presupuesto.creadoPor.nombre}</dd>
                </div>
              )}
              {presupuesto.fechaEnvio && (
                <div className="flex justify-between gap-2">
                  <dt className="text-tenue">Enviado</dt>
                  <dd>
                    {fecha(presupuesto.fechaEnvio)}
                    {presupuesto.medioEnvio && ` ${MEDIO[presupuesto.medioEnvio]}`}
                  </dd>
                </div>
              )}
              {presupuesto.fechaRespuesta && (
                <div className="flex justify-between gap-2">
                  <dt className="text-tenue">Respuesta</dt>
                  <dd>{fecha(presupuesto.fechaRespuesta)}</dd>
                </div>
              )}
            </dl>
            {presupuesto.motivoRechazo && (
              <p className="mt-3 text-xs text-red-700">Motivo: {presupuesto.motivoRechazo}</p>
            )}
          </Tarjeta>

          {!cerrado && (
            <>
              {presupuesto.estatus === 'BORRADOR' && (
                <Tarjeta className="p-5">
                  <h2 className="mb-2 text-sm font-bold text-tinta">Entregar al cliente</h2>
                  <p className="mb-3 text-xs text-tenue">
                    Descarga el PDF, mándaselo y registra por dónde se lo hiciste llegar: la venta
                    avanza sola a &laquo;Propuesta enviada&raquo; y queda anotado en el historial
                    del cliente.
                  </p>
                  <form action={marcarEnviado} className="space-y-3">
                    <input type="hidden" name="presupuestoId" value={presupuesto.id} />
                    <Campo etiqueta="Se le envió por">
                      <select name="medio" className={claseInput} defaultValue="CORREO">
                        <option value="CORREO">Correo electrónico</option>
                        <option value="WHATSAPP">WhatsApp</option>
                        <option value="PRESENCIAL">En persona</option>
                        <option value="LLAMADA">Teléfono</option>
                      </select>
                    </Campo>
                    <Boton type="submit">Marcar como enviado</Boton>
                  </form>
                </Tarjeta>
              )}

              <Tarjeta className="p-5">
                <h2 className="mb-2 text-sm font-bold text-tinta">El cliente aprobó</h2>
                <p className="mb-3 text-xs text-tenue">
                  Se cierra la venta como ganada, se abre el expediente y estos pagos se vuelven el
                  plan de cobranza. Se le cobrará exactamente lo aprobado.
                </p>
                <form action={aprobarPresupuesto} className="space-y-3">
                  <input type="hidden" name="presupuestoId" value={presupuesto.id} />
                  <Campo etiqueta="Abogado que llevará el caso">
                    <select name="abogadoId" className={claseInput} defaultValue="">
                      <option value="">Asignar después</option>
                      {abogados.map((a) => (
                        <option key={a.id} value={a.id}>{a.nombre}</option>
                      ))}
                    </select>
                  </Campo>
                  <Campo etiqueta="Plantilla de comisiones">
                    <select name="plantillaComisionId" className={claseInput} defaultValue={predeterminada?.id ?? ''}>
                      {plantillas.map((p) => (
                        <option key={p.id} value={p.id}>{p.nombre}</option>
                      ))}
                    </select>
                  </Campo>
                  <Boton type="submit">Aceptar y abrir expediente</Boton>
                </form>
              </Tarjeta>

              <Tarjeta className="p-5">
                <h2 className="mb-2 text-sm font-bold text-tinta">El cliente no aceptó</h2>
                <form action={declinarPresupuesto} className="space-y-3">
                  <input type="hidden" name="presupuestoId" value={presupuesto.id} />
                  <Campo etiqueta="Motivo">
                    <input name="motivo" className={claseInput} placeholder="Le pareció caro" />
                  </Campo>
                  <Boton type="submit" estilo="peligro">Marcar rechazado</Boton>
                </form>
              </Tarjeta>
            </>
          )}

          {presupuesto.estatus === 'ACEPTADO' && presupuesto.venta.caso && (
            <Tarjeta className="p-5">
              <p className="text-sm text-suave">
                Este presupuesto ya se convirtió en el{' '}
                <Link href={`/casos/${presupuesto.venta.caso.id}`} className="font-semibold text-marca hover:underline">
                  expediente del cliente
                </Link>
                , con su plan de pagos.
              </p>
            </Tarjeta>
          )}
        </div>
      </div>
    </>
  );
}
