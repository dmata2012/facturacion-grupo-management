const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// GET /api/receptoras
router.get('/', async (req, res) => {
  try {
    const { buscar, activo } = req.query;
    let sql = `
      SELECT r.*,
        COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada') AS total_facturas,
        COALESCE(SUM(f.total) FILTER (WHERE f.estatus != 'cancelada'), 0) AS total_facturado
      FROM fac_empresas_receptoras r
      LEFT JOIN fac_facturas f ON f.empresa_receptora_id = r.id
      WHERE 1=1`;
    const params = [];
    if (buscar) {
      params.push(`%${buscar}%`);
      sql += ` AND (r.rfc ILIKE $${params.length} OR r.razon_social ILIKE $${params.length} OR r.nombre_comercial ILIKE $${params.length})`;
    }
    if (activo !== undefined) {
      params.push(activo === 'true');
      sql += ` AND r.activo=$${params.length}`;
    }
    sql += ` GROUP BY r.id ORDER BY r.razon_social`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/receptoras/:id
router.get('/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_empresas_receptoras WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Empresa no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/receptoras/rfc/:rfc — detección automática por XML
router.get('/rfc/:rfc', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_empresas_receptoras WHERE UPPER(rfc)=UPPER($1) AND activo=TRUE`, [req.params.rfc]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/receptoras
router.post('/', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { rfc, razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, regimen_fiscal, codigo_postal, notas } = req.body;
    if (!rfc || !razon_social) return res.status(400).json({ error: 'RFC y razón social requeridos.' });
    const r = await query(
      `INSERT INTO fac_empresas_receptoras
        (rfc,razon_social,nombre_comercial,contacto,email,telefono,direccion,ciudad,regimen_fiscal,codigo_postal,notas)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [rfc.toUpperCase().trim(), razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, regimen_fiscal, codigo_postal, notas]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'RFC ya registrado.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/receptoras/:id
router.put('/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { rfc, razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, regimen_fiscal, codigo_postal, activo, notas } = req.body;
    await query(
      `UPDATE fac_empresas_receptoras
       SET rfc=$1,razon_social=$2,nombre_comercial=$3,contacto=$4,email=$5,
           telefono=$6,direccion=$7,ciudad=$8,regimen_fiscal=$9,codigo_postal=$10,
           activo=$11,notas=$12,actualizado_en=NOW()
       WHERE id=$13`,
      [rfc?.toUpperCase().trim(), razon_social, nombre_comercial, contacto, email, telefono, direccion, ciudad, regimen_fiscal, codigo_postal, activo, notas, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'RFC ya registrado.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/receptoras/:id — desactivar
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_empresas_receptoras SET activo=FALSE, actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
