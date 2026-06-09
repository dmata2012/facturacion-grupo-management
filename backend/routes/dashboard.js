const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken } = require('../middleware/auth');

router.use(verificarToken);

router.get('/', async (req, res) => {
  try {
    const { año = new Date().getFullYear() } = req.query;

    const [kpi, porEstatus, mensual, top5, cobranza, nomina, rh] = await Promise.all([
      // KPIs generales del año
      query(`
        SELECT
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0)              AS facturado,
          COALESCE(SUM(p.monto),0)                                                       AS cobrado,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada')),0)
            - COALESCE(SUM(p.monto) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada')),0) AS por_cobrar,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus='vencida'),0)
            - COALESCE(SUM(p.monto) FILTER (WHERE f.estatus='vencida'),0)                AS vencido,
          COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada')::int                       AS total_facturas,
          COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.estatus != 'cancelada')::int      AS clientes_activos
        FROM fac_facturas f
        LEFT JOIN fac_pagos p ON p.factura_id = f.id
        WHERE EXTRACT(YEAR FROM f.fecha_emision) = $1
      `, [año]),

      // Por estatus
      query(`
        SELECT estatus, COUNT(*)::int AS cantidad, COALESCE(SUM(total),0) AS monto
        FROM fac_facturas
        WHERE EXTRACT(YEAR FROM fecha_emision)=$1
        GROUP BY estatus
      `, [año]),

      // Facturado mensual vs cobrado
      query(`
        SELECT EXTRACT(MONTH FROM f.fecha_emision)::int AS mes,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0) AS facturado,
          COALESCE(SUM(p.monto),0) AS cobrado
        FROM fac_facturas f
        LEFT JOIN fac_pagos p ON p.factura_id=f.id AND EXTRACT(YEAR FROM p.fecha_pago)=$1
        WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
        GROUP BY mes ORDER BY mes
      `, [año]),

      // Top 5 clientes por facturación
      query(`
        SELECT c.razon_social,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0) AS facturado,
          COALESCE(SUM(p.monto),0) AS cobrado
        FROM fac_clientes c
        JOIN fac_facturas f ON f.cliente_id=c.id
        LEFT JOIN fac_pagos p ON p.factura_id=f.id
        WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
        GROUP BY c.id ORDER BY facturado DESC LIMIT 5
      `, [año]),

      // Facturas vencidas (cobranza urgente)
      query(`
        SELECT f.id, f.folio, f.fecha_vencimiento, c.razon_social,
          f.total - COALESCE(SUM(p.monto),0) AS saldo
        FROM fac_facturas f
        JOIN fac_clientes c ON c.id=f.cliente_id
        LEFT JOIN fac_pagos p ON p.factura_id=f.id
        WHERE f.estatus IN ('vencida','pendiente','parcial')
          AND f.fecha_vencimiento < CURRENT_DATE
        GROUP BY f.id, c.razon_social
        HAVING f.total - COALESCE(SUM(p.monto),0) > 0
        ORDER BY f.fecha_vencimiento
        LIMIT 10
      `, []),

      // Nómina del año
      query(`
        SELECT COALESCE(SUM(total_neto),0) AS total_nomina,
          COUNT(*)::int AS quincenas
        FROM fac_nomina_quincenas
        WHERE EXTRACT(YEAR FROM fecha_inicio)=$1 AND estatus='cerrada'
      `, [año]),

      // Desglose RH top conceptos
      query(`
        SELECT d.concepto, COALESCE(SUM(d.monto),0) AS total
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id=d.factura_id
        WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
        GROUP BY d.concepto ORDER BY total DESC LIMIT 8
      `, [año]),
    ]);

    res.json({
      kpi: kpi.rows[0],
      por_estatus: porEstatus.rows,
      mensual: mensual.rows,
      top5_clientes: top5.rows,
      cobranza_urgente: cobranza.rows,
      nomina: nomina.rows[0],
      rh_conceptos: rh.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
