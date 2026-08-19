import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Almacenamiento de archivos para el MVP: disco local, en una carpeta FUERA
 * de public/. Son documentos migratorios (pasaportes, actas): si vivieran en
 * public/ quedarían accesibles por URL para cualquiera que la adivinara.
 * Se sirven por /api/archivos, que sí revisa la sesión.
 *
 * Al pasar a producción esto se cambia por almacenamiento tipo S3; la única
 * pieza a reemplazar es este archivo.
 */
/**
 * En Render (y en cualquier contenedor) el disco de la aplicación se borra en
 * cada despliegue. Por eso la ruta es configurable: en producción debe apuntar
 * a un disco persistente montado, por ejemplo RUTA_ARCHIVOS=/var/data/archivos.
 */
export const CARPETA_ARCHIVOS =
  process.env.RUTA_ARCHIVOS ?? path.join(process.cwd(), 'archivos');

const TIPOS_PERMITIDOS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

const TAMANO_MAXIMO = 10 * 1024 * 1024; // 10 MB

export type ArchivoGuardado = { nombreAlmacenado: string; nombreOriginal: string };

export async function guardarArchivo(archivo: File): Promise<ArchivoGuardado | null> {
  if (!archivo || archivo.size === 0) return null;
  if (archivo.size > TAMANO_MAXIMO) throw new Error('El archivo excede 10 MB.');
  if (!TIPOS_PERMITIDOS.has(archivo.type)) {
    throw new Error('Formato no permitido. Se aceptan PDF, JPG, PNG, WEBP y HEIC.');
  }

  await mkdir(CARPETA_ARCHIVOS, { recursive: true });

  // El nombre en disco lo pone el sistema: el que trae el archivo del usuario
  // podría contener rutas ("../") o repetirse entre clientes.
  const extension = path.extname(archivo.name).slice(0, 10).replace(/[^.\w]/g, '');
  const nombreAlmacenado = `${randomUUID()}${extension}`;

  await writeFile(
    path.join(CARPETA_ARCHIVOS, nombreAlmacenado),
    Buffer.from(await archivo.arrayBuffer())
  );

  return { nombreAlmacenado, nombreOriginal: archivo.name };
}
