
-- CreateTable
CREATE TABLE "FotoCliente" (
    "clienteId" TEXT NOT NULL,
    "datos" BYTEA NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'image/jpeg',
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FotoCliente_pkey" PRIMARY KEY ("clienteId")
);

-- AddForeignKey
ALTER TABLE "FotoCliente" ADD CONSTRAINT "FotoCliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Las fotos anteriores apuntaban a archivos del disco efímero, que ya no
-- existen: sus URLs solo producirían imágenes rotas. Se limpian para que la
-- ficha muestre las iniciales hasta que se vuelva a subir la fotografía.
UPDATE "Cliente" SET "fotoUrl" = NULL WHERE "fotoUrl" IS NOT NULL;
