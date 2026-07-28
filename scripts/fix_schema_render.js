const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="postgresql://..." node <script>.js');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fix() {
  const client = await pool.connect();
  try {
    console.log('🔗 Conectado...');

    // Agregar columnas faltantes en fac_facturas
    const cols = [
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS tipo_comprobante VARCHAR(10) DEFAULT 'I'`,
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS empresa_receptora_id INTEGER REFERENCES fac_empresas_receptoras(id)`,
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS rfc_detectado VARCHAR(13)`,
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS desglose_validado BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS archivo_pdf VARCHAR(300)`,
      `ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS archivo_xml VARCHAR(300)`,
    ];

    for (const sql of cols) {
      await client.query(sql);
      const col = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1];
      console.log(`✅ Columna verificada: ${col}`);
    }

    // Verificar estructura final
    const r = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name='fac_facturas'
      ORDER BY ordinal_position
    `);
    console.log('\n📋 Columnas en fac_facturas:');
    r.rows.forEach(c => console.log(`   - ${c.column_name} (${c.data_type})`));

    console.log('\n🎉 Schema corregido correctamente.');
  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

fix();
