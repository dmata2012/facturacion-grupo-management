import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { Boton, BotonEnlace, Campo, Tarjeta, TituloSeccion, claseInput } from '@/componentes/ui';
import { cerrarPerdida } from '../../acciones';

export const metadata = { title: 'Cerrar como perdida — CRM' };

export default async function Perder({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const sesion = await exigir('ventas', 'editar');

  const [venta, motivos] = await Promise.all([
    prisma.venta.findFirst({
      where: { AND: [{ id }, filtroVentas(sesion)] },
      include: { cliente: true },
    }),
    prisma.motivoPerdida.findMany({ where: { activo: true }, orderBy: { nombre: 'asc' } }),
  ]);
  if (!venta) notFound();

  return (
    <>
      <TituloSeccion accion={<BotonEnlace href="/pipeline" estilo="suave">Cancelar</BotonEnlace>}>
        Cerrar como perdida
      </TituloSeccion>

      <Tarjeta className="max-w-lg p-6">
        <p className="mb-5 text-sm text-suave">
          Vas a cerrar el caso de <strong>{venta.cliente.nombre}</strong>. El motivo es obligatorio:
          de ahí sale el reporte de por qué se pierden los prospectos.
        </p>

        {error === 'motivo' && (
          <p className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
            Hay que seleccionar el motivo de pérdida.
          </p>
        )}

        <form action={cerrarPerdida} className="space-y-5">
          <input type="hidden" name="ventaId" value={venta.id} />
          <Campo etiqueta="Motivo de pérdida" requerido>
            <select name="motivoPerdidaId" required className={claseInput} defaultValue="">
              <option value="" disabled>
                Selecciona un motivo
              </option>
              {motivos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}
                </option>
              ))}
            </select>
          </Campo>
          <Boton type="submit" estilo="peligro">
            Cerrar como perdida
          </Boton>
        </form>
      </Tarjeta>
    </>
  );
}
