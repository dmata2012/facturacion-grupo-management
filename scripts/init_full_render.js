const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="postgresql://..." node <script>.js');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    console.log('🔗 Conectado a la base de datos...');

    // ── SCHEMA PRINCIPAL ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_usuarios (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(60) UNIQUE,
        nombre        VARCHAR(120) NOT NULL,
        email         VARCHAR(120) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        rol           VARCHAR(30)  NOT NULL DEFAULT 'capturista',
        activo        BOOLEAN      NOT NULL DEFAULT TRUE,
        creado_en     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ fac_usuarios');

    await client.query(`
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
        comision      NUMERIC(5,2) NOT NULL DEFAULT 0,
        creado_en     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ fac_clientes');

    await client.query(`
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
    `);
    console.log('✅ fac_facturas');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_desglose_rh (
        id          SERIAL PRIMARY KEY,
        factura_id  INTEGER      NOT NULL REFERENCES fac_facturas(id) ON DELETE CASCADE,
        concepto    VARCHAR(120) NOT NULL,
        monto       NUMERIC(14,2) NOT NULL DEFAULT 0,
        notas       TEXT,
        creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_fac_rh_factura ON fac_desglose_rh(factura_id);
    `);
    console.log('✅ fac_desglose_rh');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_pagos (
        id          SERIAL PRIMARY KEY,
        factura_id  INTEGER      NOT NULL REFERENCES fac_facturas(id) ON DELETE CASCADE,
        fecha_pago  DATE         NOT NULL,
        monto       NUMERIC(14,2) NOT NULL,
        forma_pago  VARCHAR(40)  NOT NULL DEFAULT 'transferencia',
        referencia  VARCHAR(100),
        notas       TEXT,
        creado_por  INTEGER      REFERENCES fac_usuarios(id),
        creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_fac_pagos_factura ON fac_pagos(factura_id);
    `);
    console.log('✅ fac_pagos');

    await client.query(`
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
    `);
    console.log('✅ fac_empleados');

    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_nomina_quincenas (
        id           SERIAL PRIMARY KEY,
        quincena     VARCHAR(20)  NOT NULL UNIQUE,
        fecha_inicio DATE         NOT NULL,
        fecha_fin    DATE         NOT NULL,
        total_percepciones NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_deducciones  NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_neto         NUMERIC(14,2) NOT NULL DEFAULT 0,
        estatus      VARCHAR(20)  NOT NULL DEFAULT 'borrador',
        notas        TEXT,
        creado_por   INTEGER      REFERENCES fac_usuarios(id),
        creado_en    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ fac_nomina_quincenas');

    await client.query(`
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
    `);
    console.log('✅ fac_nomina_detalle');

    await client.query(`
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
    `);
    console.log('✅ fac_bitacora');

    // ── CONCEPTOS ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_conceptos_rh (
        id          SERIAL PRIMARY KEY,
        clave       VARCHAR(30)  NOT NULL UNIQUE,
        nombre      VARCHAR(120) NOT NULL,
        descripcion TEXT,
        activo      BOOLEAN      NOT NULL DEFAULT TRUE,
        orden       INTEGER      NOT NULL DEFAULT 0,
        creado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      INSERT INTO fac_conceptos_rh (clave, nombre, orden) VALUES
        ('SUELDOS',    'Sueldos y Salarios',       1),
        ('ISR',        'ISR Retencion',            2),
        ('ISN',        'Impuesto Sobre Nomina',    3),
        ('IMSS_PAT',   'Cuotas IMSS Patronal',     4),
        ('IMSS_OBR',   'Cuotas IMSS Obrera',       5),
        ('INFONAVIT',  'Aportaciones INFONAVIT',   6),
        ('HONORARIOS', 'Honorarios',               7),
        ('COMISIONES', 'Comisiones',               8),
        ('BONOS',      'Bonos y Gratificaciones',  9),
        ('RELATIVOS',  'Relativos',               10),
        ('OTROS',      'Otros Conceptos',         11)
      ON CONFLICT (clave) DO NOTHING;
    `);
    console.log('✅ fac_conceptos_rh');

    // ── EMPRESAS RECEPTORAS ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS fac_empresas_receptoras (
        id               SERIAL PRIMARY KEY,
        rfc              VARCHAR(13)  NOT NULL UNIQUE,
        razon_social     VARCHAR(200) NOT NULL,
        nombre_comercial VARCHAR(200),
        contacto         VARCHAR(120),
        email            VARCHAR(120),
        telefono         VARCHAR(20),
        direccion        TEXT,
        ciudad           VARCHAR(80),
        regimen_fiscal   VARCHAR(100),
        codigo_postal    VARCHAR(10),
        activo           BOOLEAN      NOT NULL DEFAULT TRUE,
        notas            TEXT,
        creado_en        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        actualizado_en   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS empresa_receptora_id INTEGER REFERENCES fac_empresas_receptoras(id);
    `);
    console.log('✅ fac_empresas_receptoras');

    // ── USUARIO ADMIN ─────────────────────────────
    const hash = await bcrypt.hash('870142', 10);

    // Intentar con username
    await client.query(`ALTER TABLE fac_usuarios ADD COLUMN IF NOT EXISTS username VARCHAR(60) UNIQUE;`);

    const existe = await client.query(`SELECT id FROM fac_usuarios WHERE email='admin@grupomanagement.com' OR username='admin'`);
    if (existe.rows.length) {
      await client.query(
        `UPDATE fac_usuarios SET password_hash=$1, username='admin', activo=true WHERE email='admin@grupomanagement.com' OR username='admin'`,
        [hash]
      );
      console.log('✅ Contraseña admin actualizada → 870142');
    } else {
      await client.query(
        `INSERT INTO fac_usuarios(username, nombre, email, password_hash, rol, activo)
         VALUES('admin','Administrador','admin@grupomanagement.com',$1,'admin',true)`,
        [hash]
      );
      console.log('✅ Usuario admin creado → 870142');
    }

    // Verificar
    const check = await client.query(`SELECT id, username, email, rol, activo FROM fac_usuarios`);
    console.log('\n📋 Usuarios en la BD:');
    check.rows.forEach(u => console.log(' -', u.id, u.username || u.email, u.rol, u.activo ? '✅' : '❌'));

    console.log('\n🎉 Base de datos inicializada correctamente.');
    console.log('   Ingrese con: admin / 870142');

  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
