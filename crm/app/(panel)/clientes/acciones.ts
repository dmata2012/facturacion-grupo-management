'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { MedioContacto } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { exigir } from '@/lib/sesion';
import { filtroClientes } from '@/lib/permisos';
import { comprimirFotografia } from '@/lib/archivos';
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

  let fotoComprimida: Uint8Array<ArrayBuffer> | null = null;
  const foto = datos.get('foto');
  if (foto instanceof File && foto.size > 0) {
    try {
      fotoComprimida = await comprimirFotografia(foto);
    } catch {
      redirect('/clientes/nuevo?error=foto');
    }
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
      foto: fotoComprimida ? { create: { datos: fotoComprimida } } : undefined,
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

  // La URL apunta a la ruta que sirve la foto desde la base.
  if (fotoComprimida) {
    await prisma.cliente.update({
      where: { id: cliente.id },
      data: { fotoUrl: `/api/clientes/${cliente.id}/foto` },
    });
  }

  revalidatePath('/clientes');
  revalidatePath('/pipeline');
  redirect(`/clientes/${cliente.id}`);
}

/**
 * Editar los datos del cliente. El permiso se comprueba dos veces: que el rol
 * pueda editar clientes, y que ESE cliente esté dentro de lo que ese usuario
 * tiene permitido ver — un vendedor no debe poder editar la ficha de un
 * cliente de otro vendedor escribiendo su dirección a mano.
 */
export async function actualizarCliente(datos: FormData) {
  const sesion = await exigir('clientes', 'editar');
  const id = String(datos.get('id'));

  const permitido = await prisma.cliente.findFirst({
    where: { AND: [{ id }, filtroClientes(sesion)] },
  });
  if (!permitido) redirect('/sin-permiso');

  const nombre = texto(datos, 'nombre');
  const nacionalidad = texto(datos, 'nacionalidad');
  const estado = texto(datos, 'estado');
  const ciudad = texto(datos, 'ciudad');
  if (!nombre || !nacionalidad || !estado || !ciudad) {
    redirect(`/clientes/${id}/editar?error=faltan`);
  }

  // La fotografía solo se toca si suben una nueva: dejar el campo vacío
  // significa "conserva la que ya tenía", no "bórrala".
  let fotoUrl = permitido.fotoUrl;
  const foto = datos.get('foto');
  if (foto instanceof File && foto.size > 0) {
    try {
      const comprimida = await comprimirFotografia(foto);
      if (comprimida) {
        // La foto nueva reemplaza a la anterior en el mismo renglón: no queda
        // ninguna copia suelta ocupando espacio.
        await prisma.fotoCliente.upsert({
          where: { clienteId: id },
          update: { datos: comprimida, tipo: 'image/jpeg' },
          create: { clienteId: id, datos: comprimida },
        });
        fotoUrl = `/api/clientes/${id}/foto`;
      }
    } catch {
      redirect(`/clientes/${id}/editar?error=foto`);
    }
  }
  if (datos.get('quitarFoto') === 'on') {
    await prisma.fotoCliente.deleteMany({ where: { clienteId: id } });
    fotoUrl = null;
  }

  await prisma.cliente.update({
    where: { id },
    data: {
      nombre,
      nacionalidad,
      // La ubicación del cliente no tiene relación con la dependencia donde se
      // presenta su trámite: se editan por separado y ninguna toca a la otra.
      estado,
      ciudad,
      correo: texto(datos, 'correo') || null,
      telefono: texto(datos, 'telefono') || null,
      origenProspectoId: texto(datos, 'origenProspectoId') || null,
      observacionesGenerales: texto(datos, 'observaciones') || null,
      fotoUrl,
    },
  });

  await prisma.auditoria.create({
    data: { entidad: 'Cliente', entidadId: id, accion: 'datos_editados', usuarioId: sesion.id },
  });

  revalidatePath(`/clientes/${id}`);
  revalidatePath('/clientes');
  redirect(`/clientes/${id}`);
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
