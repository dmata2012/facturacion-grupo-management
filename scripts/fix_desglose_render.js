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

    await client.query(`ALTER TABLE fac_desglose_rh ADD COLUMN IF NOT EXISTS concepto_id INTEGER REFERENCES fac_conceptos_rh(id)`);
    console.log('✅ Columna concepto_id agregada a fac_desglose_rh');

    await client.query(`ALTER TABLE fac_desglose_rh ADD COLUMN IF NOT EXISTS notas TEXT`);
    console.log('✅ Columna notas verificada');

    console.log('\n🎉 Listo. Ya puede usar el desglose.');
  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

fix();
