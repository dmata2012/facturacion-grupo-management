const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken } = require('../middleware/auth');
const { NIVEL, permiso } = require('../middleware/permiso');

router.use(verificarToken);

// ═══ PROGRAMACIÓN DE PAGOS (TESORERÍA) ══════════════
// Agenda de lo que hay que pagar y cuándo. Es un módulo independiente: cada
// compromiso se captura aquí a mano (renta, impuestos, créditos, proveedores
// que no pasaron por CxP). No lee ni escribe en Gastos (CxP), que lleva su
// propio control de pago, ni genera movimiento bancario al liquidar: la cuenta
// solo se registra como el origen previsto del dinero.
//
// "Vencido" no se guarda: es estar programado con la fecha ya pasada. Si fuera
// una columna habría que recalcularla todos los días y quedaría desfasada.
const ESTATUS = ['programado', 'pagado', 'cancelado'];
const PRIORIDADES = ['alta', 'normal', 'baja'];

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_pagos_programados (
        id SERIAL PRIMARY KEY,
        beneficiario TEXT NOT NULL,
        concepto TEXT,
        monto NUMERIC(14,2) NOT NULL,
        fecha_programada DATE NOT NULL,
        -- Sin FOREIGN KEY a propósito: la tabla de cuentas la crea bancos.js en
        -- su propia migración de arranque, y una FK aquí ataría esta migración
        -- al orden en que se cargan los módulos. Se valida al capturar.
        cuenta_id INT,
        forma_pago TEXT DEFAULT 'transferencia',
        referencia TEXT,
        prioridad TEXT NOT NULL DEFAULT 'normal',
        estatus TEXT NOT NULL DEFAULT 'programado',
        pagado_en DATE,
        pago_referencia TEXT,
        pago_notas TEXT,
        notas TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW(),
        CHECK (monto > 0),
        CHECK (estatus IN ('programado','pagado','cancelado')),
        CHECK (prioridad IN ('alta','normal','baja'))
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pprog_fecha   ON fac_pagos_programados(fecha_programada)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pprog_estatus ON fac_pagos_programados(estatus)`);
    console.log('✔ Programación de Pagos: tablas listas');
  } catch (e) { console.warn('Migración programación de pagos:', e.message); }
})();

// El nombre de la cuenta se resuelve aparte y no con un JOIN: si el módulo de
// bancos todavía no creó sus tablas, un JOIN tumbaría el listado completo en
// vez de dejar los pagos sin el nombre de la cuenta, que es lo prescindible.
async function nombresDeCuentas() {
  try {
    const r = await query(
      `SELECT c.id,
              COALESCE(NULLIF(TRIM(c.alias),''), c.banco) AS nombre,
              c.banco, c.numero_cuenta
         FROM fac_bancos_cuentas c`);
    return new Map(r.rows.map(c => [c.id, c]));
  } catch { return new Map(); }
}

function filtros(q) {
  const { estatus, desde, hasta, cuenta_id, prioridad, buscar } = q;
  const params = [];
  let where = 'WHERE 1=1';

  // 'vencido' es un filtro de pantalla, no un estatus almacenado
  if (estatus === 'vencido') {
    where += ` AND p.estatus='programado' AND p.fecha_programada < CURRENT_DATE`;
  } else if (estatus === 'por_pagar') {
    where += ` AND p.estatus='programado'`;
  } else if (estatus && ESTATUS.includes(estatus)) {
    params.push(estatus); where += ` AND p.estatus=$${params.length}`;
  }

  if (desde)     { params.push(desde);     where += ` AND p.fecha_programada >= $${params.length}`; }
  if (hasta)     { params.push(hasta);     where += ` AND p.fecha_programada <= $${params.length}`; }
  if (cuenta_id) { params.push(cuenta_id); where += ` AND p.cuenta_id = $${params.length}`; }
  if (prioridad && PRIORIDADES.includes(prioridad)) {
    params.push(prioridad); where += ` AND p.prioridad = $${params.length}`;
  }
  if (buscar) {
    params.push(`%${buscar}%`);
    where += ` AND (p.beneficiario ILIKE $${params.length} OR p.concepto ILIKE $${params.length}
                    OR p.referencia ILIKE $${params.length} OR p.notas ILIKE $${params.length})`;
  }
  return { where, params };
}

// ═══ LISTADO ════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { where, params } = filtros(req.query);

    const r = await query(`
      SELECT p.*,
             TO_CHAR(p.fecha_programada,'YYYY-MM-DD') AS fecha_programada,
             TO_CHAR(p.pagado_en,'YYYY-MM-DD')        AS pagado_en,
             (p.estatus='programado' AND p.fecha_programada < CURRENT_DATE) AS vencido,
             (p.fecha_programada - CURRENT_DATE)::int AS dias,
             u.nombre AS capturado_por
        FROM fac_pagos_programados p
        LEFT JOIN fac_usuarios u ON u.id = p.creado_por
        ${where}
        ORDER BY
          CASE p.estatus WHEN 'programado' THEN 0 WHEN 'pagado' THEN 1 ELSE 2 END,
          p.fecha_programada ASC, p.id ASC
        LIMIT 500
    `, params);

    // Totales de TODO lo filtrado, no solo de lo que cabe en el límite
    const tot = await query(`
      SELECT
        COUNT(*) FILTER (WHERE p.estatus='programado')::int AS n_por_pagar,
        COUNT(*) FILTER (WHERE p.estatus='programado' AND p.fecha_programada < CURRENT_DATE)::int AS n_vencidos,
        COUNT(*) FILTER (WHERE p.estatus='pagado')::int     AS n_pagados,
        COUNT(*) FILTER (WHERE p.estatus='cancelado')::int   AS n_cancelados,
        COALESCE(SUM(p.monto) FILTER (WHERE p.estatus='programado'),0) AS por_pagar,
        COALESCE(SUM(p.monto) FILTER (WHERE p.estatus='programado' AND p.fecha_programada < CURRENT_DATE),0) AS vencido,
        COALESCE(SUM(p.monto) FILTER (WHERE p.estatus='programado'
                 AND p.fecha_programada BETWEEN CURRENT_DATE AND CURRENT_DATE + 7),0) AS proximos_7,
        COALESCE(SUM(p.monto) FILTER (WHERE p.estatus='pagado'),0)     AS pagado,
        COALESCE(SUM(p.monto) FILTER (WHERE p.estatus='cancelado'),0)  AS cancelado
      FROM fac_pagos_programados p
      ${where}`, params);

    // Panorama sin filtros: deja explicar que un listado vacío es por el rango
    // consultado y no porque no se haya programado nada.
    const global = await query(`
      SELECT COUNT(*)::int AS n,
             TO_CHAR(MIN(fecha_programada),'YYYY-MM-DD') AS primera,
             TO_CHAR(MAX(fecha_programada),'YYYY-MM-DD') AS ultima
        FROM fac_pagos_programados`);

    const cuentas = await nombresDeCuentas();
    const data = r.rows.map(p => {
      const c = p.cuenta_id ? cuentas.get(p.cuenta_id) : null;
      return { ...p, cuenta: c ? c.nombre : null, cuenta_banco: c ? c.banco : null };
    });

    res.json({ data, totales: tot.rows[0], global: global.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.*, TO_CHAR(p.fecha_programada,'YYYY-MM-DD') AS fecha_programada,
             TO_CHAR(p.pagado_en,'YYYY-MM-DD') AS pagado_en
        FROM fac_pagos_programados p WHERE p.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pago programado no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Valida y normaliza lo que llega del formulario, para no repetirlo en POST y PUT
function datosDelCuerpo(b) {
  const beneficiario = (b.beneficiario || '').trim();
  if (!beneficiario) return { error: 'El beneficiario es obligatorio.' };
  if (!b.fecha_programada) return { error: 'La fecha programada es obligatoria.' };

  const monto = parseFloat(b.monto);
  if (!Number.isFinite(monto) || monto <= 0)
    return { error: 'El monto debe ser mayor a cero.' };

  const prioridad = PRIORIDADES.includes(b.prioridad) ? b.prioridad : 'normal';
  // Un id de cuenta vacío es "sin definir", no un cero
  const cuenta_id = b.cuenta_id ? parseInt(b.cuenta_id) : null;

  return {
    beneficiario, monto, prioridad,
    cuenta_id: Number.isInteger(cuenta_id) ? cuenta_id : null,
    concepto        : (b.concepto   || '').trim() || null,
    fecha_programada: b.fecha_programada,
    forma_pago      : (b.forma_pago || 'transferencia').trim(),
    referencia      : (b.referencia || '').trim() || null,
    notas           : (b.notas      || '').trim() || null
  };
}

// ═══ ALTA ═══════════════════════════════════════════
router.post('/', permiso('programacionPagos', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const d = datosDelCuerpo(req.body);
    if (d.error) return res.status(400).json({ error: d.error });

    const r = await query(
      `INSERT INTO fac_pagos_programados(
         beneficiario, concepto, monto, fecha_programada, cuenta_id,
         forma_pago, referencia, prioridad, notas, creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [d.beneficiario, d.concepto, d.monto, d.fecha_programada, d.cuenta_id,
       d.forma_pago, d.referencia, d.prioridad, d.notas, req.usuario.id]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ EDICIÓN ════════════════════════════════════════
router.put('/:id', permiso('programacionPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const d = datosDelCuerpo(req.body);
    if (d.error) return res.status(400).json({ error: d.error });

    const r = await query(
      `UPDATE fac_pagos_programados SET
         beneficiario=$1, concepto=$2, monto=$3, fecha_programada=$4, cuenta_id=$5,
         forma_pago=$6, referencia=$7, prioridad=$8, notas=$9, actualizado_en=NOW()
       WHERE id=$10 RETURNING id`,
      [d.beneficiario, d.concepto, d.monto, d.fecha_programada, d.cuenta_id,
       d.forma_pago, d.referencia, d.prioridad, d.notas, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pago programado no encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ MARCAR PAGADO / REVERTIR ═══════════════════════
// Solo cambia el estatus de la agenda. No genera movimiento bancario: el pago
// se registra en Bancos por su lado, si así se decide más adelante.
router.patch('/:id/pagar', permiso('programacionPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const { pagado_en, pago_referencia, pago_notas, revertir } = req.body;

    const actual = await query(
      `SELECT estatus, solicitud_id FROM fac_pagos_programados WHERE id=$1`, [req.params.id]);
    if (!actual.rows.length) return res.status(404).json({ error: 'Pago programado no encontrado.' });

    // Un renglón que vino de una solicitud de pago no se liquida desde aquí: al
    // marcarlo pagado allá se avisa por correo al solicitante, y cerrarlo por
    // este lado dejaría a la solicitud abierta y al aviso sin salir.
    if (actual.rows[0].solicitud_id && !revertir)
      return res.status(400).json({
        error: 'Este pago viene de una solicitud. Márcalo pagado desde la Cola de Pagos para que se avise a quien lo pidió.' });

    if (revertir) {
      await query(
        `UPDATE fac_pagos_programados
            SET estatus='programado', pagado_en=NULL, pago_referencia=NULL,
                pago_notas=NULL, actualizado_en=NOW()
          WHERE id=$1`, [req.params.id]);
      return res.json({ ok: true, estatus: 'programado' });
    }

    if (actual.rows[0].estatus === 'cancelado')
      return res.status(400).json({ error: 'Este pago está cancelado. Reactívalo antes de marcarlo pagado.' });

    await query(
      `UPDATE fac_pagos_programados
          SET estatus='pagado',
              pagado_en = COALESCE($1::date, CURRENT_DATE),
              pago_referencia=$2, pago_notas=$3, actualizado_en=NOW()
        WHERE id=$4`,
      [pagado_en || null, (pago_referencia || '').trim() || null,
       (pago_notas || '').trim() || null, req.params.id]);
    res.json({ ok: true, estatus: 'pagado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CANCELAR / REACTIVAR ═══════════════════════════
// Cancelar no borra: deja el compromiso a la vista con su historia, que es lo
// que permite explicar después por qué no se pagó.
router.patch('/:id/cancelar', permiso('programacionPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const { motivo, reactivar } = req.body;
    const nuevo = reactivar ? 'programado' : 'cancelado';
    const r = await query(
      `UPDATE fac_pagos_programados
          SET estatus=$1,
              notas = CASE WHEN $2::text IS NULL OR TRIM($2::text)='' THEN notas
                           ELSE COALESCE(notas || E'\n', '') || $2::text END,
              actualizado_en=NOW()
        WHERE id=$3 RETURNING id`,
      [nuevo, motivo || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pago programado no encontrado.' });
    res.json({ ok: true, estatus: nuevo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ BORRAR ═════════════════════════════════════════
router.delete('/:id', permiso('programacionPagos', NIVEL.TODO), async (req, res) => {
  try {
    const r = await query(`DELETE FROM fac_pagos_programados WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pago programado no encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
