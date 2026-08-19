import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { ESTADOS_MEXICO } from '@/lib/mexico';
import { paraInput } from '@/lib/formato';
import { Boton, BotonEnlace, Campo, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { crearCliente } from '../acciones';

export const metadata = { title: 'Nuevo cliente — CRM' };

export default async function NuevoCliente({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const sesion = await exigir('clientes', 'crear');

  const [origenes, tramites, vendedores] = await Promise.all([
    prisma.origenProspecto.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
    prisma.tipoTramite.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
    prisma.usuario.findMany({ where: { rol: 'VENDEDOR', activo: true }, orderBy: { nombre: 'asc' } }),
  ]);

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/pipeline" estilo="suave">Cancelar</BotonEnlace>}>
        Nuevo cliente
      </TituloSeccion>

      <Tarjeta className="max-w-4xl p-6">
        <p className="mb-6 text-sm text-suave">
          Esta captura crea el <strong>contacto inicial</strong>. Todavía no es un prospecto: lo será
          cuando registres la entrevista de valoración y resulte viable.
        </p>

        {error && (
          <p className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error === 'vendedor' && 'Selecciona el vendedor asignado.'}
            {error === 'foto' &&
              'No se pudo guardar la fotografía. Debe ser una imagen (JPG, PNG o HEIC) de menos de 10 MB.'}
            {error === 'faltan' &&
              'Faltan datos obligatorios: nombre, nacionalidad, estado y ciudad.'}
          </p>
        )}

        <form action={crearCliente} className="space-y-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <Campo etiqueta="Nombre completo" requerido>
              <input name="nombre" required className={claseInput} />
            </Campo>
            <Campo etiqueta="Nacionalidad" requerido>
              <input name="nacionalidad" required className={claseInput} placeholder="Venezolana" />
            </Campo>

            <Campo etiqueta="Estado (México)" requerido ayuda="Dónde vive el cliente.">
              <select name="estado" required className={claseInput} defaultValue="">
                <option value="" disabled>
                  Selecciona el estado
                </option>
                {ESTADOS_MEXICO.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </Campo>
            <Campo etiqueta="Ciudad" requerido>
              <input name="ciudad" required className={claseInput} />
            </Campo>

            <Campo etiqueta="Correo electrónico">
              <input name="correo" type="email" className={claseInput} />
            </Campo>
            <Campo etiqueta="Teléfono / WhatsApp">
              <input name="telefono" type="tel" className={claseInput} />
            </Campo>

            <Campo etiqueta="Origen del prospecto">
              <select name="origenProspectoId" className={claseInput} defaultValue="">
                <option value="">Sin especificar</option>
                {origenes.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nombre}
                  </option>
                ))}
              </select>
            </Campo>

            {sesion.rol === 'VENDEDOR' ? (
              <Campo etiqueta="Vendedor asignado">
                <input disabled value={sesion.nombre} className={`${claseInput} bg-lienzo`} />
              </Campo>
            ) : (
              <Campo etiqueta="Vendedor asignado" requerido>
                <select name="vendedorId" required className={claseInput} defaultValue="">
                  <option value="" disabled>
                    Selecciona el vendedor
                  </option>
                  {vendedores.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nombre}
                    </option>
                  ))}
                </select>
              </Campo>
            )}

            <Campo etiqueta="Tipo de trámite que requiere" requerido>
              <select name="tipoTramiteId" required className={claseInput} defaultValue="">
                <option value="" disabled>
                  Selecciona el trámite
                </option>
                {tramites.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </select>
            </Campo>

            <Campo etiqueta="Fecha de primer contacto" requerido>
              <input
                name="fechaPrimerContacto"
                type="date"
                required
                defaultValue={paraInput(new Date())}
                className={claseInput}
              />
            </Campo>

            <Campo etiqueta="Medio de contacto" requerido>
              <select name="medioContacto" required className={claseInput} defaultValue="LLAMADA">
                <option value="LLAMADA">Llamada</option>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="CORREO">Correo</option>
                <option value="PRESENCIAL">Presencial</option>
              </select>
            </Campo>

            <Campo etiqueta="Fotografía del cliente" ayuda="Opcional. JPG, PNG o HEIC. El sistema la reduce y comprime al guardarla.">
              <input
                name="foto"
                type="file"
                accept="image/*"
                className="w-full text-sm text-suave file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold"
              />
            </Campo>
          </div>

          <Campo
            etiqueta="Observaciones generales"
            ayuda="Nota fija visible siempre en la ficha, ej. «prefiere que le llamen por las tardes»."
          >
            <textarea name="observaciones" rows={3} className={claseInput} />
          </Campo>

          <Boton type="submit">Guardar contacto inicial</Boton>
        </form>
      </Tarjeta>
    </>
  );
}
