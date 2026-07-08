const router = require('express').Router();
const { query, getClient } = require('../config/db');

// Helper: distribuir días de solicitud entre periodos (FIFO, más antiguos primero)
// Devuelve { asignaciones: [{periodo_id, num_periodo, dias}], resumen: "X días de P°Y + ..." }
async function distribuirDiasFIFO(client, empleadoId, diasTotales) {
  const r = await client.query(`
    SELECT id, num_periodo,
      dias_correspondientes - dias_tomados AS pendientes
    FROM fac_vacaciones_periodos
    WHERE empleado_id = $1
      AND dias_correspondientes - dias_tomados > 0
    ORDER BY num_periodo ASC
  `, [empleadoId]);

  const asignaciones = [];
  let faltan = parseFloat(diasTotales);
  for (const p of r.rows) {
    if (faltan <= 0) break;
    const pend = parseFloat(p.pendientes);
    const usar = Math.min(pend, faltan);
    asignaciones.push({ periodo_id: p.id, num_periodo: p.num_periodo, dias: +usar.toFixed(2) });
    faltan = +(faltan - usar).toFixed(2);
  }
  const ok = faltan <= 0.001;
  const resumen = asignaciones.length
    ? asignaciones.map(a => `${a.dias} día${a.dias!==1?'s':''} del P°${a.num_periodo}`).join(', ')
    : 'sin periodos disponibles';
  return { ok, asignaciones, resumen, faltantes: faltan };
}
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

// ── GUARDAR PERIODOS (upsert selectivo, preserva dias_tomados y solicitudes) ──
router.put('/empleados/:id/periodos', requireRol('admin', 'capturista'), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { periodos } = req.body; // [{num_periodo, dias_correspondientes, notas}]
    const empId = req.params.id;

    // Traer los periodos existentes
    const existentes = await client.query(
      `SELECT id, num_periodo, dias_tomados FROM fac_vacaciones_periodos WHERE empleado_id=$1`,
      [empId]
    );
    const porNum = new Map(existentes.rows.map(r => [r.num_periodo, r]));
    const numsEnviados = new Set();

    for (const p of (periodos || [])) {
      const num = parseInt(p.num_periodo) || 0;
      if (num <= 0) continue;
      numsEnviados.add(num);
      const dc  = parseFloat(p.dias_correspondientes) || 0;
      const not = p.notas || null;
      if (porNum.has(num)) {
        // UPDATE — solo dias_correspondientes y notas (dias_tomados se preserva)
        await client.query(
          `UPDATE fac_vacaciones_periodos
             SET dias_correspondientes=$1, notas=$2, actualizado_en=NOW()
           WHERE id=$3`,
          [dc, not, porNum.get(num).id]
        );
      } else {
        // INSERT nuevo periodo (dias_tomados=0)
        await client.query(
          `INSERT INTO fac_vacaciones_periodos(empleado_id, num_periodo, dias_correspondientes, dias_tomados, notas)
           VALUES($1,$2,$3,0,$4)`,
          [empId, num, dc, not]
        );
      }
    }

    // DELETE periodos que ya no se enviaron (solo si no tienen solicitudes asociadas)
    for (const [num, per] of porNum) {
      if (numsEnviados.has(num)) continue;
      const uso = await client.query(
        `SELECT COUNT(*)::int AS n FROM fac_vacaciones_solicitud_periodos WHERE periodo_id=$1`,
        [per.id]
      );
      if (uso.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `No se puede eliminar el periodo ${num}° porque tiene solicitudes vacacionales aplicadas. Elimina las solicitudes primero.`
        });
      }
      await client.query(`DELETE FROM fac_vacaciones_periodos WHERE id=$1`, [per.id]);
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
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
            fecha_regreso, observaciones, estatus, distribucion } = req.body;
    if (!empleado_id || !fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: 'Empleado y fechas son requeridas.' });
    const dias = parseFloat(dias_solicitados) || 0;
    if (dias <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Los días solicitados deben ser mayor a 0.' });
    }

    // Distribuir días — manual si viene distribucion, o FIFO automática
    const est = estatus || 'aprobada';
    let asignaciones = [];
    let resumen = null;
    if (est !== 'rechazada') {
      if (Array.isArray(distribucion) && distribucion.length) {
        // Distribución MANUAL: validar que cada periodo pertenece al empleado y tiene pendientes suficientes
        let sumaSolicitada = 0;
        for (const d of distribucion) {
          const usar = parseFloat(d.dias) || 0;
          if (usar <= 0) continue;
          const p = await client.query(
            `SELECT id, num_periodo, dias_correspondientes - dias_tomados AS pendientes
             FROM fac_vacaciones_periodos WHERE id=$1 AND empleado_id=$2`,
            [d.periodo_id, empleado_id]
          );
          if (!p.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Periodo ${d.periodo_id} no encontrado para este empleado.` });
          }
          const pend = parseFloat(p.rows[0].pendientes);
          if (usar > pend + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Periodo ${p.rows[0].num_periodo}° solo tiene ${pend.toFixed(1)} días pendientes, no se pueden aplicar ${usar}.` });
          }
          asignaciones.push({ periodo_id: p.rows[0].id, num_periodo: p.rows[0].num_periodo, dias: +usar.toFixed(2) });
          sumaSolicitada += usar;
        }
        if (Math.abs(sumaSolicitada - dias) > 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `La distribución (${sumaSolicitada.toFixed(1)}) no coincide con los días solicitados (${dias.toFixed(1)}).` });
        }
        resumen = asignaciones.map(a => `${a.dias} día${a.dias!==1?'s':''} del P°${a.num_periodo}`).join(', ');
      } else {
        // Distribución AUTOMÁTICA (FIFO)
        const dist = await distribuirDiasFIFO(client, empleado_id, dias);
        if (!dist.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `No hay días suficientes en los periodos. Faltan ${dist.faltantes.toFixed(1)} día${dist.faltantes!==1?'s':''}. Genera más periodos o ajusta los días.`
          });
        }
        asignaciones = dist.asignaciones;
        resumen = dist.resumen;
      }
    }

    // Insertar solicitud
    const r = await client.query(
      `INSERT INTO fac_vacaciones_solicitudes(
         empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
         fecha_regreso, periodos_aplicados, observaciones, estatus, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [empleado_id, fecha_solicitud || new Date(), fecha_inicio, fecha_fin, dias,
       fecha_regreso || null, resumen, observaciones || null, est, req.usuario.id]
    );
    const solId = r.rows[0].id;

    // Aplicar asignaciones: guardar y descontar de cada periodo
    for (const a of asignaciones) {
      await client.query(
        `INSERT INTO fac_vacaciones_solicitud_periodos(solicitud_id, periodo_id, dias_aplicados)
         VALUES($1, $2, $3)`,
        [solId, a.periodo_id, a.dias]
      );
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = dias_tomados + $1, actualizado_en=NOW()
         WHERE id = $2`,
        [a.dias, a.periodo_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...r.rows[0], asignaciones });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
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
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Recuperar las asignaciones para revertirlas
    const asig = await client.query(
      `SELECT periodo_id, dias_aplicados FROM fac_vacaciones_solicitud_periodos WHERE solicitud_id=$1`,
      [req.params.id]
    );
    for (const a of asig.rows) {
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = GREATEST(0, dias_tomados - $1), actualizado_en=NOW()
         WHERE id = $2`,
        [parseFloat(a.dias_aplicados), a.periodo_id]
      );
    }
    // ON DELETE CASCADE en fac_vacaciones_solicitud_periodos elimina las asignaciones
    await client.query(`DELETE FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, revertidos: asig.rows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
