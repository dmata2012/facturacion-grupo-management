const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// ═══ OTROS INGRESOS S/F (sin factura) ═══════════════
// Cobros por servicio que no generan CFDI pero sí son ingreso. No son un caso
// especial del desglose de una factura: no hay factura que desglosar, así que
// viven en su propia tabla.
//
// Siempre son de contado — se capturan cuando el dinero ya entró — por eso no
// hay saldo, ni fecha de vencimiento, ni estatus de cobro: el registro ES el
// cobro. Si algún día se pudiera quedar a deber, esto necesitaría replantearse.
const TIPOS_SEED = [
  { nombre: 'Relativos',      color: '#0891b2', orden: 1 },
  { nombre: 'Otros Ingresos', color: '#7c3aed', orden: 2 }
];

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_ingresos_sf_tipos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#0891b2',
        orden INT DEFAULT 99,
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);

    await query(`
      CREATE TABLE IF NOT EXISTS fac_ingresos_sf (
        id SERIAL PRIMARY KEY,
        cliente_id INT NOT NULL REFERENCES fac_clientes(id) ON DELETE RESTRICT,
        tipo_id INT REFERENCES fac_ingresos_sf_tipos(id) ON DELETE SET NULL,
        fecha_cobro DATE NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        forma_pago TEXT DEFAULT 'transferencia',
        referencia TEXT,
        notas TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW(),
        CHECK (monto > 0)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_isf_fecha   ON fac_ingresos_sf(fecha_cobro)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_isf_cliente ON fac_ingresos_sf(cliente_id)`);

    // Marca para los clientes que solo tienen ingreso sin factura. Sin ella
    // aparecerían en Cobranza y Estado de Cuenta con cero facturas y saldo cero,
    // ensuciando pantallas que existen para perseguir dinero por cobrar.
    await query(`ALTER TABLE fac_clientes ADD COLUMN IF NOT EXISTS solo_sf BOOLEAN DEFAULT FALSE`);

    for (const t of TIPOS_SEED) {
      await query(
        `INSERT INTO fac_ingresos_sf_tipos(nombre, color, orden) VALUES($1,$2,$3)
         ON CONFLICT (nombre) DO NOTHING`,
        [t.nombre, t.color, t.orden]);
    }
    console.log('✔ Otros Ingresos S/F: tablas listas');
  } catch (e) { console.warn('Migración ingresos S/F:', e.message); }
})();

// ═══ CATÁLOGO DE TIPOS ══════════════════════════════
router.get('/tipos', async (req, res) => {
  try {
    const r = await query(`
      SELECT t.*,
        (SELECT COUNT(*)::int FROM fac_ingresos_sf i WHERE i.tipo_id = t.id) AS n_registros
      FROM fac_ingresos_sf_tipos t
      WHERE t.activo ORDER BY t.orden, t.nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tipos', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, color, orden } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del tipo requerido.' });
    const r = await query(
      `INSERT INTO fac_ingresos_sf_tipos(nombre, color, orden) VALUES($1,$2,$3)
       ON CONFLICT (nombre) DO UPDATE SET activo=TRUE, color=EXCLUDED.color RETURNING *`,
      [nombre.trim(), color || '#0891b2', parseInt(orden) || 99]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/tipos/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, color, orden } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    await query(`UPDATE fac_ingresos_sf_tipos SET nombre=$1, color=$2, orden=$3 WHERE id=$4`,
      [nombre.trim(), color || '#0891b2', parseInt(orden) || 99, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe otro tipo con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});

// Baja lógica si ya se usó: borrarlo dejaría cobros históricos sin clasificar
router.delete('/tipos/:id', requireRol('admin', 'gerente'), async (req, res) => {
  try {
    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_ingresos_sf WHERE tipo_id=$1`, [req.params.id]);
    if (uso.rows[0].n > 0) {
      await query(`UPDATE fac_ingresos_sf_tipos SET activo=FALSE WHERE id=$1`, [req.params.id]);
      return res.json({ ok: true, desactivado: true, registros: uso.rows[0].n });
    }
    await query(`DELETE FROM fac_ingresos_sf_tipos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, eliminado: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ COBROS ═════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { desde, hasta, cliente_id, tipo_id, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (desde)      { params.push(desde);      where += ` AND i.fecha_cobro >= $${params.length}`; }
    if (hasta)      { params.push(hasta);      where += ` AND i.fecha_cobro <= $${params.length}`; }
    if (cliente_id) { params.push(cliente_id); where += ` AND i.cliente_id = $${params.length}`; }
    if (tipo_id)    { params.push(tipo_id);    where += ` AND i.tipo_id = $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (c.razon_social ILIKE $${params.length} OR c.nombre_comercial ILIKE $${params.length}
                      OR c.rfc ILIKE $${params.length} OR i.referencia ILIKE $${params.length}
                      OR i.notas ILIKE $${params.length})`;
    }

    const r = await query(`
      SELECT i.*, TO_CHAR(i.fecha_cobro,'YYYY-MM-DD') AS fecha_cobro,
        COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente,
        c.rfc, t.nombre AS tipo, t.color AS tipo_color,
        u.nombre AS capturado_por
      FROM fac_ingresos_sf i
      JOIN fac_clientes c ON c.id = i.cliente_id
      LEFT JOIN fac_ingresos_sf_tipos t ON t.id = i.tipo_id
      LEFT JOIN fac_usuarios u ON u.id = i.creado_por
      ${where}
      ORDER BY i.fecha_cobro DESC, i.id DESC
      LIMIT 500
    `, params);

    const tot = await query(`
      SELECT COUNT(i.id)::int AS n, COALESCE(SUM(i.monto),0) AS total,
             COUNT(DISTINCT i.cliente_id)::int AS clientes
      FROM fac_ingresos_sf i
      JOIN fac_clientes c ON c.id = i.cliente_id
      ${where}`, params);

    const porTipo = await query(`
      SELECT COALESCE(t.nombre,'Sin tipo') AS tipo, COALESCE(t.color,'#94a3b8') AS color,
             COUNT(i.id)::int AS n, COALESCE(SUM(i.monto),0) AS total
      FROM fac_ingresos_sf i
      JOIN fac_clientes c ON c.id = i.cliente_id
      LEFT JOIN fac_ingresos_sf_tipos t ON t.id = i.tipo_id
      ${where}
      GROUP BY t.nombre, t.color ORDER BY total DESC`, params);

    const porCliente = await query(`
      SELECT COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente,
             COUNT(i.id)::int AS n, COALESCE(SUM(i.monto),0) AS total
      FROM fac_ingresos_sf i
      JOIN fac_clientes c ON c.id = i.cliente_id
      ${where}
      GROUP BY 1 ORDER BY total DESC LIMIT 20`, params);

    res.json({ ingresos: r.rows, totales: tot.rows[0],
               por_tipo: porTipo.rows, por_cliente: porCliente.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cliente_id, tipo_id, fecha_cobro, monto, forma_pago, referencia, notas } = req.body;
    if (!cliente_id || !fecha_cobro || !monto)
      return res.status(400).json({ error: 'Cliente, fecha de cobro y monto son requeridos.' });
    if (!tipo_id) return res.status(400).json({ error: 'Selecciona el tipo de ingreso.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    const r = await query(
      `INSERT INTO fac_ingresos_sf(cliente_id, tipo_id, fecha_cobro, monto, forma_pago,
         referencia, notas, creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cliente_id, tipo_id, fecha_cobro, m, forma_pago || 'transferencia',
       referencia || null, notas || null, req.usuario.id]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cliente_id, tipo_id, fecha_cobro, monto, forma_pago, referencia, notas } = req.body;
    if (!cliente_id || !fecha_cobro || !monto)
      return res.status(400).json({ error: 'Cliente, fecha de cobro y monto son requeridos.' });
    if (!tipo_id) return res.status(400).json({ error: 'Selecciona el tipo de ingreso.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    await query(
      `UPDATE fac_ingresos_sf SET cliente_id=$1, tipo_id=$2, fecha_cobro=$3, monto=$4,
         forma_pago=$5, referencia=$6, notas=$7, actualizado_en=NOW()
       WHERE id=$8`,
      [cliente_id, tipo_id, fecha_cobro, m, forma_pago || 'transferencia',
       referencia || null, notas || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireRol('admin', 'gerente', 'tesoreria'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_ingresos_sf WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marcar un cliente como "solo ingresos sin factura", para que Cobranza y
// Estado de Cuenta dejen de listarlo con cero facturas y saldo cero.
router.patch('/clientes/:id/solo-sf', requireRol('admin', 'gerente', 'tesoreria'), async (req, res) => {
  try {
    await query(`UPDATE fac_clientes SET solo_sf=$1 WHERE id=$2`,
      [req.body.solo_sf !== false, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
