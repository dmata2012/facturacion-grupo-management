const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Los reportes son solo para admin, con una excepción: el Estado de Cuenta
// también lo consulta gerencia (es una vista de saldos por cliente, no un reporte
// operativo). Si en el futuro se abren más reportes a gerente, agregarlos aquí.
const RUTAS_GERENCIA = ['/estado-cuenta', '/concentrado'];
router.use((req, res, next) => {
  const roles = RUTAS_GERENCIA.includes(req.path) ? ['admin','gerente'] : ['admin'];
  return requireRol(...roles)(req, res, next);
});

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

// ── REPORTE CONCEPTOS RH / DESGLOSE ──────────
router.get('/rh', async (req, res) => {
  try {
    const { desde, hasta, cliente_id } = req.query;
    const params = [];
    let whereF = "WHERE f.estatus != 'cancelada'";
    if (desde)      { params.push(desde);      whereF += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta)      { params.push(hasta);      whereF += ` AND f.fecha_emision<=$${params.length}`; }
    if (cliente_id) { params.push(cliente_id); whereF += ` AND f.cliente_id=$${params.length}`; }

    const [resumen, detalle, kpiR] = await Promise.all([
      // Resumen agrupado por concepto
      query(`
        SELECT d.concepto,
          COUNT(DISTINCT f.id)::int  AS facturas,
          COUNT(d.id)::int           AS ocurrencias,
          COALESCE(SUM(d.monto),0)   AS total,
          COALESCE(AVG(d.monto),0)   AS promedio,
          COALESCE(MIN(d.monto),0)   AS minimo,
          COALESCE(MAX(d.monto),0)   AS maximo
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id=d.factura_id
        ${whereF}
        GROUP BY d.concepto ORDER BY total DESC
      `, params),

      // Detalle: una fila por partida de desglose con datos de la factura
      query(`
        SELECT f.id, f.folio, f.fecha_emision, f.estatus,
               f.total AS total_factura, f.desglose_validado,
               c.razon_social, c.rfc,
               d.concepto, d.monto, d.notas
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id = d.factura_id
        JOIN fac_clientes c ON c.id = f.cliente_id
        ${whereF}
        ORDER BY f.fecha_emision DESC, f.id, d.id
      `, params),

      // KPIs del período
      query(`
        SELECT
          COALESCE(SUM(d.monto), 0)                                        AS total_desglose,
          COUNT(DISTINCT d.factura_id)::int                                AS facturas_con_desglose,
          COUNT(DISTINCT f.id) FILTER (WHERE f.desglose_validado = TRUE)::int  AS cuadradas,
          COUNT(DISTINCT f.id) FILTER (WHERE f.desglose_validado = FALSE AND f.estatus != 'cancelada')::int AS pendientes,
          COUNT(DISTINCT f.cliente_id)::int                                AS clientes
        FROM fac_facturas f
        LEFT JOIN fac_desglose_rh d ON d.factura_id = f.id
        ${whereF}
      `, params),
    ]);

    res.json({
      resumen : resumen.rows,
      detalle : detalle.rows,
      kpi     : kpiR.rows[0] || {},
    });
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
// Muestra el monto del concepto "Comisiones" del desglose por factura/cliente
router.get('/comisiones', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const params = [];
    let filtroFecha = '';
    if (desde) { params.push(desde); filtroFecha += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta) { params.push(hasta); filtroFecha += ` AND f.fecha_emision<=$${params.length}`; }

    // ── Detalle: una fila por factura, sin cartesian product ──
    const detalle = await query(`
      SELECT
        f.id,
        f.folio,
        f.fecha_emision,
        f.estatus,
        f.total                                                  AS total_factura,
        c.rfc,
        c.razon_social,
        COALESCE(sub_p.cobrado, 0)                               AS cobrado,
        f.total - COALESCE(sub_p.cobrado, 0)                     AS saldo,
        COALESCE(sub_d.comision, 0)                              AS comision_desglose,
        CASE
          WHEN f.estatus = 'pagada'
            THEN COALESCE(sub_d.comision, 0)
          WHEN f.estatus = 'parcial' AND NULLIF(f.total,0) IS NOT NULL
            THEN ROUND(
              (COALESCE(sub_p.cobrado,0) / f.total)
              * COALESCE(sub_d.comision,0), 2)
          ELSE 0
        END                                                      AS comision_cobrada
      FROM fac_facturas f
      JOIN  fac_clientes c ON c.id = f.cliente_id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS cobrado
        FROM   fac_pagos
        GROUP  BY factura_id
      ) sub_p ON sub_p.factura_id = f.id
      INNER JOIN (
        SELECT factura_id, SUM(monto) AS comision
        FROM   fac_desglose_rh
        WHERE  concepto ILIKE '%comisi%'
        GROUP  BY factura_id
        HAVING SUM(monto) > 0
      ) sub_d ON sub_d.factura_id = f.id
      WHERE f.estatus != 'cancelada'
      ${filtroFecha}
      ORDER BY c.razon_social, f.fecha_emision DESC
    `, params);

    // ── Resumen acumulado por cliente ──
    const resumen = await query(`
      SELECT
        c.rfc,
        c.razon_social,
        COUNT(DISTINCT f.id)::int                         AS facturas,
        COALESCE(SUM(f.total), 0)                         AS facturado,
        COALESCE(SUM(sub_p.cobrado), 0)                   AS cobrado,
        COALESCE(SUM(sub_d.comision), 0)                  AS total_comision,
        COALESCE(SUM(
          CASE
            WHEN f.estatus = 'pagada'
              THEN sub_d.comision
            WHEN f.estatus = 'parcial' AND NULLIF(f.total,0) IS NOT NULL
              THEN ROUND((COALESCE(sub_p.cobrado,0)/f.total)*sub_d.comision, 2)
            ELSE 0
          END
        ), 0)                                             AS comision_cobrada
      FROM fac_facturas f
      JOIN  fac_clientes c ON c.id = f.cliente_id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS cobrado
        FROM   fac_pagos
        GROUP  BY factura_id
      ) sub_p ON sub_p.factura_id = f.id
      INNER JOIN (
        SELECT factura_id, SUM(monto) AS comision
        FROM   fac_desglose_rh
        WHERE  concepto ILIKE '%comisi%'
        GROUP  BY factura_id
        HAVING SUM(monto) > 0
      ) sub_d ON sub_d.factura_id = f.id
      WHERE f.estatus != 'cancelada'
      ${filtroFecha}
      GROUP BY c.rfc, c.razon_social
      ORDER BY total_comision DESC
    `, params);

    res.json({ resumen: resumen.rows, detalle: detalle.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANÁLISIS POR CONCEPTO DE DESGLOSE ────────
router.get('/concepto', async (req, res) => {
  try {
    const { concepto, desde, hasta } = req.query;
    if (!concepto) return res.status(400).json({ error: 'Parámetro concepto requerido.' });

    // El rango de fechas es opcional; cuando viene se aplica a todas las consultas.
    // $1 siempre es el concepto; las fechas ocupan $2/$3 según se reciban.
    const params = [`%${concepto}%`];
    let rango = '';
    if (desde) { params.push(desde); rango += ` AND f.fecha_emision >= $${params.length}`; }
    if (hasta) { params.push(hasta); rango += ` AND f.fecha_emision <= $${params.length}`; }
    const hayRango = !!(desde || hasta);

    // El facturado total (denominador de la participación) debe medirse en el mismo
    // período, si no el porcentaje compararía peras con manzanas.
    // Sus placeholders continúan la numeración de `params`, porque en la consulta
    // del KPI ambos arreglos se concatenan.
    const paramsTot = [];
    let rangoTot = '';
    const baseTot = params.length;
    if (desde) { paramsTot.push(desde); rangoTot += ` AND f2.fecha_emision >= $${baseTot + paramsTot.length}`; }
    if (hasta) { paramsTot.push(hasta); rangoTot += ` AND f2.fecha_emision <= $${baseTot + paramsTot.length}`; }

    const [mensual, topClientes, historico, kpiRes] = await Promise.all([

      // Evolución mensual (últimos 24 meses)
      query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', f.fecha_emision), 'YYYY-MM') AS periodo,
          EXTRACT(MONTH FROM f.fecha_emision)::int                  AS mes,
          EXTRACT(YEAR  FROM f.fecha_emision)::int                  AS año,
          COUNT(DISTINCT f.id)::int                                 AS facturas,
          COALESCE(SUM(d.monto), 0)                                 AS total
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id = d.factura_id
        WHERE d.concepto ILIKE $1
          AND f.estatus != 'cancelada'
          ${hayRango ? rango : `AND f.fecha_emision >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '23 months'`}
        GROUP BY periodo, mes, año
        ORDER BY periodo
      `, params),

      // Top 10 clientes por monto acumulado
      query(`
        SELECT
          c.razon_social,
          c.rfc,
          COUNT(DISTINCT f.id)::int  AS facturas,
          COALESCE(SUM(d.monto), 0) AS total
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id = d.factura_id
        JOIN fac_clientes c ON c.id = f.cliente_id
        WHERE d.concepto ILIKE $1
          AND f.estatus != 'cancelada'${rango}
        GROUP BY c.id, c.razon_social, c.rfc
        ORDER BY total DESC
        LIMIT 10
      `, params),

      // Crecimiento histórico anual
      query(`
        SELECT
          EXTRACT(YEAR FROM f.fecha_emision)::int AS año,
          COALESCE(SUM(d.monto), 0)               AS total,
          COUNT(DISTINCT f.id)::int               AS facturas
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id = d.factura_id
        WHERE d.concepto ILIKE $1
          AND f.estatus != 'cancelada'${rango}
        GROUP BY año
        ORDER BY año
      `, params),

      // KPI: participación, ocurrencias, clientes
      query(`
        SELECT
          COALESCE(SUM(d.monto), 0)                                                        AS concepto_total,
          COUNT(DISTINCT d.id)::int                                                         AS ocurrencias,
          COUNT(DISTINCT f.cliente_id)::int                                                 AS clientes,
          (SELECT COALESCE(SUM(f2.total),0) FROM fac_facturas f2
            WHERE f2.estatus != 'cancelada'${rangoTot}) AS total_facturado
        FROM fac_desglose_rh d
        JOIN fac_facturas f ON f.id = d.factura_id
        WHERE d.concepto ILIKE $1
          AND f.estatus != 'cancelada'${rango}
      `, [...params, ...paramsTot]),
    ]);

    res.json({
      mensual     : mensual.rows,
      top_clientes: topClientes.rows,
      historico   : historico.rows,
      kpi         : kpiRes.rows[0] || {},
      periodo     : { desde: desde || null, hasta: hasta || null },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADO DE CUENTA: clientes + sus facturas ──
router.get('/estado-cuenta', async (req, res) => {
  try {
    const { buscar, solo_saldo } = req.query;
    const params = [];
    // Los clientes que solo tienen ingreso sin factura no se persiguen por
    // cobranza: sin esto saldrian aqui con cero facturas y saldo cero.
    let whereCli = 'WHERE c.activo = TRUE AND COALESCE(c.solo_sf, FALSE) = FALSE';
    if (buscar) {
      params.push(`%${buscar}%`);
      whereCli += ` AND (c.razon_social ILIKE $${params.length} OR c.rfc ILIKE $${params.length} OR c.nombre_comercial ILIKE $${params.length})`;
    }

    // Traer clientes con totales agregados
    const clientes = await query(`
      SELECT c.id, c.rfc, c.razon_social, c.nombre_comercial, c.ejecutivo_cuenta,
        COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada')::int           AS facturas,
        COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0)  AS facturado,
        COALESCE(SUM(sub_p.cobrado),0)                                     AS cobrado,
        COALESCE(SUM(
          CASE WHEN f.estatus NOT IN ('cancelada','pagada')
               THEN f.total - COALESCE(sub_p.cobrado,0) ELSE 0 END
        ),0)                                                                AS saldo,
        COALESCE(SUM(
          CASE WHEN f.estatus NOT IN ('cancelada','pagada')
                AND f.fecha_vencimiento < CURRENT_DATE
               THEN f.total - COALESCE(sub_p.cobrado,0) ELSE 0 END
        ),0)                                                                AS vencido
      FROM fac_clientes c
      LEFT JOIN fac_facturas f ON f.cliente_id = c.id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
      ) sub_p ON sub_p.factura_id = f.id
      ${whereCli}
      GROUP BY c.id
      ORDER BY saldo DESC, c.razon_social
    `, params);

    let lista = clientes.rows;
    if (solo_saldo === 'true') lista = lista.filter(c => parseFloat(c.saldo) > 0);

    // Traer todas las facturas (no canceladas) de esos clientes
    const ids = lista.map(c => c.id);
    let facturas = [];
    if (ids.length) {
      const fr = await query(`
        SELECT f.id, f.cliente_id, f.folio, f.fecha_emision, f.fecha_vencimiento,
               f.total, f.estatus, f.desglose_validado,
               COALESCE(sub_p.cobrado,0)                  AS cobrado,
               f.total - COALESCE(sub_p.cobrado,0)        AS saldo
        FROM fac_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
        ) sub_p ON sub_p.factura_id = f.id
        WHERE f.cliente_id = ANY($1::int[]) AND f.estatus != 'cancelada'
        ORDER BY f.fecha_emision DESC
      `, [ids]);
      facturas = fr.rows;
    }

    // Adjuntar facturas a cada cliente
    const byCli = {};
    facturas.forEach(f => { (byCli[f.cliente_id] = byCli[f.cliente_id] || []).push(f); });
    lista.forEach(c => { c.facturas = byCli[c.id] || []; });

    res.json(lista);
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

// ══ CONCENTRADO DE INGRESOS Y GASTOS ═══════════════════════════════
// Matriz concepto × mes del año, en el formato que dirección ya usaba en Excel.
//
// El ingreso NO es lo facturado: el grupo factura la nómina completa del cliente
// (sueldos, IMSS, ISN…) pero de eso solo le pertenece la comisión. El resto es
// dinero de paso. Por eso el bloque de ingresos toma únicamente los conceptos de
// desglose de Comisiones y Otros.
//
// base=cobrado (predeterminado): los ingresos se reconocen cuando entran, por
// fecha de pago, que es lo que significa "efectivamente cobrado".
router.get('/concentrado', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear();
    const baseGasto = req.query.base_gasto === 'pagado' ? 'pagado' : 'devengado';
    const vacio = () => Array(12).fill(0);

    // ── INGRESOS: la parte cobrada que corresponde a comisión y a otros ──
    // Un pago cubre una porción de la factura, así que se reparte en la misma
    // proporción que el desglose. Sin esto, un abono parcial contaría comisión
    // completa y el mes saldría inflado.
    const ing = await query(`
      WITH pagos_mes AS (
        SELECT p.factura_id,
               EXTRACT(MONTH FROM p.fecha_pago)::int AS mes,
               SUM(p.monto) AS pagado
          FROM fac_pagos p
         WHERE EXTRACT(YEAR FROM p.fecha_pago) = $1
         GROUP BY 1, 2
      ),
      desg AS (
        SELECT factura_id,
               COALESCE(SUM(monto) FILTER (WHERE UPPER(concepto) LIKE '%COMISI%'),0) AS comision,
               COALESCE(SUM(monto) FILTER (WHERE UPPER(concepto) LIKE '%OTRO%'),0)   AS otros
          FROM fac_desglose_rh
         GROUP BY 1
      )
      SELECT COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social, 'Sin cliente') AS cliente,
             pm.mes,
             SUM(pm.pagado * d.comision / NULLIF(f.total,0)) AS comision,
             SUM(pm.pagado * d.otros    / NULLIF(f.total,0)) AS otros
        FROM pagos_mes pm
        JOIN fac_facturas f ON f.id = pm.factura_id
        LEFT JOIN fac_clientes c ON c.id = f.cliente_id
        JOIN desg d ON d.factura_id = pm.factura_id
       GROUP BY 1, 2
    `, [anio]);

    // ── INGRESOS SIN FACTURA ──
    // Fuente independiente: no hay comprobante que desglosar ni pago parcial que
    // prorratear, el monto cobrado es el ingreso. La tabla puede no existir
    // todavia si el modulo aun no se ha desplegado, por eso el try.
    let sinFactura = [];
    try {
      const isf = await query(`
        SELECT COALESCE(t.nombre,'Sin tipo') AS tipo,
               COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente,
               EXTRACT(MONTH FROM i.fecha_cobro)::int AS mes,
               SUM(i.monto) AS monto
          FROM fac_ingresos_sf i
          JOIN fac_clientes c ON c.id = i.cliente_id
          LEFT JOIN fac_ingresos_sf_tipos t ON t.id = i.tipo_id
         WHERE EXTRACT(YEAR FROM i.fecha_cobro) = $1
         GROUP BY 1, 2, 3
      `, [anio]);
      sinFactura = isf.rows;
    } catch (e) { sinFactura = []; }

    const armaGrupo = (titulo, campo) => {
      const porCliente = {};
      ing.rows.forEach(r => {
        const v = parseFloat(r[campo]) || 0;
        if (!v) return;
        const f = porCliente[r.cliente] || (porCliente[r.cliente] = { nombre: r.cliente, meses: vacio(), total: 0 });
        f.meses[r.mes - 1] += v;
        f.total += v;
      });
      const filas = Object.values(porCliente).sort((a, b) => b.total - a.total);
      const meses = vacio();
      filas.forEach(f => f.meses.forEach((v, i) => { meses[i] += v; }));
      return { titulo, filas, meses, total: meses.reduce((a, b) => a + b, 0) };
    };
    const facturados = [armaGrupo('COMISIONES', 'comision'), armaGrupo('OTROS INGRESOS', 'otros')];

    // Un grupo por tipo del catalogo, con su desglose por cliente
    const porTipo = {};
    sinFactura.forEach(r => {
      const g = porTipo[r.tipo] || (porTipo[r.tipo] = {});
      const f = g[r.cliente] || (g[r.cliente] = { nombre: r.cliente, meses: vacio(), total: 0 });
      const v = parseFloat(r.monto) || 0;
      f.meses[r.mes - 1] += v;
      f.total += v;
    });
    const noFacturados = Object.keys(porTipo).map(tipo => {
      const filas = Object.values(porTipo[tipo]).sort((a, b) => b.total - a.total);
      const meses = vacio();
      filas.forEach(f => f.meses.forEach((v, i) => { meses[i] += v; }));
      return { titulo: tipo.toUpperCase(), filas, meses, total: meses.reduce((a, b) => a + b, 0) };
    }).sort((a, b) => b.total - a.total);

    const suma = arr => {
      const m = vacio();
      arr.forEach(g => g.meses.forEach((v, i) => { m[i] += v; }));
      return m;
    };
    const mesesFac = suma(facturados);
    const mesesSF  = suma(noFacturados);
    const mesesIng = mesesFac.map((v, i) => v + mesesSF[i]);
    const grupos = [...facturados, ...noFacturados];

    // ── GASTOS: por concepto, separados en bloques según su categoría ──
    // Con base "pagado" solo cuenta lo liquidado y en el mes en que se pagó; el
    // gasto sin fecha de pago simplemente no aparece.
    const campoFecha = baseGasto === 'pagado' ? 'g.fecha_pago' : 'g.fecha';
    const filtroPago = baseGasto === 'pagado'
      ? 'AND g.fecha_pago IS NOT NULL AND COALESCE(g.pagado,0) > 0' : '';
    const montoCol = baseGasto === 'pagado' ? 'LEAST(COALESCE(g.pagado,0), g.monto)' : 'g.monto';

    const gas = await query(`
      SELECT COALESCE(k.bloque,'operacion')          AS bloque,
             COALESCE(c.nombre,'Sin clasificar')     AS concepto,
             COALESCE(c.orden, 999)                  AS orden,
             COALESCE(k.nombre,'Sin categoría')      AS categoria,
             EXTRACT(MONTH FROM ${campoFecha})::int  AS mes,
             SUM(${montoCol})                        AS monto
        FROM fac_gastos g
        LEFT JOIN fac_gastos_conceptos  c ON c.id = g.concepto_id
        LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
       WHERE EXTRACT(YEAR FROM ${campoFecha}) = $1 ${filtroPago}
       GROUP BY 1, 2, 3, 4, 5
    `, [anio]);

    const armaBloque = (titulo, clave) => {
      const porConcepto = {};
      gas.rows.filter(r => r.bloque === clave).forEach(r => {
        const v = parseFloat(r.monto) || 0;
        const f = porConcepto[r.concepto] ||
          (porConcepto[r.concepto] = { nombre: r.concepto, categoria: r.categoria, orden: r.orden, meses: vacio(), total: 0 });
        f.meses[r.mes - 1] += v;
        f.total += v;
      });
      const filas = Object.values(porConcepto).sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));
      const meses = vacio();
      filas.forEach(f => f.meses.forEach((v, i) => { meses[i] += v; }));
      return { titulo, clave, filas, meses, total: meses.reduce((a, b) => a + b, 0) };
    };
    const bloques = [
      armaBloque('GASTOS DE OPERACIÓN', 'operacion'),
      armaBloque('GASTOS DE PAGO DE IMPUESTOS', 'impuestos')
    ];
    const mesesGas = vacio();
    bloques.forEach(b => b.meses.forEach((v, i) => { mesesGas[i] += v; }));

    const utilidad = mesesIng.map((v, i) => v - mesesGas[i]);

    // Cuántas categorías están marcadas como impuestos: si son cero, la pantalla
    // explica que el bloque sale vacío porque falta clasificarlas, no por falta
    // de datos.
    const catImp = await query(
      `SELECT COUNT(*)::int AS n FROM fac_gastos_categorias WHERE bloque='impuestos' AND activa`);

    res.json({
      anio, base_gasto: baseGasto,
      ingresos: {
        grupos,
        facturado:    { grupos: facturados,    meses: mesesFac, total: mesesFac.reduce((a, b) => a + b, 0) },
        no_facturado: { grupos: noFacturados,  meses: mesesSF,  total: mesesSF.reduce((a, b) => a + b, 0) },
        meses: mesesIng, total: mesesIng.reduce((a, b) => a + b, 0)
      },
      gastos:   { bloques, meses: mesesGas, total: mesesGas.reduce((a, b) => a + b, 0) },
      utilidad: { meses: utilidad, total: utilidad.reduce((a, b) => a + b, 0) },
      categorias_impuestos: catImp.rows[0].n
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
