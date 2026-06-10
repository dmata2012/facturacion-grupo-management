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

// GET /api/pagos/kpi — indicadores de cobranza
router.get('/kpi', async (req, res) => {
  try {
    const [cobradoMes, porCobrar, porVencer, vencidas15, morosos] = await Promise.all([

      // Cobrado en el mes actual
      query(`
        SELECT COALESCE(SUM(monto), 0) AS total
        FROM fac_pagos
        WHERE DATE_TRUNC('month', fecha_pago) = DATE_TRUNC('month', CURRENT_DATE)
      `),

      // Total saldo por cobrar + conteo de facturas
      query(`
        SELECT
          COALESCE(SUM(f.total - COALESCE(sub_p.cobrado,0)), 0) AS total,
          COUNT(DISTINCT f.id)::int                              AS facturas
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) sub_p ON sub_p.factura_id = f.id
        WHERE f.estatus NOT IN ('cancelada','pagada')
          AND f.total - COALESCE(sub_p.cobrado,0) > 0
      `),

      // Facturas que vencen en los próximos 15 días (con saldo)
      query(`
        SELECT COUNT(DISTINCT f.id)::int AS facturas
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) sub_p ON sub_p.factura_id = f.id
        WHERE f.estatus NOT IN ('cancelada','pagada')
          AND f.fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '15 days'
          AND f.total - COALESCE(sub_p.cobrado,0) > 0
      `),

      // Facturas con más de 15 días vencidas (conteo + monto)
      query(`
        SELECT
          COUNT(DISTINCT f.id)::int                              AS facturas,
          COALESCE(SUM(f.total - COALESCE(sub_p.cobrado,0)), 0) AS monto
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) sub_p ON sub_p.factura_id = f.id
        WHERE f.estatus NOT IN ('cancelada','pagada')
          AND f.fecha_vencimiento < CURRENT_DATE - INTERVAL '15 days'
          AND f.total - COALESCE(sub_p.cobrado,0) > 0
      `),

      // Clientes morosos (con al menos una factura vencida)
      query(`
        SELECT COUNT(DISTINCT f.cliente_id)::int AS clientes
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) sub_p ON sub_p.factura_id = f.id
        WHERE f.estatus NOT IN ('cancelada','pagada')
          AND f.fecha_vencimiento < CURRENT_DATE
          AND f.total - COALESCE(sub_p.cobrado,0) > 0
      `),
    ]);

    res.json({
      cobrado_mes       : parseFloat(cobradoMes.rows[0].total)   || 0,
      por_cobrar        : parseFloat(porCobrar.rows[0].total)    || 0,
      facturas_activas  : porCobrar.rows[0].facturas             || 0,
      por_vencer        : porVencer.rows[0].facturas             || 0,
      vencidas_15       : vencidas15.rows[0].facturas            || 0,
      monto_vencido_15  : parseFloat(vencidas15.rows[0].monto)   || 0,
      clientes_morosos  : morosos.rows[0].clientes               || 0,
    });
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
