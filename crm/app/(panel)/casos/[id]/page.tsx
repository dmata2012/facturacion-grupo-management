import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroCasos, puede } from '@/lib/permisos';
import { fecha, fechaHora, paraInput } from '@/lib/formato';
import {
  Boton, BotonEnlace, Campo, Dato, Insignia, Tarjeta, TituloSeccion, claseInput,
} from '@/componentes/ui';
import { cambiarEtapaCaso, guardarDatosCaso, subirDocumento } from '../acciones';

export default async function DetalleCaso({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const sesion = await exigir('casos');

  const caso = await prisma.caso.findFirst({
    where: { AND: [{ id }, filtroCasos(sesion)] },
    include: {
      etapaActual: true,
      abogado: true,
      tipoTramite: { include: { etapas: { orderBy: { orden: 'asc' } } } },
      venta: { include: { cliente: true, vendedor: true } },
      documentos: { include: { plantilla: true, subidoPor: true }, orderBy: { nombre: 'asc' } },
      historial: { include: { usuario: true }, orderBy: { fecha: 'desc' } },
    },
  });
  if (!caso) notFound();

  const [abogados] = await Promise.all([
    prisma.usuario.findMany({ where: { rol: 'ABOGADO', activo: true }, orderBy: { nombre: 'asc' } }),
  ]);

  const puedeEditar = puede(sesion.rol, 'casos', 'editar');

  return (
    <>
      <TituloSeccion
        accion={
          <BotonEnlace href={`/clientes/${caso.venta.clienteId}`} estilo="suave">
            Ver ficha del cliente
          </BotonEnlace>
        }
      >
        {caso.venta.cliente.nombre}
      </TituloSeccion>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm text-suave">
        <Insignia tono="marca">{caso.tipoTramite.nombre}</Insignia>
        <Insignia tono="info">{caso.etapaActual?.nombre ?? 'Sin etapa'}</Insignia>
        <span>Vendedor: {caso.venta.vendedor.nombre}</span>
      </div>

      {error === 'archivo' && (
        <p className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
          No se pudo subir el archivo. Revisa que sea PDF o imagen y pese menos de 10 MB.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Tarjeta className="p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Etapa del trámite</h2>
            {puedeEditar ? (
              <form action={cambiarEtapaCaso} className="flex flex-wrap gap-2">
                <input type="hidden" name="casoId" value={caso.id} />
                <select
                  name="etapaId"
                  defaultValue={caso.etapaActualId ?? ''}
                  className={`${claseInput} max-w-xs`}
                  aria-label="Etapa del caso"
                >
                  {caso.tipoTramite.etapas.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.nombre}
                    </option>
                  ))}
                </select>
                <Boton type="submit">Cambiar etapa</Boton>
              </form>
            ) : (
              <p className="text-sm text-suave">{caso.etapaActual?.nombre ?? 'Sin etapa'}</p>
            )}
            <p className="mt-3 text-xs text-tenue">
              La fecha de presentación ante la autoridad no se captura: queda registrada sola cuando
              el caso entra a esa etapa.
            </p>
          </Tarjeta>

          <Tarjeta className="p-6">
            <h2 className="mb-1 text-sm font-bold text-tinta">Datos del trámite</h2>
            <p className="mb-4 text-xs text-tenue">
              La dependencia donde se presenta es independiente del domicilio del cliente
              ({caso.venta.cliente.ciudad}, {caso.venta.cliente.estado}): el sistema no la deduce.
            </p>
            <form action={guardarDatosCaso} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="casoId" value={caso.id} />
              <Campo etiqueta="Dependencia / oficina donde se presentó">
                <input
                  name="dependencia"
                  defaultValue={caso.dependencia ?? ''}
                  className={claseInput}
                  placeholder="Delegación Veracruz"
                  disabled={!puedeEditar}
                />
              </Campo>
              <Campo etiqueta="Modalidad">
                <select
                  name="modalidad"
                  defaultValue={caso.modalidad ?? ''}
                  className={claseInput}
                  disabled={!puedeEditar}
                >
                  <option value="">Sin especificar</option>
                  <option value="PRESENCIAL">Presencial</option>
                  <option value="EN_LINEA">En línea</option>
                </select>
              </Campo>
              <Campo etiqueta="Oficina exacta" ayuda="Si se presentó de forma presencial.">
                <input
                  name="oficina"
                  defaultValue={caso.oficina ?? ''}
                  className={claseInput}
                  disabled={!puedeEditar}
                />
              </Campo>
              <Campo etiqueta="Abogado / operador asignado">
                <select
                  name="abogadoId"
                  defaultValue={caso.abogadoId ?? ''}
                  className={claseInput}
                  disabled={!puedeEditar}
                >
                  <option value="">Sin asignar</option>
                  {abogados.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nombre}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo
                etiqueta="Fecha tentativa de resolución máxima"
                ayuda="La usa el motor de alertas."
              >
                <input
                  type="date"
                  name="fechaTentativaResolucion"
                  defaultValue={paraInput(caso.fechaTentativaResolucion)}
                  className={claseInput}
                  disabled={!puedeEditar}
                />
              </Campo>
              <div className="flex items-end">
                {puedeEditar && <Boton type="submit" estilo="suave">Guardar datos</Boton>}
              </div>
            </form>
          </Tarjeta>

          <Tarjeta className="p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Checklist de documentos</h2>
            <ul className="divide-y divide-borde">
              {caso.documentos.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-52 flex-1">
                    <p className="text-sm font-semibold text-tinta">{d.nombre}</p>
                    {d.fechaSubida && (
                      <p className="text-xs text-tenue">
                        {d.subidoPor?.nombre} · {fecha(d.fechaSubida)}
                        {d.fechaVigencia && ` · vence ${fecha(d.fechaVigencia)}`}
                      </p>
                    )}
                  </div>
                  <Insignia tono={d.estatus === 'ENTREGADO' ? 'exito' : 'neutro'}>
                    {d.estatus === 'ENTREGADO' ? 'Entregado' : 'Pendiente'}
                  </Insignia>
                  {d.archivoUrl && (
                    <a href={d.archivoUrl} target="_blank" className="text-sm font-semibold text-marca hover:underline">
                      Ver
                    </a>
                  )}
                  {puedeEditar && (
                    <form action={subirDocumento} className="flex items-center gap-2">
                      <input type="hidden" name="documentoId" value={d.id} />
                      <input
                        type="file"
                        name="archivo"
                        required
                        aria-label={`Subir ${d.nombre}`}
                        className="max-w-40 text-xs file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-semibold"
                      />
                      {d.plantilla?.requiereVigencia && (
                        <input
                          type="date"
                          name="fechaVigencia"
                          aria-label={`Vigencia de ${d.nombre}`}
                          defaultValue={paraInput(d.fechaVigencia)}
                          className="rounded border border-borde px-2 py-1 text-xs"
                        />
                      )}
                      <Boton type="submit" estilo="suave" className="px-3 py-1 text-xs">
                        Subir
                      </Boton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Tarjeta>
        </div>

        <div className="space-y-6">
          <Tarjeta className="p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Resumen</h2>
            <dl className="space-y-3">
              <Dato etiqueta="Cliente" valor={
                <Link href={`/clientes/${caso.venta.clienteId}`} className="text-marca hover:underline">
                  {caso.venta.cliente.nombre}
                </Link>
              } />
              <Dato etiqueta="Nacionalidad" valor={caso.venta.cliente.nacionalidad} />
              <Dato etiqueta="Ubicación del cliente" valor={`${caso.venta.cliente.ciudad}, ${caso.venta.cliente.estado}`} />
              <Dato etiqueta="Presentado ante autoridad" valor={fecha(caso.fechaPresentacion)} />
              <Dato etiqueta="Resolución tentativa" valor={fecha(caso.fechaTentativaResolucion)} />
              <Dato etiqueta="Expediente abierto" valor={fecha(caso.creadoEn)} />
            </dl>
          </Tarjeta>

          <Tarjeta className="p-6">
            <h2 className="mb-4 text-sm font-bold text-tinta">Historial de etapas</h2>
            <ol className="space-y-3">
              {caso.historial.map((h) => (
                <li key={h.id} className="border-l-2 border-borde pl-3">
                  <p className="text-sm font-semibold text-tinta">{h.etapaNueva}</p>
                  <p className="text-xs text-tenue">
                    {fechaHora(h.fecha)}
                    {h.usuario && ` · ${h.usuario.nombre}`}
                  </p>
                </li>
              ))}
            </ol>
          </Tarjeta>
        </div>
      </div>
    </>
  );
}
