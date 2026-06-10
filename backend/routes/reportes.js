const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken } = require('../middleware/auth');

router.use(verificarToken);

// ── REPORTE COBRANZA ──────────────────────────
router.get('/cobranza', async (req, res) => {
  try {
    const { desde, hasta, cliente_id, estatus } = req.query;
    const params = []; let where = 'WHERE f.estatus != \'cancelada\'';
    if (desde)      { params.push(desde);      where += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta)      { params.push(hasta);      where += ` AND f.fecha_emision<=$${params.length}`; }
    if (cliente_id) { params.push(cliente_id); where += ` AND f.cliente_id=$${params.length}`; }
    if (estatus)    { params.push(estatus);    where += ` AND f.estatus=$${params.length}`; }

    const r = await query(`
      SELECT f.id, f.folio, f.fecha_emision, f.fecha_vencimiento, f.total, f.estatus, f.concepto,
        c.razon_social, c.rfc, c.email AS cliente_email,
        COALESCE(SUM(p.monto),0)           AS cobrado,
        f.total - COALESCE(SUM(p.monto),0) AS saldo,
        CASE WHEN f.fecha_vencimiento < CURRENT_DATE AND f.estatus != 'pagada' THEN
          CURRENT_DATE - f.fecha_vencimiento ELSE 0 END AS dias_vencido
      FROM fac_facturas f
      LEFT JOIN fac_clientes c ON c.id=f.cliente_id
      LEFT JOIN fac_pagos p ON p.factura_id=f.id
      ${where}
      GROUP BY f.id, c.razon_social, c.rfc, c.email
      ORDER BY dias_vencido DESC, f.fecha_emision
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE CLIENTES ──────────────────────────
router.get('/clientes', async (req, res) => {
  try {
    const { año = new Date().getFullYear() } = req.query;
    const r = await query(`
      SELECT c.id, c.rfc, c.razon_social, c.ciudad,
        COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada')::int    AS facturas,
        COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0) AS facturado,
        COALESCE(SUM(p.monto),0)                                    AS cobrado,
        COALESCE(SUM(f.total) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada')),0)
          - COALESCE(SUM(p.monto) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada')),0) AS saldo,
        MAX(f.fecha_emision)                                        AS ultima_factura
      FROM fac_clientes c
      LEFT JOIN fac_facturas f ON f.cliente_id=c.id AND EXTRACT(YEAR FROM f.fecha_emision)=$1
      LEFT JOIN fac_pagos p ON p.factura_id=f.id
      WHERE c.activo=TRUE
      GROUP BY c.id ORDER BY facturado DESC
    `, [año]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE CONCEPTOS RH ──────────────────────
router.get('/rh', async (req, res) => {
  try {
    const { desde, hasta, cliente_id } = req.query;
    const params = []; let where = 'WHERE f.estatus != \'cancelada\'';
    if (desde)      { params.push(desde);      where += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta)      { params.push(hasta);      where += ` AND f.fecha_emision<=$${params.length}`; }
    if (cliente_id) { params.push(cliente_id); where += ` AND f.cliente_id=$${params.length}`; }

    const r = await query(`
      SELECT d.concepto,
        COUNT(d.id)::int           AS ocurrencias,
        COALESCE(SUM(d.monto),0)   AS total,
        COALESCE(AVG(d.monto),0)   AS promedio,
        COALESCE(MIN(d.monto),0)   AS minimo,
        COALESCE(MAX(d.monto),0)   AS maximo
      FROM fac_desglose_rh d
      JOIN fac_facturas f ON f.id=d.factura_id
      ${where}
      GROUP BY d.concepto ORDER BY total DESC
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE NÓMINA ────────────────────────────
router.get('/nomina', async (req, res) => {
  try {
    const { año = new Date().getFullYear() } = req.query;
    const r = await query(`
      SELECT q.quincena, q.fecha_inicio, q.fecha_fin, q.total_percepciones, q.total_deducciones, q.total_neto, q.estatus
      FROM fac_nomina_quincenas q
      WHERE EXTRACT(YEAR FROM q.fecha_inicio)=$1
      ORDER BY q.fecha_inicio
    `, [año]);

    const empleados = await query(`
      SELECT e.nombre, e.puesto, e.departamento,
        COALESCE(SUM(d.percepciones),0) AS total_percepciones,
        COALESCE(SUM(d.deducciones),0)  AS total_deducciones,
        COALESCE(SUM(d.neto),0)         AS total_neto
      FROM fac_empleados e
      LEFT JOIN fac_nomina_detalle d ON d.empleado_id=e.id
      LEFT JOIN fac_nomina_quincenas q ON q.id=d.quincena_id AND EXTRACT(YEAR FROM q.fecha_inicio)=$1
      WHERE e.activo=TRUE
      GROUP BY e.id ORDER BY total_neto DESC
    `, [año]);

    res.json({ quincenas: r.rows, por_empleado: empleados.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE EJECUTIVO ─────────────────────────
router.get('/ejecutivo', async (req, res) => {
  try {
    const { año = new Date().getFullYear() } = req.query;
    const r = await query(`
      SELECT
        EXTRACT(MONTH FROM f.fecha_emision)::int AS mes,
        COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0)          AS facturado,
        COALESCE(SUM(p.monto),0)                                                   AS cobrado,
        COALESCE(SUM(rh.monto),0)                                                  AS costo_rh,
        COUNT(DISTINCT f.id) FILTER (WHERE f.estatus != 'cancelada')::int          AS facturas,
        COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.estatus != 'cancelada')::int  AS clientes
      FROM fac_facturas f
      LEFT JOIN fac_pagos p ON p.factura_id=f.id AND EXTRACT(YEAR FROM p.fecha_pago)=$1
      LEFT JOIN fac_desglose_rh rh ON rh.factura_id=f.id
      WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1
      GROUP BY mes ORDER BY mes
    `, [año]);

    const nomMensual = await query(`
      SELECT EXTRACT(MONTH FROM fecha_inicio)::int AS mes, SUM(total_neto) AS nomina
      FROM fac_nomina_quincenas
      WHERE EXTRACT(YEAR FROM fecha_inicio)=$1
      GROUP BY mes ORDER BY mes
    `, [año]);

    res.json({ mensual: r.rows, nomina_mensual: nomMensual.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE COMISIONES ────────────────────────
router.get('/comisiones', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const params = [];
    let whereF = "WHERE f.estatus != 'cancelada'";
    if (desde) { params.push(desde); whereF += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta) { params.push(hasta); whereF += ` AND f.fecha_emision<=$${params.length}`; }

    // Detalle: una fila por factura con el monto de comisión del desglose
    const detalle = await query(`
      SELECT
        f.id, f.folio, f.fecha_emision, f.estatus,
        f.total AS total_factura,
        c.rfc, c.razon_social,
        COALESCE(SUM(p.monto),0)                                   AS cobrado,
        f.total - COALESCE(SUM(p.monto),0)                         AS saldo,
        COALESCE(SUM(d.monto) FILTER (
          WHERE UPPER(d.concepto) ILIKE '%COMISION%'
        ),0)                                                        AS comision_desglose,
        CASE WHEN f.estatus = 'pagada' THEN
          COALESCE(SUM(d.monto) FILTER (WHERE UPPER(d.concepto) ILIKE '%COMISION%'),0)
        ELSE 0 END                                                  AS comision_cobrada
      FROM fac_facturas f
      JOIN fac_clientes c ON c.id = f.cliente_id
      LEFT JOIN fac_pagos p ON p.factura_id = f.id
      LEFT JOIN fac_desglose_rh d ON d.factura_id = f.id
      ${whereF}
      GROUP BY f.id, c.rfc, c.razon_social
      HAVING COALESCE(SUM(d.monto) FILTER (WHERE UPPER(d.concepto) ILIKE '%COMISION%'),0) > 0
      ORDER BY c.razon_social, f.fecha_emision DESC
    `, params);

    // Resumen acumulado por cliente
    const resumen = await query(`
      SELECT
        c.rfc, c.razon_social,
        COUNT(DISTINCT f.id)::int                                          AS facturas,
        COALESCE(SUM(f.total),0)                                          AS facturado,
        COALESCE(SUM(p.monto),0)                                          AS cobrado,
        COALESCE(SUM(d.monto) FILTER (WHERE UPPER(d.concepto) ILIKE '%COMISION%'),0) AS total_comision,
        COALESCE(SUM(d.monto) FILTER (WHERE UPPER(d.concepto) ILIKE '%COMISION%' AND f.estatus='pagada'),0) AS comision_cobrada
      FROM fac_facturas f
      JOIN fac_clientes c ON c.id = f.cliente_id
      LEFT JOIN fac_pagos p ON p.factura_id = f.id
      LEFT JOIN fac_desglose_rh d ON d.factura_id = f.id
      ${whereF}
      GROUP BY c.rfc, c.razon_social
      HAVING COALESCE(SUM(d.monto) FILTER (WHERE UPPER(d.concepto) ILIKE '%COMISION%'),0) > 0
      ORDER BY total_comision DESC
    `, params);

    res.json({ resumen: resumen.rows, detalle: detalle.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADÍSTICAS POR CLIENTE ──────────────────
router.get('/cliente/:id', async (req, res) => {
  try {
    const [cliente, mensual, rh, historial] = await Promise.all([
      query(`SELECT * FROM fac_clientes WHERE id=$1`, [req.params.id]),
      query(`
        SELECT EXTRACT(YEAR FROM f.fecha_emision)::int AS año,
          EXTRACT(MONTH FROM f.fecha_emision)::int AS mes,
          COALESCE(SUM(f.total),0) AS facturado,
          COALESCE(SUM(p.monto),0) AS cobrado
        FROM fac_facturas f
        LEFT JOIN fac_pagos p ON p.factura_id=f.id
        WHERE f.cliente_id=$1 AND f.estatus != 'cancelada'
        GROUP BY año, mes ORDER BY año, mes
      `, [req.params.id]),
      query(`
        SELECT d.concepto, COALESCE(SUM(d.monto),0) AS total
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id=d.factura_id
        WHERE f.cliente_id=$1 AND f.estatus != 'cancelada'
        GROUP BY d.concepto ORDER BY total DESC
      `, [req.params.id]),
      query(`
        SELECT f.id, f.folio, f.fecha_emision, f.total, f.estatus,
          COALESCE(SUM(p.monto),0) AS cobrado,
          f.total - COALESCE(SUM(p.monto),0) AS saldo
        FROM fac_facturas f LEFT JOIN fac_pagos p ON p.factura_id=f.id
        WHERE f.cliente_id=$1
        GROUP BY f.id ORDER BY f.fecha_emision DESC LIMIT 20
      `, [req.params.id]),
    ]);

    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json({ cliente: cliente.rows[0], mensual: mensual.rows, rh: rh.rows, historial: historial.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
