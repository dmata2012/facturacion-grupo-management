
-- CreateEnum
CREATE TYPE "EstatusPresupuesto" AS ENUM ('BORRADOR', 'ENVIADO', 'ACEPTADO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "Presupuesto" (
    "id" TEXT NOT NULL,
    "folio" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "estatus" "EstatusPresupuesto" NOT NULL DEFAULT 'BORRADOR',
    "validoHasta" TIMESTAMP(3),
    "fechaEnvio" TIMESTAMP(3),
    "fechaRespuesta" TIMESTAMP(3),
    "motivoRechazo" TEXT,
    "condiciones" TEXT,
    "notas" TEXT,
    "creadoPorId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Presupuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresupuestoConcepto" (
    "id" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PresupuestoConcepto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresupuestoPago" (
    "id" TEXT NOT NULL,
    "presupuestoId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "descripcion" TEXT,
    "fechaPropuesta" TIMESTAMP(3) NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PresupuestoPago_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Presupuesto_folio_key" ON "Presupuesto"("folio");

-- CreateIndex
CREATE INDEX "Presupuesto_ventaId_idx" ON "Presupuesto"("ventaId");

-- CreateIndex
CREATE INDEX "Presupuesto_estatus_idx" ON "Presupuesto"("estatus");

-- CreateIndex
CREATE UNIQUE INDEX "PresupuestoPago_presupuestoId_numero_key" ON "PresupuestoPago"("presupuestoId", "numero");

-- AddForeignKey
ALTER TABLE "Presupuesto" ADD CONSTRAINT "Presupuesto_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presupuesto" ADD CONSTRAINT "Presupuesto_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoConcepto" ADD CONSTRAINT "PresupuestoConcepto_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresupuestoPago" ADD CONSTRAINT "PresupuestoPago_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

