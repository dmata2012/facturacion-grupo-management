-- El medio de pago pasa de texto libre a catálogo, para que la estadística
-- por forma de pago sea fiable. Lo ya capturado se conserva: se convierte en
-- entradas del catálogo y las cuotas quedan enlazadas a ellas.

CREATE TABLE "MetodoPago" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "MetodoPago_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MetodoPago_nombre_key" ON "MetodoPago"("nombre");

-- Formas de pago habituales de un despacho.
INSERT INTO "MetodoPago" ("id", "nombre", "orden") VALUES
  (gen_random_uuid()::text, 'Transferencia', 1),
  (gen_random_uuid()::text, 'Depósito bancario', 2),
  (gen_random_uuid()::text, 'Efectivo', 3),
  (gen_random_uuid()::text, 'Tarjeta de crédito o débito', 4),
  (gen_random_uuid()::text, 'Cheque', 5),
  (gen_random_uuid()::text, 'Otro', 6);

ALTER TABLE "Cuota" ADD COLUMN "metodoPagoId" TEXT;

-- Lo capturado a mano que no coincida con el catálogo se agrega tal cual:
-- perder cómo pagó un cliente para encajarlo en una lista sería peor.
INSERT INTO "MetodoPago" ("id", "nombre", "orden")
SELECT gen_random_uuid()::text, TRIM("metodoPago"), 99
FROM "Cuota"
WHERE "metodoPago" IS NOT NULL AND TRIM("metodoPago") <> ''
  AND LOWER(TRIM("metodoPago")) NOT IN (SELECT LOWER("nombre") FROM "MetodoPago")
GROUP BY TRIM("metodoPago");

UPDATE "Cuota" c
SET "metodoPagoId" = m."id"
FROM "MetodoPago" m
WHERE c."metodoPago" IS NOT NULL
  AND LOWER(TRIM(c."metodoPago")) = LOWER(m."nombre");

ALTER TABLE "Cuota" DROP COLUMN "metodoPago";

CREATE INDEX "Cuota_metodoPagoId_idx" ON "Cuota"("metodoPagoId");
ALTER TABLE "Cuota" ADD CONSTRAINT "Cuota_metodoPagoId_fkey"
  FOREIGN KEY ("metodoPagoId") REFERENCES "MetodoPago"("id") ON DELETE SET NULL ON UPDATE CASCADE;
