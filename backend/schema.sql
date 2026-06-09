-- ═══════════════════════════════════════════════
--  SISTEMA INTEGRAL DE FACTURACIÓN
--  Schema PostgreSQL
-- ═══════════════════════════════════════════════

-- Extensión para UUID (opcional)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USUARIOS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_usuarios (
  id            SERIAL PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol           VARCHAR(30)  NOT NULL DEFAULT 'capturista',
  -- roles: admin | gerente | capturista | lectura
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── CLIENTES ──────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_clientes (
  id            SERIAL PRIMARY KEY,
  rfc           VARCHAR(13)  NOT NULL UNIQUE,
  razon_social  VARCHAR(200) NOT NULL,
  nombre_comercial VARCHAR(200),
  contacto      VARCHAR(120),
  email         VARCHAR(120),
  telefono      VARCHAR(20),
  direccion     TEXT,
  ciudad        VARCHAR(80),
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  notas         TEXT,
  creado_en     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── FACTURAS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_facturas (
  id              SERIAL PRIMARY KEY,
  cliente_id      INTEGER      REFERENCES fac_clientes(id),
  folio           VARCHAR(50),
  uuid_cfdi       VARCHAR(40),
  fecha_emision   DATE         NOT NULL,
  fecha_vencimiento DATE,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  moneda          VARCHAR(3)   NOT NULL DEFAULT 'MXN',
  concepto        TEXT,
  estatus         VARCHAR(20)  NOT NULL DEFAULT 'pendiente',
  -- estatus: pendiente | parcial | pagada | vencida | cancelada
  archivo_pdf     VARCHAR(300),
  archivo_xml     VARCHAR(300),
  rfc_detectado   VARCHAR(13),
  desglose_validado BOOLEAN    NOT NULL DEFAULT FALSE,
  creado_por      INTEGER      REFERENCES fac_usuarios(id),
  creado_en       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_facturas_cliente ON fac_facturas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_fac_facturas_estatus ON fac_facturas(estatus);
CREATE INDEX IF NOT EXISTS idx_fac_facturas_fecha   ON fac_facturas(fecha_emision);

-- ── DESGLOSE RH ───────────────────────────────
CREATE TABLE IF NOT EXISTS fac_desglose_rh (
  id          SERIAL PRIMARY KEY,
  factura_id  INTEGER      NOT NULL REFERENCES fac_facturas(id) ON DELETE CASCADE,
  concepto    VARCHAR(120) NOT NULL,
  -- ej: Sueldos, Honorarios, Comisiones, Bonos, Cuotas IMSS, etc.
  monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas       TEXT,
  creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_rh_factura ON fac_desglose_rh(factura_id);

-- ── PAGOS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_pagos (
  id          SERIAL PRIMARY KEY,
  factura_id  INTEGER      NOT NULL REFERENCES fac_facturas(id) ON DELETE CASCADE,
  fecha_pago  DATE         NOT NULL,
  monto       NUMERIC(14,2) NOT NULL,
  forma_pago  VARCHAR(40)  NOT NULL DEFAULT 'transferencia',
  -- transferencia | cheque | efectivo | tarjeta | otro
  referencia  VARCHAR(100),
  notas       TEXT,
  creado_por  INTEGER      REFERENCES fac_usuarios(id),
  creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_pagos_factura ON fac_pagos(factura_id);

-- ── EMPLEADOS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_empleados (
  id           SERIAL PRIMARY KEY,
  nombre       VARCHAR(120) NOT NULL,
  puesto       VARCHAR(80),
  departamento VARCHAR(80),
  salario_base NUMERIC(14,2) NOT NULL DEFAULT 0,
  fecha_ingreso DATE,
  activo       BOOLEAN      NOT NULL DEFAULT TRUE,
  notas        TEXT,
  creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── NÓMINA QUINCENAS ──────────────────────────
CREATE TABLE IF NOT EXISTS fac_nomina_quincenas (
  id           SERIAL PRIMARY KEY,
  quincena     VARCHAR(20)  NOT NULL UNIQUE,
  -- formato: 2024-01-1 (año-mes-quincena 1 o 2)
  fecha_inicio DATE         NOT NULL,
  fecha_fin    DATE         NOT NULL,
  total_percepciones NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deducciones  NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_neto         NUMERIC(14,2) NOT NULL DEFAULT 0,
  estatus      VARCHAR(20)  NOT NULL DEFAULT 'borrador',
  -- borrador | cerrada
  notas        TEXT,
  creado_por   INTEGER      REFERENCES fac_usuarios(id),
  creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── NÓMINA DETALLE ────────────────────────────
CREATE TABLE IF NOT EXISTS fac_nomina_detalle (
  id             SERIAL PRIMARY KEY,
  quincena_id    INTEGER      NOT NULL REFERENCES fac_nomina_quincenas(id) ON DELETE CASCADE,
  empleado_id    INTEGER      NOT NULL REFERENCES fac_empleados(id),
  percepciones   NUMERIC(14,2) NOT NULL DEFAULT 0,
  deducciones    NUMERIC(14,2) NOT NULL DEFAULT 0,
  neto           NUMERIC(14,2) GENERATED ALWAYS AS (percepciones - deducciones) STORED,
  notas          TEXT,
  creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_nomina_det_quincena  ON fac_nomina_detalle(quincena_id);
CREATE INDEX IF NOT EXISTS idx_fac_nomina_det_empleado  ON fac_nomina_detalle(empleado_id);

-- ── BITÁCORA ──────────────────────────────────
CREATE TABLE IF NOT EXISTS fac_bitacora (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER      REFERENCES fac_usuarios(id),
  accion      VARCHAR(50)  NOT NULL,
  tabla       VARCHAR(60),
  registro_id INTEGER,
  detalle     TEXT,
  ip          VARCHAR(45),
  creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── USUARIO ADMIN POR DEFECTO ─────────────────
-- Contraseña: Admin2024! (cambiar después)
INSERT INTO fac_usuarios (nombre, email, password_hash, rol)
VALUES ('Administrador', 'admin@despacho.com',
        '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin')
ON CONFLICT (email) DO NOTHING;
