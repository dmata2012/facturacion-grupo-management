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

ALTER TABLE fac_facturas
  ADD COLUMN IF NOT EXISTS empresa_receptora_id INTEGER REFERENCES fac_empresas_receptoras(id);
