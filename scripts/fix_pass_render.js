const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// ⚠️  Pega aquí la External URL de tu PostgreSQL de Render
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="postgresql://..." node <script>.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixAdmin() {
  try {
    const hash = await bcrypt.hash('870142', 10);
    const r = await pool.query(
      `UPDATE fac_usuarios SET password_hash=$1 WHERE username='admin' RETURNING id, username, rol`,
      [hash]
    );
    if (r.rows.length) {
      console.log('✅ Contraseña actualizada:', r.rows[0]);
    } else {
      // Si no existe el usuario admin, lo creamos
      const r2 = await pool.query(
        `INSERT INTO fac_usuarios(username, nombre, email, password_hash, rol, activo)
         VALUES('admin','Administrador','admin@grupomanagement.com',$1,'admin',true)
         RETURNING id, username, rol`,
        [hash]
      );
      console.log('✅ Usuario admin creado:', r2.rows[0]);
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    await pool.end();
  }
}

fixAdmin();
