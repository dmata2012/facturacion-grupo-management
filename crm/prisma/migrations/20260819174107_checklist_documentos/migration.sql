-- El expediente deja de guardar archivos: ahora se confirma la entrega de
-- cada documento. Los campos se RENOMBRAN en vez de recrearse, para no perder
-- quién confirmó cada documento ni cuándo.

ALTER TABLE "Documento" RENAME COLUMN "subidoPorId" TO "confirmadoPorId";
ALTER TABLE "Documento" RENAME COLUMN "fechaSubida" TO "fechaEntrega";
ALTER TABLE "Documento" RENAME CONSTRAINT "Documento_subidoPorId_fkey" TO "Documento_confirmadoPorId_fkey";

-- Nota por renglón: dónde quedó el original, si viene incompleto, etc.
ALTER TABLE "Documento" ADD COLUMN "observacion" TEXT;

-- Las columnas archivoUrl y archivoNombre se conservan a propósito: guardan
-- las referencias de los documentos ya cargados. Ninguna pantalla las usa.
