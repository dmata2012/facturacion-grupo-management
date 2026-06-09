const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

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
    const { rfc, razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, notas, comision } = req.body;
    if (!rfc || !razon_social) return res.status(400).json({ error: 'RFC y razón social requeridos.' });
    const r = await query(
      `INSERT INTO fac_clientes(rfc,razon_social,nombre_comercial,contacto,email,telefono,direccion,ciudad,notas,comision)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [rfc.toUpperCase(), razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, notas, parseFloat(comision)||0]
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
    const { rfc, razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, activo, notas, comision } = req.body;
    await query(
      `UPDATE fac_clientes SET rfc=$1,razon_social=$2,nombre_comercial=$3,contacto=$4,email=$5,
       telefono=$6,direccion=$7,ciudad=$8,activo=$9,notas=$10,comision=$11,actualizado_en=NOW() WHERE id=$12`,
      [rfc?.toUpperCase(), razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, activo, notas, parseFloat(comision)||0, req.params.id]
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
