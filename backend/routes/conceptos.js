const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// GET /api/conceptos  — lista activos para el desglose
router.get('/', async (req, res) => {
  try {
    const { todos } = req.query;
    let sql = 'SELECT * FROM fac_conceptos_rh';
    if (!todos) sql += ' WHERE activo=TRUE';
    sql += ' ORDER BY orden, nombre';
    const r = await query(sql);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/conceptos
router.post('/', requireRol('admin'), async (req, res) => {
  try {
    const { clave, nombre, descripcion, orden } = req.body;
    if (!clave || !nombre) return res.status(400).json({ error: 'Clave y nombre requeridos.' });
    const r = await query(
      `INSERT INTO fac_conceptos_rh(clave,nombre,descripcion,orden) VALUES($1,$2,$3,$4) RETURNING *`,
      [clave.toUpperCase().trim(), nombre.trim(), descripcion || null, parseInt(orden) || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Clave ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/conceptos/:id
router.put('/:id', requireRol('admin'), async (req, res) => {
  try {
    const { clave, nombre, descripcion, activo, orden } = req.body;
    await query(
      `UPDATE fac_conceptos_rh SET clave=$1,nombre=$2,descripcion=$3,activo=$4,orden=$5 WHERE id=$6`,
      [clave.toUpperCase().trim(), nombre.trim(), descripcion || null, activo, parseInt(orden) || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Clave ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/conceptos/:id  — desactiva
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_conceptos_rh SET activo=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
