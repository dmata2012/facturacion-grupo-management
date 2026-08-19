import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { Aviso, Boton, BotonEnlace, Insignia, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { alternarTipoTramite, borrarTipoTramite, crearTipoTramite } from '../acciones';

export const metadata = { title: 'Tipos de trámite — CRM' };

const ERRORES: Record<string, string> = {
  nombre: 'Escribe un nombre para el tipo de trámite.',
  duplicado: 'Ya existe un tipo de trámite con ese nombre.',
  'en-uso': 'Ese trámite ya tiene prospectos o expedientes, así que no se borra. Desactívalo: deja de ofrecerse en las capturas nuevas y el historial se conserva.',
};

export default async function Tramites({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  await exigir('configuracion');

  const tramites = await prisma.tipoTramite.findMany({
    include: {
      etapas: true,
      documentos: true,
      _count: { select: { leads: true, ventas: true, casos: true } },
    },
    orderBy: { nombre: 'asc' },
  });

  return (
    <>
      <TituloSeccion
        accion={<BotonEnlace href="/configuracion" estilo="suave">Volver a configuración</BotonEnlace>}
      >
        Tipos de trámite
      </TituloSeccion>

      <p className="mb-5 max-w-3xl text-sm text-suave">
        Cada tipo de trámite define las etapas por las que pasa el expediente y los documentos que se
        le piden al cliente. Al cerrar una venta, el caso nuevo copia de aquí su checklist. Cambiar
        una plantilla no altera los expedientes ya abiertos.
      </p>

      {error && <Aviso>{ERRORES[error] ?? 'No se pudo completar la operación.'}</Aviso>}

      <Tarjeta className="mb-6 p-5">
        <form action={crearTipoTramite} className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1">
            <span className="mb-1.5 block text-sm font-semibold">Nuevo tipo de trámite</span>
            <input name="nombre" required className={claseInput} placeholder="Visa de estudiante" />
          </label>
          <Boton type="submit">Agregar</Boton>
        </form>
        <p className="mt-2 text-xs text-tenue">
          El nuevo trámite nace con las mismas etapas que los existentes, para que puedas ajustarlas
          en vez de escribirlas desde cero.
        </p>
      </Tarjeta>

      <div className="grid gap-4 md:grid-cols-2">
        {tramites.map((t) => {
          const enUso = t._count.leads + t._count.ventas + t._count.casos;
          return (
            <Tarjeta key={t.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link
                    href={`/configuracion/tramites/${t.id}`}
                    className="text-base font-bold text-tinta hover:text-marca"
                  >
                    {t.nombre}
                  </Link>
                  <p className="mt-0.5 text-xs text-tenue">
                    {t.etapas.length} etapas · {t.documentos.length} documentos
                    {enUso > 0 && ` · ${enUso} registros lo usan`}
                  </p>
                </div>
                <Insignia tono={t.activo ? 'exito' : 'neutro'}>
                  {t.activo ? 'Activo' : 'Inactivo'}
                </Insignia>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <BotonEnlace href={`/configuracion/tramites/${t.id}`} estilo="suave" className="px-3 py-1.5 text-xs">
                  Editar plantilla
                </BotonEnlace>
                <form action={alternarTipoTramite}>
                  <input type="hidden" name="id" value={t.id} />
                  <Boton type="submit" estilo="suave" className="px-3 py-1.5 text-xs">
                    {t.activo ? 'Desactivar' : 'Activar'}
                  </Boton>
                </form>
                {enUso === 0 && (
                  <form action={borrarTipoTramite}>
                    <input type="hidden" name="id" value={t.id} />
                    <Boton type="submit" estilo="peligro" className="px-3 py-1.5 text-xs">
                      Borrar
                    </Boton>
                  </form>
                )}
              </div>
            </Tarjeta>
          );
        })}
      </div>
    </>
  );
}
