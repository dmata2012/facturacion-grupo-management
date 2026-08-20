-- AlterTable
ALTER TABLE "ProximoSeguimiento" ADD COLUMN     "presupuestoId" TEXT;

-- CreateIndex
CREATE INDEX "ProximoSeguimiento_presupuestoId_idx" ON "ProximoSeguimiento"("presupuestoId");

-- AddForeignKey
ALTER TABLE "ProximoSeguimiento" ADD CONSTRAINT "ProximoSeguimiento_presupuestoId_fkey" FOREIGN KEY ("presupuestoId") REFERENCES "Presupuesto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

