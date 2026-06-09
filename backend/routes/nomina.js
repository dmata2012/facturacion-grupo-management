const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// ── EMPLEADOS ─────────────────────────────────
router.get('/empleados', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_empleados WHERE activo=TRUE ORDER BY nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/empleados', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { nombre, puesto, departamento, salario_base, fecha_ingreso, notas } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_empleados(nombre,puesto,departamento,salario_base,fecha_ingreso,notas) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nombre, puesto, departamento, parseFloat(salario_base) || 0, fecha_ingreso || null, notas]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/empleados/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { nombre, puesto, departamento, salario_base, fecha_ingreso, activo, notas } = req.body;
    await query(
      `UPDATE fac_empleados SET nombre=$1,puesto=$2,departamento=$3,salario_base=$4,fecha_ingreso=$5,activo=$6,notas=$7,actualizado_en=NOW() WHERE id=$8`,
      [nombre, puesto, departamento, parseFloat(salario_base) || 0, fecha_ingreso || null, activo, notas, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── QUINCENAS ─────────────────────────────────
router.get('/quincenas', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_nomina_quincenas ORDER BY fecha_inicio DESC LIMIT 30`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/quincenas/:id', async (req, res) => {
  try {
    const q = await query(`SELECT * FROM fac_nomina_quincenas WHERE id=$1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Quincena no encontrada.' });
    const det = await query(`
      SELECT d.*, e.nombre, e.puesto, e.departamento
      FROM fac_nomina_detalle d
      JOIN fac_empleados e ON e.id=d.empleado_id
      WHERE d.quincena_id=$1 ORDER BY e.nombre
    `, [req.params.id]);
    res.json({ ...q.rows[0], detalle: det.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/quincenas', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { quincena, fecha_inicio, fecha_fin, notas } = req.body;
    if (!quincena || !fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Campos requeridos.' });
    const r = await query(
      `INSERT INTO fac_nomina_quincenas(quincena,fecha_inicio,fecha_fin,notas,creado_por) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [quincena, fecha_inicio, fecha_fin, notas, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Quincena ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

// Guardar detalle de quincena (reemplaza completo)
router.put('/quincenas/:id/detalle', requireRol('admin', 'capturista'), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { partidas } = req.body; // [{ empleado_id, percepciones, deducciones, notas }]
    const qId = req.params.id;

    await client.query(`DELETE FROM fac_nomina_detalle WHERE quincena_id=$1`, [qId]);
    let totPerc = 0, totDed = 0;
    for (const p of (partidas || [])) {
      const perc = parseFloat(p.percepciones) || 0;
      const ded  = parseFloat(p.deducciones)  || 0;
      await client.query(
        `INSERT INTO fac_nomina_detalle(quincena_id,empleado_id,percepciones,deducciones,notas) VALUES($1,$2,$3,$4,$5)`,
        [qId, p.empleado_id, perc, ded, p.notas || null]
      );
      totPerc += perc; totDed += ded;
    }
    await client.query(
      `UPDATE fac_nomina_quincenas SET total_percepciones=$1,total_deducciones=$2,total_neto=$3,actualizado_en=NOW() WHERE id=$4`,
      [totPerc, totDed, totPerc - totDed, qId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, total_percepciones: totPerc, total_deducciones: totDed, total_neto: totPerc - totDed });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Cerrar quincena
router.patch('/quincenas/:id/cerrar', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_nomina_quincenas SET estatus='cerrada',actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
