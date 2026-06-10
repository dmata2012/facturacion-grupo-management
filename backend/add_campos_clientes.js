const { Pool } = require('pg');

const DATABASE_URL = 'postgresql://facturacion_db_tbm9_user:X4A6lk6zECS9TBcxOzd2azoZVTyxX974@dpg-d8k5jtojo6nc739n4b70-a.oregon-postgres.render.com/facturacion_db_tbm9';

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔗 Conectado a facturacion_db_tbm9...');

    await client.query(`
      ALTER TABLE fac_clientes
        ADD COLUMN IF NOT EXISTS contacto_admin   VARCHAR(120),
        ADD COLUMN IF NOT EXISTS contacto_pagos   VARCHAR(120),
        ADD COLUMN IF NOT EXISTS whatsapp         VARCHAR(20),
        ADD COLUMN IF NOT EXISTS dias_credito     INTEGER      DEFAULT 0,
        ADD COLUMN IF NOT EXISTS condiciones_pago VARCHAR(200),
        ADD COLUMN IF NOT EXISTS ejecutivo_cuenta VARCHAR(120)
    `);
    console.log('✅ Columnas agregadas a fac_clientes:');
    console.log('   - contacto_admin');
    console.log('   - contacto_pagos');
    console.log('   - whatsapp');
    console.log('   - dias_credito');
    console.log('   - condiciones_pago');
    console.log('   - ejecutivo_cuenta');

    // Verificar
    const r = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name='fac_clientes'
      ORDER BY ordinal_position
    `);
    console.log('\n📋 Columnas actuales de fac_clientes:');
    r.rows.forEach(c => console.log(`   ${c.column_name.padEnd(20)} ${c.data_type}`));
    console.log('\n🎉 Migración completada.');
  } catch(e) {
    console.error('❌ Error:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
