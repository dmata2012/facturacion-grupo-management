import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

/**
 * Fotografía del cliente, servida desde la base de datos.
 *
 * Vive ahí y no en disco porque el disco de la aplicación se borra en cada
 * despliegue: las fotos desaparecían sin que nadie se enterara hasta abrir
 * una ficha. Comprimidas pesan unos 100 KB, así que la base las lleva bien y
 * además entran en los respaldos.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sesion = await auth();
  if (!sesion?.user?.id) return new NextResponse('No autorizado', { status: 401 });

  const { id } = await params;
  const foto = await prisma.fotoCliente.findUnique({ where: { clienteId: id } });
  if (!foto) return new NextResponse('Sin fotografía', { status: 404 });

  return new NextResponse(new Uint8Array(foto.datos), {
    headers: {
      'Content-Type': foto.tipo,
      // Privada: es la foto de un expediente migratorio, no debe quedar en
      // cachés compartidas. El navegador sí puede reusarla un rato.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
