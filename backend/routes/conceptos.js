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
    // Actualización parcial: solo campo activo
    const keys = Object.keys(req.body);
    if (keys.length === 1 && keys[0] === 'activo') {
      await query(`UPDATE fac_conceptos_rh SET activo=$1 WHERE id=$2`, [req.body.activo, req.params.id]);
      return res.json({ ok: true });
    }
    // Actualización completa
    const { clave, nombre, descripcion, activo, orden } = req.body;
    if (!clave || !nombre) return res.status(400).json({ error: 'Clave y nombre requeridos.' });
    await query(
      `UPDATE fac_conceptos_rh SET clave=$1,nombre=$2,descripcion=$3,activo=$4,orden=$5 WHERE id=$6`,
      [clave.toUpperCase().trim(), nombre.trim(), descripcion || null,
       activo !== false, parseInt(orden) || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Clave ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/conceptos/:id  — eliminar permanentemente del catálogo
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    // Verificar si tiene registros en desgloses
    const uso = await query(
      `SELECT COUNT(*)::int AS total FROM fac_desglose_rh WHERE concepto_id=$1`,
      [req.params.id]
    );
    const enUso = uso.rows[0]?.total || 0;

    // Desligar FK en desgloses (el texto del concepto se preserva)
    if (enUso > 0) {
      await query(`UPDATE fac_desglose_rh SET concepto_id=NULL WHERE concepto_id=$1`, [req.params.id]);
    }

    // Eliminar del catálogo
    const r = await query(`DELETE FROM fac_conceptos_rh WHERE id=$1 RETURNING id,nombre`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Concepto no encontrado.' });

    res.json({ ok: true, nombre: r.rows[0].nombre, desgloses_afectados: enUso });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
