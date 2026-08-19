import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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

// ── Fotografías de clientes ───────────────────────────────────────

const TIPOS_IMAGEN = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
]);

/** Lado máximo de la fotografía guardada. De sobra para una ficha. */
const LADO_FOTO = 800;

/**
 * Guarda la fotografía de un cliente reducida y comprimida: una foto de
 * celular de 4 MB queda en unos 80 KB, sin que nadie tenga que encogerla a
 * mano antes de subirla.
 *
 * Esto vale SOLO para la foto del cliente. Los documentos del expediente
 * (pasaportes, actas, resoluciones) se guardan intactos con guardarArchivo:
 * son evidencia y deben conservarse tal como se recibieron.
 */
export async function guardarFotografia(archivo: File): Promise<ArchivoGuardado | null> {
  if (!archivo || archivo.size === 0) return null;
  if (archivo.size > TAMANO_MAXIMO) throw new Error('La imagen excede 10 MB.');
  if (!TIPOS_IMAGEN.has(archivo.type)) {
    throw new Error('La fotografía debe ser una imagen: JPG, PNG, WEBP o HEIC.');
  }

  await mkdir(CARPETA_ARCHIVOS, { recursive: true });
  const nombreAlmacenado = `${randomUUID()}.jpg`;

  const optimizada = await sharp(Buffer.from(await archivo.arrayBuffer()))
    // Las fotos de celular traen la orientación en los metadatos; sin esto se
    // verían acostadas.
    .rotate()
    .resize({ width: LADO_FOTO, height: LADO_FOTO, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  await writeFile(path.join(CARPETA_ARCHIVOS, nombreAlmacenado), optimizada);
  return { nombreAlmacenado, nombreOriginal: archivo.name };
}

/**
 * Borra un archivo del almacenamiento. Quien llama debe haber comprobado antes
 * que ningún registro lo siga usando.
 */
export async function borrarArchivo(url: string | null | undefined): Promise<void> {
  if (!url) return;
  // basename corta cualquier intento de salir de la carpeta con "../".
  const nombre = path.basename(url);
  if (!nombre || nombre === '.' || nombre === '..') return;
  // Si el archivo ya no está, no hay nada que reportar.
  await unlink(path.join(CARPETA_ARCHIVOS, nombre)).catch(() => {});
}
