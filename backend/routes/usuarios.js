const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');
const { normalizarRol } = require('./auth');

// Roles válidos del sistema — cualquier otro valor deja al usuario sin permisos
// Roles base del sistema. Los perfiles configurables se agregan encima: se
// consultan en fac_perfiles para que un perfil creado desde la pantalla de
// permisos sea asignable de inmediato, sin tocar este archivo.
const ROLES_BASE = ['admin','gerente','capturista','tesoreria','tesoreria_consulta','checador','lectura'];
const ROLES_VALIDOS = ROLES_BASE;

async function rolesPermitidos() {
  try {
    const r = await query(`SELECT clave FROM fac_perfiles WHERE activo`);
    const claves = r.rows.map(x => x.clave);
    return [...new Set([...ROLES_BASE, ...claves])];
  } catch (e) { return ROLES_BASE; }
}

// Enlace usuario ↔ expediente de empleado. Sin esto, un colaborador que entra a
// pedir sus vacaciones no tiene a quién referirse: el sistema sabe quién inició
// sesión, pero no qué empleado es.
(async () => {
  try {
    await query(`ALTER TABLE fac_usuarios ADD COLUMN IF NOT EXISTS empleado_id INT`);
    // Emparejar por correo lo que se pueda, para no capturarlo uno por uno
    const r = await query(`
      UPDATE fac_usuarios u SET empleado_id = e.id
      FROM fac_empleados e
      WHERE u.empleado_id IS NULL
        AND e.email IS NOT NULL AND TRIM(e.email) <> ''
        AND LOWER(TRIM(e.email)) = LOWER(TRIM(u.email))
      RETURNING u.nombre`);
    if (r.rows.length) console.log(`✔ ${r.rows.length} usuario(s) enlazados a su expediente por correo`);
  } catch (e) { console.warn('Enlace usuario-empleado:', e.message); }
})();

// Corrección única de roles guardados con variantes ('Gerencia', 'GERENTE', 'Tesorería'…),
// que dejaban al usuario sin permisos porque no coincidían con requireRol() ni con los PAGES_*.
(async () => {
  try {
    const r = await query(`SELECT id, nombre, rol FROM fac_usuarios`);
    for (const u of r.rows) {
      const norm = normalizarRol(u.rol);
      if (norm !== u.rol && ROLES_VALIDOS.includes(norm)) {
        await query(`UPDATE fac_usuarios SET rol=$1 WHERE id=$2`, [norm, u.id]);
        console.log(`✔ Rol normalizado: ${u.nombre} "${u.rol}" → "${norm}"`);
      } else if (!ROLES_VALIDOS.includes(norm)) {
        console.warn(`⚠ Usuario "${u.nombre}" tiene el rol inválido "${u.rol}" — revísalo en Usuarios.`);
      }
    }
  } catch (e) { console.warn('Normalización de roles:', e.message); }
})();

router.use(verificarToken);

// PUT /api/usuarios/cambiar-clave — cualquier usuario cambia su propia clave
router.put('/cambiar-clave', async (req, res) => {
  try {
    const { clave_actual, clave_nueva } = req.body;
    if (!clave_actual || !clave_nueva)
      return res.status(400).json({ error: 'Clave actual y nueva son requeridas.' });
    if (String(clave_nueva).length < 6)
      return res.status(400).json({ error: 'La nueva clave debe tener al menos 6 caracteres.' });

    const r = await query(`SELECT password_hash FROM fac_usuarios WHERE id=$1 AND activo=TRUE`, [req.usuario.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const ok = await bcrypt.compare(clave_actual, r.rows[0].password_hash);
    if (!ok) return res.status(403).json({ error: 'La clave actual es incorrecta.' });

    const hash = await bcrypt.hash(clave_nueva, 10);
    await query(`UPDATE fac_usuarios SET password_hash=$1, actualizado_en=NOW() WHERE id=$2`, [hash, req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// GET  /api/usuarios
router.get('/', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`
      SELECT u.id, u.nombre, u.email, u.rol, u.activo, u.creado_en, u.empleado_id,
             e.nombre AS empleado_nombre
        FROM fac_usuarios u
        LEFT JOIN fac_empleados e ON e.id = u.empleado_id
       ORDER BY u.nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/usuarios
router.post('/', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, email, password, rol, empleado_id } = req.body;
    if (!nombre || !email || !password || !rol) return res.status(400).json({ error: 'Campos requeridos.' });
    const rolNorm = normalizarRol(rol);
    const validos = await rolesPermitidos();
    if (!validos.includes(rolNorm))
      return res.status(400).json({ error: `Perfil inválido: "${rol}". Válidos: ${validos.join(', ')}.` });
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      `INSERT INTO fac_usuarios(nombre,email,password_hash,rol,empleado_id) VALUES($1,$2,$3,$4,$5) RETURNING id,nombre,email,rol,activo,empleado_id`,
      [nombre, email.toLowerCase(), hash, rolNorm, empleado_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email ya registrado.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/usuarios/:id
router.put('/:id', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, email, rol, activo, password, empleado_id } = req.body;
    const rolNorm = normalizarRol(rol);
    const validos = await rolesPermitidos();
    if (!validos.includes(rolNorm))
      return res.status(400).json({ error: `Perfil inválido: "${rol}". Válidos: ${validos.join(', ')}.` });
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await query(`UPDATE fac_usuarios SET nombre=$1,email=$2,rol=$3,activo=$4,password_hash=$5,empleado_id=$6,actualizado_en=NOW() WHERE id=$7`,
        [nombre, email.toLowerCase(), rolNorm, activo, hash, empleado_id || null, req.params.id]);
    } else {
      await query(`UPDATE fac_usuarios SET nombre=$1,email=$2,rol=$3,activo=$4,empleado_id=$5,actualizado_en=NOW() WHERE id=$6`,
        [nombre, email.toLowerCase(), rolNorm, activo, empleado_id || null, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/usuarios/:id
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_usuarios SET activo=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
