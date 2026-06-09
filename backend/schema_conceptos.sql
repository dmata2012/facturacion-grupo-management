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
