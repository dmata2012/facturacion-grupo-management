import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { filtroVentas } from '@/lib/permisos';
import { generarPdfPresupuesto } from '@/lib/presupuesto-pdf';

/** Descarga del presupuesto en PDF, generado al vuelo desde la base. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sesion = await auth();
  if (!sesion?.user?.id) return new Response('No autorizado', { status: 401 });

  const { id } = await params;
  const presupuesto = await prisma.presupuesto.findFirst({
    where: {
      AND: [{ id }, { venta: filtroVentas({ id: sesion.user.id, rol: sesion.user.rol }) }],
    },
    include: {
      conceptos: { orderBy: { orden: 'asc' } },
      pagos: { orderBy: { numero: 'asc' } },
      creadoPor: true,
      venta: { include: { cliente: true, tipoTramite: true, vendedor: true } },
    },
  });
  if (!presupuesto) return new Response('No encontrado', { status: 404 });

  const pdf = await generarPdfPresupuesto(presupuesto);

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="presupuesto-${presupuesto.folio}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
