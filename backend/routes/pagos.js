const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');
const { recalcularEstatus } = require('./facturas');

router.use(verificarToken);

// GET /api/pagos?cliente_id=&desde=&hasta=&vencidas=true
router.get('/', async (req, res) => {
  try {
    const { cliente_id, desde, hasta, vencidas } = req.query;
    const params = [];
    let where = 'WHERE f.estatus != \'cancelada\'';

    if (cliente_id) { params.push(cliente_id); where += ` AND f.cliente_id=$${params.length}`; }
    if (desde)      { params.push(desde); where += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta)      { params.push(hasta); where += ` AND f.fecha_emision<=$${params.length}`; }
    if (vencidas === 'true') where += ` AND f.estatus='vencida'`;

    const r = await query(`
      SELECT f.id, f.folio, f.fecha_emision, f.fecha_vencimiento, f.total, f.estatus,
        c.razon_social, c.rfc,
        COALESCE(SUM(p.monto),0)           AS cobrado,
        f.total - COALESCE(SUM(p.monto),0) AS saldo
      FROM fac_facturas f
      LEFT JOIN fac_clientes c ON c.id=f.cliente_id
      LEFT JOIN fac_pagos p ON p.factura_id=f.id
      ${where}
      GROUP BY f.id, c.razon_social, c.rfc
      HAVING f.total - COALESCE(SUM(p.monto),0) > 0
      ORDER BY f.fecha_vencimiento NULLS LAST, f.fecha_emision
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pagos/factura/:factura_id
router.get('/factura/:factura_id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_pagos WHERE factura_id=$1 ORDER BY fecha_pago DESC`, [req.params.factura_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pagos
router.post('/', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { factura_id, fecha_pago, monto, forma_pago, referencia, notas } = req.body;
    if (!factura_id || !fecha_pago || !monto) return res.status(400).json({ error: 'Factura, fecha y monto requeridos.' });

    const r = await query(
      `INSERT INTO fac_pagos(factura_id,fecha_pago,monto,forma_pago,referencia,notas,creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [factura_id, fecha_pago, parseFloat(monto), forma_pago || 'transferencia', referencia, notas, req.usuario.id]
    );
    await recalcularEstatus(factura_id);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/pagos/:id
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`DELETE FROM fac_pagos WHERE id=$1 RETURNING factura_id`, [req.params.id]);
    if (r.rows.length) await recalcularEstatus(r.rows[0].factura_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
