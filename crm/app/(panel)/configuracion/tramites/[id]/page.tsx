import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { Aviso, Boton, BotonEnlace, Insignia, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import {
  agregarDocumento, agregarEtapa, borrarDocumento, borrarEtapa, editarDocumento,
  marcarPresentacion, moverEtapa, renombrarEtapa, renombrarTipoTramite,
} from '../../acciones';

const ERRORES: Record<string, string> = {
  nombre: 'Escribe un nombre.',
  duplicado: 'Ya existe un tipo de trámite con ese nombre.',
  'doc-duplicado': 'Ese documento ya está en la lista de este trámite.',
  'etapa-en-uso': 'Hay expedientes parados en esa etapa. Muévelos antes de borrarla, o quedarían sin etapa.',
};

export default async function EditarTramite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  await exigir('configuracion');

  const tipo = await prisma.tipoTramite.findUnique({
    where: { id },
    include: {
      etapas: { orderBy: { orden: 'asc' }, include: { _count: { select: { casosEnEstaEtapa: true } } } },
      documentos: { orderBy: { orden: 'asc' } },
    },
  });
  if (!tipo) notFound();

  return (
    <>
      <TituloSeccion
        accion={<BotonEnlace href="/configuracion/tramites" estilo="suave">Volver</BotonEnlace>}
      >
        {tipo.nombre}
      </TituloSeccion>

      {error && <Aviso>{ERRORES[error] ?? 'No se pudo completar la operación.'}</Aviso>}

      <Tarjeta className="mb-6 p-5">
        <form action={renombrarTipoTramite} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={tipo.id} />
          <label className="min-w-56 flex-1">
            <span className="mb-1.5 block text-sm font-semibold">Nombre del trámite</span>
            <input name="nombre" defaultValue={tipo.nombre} className={claseInput} />
          </label>
          <Boton type="submit" estilo="suave">Guardar nombre</Boton>
        </form>
      </Tarjeta>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Etapas ── */}
        <Tarjeta className="p-5">
          <h2 className="text-sm font-bold text-tinta">Etapas del expediente</h2>
          <p className="mb-4 text-xs text-tenue">
            En este orden avanzan los casos. La etapa marcada como presentación es la que fija la
            fecha de presentación ante la autoridad, sin que nadie la capture.
          </p>

          <ul className="mb-4 divide-y divide-borde">
            {tipo.etapas.map((e, i) => (
              <li key={e.id} className="py-2.5">
                <form action={renombrarEtapa} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={e.id} />
                  <span className="w-5 text-xs font-semibold text-tenue">{i + 1}</span>
                  <input
                    name="nombre"
                    defaultValue={e.nombre}
                    aria-label={`Nombre de la etapa ${i + 1}`}
                    className="min-w-40 flex-1 rounded-md border border-borde px-2 py-1 text-sm"
                  />
                  <Boton type="submit" estilo="suave" className="px-2 py-1 text-xs">Guardar</Boton>
                </form>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
                  {e.esPresentacion ? (
                    <Insignia tono="marca">Presentación ante autoridad</Insignia>
                  ) : (
                    <form action={marcarPresentacion}>
                      <input type="hidden" name="id" value={e.id} />
                      <button className="rounded px-2 py-0.5 text-xs text-suave underline-offset-2 hover:text-marca hover:underline">
                        marcar como presentación
                      </button>
                    </form>
                  )}
                  {e._count.casosEnEstaEtapa > 0 && (
                    <Insignia tono="info">{e._count.casosEnEstaEtapa} casos aquí</Insignia>
                  )}

                  <span className="flex-1" />

                  {i > 0 && (
                    <form action={moverEtapa}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="direccion" value="arriba" />
                      <button aria-label={`Subir ${e.nombre}`} className="rounded border border-borde px-2 py-0.5 text-xs hover:bg-lienzo">↑</button>
                    </form>
                  )}
                  {i < tipo.etapas.length - 1 && (
                    <form action={moverEtapa}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="direccion" value="abajo" />
                      <button aria-label={`Bajar ${e.nombre}`} className="rounded border border-borde px-2 py-0.5 text-xs hover:bg-lienzo">↓</button>
                    </form>
                  )}
                  {e._count.casosEnEstaEtapa === 0 && (
                    <form action={borrarEtapa}>
                      <input type="hidden" name="id" value={e.id} />
                      <button className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50">
                        Borrar
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <form action={agregarEtapa} className="flex flex-wrap items-end gap-2 border-t border-borde pt-4">
            <input type="hidden" name="tipoTramiteId" value={tipo.id} />
            <input name="nombre" required placeholder="Nueva etapa" className={`${claseInput} min-w-40 flex-1`} />
            <Boton type="submit" className="px-3 py-2 text-sm">Agregar etapa</Boton>
          </form>
        </Tarjeta>

        {/* ── Documentos ── */}
        <Tarjeta className="p-5">
          <h2 className="text-sm font-bold text-tinta">Documentos requeridos</h2>
          <p className="mb-4 text-xs text-tenue">
            El checklist que se genera en cada expediente nuevo. Marca "con vigencia" en los que
            caducan (pasaporte, visa): así el sistema pide la fecha y puede avisar antes.
          </p>

          <ul className="mb-4 divide-y divide-borde">
            {tipo.documentos.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <form action={editarDocumento} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={d.id} />
                  <input
                    name="nombre"
                    defaultValue={d.nombre}
                    aria-label={`Nombre del documento ${d.nombre}`}
                    className="min-w-40 flex-1 rounded-md border border-borde px-2 py-1 text-sm"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-suave">
                    <input type="checkbox" name="requiereVigencia" defaultChecked={d.requiereVigencia} />
                    con vigencia
                  </label>
                  <Boton type="submit" estilo="suave" className="px-2 py-1 text-xs">Guardar</Boton>
                </form>
                <form action={borrarDocumento}>
                  <input type="hidden" name="id" value={d.id} />
                  <button className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50">
                    Borrar
                  </button>
                </form>
              </li>
            ))}
          </ul>

          <form action={agregarDocumento} className="flex flex-wrap items-end gap-2 border-t border-borde pt-4">
            <input type="hidden" name="tipoTramiteId" value={tipo.id} />
            <input name="nombre" required placeholder="Nuevo documento" className={`${claseInput} min-w-40 flex-1`} />
            <label className="flex items-center gap-1.5 pb-2 text-xs text-suave">
              <input type="checkbox" name="requiereVigencia" />
              con vigencia
            </label>
            <Boton type="submit" className="px-3 py-2 text-sm">Agregar</Boton>
          </form>

          <p className="mt-3 text-xs text-tenue">
            Quitar un documento de aquí no lo borra de los expedientes ya abiertos: esos conservan su
            copia y su archivo. Solo cambia lo que se pedirá en los casos nuevos.
          </p>
        </Tarjeta>
      </div>
    </>
  );
}
