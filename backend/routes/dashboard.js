const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);
// Dashboard solo para admin (no capturista)
router.use(requireRol('admin'));

router.get('/', async (req, res) => {
  try {
    const { año = new Date().getFullYear() } = req.query;

    const [kpi, porEstatus, mensual, top5, cobranza, nomina, rh] = await Promise.all([
      // KPIs generales del año
      // 'por_cobrar' y 'vencido' excluyen a los clientes que no requieren desglose,
      // igual que los KPIs del módulo Cobranza. 'facturado' y 'cobrado' sí los incluyen
      // porque son montos históricos reales, no saldos pendientes.
      query(`
        SELECT
          COALESCE(SUM(f.total)     FILTER (WHERE f.estatus != 'cancelada'),0)           AS facturado,
          COALESCE(SUM(pg.cobrado)  FILTER (WHERE f.estatus != 'cancelada'),0)           AS cobrado,
          COALESCE(SUM(pg.cobrado)  FILTER (WHERE f.estatus  = 'cancelada'),0)           AS cobrado_canceladas,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada') AND COALESCE(c.aplica_desglose,TRUE)),0)
            - COALESCE(SUM(pg.cobrado) FILTER (WHERE f.estatus NOT IN ('cancelada','pagada') AND COALESCE(c.aplica_desglose,TRUE)),0) AS por_cobrar,
          COALESCE(SUM(f.total) FILTER (WHERE f.estatus='vencida' AND COALESCE(c.aplica_desglose,TRUE)),0)
            - COALESCE(SUM(pg.cobrado) FILTER (WHERE f.estatus='vencida' AND COALESCE(c.aplica_desglose,TRUE)),0) AS vencido,
          COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada')::int                       AS total_facturas,
          COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada'
                                AND COALESCE(pg.cobrado,0) > f.total + 0.01)::int        AS facturas_sobrepagadas,
          COALESCE(SUM(GREATEST(COALESCE(pg.cobrado,0) - f.total, 0))
                   FILTER (WHERE f.estatus != 'cancelada'),0)                            AS sobrepago,
          COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.estatus != 'cancelada')::int      AS clientes_activos
        FROM fac_facturas f
        -- Los pagos se agregan por factura ANTES de unir: con el LEFT JOIN directo
        -- una factura con tres pagos aparecia tres veces y su total se sumaba tres
        -- veces en facturado y en el conteo de facturas.
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) pg ON pg.factura_id = f.id
        LEFT JOIN fac_clientes c ON c.id = f.cliente_id
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
          COALESCE(SUM(f.total),0)         AS facturado,
          COALESCE(SUM(pg.cobrado),0)      AS cobrado
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos
           WHERE EXTRACT(YEAR FROM fecha_pago)=$1 GROUP BY factura_id
        ) pg ON pg.factura_id = f.id
        WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
        GROUP BY mes ORDER BY mes
      `, [año]),

      // Top 5 clientes por facturación
      query(`
        SELECT c.razon_social,
          COALESCE(SUM(f.total),0)    AS facturado,
          COALESCE(SUM(pg.cobrado),0) AS cobrado
        FROM fac_clientes c
        JOIN fac_facturas f ON f.cliente_id=c.id
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) pg ON pg.factura_id = f.id
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
        SELECT d.concepto, COALESCE(SUM(d.monto),0) AS total, COUNT(*)::int AS veces
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id=d.factura_id
        WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
        GROUP BY d.concepto ORDER BY total DESC LIMIT 10
      `, [año]),
    ]);

    // Consultas extra de desglose (separadas para no romper el Promise.all)
    let rhMensual = { rows: [] }, rhCliente = { rows: [] }, rhKpi = { rows: [{}] };
    try {
      [rhMensual, rhCliente, rhKpi] = await Promise.all([
        query(`
          SELECT EXTRACT(MONTH FROM f.fecha_emision)::int AS mes,
                 d.concepto, COALESCE(SUM(d.monto),0) AS total
          FROM fac_desglose_rh d
          JOIN fac_facturas f ON f.id=d.factura_id
          WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
          GROUP BY mes, d.concepto ORDER BY mes
        `, [año]),
        query(`
          SELECT c.razon_social, COALESCE(SUM(d.monto),0) AS total_desglose,
                 COUNT(DISTINCT f.id)::int AS facturas_con_desglose
          FROM fac_desglose_rh d
          JOIN fac_facturas f ON f.id=d.factura_id
          JOIN fac_clientes c ON c.id=f.cliente_id
          WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1 AND f.estatus != 'cancelada'
          GROUP BY c.id, c.razon_social ORDER BY total_desglose DESC LIMIT 8
        `, [año]),
        query(`
          SELECT
            COUNT(DISTINCT f.id) FILTER (WHERE f.desglose_validado=TRUE)::int AS cuadradas,
            COUNT(DISTINCT f.id) FILTER (WHERE f.desglose_validado=FALSE AND f.estatus!='cancelada')::int AS pendientes,
            COALESCE(SUM(d.monto),0) AS total_desglose,
            COUNT(d.id)::int AS total_partidas,
            COUNT(DISTINCT d.factura_id)::int AS facturas_con_desglose
          FROM fac_facturas f
          LEFT JOIN fac_desglose_rh d ON d.factura_id=f.id
          WHERE EXTRACT(YEAR FROM f.fecha_emision)=$1
        `, [año]),
      ]);
    } catch(e2) { console.warn('Desglose stats warning:', e2.message); }

    res.json({
      kpi: kpi.rows[0],
      por_estatus: porEstatus.rows,
      mensual: mensual.rows,
      top5_clientes: top5.rows,
      cobranza_urgente: cobranza.rows,
      nomina: nomina.rows[0],
      rh_conceptos: rh.rows,
      rh_mensual: rhMensual.rows,
      rh_clientes: rhCliente.rows,
      rh_kpi: rhKpi.rows[0] || {},
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
