const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Migración idempotente: datos personales del colaborador
(async () => {
  try {
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS fecha_nacimiento DATE`);
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS telefono TEXT`);
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS email TEXT`);
  } catch (e) { console.warn('Migración datos empleado:', e.message); }
})();

// ── EMPLEADOS ─────────────────────────────────
router.get('/empleados', async (req, res) => {
  try {
    const r = await query(`
      SELECT *,
        TO_CHAR(fecha_ingreso,'YYYY-MM-DD')     AS fecha_ingreso,
        TO_CHAR(fecha_nacimiento,'YYYY-MM-DD')  AS fecha_nacimiento
      FROM fac_empleados WHERE activo=TRUE ORDER BY nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/nomina/cumpleanos?mes=7 — calendario de cumpleaños
router.get('/cumpleanos', async (req, res) => {
  try {
    const { mes } = req.query;
    const params = [];
    let filtro = '';
    if (mes) { params.push(parseInt(mes)); filtro = ` AND EXTRACT(MONTH FROM fecha_nacimiento) = $${params.length}`; }
    const r = await query(`
      SELECT id, nombre, numero_colaborador, puesto, departamento,
        TO_CHAR(fecha_nacimiento,'YYYY-MM-DD') AS fecha_nacimiento,
        EXTRACT(DAY   FROM fecha_nacimiento)::int AS dia,
        EXTRACT(MONTH FROM fecha_nacimiento)::int AS mes,
        DATE_PART('year', AGE(fecha_nacimiento))::int AS edad,
        -- Días que faltan para el próximo cumpleaños
        (
          (DATE (EXTRACT(YEAR FROM CURRENT_DATE)::text || '-' ||
                 LPAD(EXTRACT(MONTH FROM fecha_nacimiento)::text,2,'0') || '-' ||
                 LPAD(EXTRACT(DAY   FROM fecha_nacimiento)::text,2,'0'))
           + CASE WHEN (EXTRACT(MONTH FROM fecha_nacimiento), EXTRACT(DAY FROM fecha_nacimiento))
                       < (EXTRACT(MONTH FROM CURRENT_DATE), EXTRACT(DAY FROM CURRENT_DATE))
                  THEN INTERVAL '1 year' ELSE INTERVAL '0' END
          )::date - CURRENT_DATE
        ) AS dias_faltan
      FROM fac_empleados
      WHERE activo = TRUE AND fecha_nacimiento IS NOT NULL${filtro}
      ORDER BY mes, dia
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/empleados', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { numero_colaborador, nombre, puesto, departamento, salario_base,
            fecha_ingreso, fecha_nacimiento, telefono, email, notas } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_empleados(numero_colaborador,nombre,puesto,departamento,salario_base,
         fecha_ingreso,fecha_nacimiento,telefono,email,notas)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [(numero_colaborador||'').toString().trim() || null,
       nombre, puesto, departamento, parseFloat(salario_base) || 0,
       fecha_ingreso || null, fecha_nacimiento || null,
       telefono || null, email || null, notas]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/empleados/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { numero_colaborador, nombre, puesto, departamento, salario_base,
            fecha_ingreso, fecha_nacimiento, telefono, email, activo, notas } = req.body;
    await query(
      `UPDATE fac_empleados SET numero_colaborador=$1,nombre=$2,puesto=$3,departamento=$4,
         salario_base=$5,fecha_ingreso=$6,fecha_nacimiento=$7,telefono=$8,email=$9,
         activo=$10,notas=$11,actualizado_en=NOW()
       WHERE id=$12`,
      [(numero_colaborador||'').toString().trim() || null,
       nombre, puesto, departamento, parseFloat(salario_base) || 0,
       fecha_ingreso || null, fecha_nacimiento || null,
       telefono || null, email || null, activo, notas, req.params.id]
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
    const { partidas } = req.body;
    // partidas: [{ empleado_id, pago_imss, pago_efectivo, total_isr, total_imss, costo_patronal_gm, notas }]
    const qId = req.params.id;

    await client.query(`DELETE FROM fac_nomina_detalle WHERE quincena_id=$1`, [qId]);

    let tPagoImss=0, tPagoEf=0, tNetoPag=0,
        tISR=0, tIMSS=0, tCostPat=0,
        tCostPatGM=0, tCostoGM=0;

    for (const p of (partidas || [])) {
      const pagoImss   = parseFloat(p.pago_imss)         || 0;
      const pagoEf     = parseFloat(p.pago_efectivo)     || 0;
      const totIsr     = parseFloat(p.total_isr)         || 0;
      const totImss    = parseFloat(p.total_imss)        || 0;
      const costPatGM  = parseFloat(p.costo_patronal_gm) || 0;

      const netoPagado = +(pagoImss + pagoEf).toFixed(2);
      const costPat    = +(totIsr + totImss).toFixed(2);
      const costoGM    = +(netoPagado + costPat + costPatGM).toFixed(2);

      // Para compatibilidad con totales antiguos: percepciones = neto_total_pagado
      await client.query(
        `INSERT INTO fac_nomina_detalle(
           quincena_id, empleado_id,
           percepciones, deducciones,
           pago_imss, pago_efectivo, neto_total_pagado,
           total_isr, total_imss, total_costos_patronales,
           costo_patronal_gm, costo_total_gm,
           notas
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [qId, p.empleado_id,
         netoPagado, 0,
         pagoImss, pagoEf, netoPagado,
         totIsr, totImss, costPat,
         costPatGM, costoGM,
         p.notas || null]
      );

      tPagoImss  += pagoImss;
      tPagoEf    += pagoEf;
      tNetoPag   += netoPagado;
      tISR       += totIsr;
      tIMSS      += totImss;
      tCostPat   += costPat;
      tCostPatGM += costPatGM;
      tCostoGM   += costoGM;
    }

    await client.query(
      `UPDATE fac_nomina_quincenas SET
         total_percepciones=$1, total_deducciones=0, total_neto=$1,
         total_pago_imss=$2, total_pago_efectivo=$3, total_neto_pagado=$4,
         total_isr=$5, total_imss=$6, total_costos_patronales=$7,
         total_costo_patronal_gm=$8, total_costo_gm=$9,
         actualizado_en=NOW()
       WHERE id=$10`,
      [tNetoPag, tPagoImss, tPagoEf, tNetoPag,
       tISR, tIMSS, tCostPat, tCostPatGM, tCostoGM, qId]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      total_pago_imss: tPagoImss, total_pago_efectivo: tPagoEf,
      total_neto_pagado: tNetoPag,
      total_isr: tISR, total_imss: tIMSS,
      total_costos_patronales: tCostPat,
      total_costo_patronal_gm: tCostPatGM,
      total_costo_gm: tCostoGM
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Guardar totales de quincena (captura global, sin desglose por empleado)
router.put('/quincenas/:id/totales', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { pago_imss, pago_efectivo, total_isr, total_imss, costo_patronal_gm, notas } = req.body;
    const pi   = parseFloat(pago_imss)         || 0;
    const pe   = parseFloat(pago_efectivo)     || 0;
    const ti   = parseFloat(total_isr)         || 0;
    const tm   = parseFloat(total_imss)        || 0;
    const cp   = parseFloat(costo_patronal_gm) || 0;
    const neto = +(pi + pe).toFixed(2);
    const cpat = +(ti + tm).toFixed(2);
    const tot  = +(neto + cpat + cp).toFixed(2);

    await query(
      `UPDATE fac_nomina_quincenas SET
         total_pago_imss=$1, total_pago_efectivo=$2, total_neto_pagado=$3,
         total_isr=$4, total_imss=$5, total_costos_patronales=$6,
         total_costo_patronal_gm=$7, total_costo_gm=$8,
         total_percepciones=$3, total_deducciones=0, total_neto=$3,
         notas=COALESCE($9, notas),
         actualizado_en=NOW()
       WHERE id=$10`,
      [pi, pe, neto, ti, tm, cpat, cp, tot, notas || null, req.params.id]
    );

    res.json({
      ok: true,
      total_pago_imss: pi, total_pago_efectivo: pe, total_neto_pagado: neto,
      total_isr: ti, total_imss: tm, total_costos_patronales: cpat,
      total_costo_patronal_gm: cp, total_costo_gm: tot
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cerrar quincena
router.patch('/quincenas/:id/cerrar', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_nomina_quincenas SET estatus='cerrada',actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reabrir quincena cerrada (requiere clave)
router.patch('/quincenas/:id/reabrir', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { clave } = req.body;
    const claveCorrecta = process.env.NOMINA_UNLOCK_KEY || 'grupo2026';
    if (!clave || clave !== claveCorrecta) {
      return res.status(403).json({ error: 'Clave incorrecta.' });
    }
    const r = await query(
      `UPDATE fac_nomina_quincenas SET estatus='abierta',actualizado_en=NOW()
       WHERE id=$1 AND estatus='cerrada' RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Quincena no encontrada o ya estaba abierta.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
