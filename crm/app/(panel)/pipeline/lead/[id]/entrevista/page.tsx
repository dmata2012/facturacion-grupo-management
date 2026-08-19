import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { fecha } from '@/lib/formato';
import { Boton, BotonEnlace, Campo, Dato, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { guardarEntrevista } from '../../../acciones';

export const metadata = { title: 'Entrevista de valoración — CRM' };

export default async function Entrevista({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sesion = await exigir('ventas', 'editar');

  const lead = await prisma.lead.findFirst({
    where: { id, ...(sesion.rol === 'VENDEDOR' ? { vendedorId: sesion.id } : {}) },
    include: { cliente: true, tipoTramite: true, vendedor: true },
  });
  if (!lead) notFound();

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/pipeline" estilo="suave">Volver</BotonEnlace>}>
        Entrevista de valoración
      </TituloSeccion>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Tarjeta className="p-6">
          <p className="mb-5 text-sm text-suave">
            Un contacto inicial se vuelve <strong>prospecto calificado</strong> solo si esta
            entrevista resulta viable. Si no es viable, el contacto se archiva y no se cuenta como
            prospecto perdido.
          </p>

          <form action={guardarEntrevista} className="space-y-5">
            <input type="hidden" name="leadId" value={lead.id} />

            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-tinta">
                Resultado <span className="text-marca">*</span>
              </legend>
              <div className="space-y-2">
                {[
                  { v: 'VIABLE', t: 'Viable', d: 'Pasa a prospecto calificado y entra al pipeline.' },
                  { v: 'REQUIERE_INFO', t: 'Requiere más información', d: 'Se queda en valoración.' },
                  { v: 'NO_VIABLE', t: 'No viable', d: 'Se archiva el contacto.' },
                ].map((o) => (
                  <label
                    key={o.v}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-borde p-3 hover:bg-lienzo"
                  >
                    <input type="radio" name="resultado" value={o.v} required className="mt-1" />
                    <span>
                      <span className="block text-sm font-semibold text-tinta">{o.t}</span>
                      <span className="block text-xs text-tenue">{o.d}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Campo
              etiqueta="Valor estimado del caso"
              ayuda="Solo si resultó viable. Se puede ajustar después, al cerrar la venta."
            >
              <input name="montoEstimado" type="number" min="0" step="100" className={claseInput} />
            </Campo>

            <Campo etiqueta="Notas de la entrevista">
              <textarea name="notas" rows={5} className={claseInput} />
            </Campo>

            <Boton type="submit">Guardar entrevista</Boton>
          </form>
        </Tarjeta>

        <Tarjeta className="h-fit p-6">
          <h2 className="mb-4 text-sm font-bold text-tinta">Contacto</h2>
          <dl className="space-y-3">
            <Dato etiqueta="Cliente" valor={lead.cliente.nombre} />
            <Dato etiqueta="Nacionalidad" valor={lead.cliente.nacionalidad} />
            <Dato
              etiqueta="Ubicación"
              valor={`${lead.cliente.ciudad}, ${lead.cliente.estado}`}
            />
            <Dato etiqueta="Trámite de interés" valor={lead.tipoTramite.nombre} />
            <Dato etiqueta="Vendedor" valor={lead.vendedor.nombre} />
            <Dato etiqueta="Primer contacto" valor={fecha(lead.fechaPrimerContacto)} />
            <Dato etiqueta="Teléfono" valor={lead.cliente.telefono} />
            <Dato etiqueta="Correo" valor={lead.cliente.correo} />
          </dl>
        </Tarjeta>
      </div>
    </>
  );
}
