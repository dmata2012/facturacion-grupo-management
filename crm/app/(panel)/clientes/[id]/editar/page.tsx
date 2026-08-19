import Image from 'next/image';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroClientes } from '@/lib/permisos';
import { ESTADOS_MEXICO } from '@/lib/mexico';
import { Aviso, Boton, BotonEnlace, Campo, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { actualizarCliente } from '../../acciones';

export const metadata = { title: 'Editar cliente — CRM' };

const ERRORES: Record<string, string> = {
  faltan: 'Faltan datos obligatorios: nombre, nacionalidad, estado y ciudad.',
  foto: 'No se pudo guardar la fotografía. Debe ser JPG, PNG o PDF y pesar menos de 10 MB.',
};

export default async function EditarCliente({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const sesion = await exigir('clientes', 'editar');

  const [cliente, origenes] = await Promise.all([
    prisma.cliente.findFirst({ where: { AND: [{ id }, filtroClientes(sesion)] } }),
    prisma.origenProspecto.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
  ]);
  if (!cliente) notFound();

  return (
    <>
      <TituloSeccion
        etiqueta="Cartera"
        accion={<BotonEnlace href={`/clientes/${cliente.id}`} estilo="suave">Cancelar</BotonEnlace>}
      >
        Editar {cliente.nombre}
      </TituloSeccion>

      {error && <Aviso>{ERRORES[error] ?? 'No se pudo guardar.'}</Aviso>}

      <Tarjeta className="max-w-4xl p-6">
        <form action={actualizarCliente} className="space-y-6">
          <input type="hidden" name="id" value={cliente.id} />

          <div className="grid gap-5 sm:grid-cols-2">
            <Campo etiqueta="Nombre completo" requerido>
              <input name="nombre" defaultValue={cliente.nombre} required className={claseInput} />
            </Campo>
            <Campo etiqueta="Nacionalidad" requerido>
              <input
                name="nacionalidad"
                defaultValue={cliente.nacionalidad}
                required
                className={claseInput}
              />
            </Campo>

            <Campo etiqueta="Estado (México)" requerido ayuda="Dónde vive el cliente.">
              <select name="estado" required className={claseInput} defaultValue={cliente.estado}>
                {ESTADOS_MEXICO.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </Campo>
            <Campo etiqueta="Ciudad" requerido>
              <input name="ciudad" defaultValue={cliente.ciudad} required className={claseInput} />
            </Campo>

            <Campo etiqueta="Correo electrónico">
              <input
                name="correo"
                type="email"
                defaultValue={cliente.correo ?? ''}
                className={claseInput}
              />
            </Campo>
            <Campo etiqueta="Teléfono / WhatsApp">
              <input
                name="telefono"
                type="tel"
                defaultValue={cliente.telefono ?? ''}
                className={claseInput}
              />
            </Campo>

            <Campo etiqueta="Origen del prospecto">
              <select
                name="origenProspectoId"
                className={claseInput}
                defaultValue={cliente.origenProspectoId ?? ''}
              >
                <option value="">Sin especificar</option>
                {origenes.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </select>
            </Campo>
          </div>

          <Campo
            etiqueta="Observaciones generales"
            ayuda="Nota fija visible siempre en la ficha, ej. «prefiere que le llamen por las tardes»."
          >
            <textarea
              name="observaciones"
              rows={3}
              defaultValue={cliente.observacionesGenerales ?? ''}
              className={claseInput}
            />
          </Campo>

          <div className="border-t border-borde pt-5">
            <h2 className="mb-3 text-sm font-bold text-tinta">Fotografía</h2>
            <div className="flex flex-wrap items-start gap-5">
              {cliente.fotoUrl ? (
                <Image
                  src={cliente.fotoUrl}
                  alt={`Fotografía de ${cliente.nombre}`}
                  width={112}
                  height={112}
                  unoptimized
                  className="h-28 w-28 rounded-tarjeta border border-borde object-cover"
                />
              ) : (
                <div className="flex h-28 w-28 items-center justify-center rounded-tarjeta border border-dashed border-borde text-xs text-tenue">
                  Sin foto
                </div>
              )}

              <div className="min-w-56 flex-1 space-y-3">
                <Campo etiqueta="Reemplazar fotografía" ayuda="JPG, PNG o PDF, hasta 10 MB.">
                  <input
                    name="foto"
                    type="file"
                    accept="image/*,application/pdf"
                    className="w-full text-sm text-suave file:mr-3 file:rounded-sm file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold"
                  />
                </Campo>
                <p className="text-xs text-tenue">
                  Si dejas el campo vacío, se conserva la fotografía actual.
                </p>
                {cliente.fotoUrl && (
                  <label className="flex items-center gap-2 text-sm text-suave">
                    <input type="checkbox" name="quitarFoto" />
                    Quitar la fotografía actual
                  </label>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Boton type="submit">Guardar cambios</Boton>
            <BotonEnlace href={`/clientes/${cliente.id}`} estilo="suave">
              Cancelar
            </BotonEnlace>
          </div>
        </form>
      </Tarjeta>
    </>
  );
}
