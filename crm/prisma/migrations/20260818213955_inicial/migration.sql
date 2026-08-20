-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('VENDEDOR', 'ABOGADO', 'DIRECTOR', 'ASISTENTE', 'CONTADOR');

-- CreateEnum
CREATE TYPE "EtapaComercial" AS ENUM ('CONTACTO_INICIAL', 'ENTREVISTA_VALORACION', 'PROSPECTO_CALIFICADO', 'CONTACTADO', 'CONSULTA_AGENDADA', 'PROPUESTA_ENVIADA', 'NEGOCIACION', 'CERRADO_GANADO', 'CERRADO_PERDIDO');

-- CreateEnum
CREATE TYPE "ResultadoEntrevista" AS ENUM ('VIABLE', 'NO_VIABLE', 'REQUIERE_INFO');

-- CreateEnum
CREATE TYPE "MedioContacto" AS ENUM ('LLAMADA', 'WHATSAPP', 'CORREO', 'PRESENCIAL');

-- CreateEnum
CREATE TYPE "Modalidad" AS ENUM ('PRESENCIAL', 'EN_LINEA');

-- CreateEnum
CREATE TYPE "EstatusDocumento" AS ENUM ('PENDIENTE', 'ENTREGADO');

-- CreateEnum
CREATE TYPE "EstatusComision" AS ENUM ('PENDIENTE', 'PAGADA');

-- CreateEnum
CREATE TYPE "TipoCita" AS ENUM ('CONSULTA_NUEVA', 'ACTUALIZACION_CASO', 'SEGUIMIENTO_SALIENTE');

-- CreateEnum
CREATE TYPE "EstatusSeguimiento" AS ENUM ('PENDIENTE', 'COMPLETADO');

-- CreateEnum
CREATE TYPE "CanalAlerta" AS ENUM ('WHATSAPP', 'CORREO', 'AMBOS');

-- CreateEnum
CREATE TYPE "TipoAlerta" AS ENUM ('CUOTA_POR_VENCER', 'CUOTA_VENCIDA', 'DOCUMENTO_POR_CADUCAR', 'RESOLUCION_PROXIMA', 'PROXIMO_SEGUIMIENTO');

-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "correo" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "rol" "Rol" NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrigenProspecto" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OrigenProspecto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MotivoPerdida" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MotivoPerdida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TipoTramite" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TipoTramite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EtapaPlantilla" (
    "id" TEXT NOT NULL,
    "tipoTramiteId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "esPresentacion" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EtapaPlantilla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentoPlantilla" (
    "id" TEXT NOT NULL,
    "tipoTramiteId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "requiereVigencia" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DocumentoPlantilla_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "fotoUrl" TEXT,
    "nacionalidad" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "ciudad" TEXT NOT NULL,
    "correo" TEXT,
    "telefono" TEXT,
    "origenProspectoId" TEXT,
    "observacionesGenerales" TEXT,
    "archivado" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "vendedorId" TEXT NOT NULL,
    "medioContacto" "MedioContacto" NOT NULL,
    "fechaPrimerContacto" TIMESTAMP(3) NOT NULL,
    "tipoTramiteId" TEXT NOT NULL,
    "resultadoEntrevista" "ResultadoEntrevista",
    "notasEntrevista" TEXT,
    "fechaEntrevista" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venta" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "leadId" TEXT,
    "tipoTramiteId" TEXT NOT NULL,
    "vendedorId" TEXT NOT NULL,
    "montoTotal" DECIMAL(12,2) NOT NULL,
    "etapa" "EtapaComercial" NOT NULL DEFAULT 'PROSPECTO_CALIFICADO',
    "fechaCierre" TIMESTAMP(3),
    "motivoPerdidaId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Caso" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "tipoTramiteId" TEXT NOT NULL,
    "etapaActualId" TEXT,
    "abogadoId" TEXT,
    "dependencia" TEXT,
    "modalidad" "Modalidad",
    "oficina" TEXT,
    "fechaPresentacion" TIMESTAMP(3),
    "fechaTentativaResolucion" TIMESTAMP(3),
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Caso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistorialEtapa" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT,
    "casoId" TEXT,
    "etapaAnterior" TEXT,
    "etapaNueva" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioId" TEXT,

    CONSTRAINT "HistorialEtapa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Documento" (
    "id" TEXT NOT NULL,
    "casoId" TEXT NOT NULL,
    "plantillaId" TEXT,
    "nombre" TEXT NOT NULL,
    "archivoUrl" TEXT,
    "archivoNombre" TEXT,
    "subidoPorId" TEXT,
    "fechaSubida" TIMESTAMP(3),
    "estatus" "EstatusDocumento" NOT NULL DEFAULT 'PENDIENTE',
    "fechaVigencia" TIMESTAMP(3),

    CONSTRAINT "Documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cuota" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "esInicial" BOOLEAN NOT NULL DEFAULT false,
    "fechaPactada" TIMESTAMP(3) NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "pagadoEn" TIMESTAMP(3),
    "metodoPago" TEXT,

    CONSTRAINT "Cuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comision" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "participanteId" TEXT NOT NULL,
    "rol" "Rol" NOT NULL,
    "porcentaje" DECIMAL(5,2) NOT NULL,
    "montoCalculado" DECIMAL(12,2) NOT NULL,
    "estatus" "EstatusComision" NOT NULL DEFAULT 'PENDIENTE',
    "fechaPago" TIMESTAMP(3),
    "plantillaOrigenId" TEXT,
    "versionPlantilla" INTEGER,

    CONSTRAINT "Comision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlantillaComision" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "esPredeterminada" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PlantillaComision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlantillaComisionItem" (
    "id" TEXT NOT NULL,
    "plantillaId" TEXT NOT NULL,
    "rol" "Rol" NOT NULL,
    "porcentaje" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "PlantillaComisionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interaccion" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "medio" "MedioContacto" NOT NULL,
    "resultado" TEXT NOT NULL,
    "usuarioId" TEXT,

    CONSTRAINT "Interaccion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProximoSeguimiento" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT NOT NULL,
    "responsableId" TEXT NOT NULL,
    "estatus" "EstatusSeguimiento" NOT NULL DEFAULT 'PENDIENTE',

    CONSTRAINT "ProximoSeguimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cita" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT,
    "titulo" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3),
    "tipo" "TipoCita" NOT NULL,
    "modalidad" "Modalidad" NOT NULL DEFAULT 'PRESENCIAL',
    "responsableId" TEXT,
    "seguimientoId" TEXT,

    CONSTRAINT "Cita_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigAlerta" (
    "id" TEXT NOT NULL,
    "tipo" "TipoAlerta" NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "diasAnticipacion" INTEGER NOT NULL DEFAULT 5,
    "canal" "CanalAlerta" NOT NULL DEFAULT 'AMBOS',
    "destinatarios" "Rol"[],
    "notificarCliente" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ConfigAlerta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Auditoria" (
    "id" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidadId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "detalle" JSONB,
    "usuarioId" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_correo_key" ON "Usuario"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "OrigenProspecto_nombre_key" ON "OrigenProspecto"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "MotivoPerdida_nombre_key" ON "MotivoPerdida"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "TipoTramite_nombre_key" ON "TipoTramite"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "EtapaPlantilla_tipoTramiteId_orden_key" ON "EtapaPlantilla"("tipoTramiteId", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentoPlantilla_tipoTramiteId_nombre_key" ON "DocumentoPlantilla"("tipoTramiteId", "nombre");

-- CreateIndex
CREATE INDEX "Cliente_nombre_idx" ON "Cliente"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "Venta_leadId_key" ON "Venta"("leadId");

-- CreateIndex
CREATE INDEX "Venta_etapa_idx" ON "Venta"("etapa");

-- CreateIndex
CREATE INDEX "Venta_vendedorId_idx" ON "Venta"("vendedorId");

-- CreateIndex
CREATE UNIQUE INDEX "Caso_ventaId_key" ON "Caso"("ventaId");

-- CreateIndex
CREATE INDEX "Caso_etapaActualId_idx" ON "Caso"("etapaActualId");

-- CreateIndex
CREATE INDEX "Caso_abogadoId_idx" ON "Caso"("abogadoId");

-- CreateIndex
CREATE INDEX "HistorialEtapa_ventaId_idx" ON "HistorialEtapa"("ventaId");

-- CreateIndex
CREATE INDEX "HistorialEtapa_casoId_idx" ON "HistorialEtapa"("casoId");

-- CreateIndex
CREATE INDEX "Documento_casoId_idx" ON "Documento"("casoId");

-- CreateIndex
CREATE INDEX "Cuota_fechaPactada_idx" ON "Cuota"("fechaPactada");

-- CreateIndex
CREATE UNIQUE INDEX "Cuota_ventaId_numero_key" ON "Cuota"("ventaId", "numero");

-- CreateIndex
CREATE INDEX "Comision_estatus_idx" ON "Comision"("estatus");

-- CreateIndex
CREATE UNIQUE INDEX "Comision_ventaId_participanteId_rol_key" ON "Comision"("ventaId", "participanteId", "rol");

-- CreateIndex
CREATE UNIQUE INDEX "PlantillaComision_nombre_key" ON "PlantillaComision"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "PlantillaComisionItem_plantillaId_rol_key" ON "PlantillaComisionItem"("plantillaId", "rol");

-- CreateIndex
CREATE INDEX "Interaccion_clienteId_fecha_idx" ON "Interaccion"("clienteId", "fecha");

-- CreateIndex
CREATE INDEX "ProximoSeguimiento_fecha_estatus_idx" ON "ProximoSeguimiento"("fecha", "estatus");

-- CreateIndex
CREATE UNIQUE INDEX "Cita_seguimientoId_key" ON "Cita"("seguimientoId");

-- CreateIndex
CREATE INDEX "Cita_inicio_idx" ON "Cita"("inicio");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigAlerta_tipo_key" ON "ConfigAlerta"("tipo");

-- CreateIndex
CREATE INDEX "Auditoria_entidad_entidadId_idx" ON "Auditoria"("entidad", "entidadId");

-- CreateIndex
CREATE INDEX "Auditoria_fecha_idx" ON "Auditoria"("fecha");

-- AddForeignKey
ALTER TABLE "EtapaPlantilla" ADD CONSTRAINT "EtapaPlantilla_tipoTramiteId_fkey" FOREIGN KEY ("tipoTramiteId") REFERENCES "TipoTramite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentoPlantilla" ADD CONSTRAINT "DocumentoPlantilla_tipoTramiteId_fkey" FOREIGN KEY ("tipoTramiteId") REFERENCES "TipoTramite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_origenProspectoId_fkey" FOREIGN KEY ("origenProspectoId") REFERENCES "OrigenProspecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tipoTramiteId_fkey" FOREIGN KEY ("tipoTramiteId") REFERENCES "TipoTramite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_tipoTramiteId_fkey" FOREIGN KEY ("tipoTramiteId") REFERENCES "TipoTramite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_motivoPerdidaId_fkey" FOREIGN KEY ("motivoPerdidaId") REFERENCES "MotivoPerdida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caso" ADD CONSTRAINT "Caso_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caso" ADD CONSTRAINT "Caso_tipoTramiteId_fkey" FOREIGN KEY ("tipoTramiteId") REFERENCES "TipoTramite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caso" ADD CONSTRAINT "Caso_etapaActualId_fkey" FOREIGN KEY ("etapaActualId") REFERENCES "EtapaPlantilla"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caso" ADD CONSTRAINT "Caso_abogadoId_fkey" FOREIGN KEY ("abogadoId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistorialEtapa" ADD CONSTRAINT "HistorialEtapa_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistorialEtapa" ADD CONSTRAINT "HistorialEtapa_casoId_fkey" FOREIGN KEY ("casoId") REFERENCES "Caso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistorialEtapa" ADD CONSTRAINT "HistorialEtapa_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documento" ADD CONSTRAINT "Documento_casoId_fkey" FOREIGN KEY ("casoId") REFERENCES "Caso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documento" ADD CONSTRAINT "Documento_plantillaId_fkey" FOREIGN KEY ("plantillaId") REFERENCES "DocumentoPlantilla"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documento" ADD CONSTRAINT "Documento_subidoPorId_fkey" FOREIGN KEY ("subidoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cuota" ADD CONSTRAINT "Cuota_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comision" ADD CONSTRAINT "Comision_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comision" ADD CONSTRAINT "Comision_participanteId_fkey" FOREIGN KEY ("participanteId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comision" ADD CONSTRAINT "Comision_plantillaOrigenId_fkey" FOREIGN KEY ("plantillaOrigenId") REFERENCES "PlantillaComision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlantillaComisionItem" ADD CONSTRAINT "PlantillaComisionItem_plantillaId_fkey" FOREIGN KEY ("plantillaId") REFERENCES "PlantillaComision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaccion" ADD CONSTRAINT "Interaccion_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaccion" ADD CONSTRAINT "Interaccion_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProximoSeguimiento" ADD CONSTRAINT "ProximoSeguimiento_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProximoSeguimiento" ADD CONSTRAINT "ProximoSeguimiento_responsableId_fkey" FOREIGN KEY ("responsableId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cita" ADD CONSTRAINT "Cita_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cita" ADD CONSTRAINT "Cita_responsableId_fkey" FOREIGN KEY ("responsableId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cita" ADD CONSTRAINT "Cita_seguimientoId_fkey" FOREIGN KEY ("seguimientoId") REFERENCES "ProximoSeguimiento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auditoria" ADD CONSTRAINT "Auditoria_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
