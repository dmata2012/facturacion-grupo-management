import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroVentas } from '@/lib/permisos';
import { Aviso, BotonEnlace, TituloSeccion } from '@/componentes/ui';
import { FormularioPresupuesto } from '@/componentes/formulario-presupuesto';
import { nuevoPresupuesto } from '../acciones';

export const metadata = { title: 'Nuevo presupuesto — CRM' };

const ERRORES: Record<string, string> = {
  conceptos: 'Captura al menos un concepto con su importe.',
  pagos: 'Captura al menos un pago con fecha e importe.',
  descuadre:
    'Los pagos no suman el total de los conceptos. Si no cuadran, el cliente aprobaría una cifra y se le cobraría otra.',
};

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
        Nuevo presupuesto
      </TituloSeccion>

      {error && <Aviso>{ERRORES[error] ?? 'Revisa los datos capturados.'}</Aviso>}

      <FormularioPresupuesto
        ventaId={venta.id}
        accion={nuevoPresupuesto}
        tramite={venta.tipoTramite.nombre}
        vendedor={venta.vendedor.nombre}
        cliente={{
          nombre: venta.cliente.nombre,
          nacionalidad: venta.cliente.nacionalidad,
          ciudad: venta.cliente.ciudad,
          estado: venta.cliente.estado,
          fotoUrl: venta.cliente.fotoUrl,
        }}
      />
    </>
  );
}
