const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Tabla LFT (post-reforma 2023): años cumplidos → días de vacaciones
function diasPorAnio(anio) {
  if (anio <= 0)  return 0;
  if (anio === 1) return 12;
  if (anio === 2) return 14;
  if (anio === 3) return 16;
  if (anio === 4) return 18;
  if (anio === 5) return 20;
  if (anio <= 10) return 22;
  if (anio <= 15) return 24;
  if (anio <= 20) return 26;
  if (anio <= 25) return 28;
  if (anio <= 30) return 30;
  return 32;
}

function anios(fechaIngreso) {
  if (!fechaIngreso) return 0;
  const ing = new Date(fechaIngreso);
  const hoy = new Date();
  let a = hoy.getFullYear() - ing.getFullYear();
  const m = hoy.getMonth() - ing.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < ing.getDate())) a--;
  return Math.max(0, a);
}

// ── LISTAR EMPLEADOS CON RESUMEN VACACIONAL ──
router.get('/empleados', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.id, e.nombre, e.puesto, e.departamento, e.fecha_ingreso,
        COALESCE(SUM(p.dias_correspondientes),0) AS dias_total,
        COALESCE(SUM(p.dias_tomados),0)          AS dias_tomados,
        COALESCE(SUM(p.dias_correspondientes - p.dias_tomados),0) AS dias_pendientes
      FROM fac_empleados e
      LEFT JOIN fac_vacaciones_periodos p ON p.empleado_id = e.id
      WHERE e.activo = TRUE
      GROUP BY e.id
      ORDER BY e.nombre
    `);
    res.json(r.rows.map(emp => ({ ...emp, antiguedad_anios: anios(emp.fecha_ingreso) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE: PERIODOS POR VENCER ──
// Cada periodo se gana cuando se cumple ese año de antigüedad
// Por LFT vencen 6 meses después de cumplido el año
router.get('/por-vencer', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        e.id          AS empleado_id,
        e.nombre, e.puesto, e.departamento, e.fecha_ingreso,
        p.num_periodo,
        p.dias_correspondientes,
        p.dias_tomados,
        (p.dias_correspondientes - p.dias_tomados)::numeric AS dias_pendientes,
        (e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL)::date              AS fecha_ganado,
        (e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL + INTERVAL '6 months')::date AS fecha_vence,
        ((e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL + INTERVAL '6 months')::date - CURRENT_DATE) AS dias_para_vencer
      FROM fac_empleados e
      JOIN fac_vacaciones_periodos p ON p.empleado_id = e.id
      WHERE e.activo = TRUE
        AND e.fecha_ingreso IS NOT NULL
        AND p.dias_correspondientes - p.dias_tomados > 0
      ORDER BY fecha_vence ASC, e.nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DETALLE DE UN EMPLEADO ──
router.get('/empleados/:id', async (req, res) => {
  try {
    const emp = await query(`SELECT * FROM fac_empleados WHERE id=$1`, [req.params.id]);
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });

    const periodos = await query(`
      SELECT * FROM fac_vacaciones_periodos WHERE empleado_id=$1 ORDER BY num_periodo
    `, [req.params.id]);

    const solicitudes = await query(`
      SELECT * FROM fac_vacaciones_solicitudes WHERE empleado_id=$1 ORDER BY fecha_solicitud DESC, id DESC
    `, [req.params.id]);

    const e = emp.rows[0];
    res.json({
      ...e,
      antiguedad_anios: anios(e.fecha_ingreso),
      periodos: periodos.rows,
      solicitudes: solicitudes.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GENERAR PERIODOS POR ANTIGÜEDAD ──
router.post('/empleados/:id/generar-periodos', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const emp = await query(`SELECT fecha_ingreso FROM fac_empleados WHERE id=$1`, [req.params.id]);
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });
    const a = anios(emp.rows[0].fecha_ingreso);
    if (a < 1) return res.json({ ok: true, periodos_creados: 0, mensaje: 'Aún no cumple 1 año.' });

    let creados = 0;
    for (let n = 1; n <= a; n++) {
      const dias = diasPorAnio(n);
      const r = await query(
        `INSERT INTO fac_vacaciones_periodos(empleado_id, num_periodo, dias_correspondientes)
         VALUES($1, $2, $3)
         ON CONFLICT (empleado_id, num_periodo) DO NOTHING
         RETURNING id`,
        [req.params.id, n, dias]
      );
      if (r.rowCount) creados++;
    }
    res.json({ ok: true, periodos_creados: creados, antiguedad: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GUARDAR PERIODOS (replace) ──
router.put('/empleados/:id/periodos', requireRol('admin', 'capturista'), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { periodos } = req.body; // [{num_periodo, dias_correspondientes, dias_tomados, notas}]
    await client.query(`DELETE FROM fac_vacaciones_periodos WHERE empleado_id=$1`, [req.params.id]);
    for (const p of (periodos || [])) {
      await client.query(
        `INSERT INTO fac_vacaciones_periodos(empleado_id, num_periodo, dias_correspondientes, dias_tomados, notas)
         VALUES($1,$2,$3,$4,$5)`,
        [req.params.id, parseInt(p.num_periodo) || 0,
         parseFloat(p.dias_correspondientes) || 0,
         parseFloat(p.dias_tomados) || 0,
         p.notas || null]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── CREAR SOLICITUD ──
router.post('/solicitudes', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
            fecha_regreso, periodos_aplicados, observaciones, estatus } = req.body;
    if (!empleado_id || !fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: 'Empleado y fechas son requeridas.' });

    const r = await query(
      `INSERT INTO fac_vacaciones_solicitudes(
         empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
         fecha_regreso, periodos_aplicados, observaciones, estatus, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [empleado_id, fecha_solicitud || new Date(), fecha_inicio, fecha_fin,
       parseFloat(dias_solicitados) || 0,
       fecha_regreso || null, periodos_aplicados || null, observaciones || null,
       estatus || 'aprobada', req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET SOLICITUD ──
router.get('/solicitudes/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT s.*, e.nombre, e.puesto, e.departamento, e.fecha_ingreso
      FROM fac_vacaciones_solicitudes s
      JOIN fac_empleados e ON e.id = s.empleado_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ELIMINAR SOLICITUD ──
router.delete('/solicitudes/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
