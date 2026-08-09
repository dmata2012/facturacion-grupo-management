const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// ── ACUERDOS (%) ──────────────────────────────
// Porcentaje pactado con el cliente. Si no se captura nada se asume 16%.
const ACUERDOS_DEFAULT = 16;

(async () => {
  try {
    await query(`ALTER TABLE fac_clientes ADD COLUMN IF NOT EXISTS acuerdos NUMERIC(5,2) NOT NULL DEFAULT ${ACUERDOS_DEFAULT}`);
  } catch (e) { console.warn('Migración acuerdos:', e.message); }
})();

// Vacío / inválido → 16. Un 0 capturado a propósito sí se respeta.
function normalizarAcuerdos(v) {
  if (v === undefined || v === null || String(v).trim() === '') return ACUERDOS_DEFAULT;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : ACUERDOS_DEFAULT;
}

// GET /api/clientes
router.get('/', async (req, res) => {
  try {
    const { buscar, activo } = req.query;
    let sql = `SELECT c.*,
      COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada') AS total_facturas,
      COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'),0) AS total_facturado,
      COALESCE(SUM(p.monto),0) AS total_cobrado
      FROM fac_clientes c
      LEFT JOIN fac_facturas f ON f.cliente_id = c.id
      LEFT JOIN fac_pagos p ON p.factura_id = f.id
      WHERE 1=1`;
    const params = [];
    if (buscar) {
      params.push(`%${buscar}%`);
      sql += ` AND (c.rfc ILIKE $${params.length} OR c.razon_social ILIKE $${params.length} OR c.nombre_comercial ILIKE $${params.length})`;
    }
    if (activo !== undefined) {
      params.push(activo === 'true');
      sql += ` AND c.activo=$${params.length}`;
    }
    sql += ` GROUP BY c.id ORDER BY c.razon_social`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clientes/:id
router.get('/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_clientes WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/clientes/rfc/:rfc — buscar por RFC para detección automática
router.get('/rfc/:rfc', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_clientes WHERE UPPER(rfc)=UPPER($1) AND activo=TRUE`, [req.params.rfc]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/clientes
router.post('/', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const {
      rfc, razon_social, nombre_comercial, contacto, email, telefono,
      direccion, ciudad, notas, comision, acuerdos,
      contacto_admin, contacto_pagos, whatsapp,
      dias_credito, condiciones_pago, ejecutivo_cuenta,
      aplica_desglose
    } = req.body;
    if (!rfc || !razon_social) return res.status(400).json({ error: 'RFC y razón social requeridos.' });
    const r = await query(
      `INSERT INTO fac_clientes(
         rfc,razon_social,nombre_comercial,contacto,email,telefono,
         direccion,ciudad,notas,comision,acuerdos,
         contacto_admin,contacto_pagos,whatsapp,
         dias_credito,condiciones_pago,ejecutivo_cuenta,aplica_desglose
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        rfc.toUpperCase(), razon_social, nombre_comercial, contacto,
        email, telefono, direccion, ciudad, notas, parseFloat(comision)||0,
        normalizarAcuerdos(acuerdos),
        contacto_admin||null, contacto_pagos||null, whatsapp||null,
        parseInt(dias_credito)||0, condiciones_pago||null, ejecutivo_cuenta||null,
        aplica_desglose !== false
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'RFC ya registrado.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clientes/:id
router.put('/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const {
      rfc, razon_social, nombre_comercial, contacto, email, telefono,
      direccion, ciudad, activo, notas, comision, acuerdos,
      contacto_admin, contacto_pagos, whatsapp,
      dias_credito, condiciones_pago, ejecutivo_cuenta,
      aplica_desglose
    } = req.body;
    await query(
      `UPDATE fac_clientes SET
         rfc=$1, razon_social=$2, nombre_comercial=$3, contacto=$4, email=$5,
         telefono=$6, direccion=$7, ciudad=$8, activo=$9, notas=$10, comision=$11,
         acuerdos=$12,
         contacto_admin=$13, contacto_pagos=$14, whatsapp=$15,
         dias_credito=$16, condiciones_pago=$17, ejecutivo_cuenta=$18,
         aplica_desglose=$19,
         actualizado_en=NOW()
       WHERE id=$20`,
      [
        rfc?.toUpperCase(), razon_social, nombre_comercial, contacto,
        email, telefono, direccion, ciudad, activo, notas, parseFloat(comision)||0,
        normalizarAcuerdos(acuerdos),
        contacto_admin||null, contacto_pagos||null, whatsapp||null,
        parseInt(dias_credito)||0, condiciones_pago||null, ejecutivo_cuenta||null,
        aplica_desglose !== false,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/clientes/:id (desactivar)
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_clientes SET activo=FALSE,actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
