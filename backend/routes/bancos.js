const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Migración idempotente: tabla de cuentas bancarias
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_cuentas (
        id SERIAL PRIMARY KEY,
        banco TEXT NOT NULL,
        sucursal TEXT,
        alias TEXT,
        titular TEXT,
        tipo TEXT DEFAULT 'cheques',
        numero_cuenta TEXT,
        clabe TEXT,
        tarjeta TEXT,
        moneda TEXT DEFAULT 'MXN',
        saldo_inicial NUMERIC(14,2) DEFAULT 0,
        notas TEXT,
        activa BOOLEAN DEFAULT TRUE,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      )`);
  } catch (e) { console.warn('Migración fac_bancos_cuentas:', e.message); }
})();

// GET /api/bancos/cuentas — listado (soporta ?activa=true/false y ?buscar=)
router.get('/cuentas', async (req, res) => {
  try {
    const { activa, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (activa !== undefined) { params.push(activa === 'true'); where += ` AND activa=$${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (banco ILIKE $${params.length} OR alias ILIKE $${params.length} OR titular ILIKE $${params.length} OR numero_cuenta ILIKE $${params.length} OR clabe ILIKE $${params.length})`;
    }
    const r = await query(
      `SELECT * FROM fac_bancos_cuentas ${where} ORDER BY activa DESC, banco ASC, alias ASC`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/cuentas/:id
router.get('/cuentas/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_bancos_cuentas WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bancos/cuentas
router.post('/cuentas', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      banco, sucursal, alias, titular, tipo,
      numero_cuenta, clabe, tarjeta, moneda, saldo_inicial, notas, activa
    } = req.body;
    if (!banco || !banco.trim()) return res.status(400).json({ error: 'Nombre del banco es requerido.' });
    if (clabe && !/^\d{18}$/.test(String(clabe).trim())) {
      return res.status(400).json({ error: 'La CLABE debe tener exactamente 18 dígitos numéricos.' });
    }
    const t = ['cheques','ahorro','inversion','tarjeta','otra'].includes(tipo) ? tipo : 'cheques';
    const m = ['MXN','USD','EUR','CAD','GBP'].includes(moneda) ? moneda : 'MXN';
    const r = await query(
      `INSERT INTO fac_bancos_cuentas(
         banco, sucursal, alias, titular, tipo, numero_cuenta, clabe, tarjeta,
         moneda, saldo_inicial, notas, activa, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [banco.trim(), sucursal || null, alias || null, titular || null, t,
       numero_cuenta || null, clabe || null, tarjeta || null,
       m, parseFloat(saldo_inicial) || 0, notas || null, activa !== false, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/bancos/cuentas/:id
router.put('/cuentas/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      banco, sucursal, alias, titular, tipo,
      numero_cuenta, clabe, tarjeta, moneda, saldo_inicial, notas, activa
    } = req.body;
    if (!banco || !banco.trim()) return res.status(400).json({ error: 'Nombre del banco es requerido.' });
    if (clabe && !/^\d{18}$/.test(String(clabe).trim())) {
      return res.status(400).json({ error: 'La CLABE debe tener exactamente 18 dígitos numéricos.' });
    }
    const t = ['cheques','ahorro','inversion','tarjeta','otra'].includes(tipo) ? tipo : 'cheques';
    const m = ['MXN','USD','EUR','CAD','GBP'].includes(moneda) ? moneda : 'MXN';
    await query(
      `UPDATE fac_bancos_cuentas SET
         banco=$1, sucursal=$2, alias=$3, titular=$4, tipo=$5,
         numero_cuenta=$6, clabe=$7, tarjeta=$8, moneda=$9,
         saldo_inicial=$10, notas=$11, activa=$12, actualizado_en=NOW()
       WHERE id=$13`,
      [banco.trim(), sucursal || null, alias || null, titular || null, t,
       numero_cuenta || null, clabe || null, tarjeta || null,
       m, parseFloat(saldo_inicial) || 0, notas || null, activa !== false, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/bancos/cuentas/:id — soft delete (activa=false)
router.delete('/cuentas/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_bancos_cuentas SET activa=FALSE, actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
