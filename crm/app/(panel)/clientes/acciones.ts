'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { MedioContacto } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { guardarArchivo } from '@/lib/archivos';
import { registrarInteraccion } from '@/lib/negocio';

function texto(datos: FormData, campo: string): string {
  return String(datos.get(campo) ?? '').trim();
}

/** Captura inicial: crea el cliente y su contacto inicial (lead) de una vez. */
export async function crearCliente(datos: FormData) {
  const sesion = await exigir('clientes', 'crear');

  const nombre = texto(datos, 'nombre');
  const nacionalidad = texto(datos, 'nacionalidad');
  const estado = texto(datos, 'estado');
  const ciudad = texto(datos, 'ciudad');
  if (!nombre || !nacionalidad || !estado || !ciudad) {
    redirect('/clientes/nuevo?error=faltan');
  }

  // Un vendedor solo puede capturar prospectos a su nombre.
  const vendedorId = sesion.rol === 'VENDEDOR' ? sesion.id : texto(datos, 'vendedorId');
  if (!vendedorId) redirect('/clientes/nuevo?error=vendedor');

  let fotoUrl: string | null = null;
  const foto = datos.get('foto');
  if (foto instanceof File && foto.size > 0) {
    const guardado = await guardarArchivo(foto);
    fotoUrl = guardado ? `/api/archivos/${guardado.nombreAlmacenado}` : null;
  }

  const cliente = await prisma.cliente.create({
    data: {
      nombre,
      nacionalidad,
      estado,
      ciudad,
      correo: texto(datos, 'correo') || null,
      telefono: texto(datos, 'telefono') || null,
      origenProspectoId: texto(datos, 'origenProspectoId') || null,
      observacionesGenerales: texto(datos, 'observaciones') || null,
      fotoUrl,
      leads: {
        create: {
          vendedorId,
          tipoTramiteId: texto(datos, 'tipoTramiteId'),
          medioContacto: texto(datos, 'medioContacto') as MedioContacto,
          fechaPrimerContacto: new Date(texto(datos, 'fechaPrimerContacto')),
        },
      },
    },
  });

  revalidatePath('/clientes');
  revalidatePath('/pipeline');
  redirect(`/clientes/${cliente.id}`);
}

export async function guardarObservaciones(datos: FormData) {
  await exigir('clientes', 'editar');
  const clienteId = String(datos.get('clienteId'));
  await prisma.cliente.update({
    where: { id: clienteId },
    data: { observacionesGenerales: texto(datos, 'observaciones') || null },
  });
  revalidatePath(`/clientes/${clienteId}`);
}

/** Registra la interacción y, si se pactó, el próximo seguimiento y su cita. */
export async function nuevaInteraccion(datos: FormData) {
  const sesion = await exigir('notas', 'crear');
  const clienteId = String(datos.get('clienteId'));
  const resultado = texto(datos, 'resultado');
  if (!resultado) redirect(`/clientes/${clienteId}?pestana=notas&error=vacio`);

  const fechaSeguimiento = texto(datos, 'fechaSeguimiento');
  await registrarInteraccion(
    clienteId,
    {
      medio: texto(datos, 'medio') as MedioContacto,
      resultado,
      seguimiento: fechaSeguimiento
        ? {
            fecha: new Date(fechaSeguimiento),
            motivo: texto(datos, 'motivoSeguimiento') || 'Seguimiento pactado con el cliente',
            responsableId: sesion.id,
          }
        : null,
    },
    sesion
  );

  revalidatePath(`/clientes/${clienteId}`);
  revalidatePath('/agenda');
}
