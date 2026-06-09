const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// GET  /api/usuarios
router.get('/', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`SELECT id,nombre,email,rol,activo,creado_en FROM fac_usuarios ORDER BY nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/usuarios
router.post('/', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password || !rol) return res.status(400).json({ error: 'Campos requeridos.' });
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      `INSERT INTO fac_usuarios(nombre,email,password_hash,rol) VALUES($1,$2,$3,$4) RETURNING id,nombre,email,rol,activo`,
      [nombre, email.toLowerCase(), hash, rol]
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
    const { nombre, email, rol, activo, password } = req.body;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await query(`UPDATE fac_usuarios SET nombre=$1,email=$2,rol=$3,activo=$4,password_hash=$5,actualizado_en=NOW() WHERE id=$6`,
        [nombre, email.toLowerCase(), rol, activo, hash, req.params.id]);
    } else {
      await query(`UPDATE fac_usuarios SET nombre=$1,email=$2,rol=$3,activo=$4,actualizado_en=NOW() WHERE id=$5`,
        [nombre, email.toLowerCase(), rol, activo, req.params.id]);
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
