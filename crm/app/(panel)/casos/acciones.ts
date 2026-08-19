'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Modalidad } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroCasos } from '@/lib/permisos';
import { guardarArchivo } from '@/lib/archivos';
import { aplicarPlantillaComision, moverEtapaCaso } from '@/lib/negocio';

async function casoPropio(casoId: string, accion: 'ver' | 'editar' = 'editar') {
  const sesion = await exigir('casos', accion);
  const caso = await prisma.caso.findFirst({ where: { AND: [{ id: casoId }, filtroCasos(sesion)] } });
  if (!caso) redirect('/sin-permiso');
  return { sesion, caso };
}

export async function cambiarEtapaCaso(datos: FormData) {
  const casoId = String(datos.get('casoId'));
  const etapaId = String(datos.get('etapaId'));
  const { sesion } = await casoPropio(casoId);

  await moverEtapaCaso(casoId, etapaId, sesion);
  revalidatePath('/casos');
  revalidatePath(`/casos/${casoId}`);
}

export async function guardarDatosCaso(datos: FormData) {
  const casoId = String(datos.get('casoId'));
  const { sesion, caso } = await casoPropio(casoId);

  const abogadoId = String(datos.get('abogadoId') ?? '') || null;
  const fechaResolucion = String(datos.get('fechaTentativaResolucion') ?? '');

  await prisma.caso.update({
    where: { id: casoId },
    data: {
      // La dependencia es independiente del domicilio del cliente: se captura
      // a mano y el sistema nunca la deduce de la ubicación.
      dependencia: String(datos.get('dependencia') ?? '').trim() || null,
      oficina: String(datos.get('oficina') ?? '').trim() || null,
      modalidad: (String(datos.get('modalidad') ?? '') as Modalidad) || null,
      abogadoId,
      fechaTentativaResolucion: fechaResolucion ? new Date(fechaResolucion) : null,
    },
  });

  // Si el abogado se asigna después del cierre, su comisión se genera ahora
  // con la misma plantilla que se usó en la venta.
  if (abogadoId && abogadoId !== caso.abogadoId) {
    const venta = await prisma.venta.findUniqueOrThrow({ where: { id: caso.ventaId } });
    const previa = await prisma.comision.findFirst({ where: { ventaId: venta.id } });
    await prisma.$transaction((tx) =>
      aplicarPlantillaComision(tx, venta, previa?.plantillaOrigenId ?? null, sesion)
    );
  }

  revalidatePath(`/casos/${casoId}`);
}

export async function subirDocumento(datos: FormData) {
  const documentoId = String(datos.get('documentoId'));
  const documento = await prisma.documento.findUniqueOrThrow({ where: { id: documentoId } });
  const { sesion } = await casoPropio(documento.casoId);

  const archivo = datos.get('archivo');
  if (!(archivo instanceof File) || archivo.size === 0) {
    redirect(`/casos/${documento.casoId}?error=archivo`);
  }

  const guardado = await guardarArchivo(archivo);
  if (!guardado) redirect(`/casos/${documento.casoId}?error=archivo`);

  const vigencia = String(datos.get('fechaVigencia') ?? '');
  await prisma.documento.update({
    where: { id: documentoId },
    data: {
      archivoUrl: `/api/archivos/${guardado.nombreAlmacenado}`,
      archivoNombre: guardado.nombreOriginal,
      subidoPorId: sesion.id,
      fechaSubida: new Date(),
      estatus: 'ENTREGADO',
      fechaVigencia: vigencia ? new Date(vigencia) : undefined,
    },
  });

  const caso = await prisma.caso.findUniqueOrThrow({
    where: { id: documento.casoId },
    include: { venta: true },
  });
  revalidatePath(`/casos/${documento.casoId}`);
  revalidatePath(`/clientes/${caso.venta.clienteId}`);
}
