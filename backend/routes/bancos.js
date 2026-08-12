const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Migraciones idempotentes
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
    // Empresas (ej: LEX)
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_empresas (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        activa BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    // Catálogo de bancos (ej: BANORTE, BBVA)
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_catalogo (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        clave_sat TEXT,
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    // Semilla inicial con los bancos más usados en México (solo si está vacío)
    const cnt = await query(`SELECT COUNT(*)::int AS n FROM fac_bancos_catalogo`);
    if (cnt.rows[0].n === 0) {
      const seed = [
        ['BANORTE','072'], ['BBVA MEXICO','012'], ['SANTANDER','014'],
        ['BANAMEX','002'], ['HSBC','021'], ['SCOTIABANK','044'],
        ['INBURSA','036'], ['BAJIO','030'], ['AFIRME','062'],
        ['AZTECA','127'], ['BANREGIO','058'], ['MIFEL','042'],
        ['MULTIVA','132'], ['COMPARTAMOS','130'], ['BANCOPPEL','137'],
        ['STP','646'], ['NU MEXICO','638'], ['KLAR','661']
      ];
      for (const [nombre, clave] of seed) {
        await query(
          `INSERT INTO fac_bancos_catalogo(nombre, clave_sat) VALUES($1,$2) ON CONFLICT(nombre) DO NOTHING`,
          [nombre, clave]
        );
      }
    }
    await query(`ALTER TABLE fac_bancos_cuentas ADD COLUMN IF NOT EXISTS empresa_id INT REFERENCES fac_bancos_empresas(id) ON DELETE SET NULL`);
    // Beneficiarios (proveedores/personas que reciben cheques)
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_beneficiarios (
        id SERIAL PRIMARY KEY,
        nombre_completo TEXT NOT NULL,
        rfc TEXT,
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    // Cheques emitidos
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_cheques (
        id SERIAL PRIMARY KEY,
        cuenta_bancaria_id INT NOT NULL REFERENCES fac_bancos_cuentas(id) ON DELETE CASCADE,
        beneficiario_id INT REFERENCES fac_bancos_beneficiarios(id) ON DELETE SET NULL,
        no_cheque TEXT NOT NULL,
        fecha_emision DATE NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        concepto TEXT,
        estatus TEXT DEFAULT 'EMITIDO',
        recibio_cheque_nombre TEXT,
        recibio_cheque_fecha DATE,
        recibio_dinero_nombre TEXT,
        recibio_dinero_fecha DATE,
        movimiento_ec_id INT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      )`);
    // Chequeras por cuenta (rango de folios consecutivos)
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_chequeras (
        id SERIAL PRIMARY KEY,
        cuenta_bancaria_id INT NOT NULL REFERENCES fac_bancos_cuentas(id) ON DELETE CASCADE,
        folio_inicial INT NOT NULL,
        folio_final INT NOT NULL,
        estatus TEXT DEFAULT 'ACTIVA',
        fecha_asignacion DATE DEFAULT CURRENT_DATE,
        fecha_cierre DATE,
        notas TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        CHECK (folio_final >= folio_inicial)
      )`);
    await query(`ALTER TABLE fac_bancos_cheques ADD COLUMN IF NOT EXISTS chequera_id INT REFERENCES fac_bancos_chequeras(id) ON DELETE SET NULL`);
    // Libro de movimientos de la cuenta (registro propio de la empresa)
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_movimientos (
        id SERIAL PRIMARY KEY,
        cuenta_bancaria_id INT NOT NULL REFERENCES fac_bancos_cuentas(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        tipo TEXT NOT NULL,
        naturaleza TEXT NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        concepto TEXT,
        referencia TEXT,
        contraparte TEXT,
        factura_id INT REFERENCES fac_facturas(id) ON DELETE SET NULL,
        cheque_id INT REFERENCES fac_bancos_cheques(id) ON DELETE SET NULL,
        conciliado BOOLEAN DEFAULT FALSE,
        notas TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW(),
        CHECK (naturaleza IN ('CARGO','ABONO')),
        CHECK (monto > 0)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bmov_cuenta_fecha ON fac_bancos_movimientos(cuenta_bancaria_id, fecha)`);
    // Movimientos del estado de cuenta bancario
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_movimientos_ec (
        id SERIAL PRIMARY KEY,
        cuenta_bancaria_id INT NOT NULL REFERENCES fac_bancos_cuentas(id) ON DELETE CASCADE,
        fecha_operacion DATE NOT NULL,
        concepto_banco TEXT,
        numero_referencia TEXT,
        monto_retiro NUMERIC(14,2) DEFAULT 0,
        monto_deposito NUMERIC(14,2) DEFAULT 0,
        estado_conciliacion TEXT DEFAULT 'PENDIENTE',
        cheque_id INT REFERENCES fac_bancos_cheques(id) ON DELETE SET NULL,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
  } catch (e) { console.warn('Migración bancos:', e.message); }
})();

// GET /api/bancos/cuentas — listado (soporta ?activa=true/false y ?buscar=)
router.get('/cuentas', async (req, res) => {
  try {
    const { activa, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (activa !== undefined) { params.push(activa === 'true'); where += ` AND c.activa=$${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (c.banco ILIKE $${params.length} OR c.alias ILIKE $${params.length} OR c.titular ILIKE $${params.length} OR c.numero_cuenta ILIKE $${params.length} OR c.clabe ILIKE $${params.length})`;
    }
    const r = await query(
      `SELECT c.*, e.nombre AS empresa_nombre
       FROM fac_bancos_cuentas c
       LEFT JOIN fac_bancos_empresas e ON e.id = c.empresa_id
       ${where}
       ORDER BY c.activa DESC, c.banco ASC, c.alias ASC`,
      params
    );
    // Adjuntar el estado de la chequera activa de cada cuenta
    for (const cta of r.rows) {
      try {
        const ec = await estadoChequera(cta.id);
        cta.chequera = ec.chequera ? {
          folio_inicial: ec.chequera.folio_inicial,
          folio_final:   ec.chequera.folio_final,
          siguiente:     ec.siguiente,
          restantes:     ec.restantes,
          usados:        ec.usados,
          agotada:       !!ec.agotada
        } : null;
      } catch (e) { cta.chequera = null; }
    }
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/cuentas/:id
router.get('/cuentas/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*, e.nombre AS empresa_nombre
       FROM fac_bancos_cuentas c
       LEFT JOIN fac_bancos_empresas e ON e.id = c.empresa_id
       WHERE c.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Cuenta no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bancos/cuentas
router.post('/cuentas', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      banco, sucursal, alias, titular, tipo,
      numero_cuenta, clabe, tarjeta, moneda, saldo_inicial, notas, activa, empresa_id
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
         moneda, saldo_inicial, notas, activa, empresa_id, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [banco.trim(), sucursal || null, alias || null, titular || null, t,
       numero_cuenta || null, clabe || null, tarjeta || null,
       m, parseFloat(saldo_inicial) || 0, notas || null, activa !== false, empresa_id || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/bancos/cuentas/:id
router.put('/cuentas/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      banco, sucursal, alias, titular, tipo,
      numero_cuenta, clabe, tarjeta, moneda, saldo_inicial, notas, activa, empresa_id
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
         saldo_inicial=$10, notas=$11, activa=$12, empresa_id=$13, actualizado_en=NOW()
       WHERE id=$14`,
      [banco.trim(), sucursal || null, alias || null, titular || null, t,
       numero_cuenta || null, clabe || null, tarjeta || null,
       m, parseFloat(saldo_inicial) || 0, notas || null, activa !== false, empresa_id || null, req.params.id]
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

// ═══ CATÁLOGO DE BANCOS ═════════════════════════════
router.get('/catalogo', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM fac_bancos_cuentas cu WHERE UPPER(cu.banco) = UPPER(c.nombre)) AS n_cuentas
       FROM fac_bancos_catalogo c
       WHERE c.activo = TRUE ORDER BY c.nombre`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/catalogo', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, clave_sat } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del banco requerido.' });
    const r = await query(
      `INSERT INTO fac_bancos_catalogo(nombre, clave_sat) VALUES($1,$2)
       ON CONFLICT(nombre) DO UPDATE SET activo=TRUE, clave_sat=COALESCE(EXCLUDED.clave_sat, fac_bancos_catalogo.clave_sat)
       RETURNING *`,
      [nombre.trim().toUpperCase(), (clave_sat || '').trim() || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/catalogo/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, clave_sat } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del banco requerido.' });
    await query(
      `UPDATE fac_bancos_catalogo SET nombre=$1, clave_sat=$2 WHERE id=$3`,
      [nombre.trim().toUpperCase(), (clave_sat || '').trim() || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/catalogo/:id', requireRol('admin'), async (req, res) => {
  try {
    // No permitir baja si hay cuentas que lo usan
    const b = await query(`SELECT nombre FROM fac_bancos_catalogo WHERE id=$1`, [req.params.id]);
    if (!b.rows.length) return res.status(404).json({ error: 'Banco no encontrado.' });
    const uso = await query(
      `SELECT COUNT(*)::int AS n FROM fac_bancos_cuentas WHERE UPPER(banco) = UPPER($1)`,
      [b.rows[0].nombre]
    );
    if (uso.rows[0].n > 0) {
      return res.status(400).json({
        error: `No se puede eliminar: ${uso.rows[0].n} cuenta(s) usan este banco. Reasígnalas primero.`
      });
    }
    await query(`UPDATE fac_bancos_catalogo SET activo=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ EMPRESAS ═══════════════════════════════════════
router.get('/empresas', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_bancos_empresas WHERE activa=TRUE ORDER BY nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/empresas', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_bancos_empresas(nombre) VALUES($1)
       ON CONFLICT(nombre) DO UPDATE SET activa=TRUE RETURNING *`,
      [nombre.trim().toUpperCase()]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/empresas/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_bancos_empresas SET activa=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ BENEFICIARIOS ═══════════════════════════════════
router.get('/beneficiarios', async (req, res) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let where = 'WHERE activo=TRUE';
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (nombre_completo ILIKE $${params.length} OR rfc ILIKE $${params.length})`;
    }
    const r = await query(`SELECT * FROM fac_bancos_beneficiarios ${where} ORDER BY nombre_completo`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/beneficiarios', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre_completo, rfc } = req.body;
    if (!nombre_completo || !nombre_completo.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_bancos_beneficiarios(nombre_completo, rfc) VALUES($1,$2) RETURNING *`,
      [nombre_completo.trim().toUpperCase(), rfc ? rfc.trim().toUpperCase() : null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/beneficiarios/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre_completo, rfc } = req.body;
    await query(
      `UPDATE fac_bancos_beneficiarios SET nombre_completo=$1, rfc=$2 WHERE id=$3`,
      [nombre_completo.trim().toUpperCase(), rfc ? rfc.trim().toUpperCase() : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/beneficiarios/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_bancos_beneficiarios SET activo=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CHEQUERAS ══════════════════════════════════════
// Devuelve el estado de la chequera activa de una cuenta y cuál es el folio que toca.
// Regla: los folios se consumen en orden estricto. Un cheque cancelado también consume su folio.
async function estadoChequera(cuentaId) {
  const ch = await query(
    `SELECT * FROM fac_bancos_chequeras
     WHERE cuenta_bancaria_id=$1 AND estatus='ACTIVA'
     ORDER BY folio_inicial LIMIT 1`,
    [cuentaId]
  );
  if (!ch.rows.length) return { chequera: null, siguiente: null, usados: 0, restantes: 0 };
  const q = ch.rows[0];
  const u = await query(
    `SELECT COALESCE(MAX(no_cheque::int), 0) AS max_folio, COUNT(*)::int AS n
     FROM fac_bancos_cheques
     WHERE chequera_id=$1 AND no_cheque ~ '^[0-9]+$'`,
    [q.id]
  );
  const maxUsado = parseInt(u.rows[0].max_folio) || 0;
  const usados   = maxUsado >= q.folio_inicial ? (maxUsado - q.folio_inicial + 1) : 0;
  const siguiente = maxUsado >= q.folio_inicial ? maxUsado + 1 : q.folio_inicial;
  const agotada = siguiente > q.folio_final;
  return {
    chequera: q,
    siguiente: agotada ? null : siguiente,
    usados,
    restantes: Math.max(0, q.folio_final - q.folio_inicial + 1 - usados),
    agotada
  };
}

// GET /api/bancos/cuentas/:id/chequeras — lista con métricas de uso
router.get('/cuentas/:id/chequeras', async (req, res) => {
  try {
    const r = await query(`
      SELECT q.*,
        TO_CHAR(q.fecha_asignacion,'YYYY-MM-DD') AS fecha_asignacion,
        TO_CHAR(q.fecha_cierre,'YYYY-MM-DD')     AS fecha_cierre,
        (q.folio_final - q.folio_inicial + 1) AS total_folios,
        COALESCE((SELECT MAX(c.no_cheque::int) FROM fac_bancos_cheques c
                  WHERE c.chequera_id = q.id AND c.no_cheque ~ '^[0-9]+$'), 0) AS max_folio_usado,
        (SELECT COUNT(*)::int FROM fac_bancos_cheques c WHERE c.chequera_id = q.id) AS n_cheques
      FROM fac_bancos_chequeras q
      WHERE q.cuenta_bancaria_id=$1
      ORDER BY q.estatus='ACTIVA' DESC, q.folio_inicial DESC
    `, [req.params.id]);
    const estado = await estadoChequera(req.params.id);
    res.json({ chequeras: r.rows, estado_actual: estado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/cuentas/:id/siguiente-folio — cuál cheque toca emitir
router.get('/cuentas/:id/siguiente-folio', async (req, res) => {
  try {
    res.json(await estadoChequera(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bancos/chequeras — asignar nueva chequera
router.post('/chequeras', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cuenta_bancaria_id, folio_inicial, folio_final, notas, cerrar_anterior } = req.body;
    const ini = parseInt(folio_inicial), fin = parseInt(folio_final);
    if (!cuenta_bancaria_id || !Number.isInteger(ini) || !Number.isInteger(fin))
      return res.status(400).json({ error: 'Cuenta, folio inicial y folio final son requeridos.' });
    if (ini < 1) return res.status(400).json({ error: 'El folio inicial debe ser mayor a 0.' });
    if (fin < ini) return res.status(400).json({ error: 'El folio final debe ser mayor o igual al inicial.' });

    // No permitir rangos traslapados en la misma cuenta
    const solapa = await query(
      `SELECT id, folio_inicial, folio_final FROM fac_bancos_chequeras
       WHERE cuenta_bancaria_id=$1 AND estatus <> 'CANCELADA'
         AND NOT ($3 < folio_inicial OR $2 > folio_final)
       LIMIT 1`,
      [cuenta_bancaria_id, ini, fin]
    );
    if (solapa.rows.length) {
      const s = solapa.rows[0];
      return res.status(400).json({
        error: `El rango ${ini}–${fin} se traslapa con una chequera existente (${s.folio_inicial}–${s.folio_final}).`
      });
    }

    // Si se pide, cerrar la chequera activa anterior
    if (cerrar_anterior) {
      await query(
        `UPDATE fac_bancos_chequeras SET estatus='CERRADA', fecha_cierre=CURRENT_DATE
         WHERE cuenta_bancaria_id=$1 AND estatus='ACTIVA'`,
        [cuenta_bancaria_id]
      );
    } else {
      const activa = await query(
        `SELECT id FROM fac_bancos_chequeras WHERE cuenta_bancaria_id=$1 AND estatus='ACTIVA' LIMIT 1`,
        [cuenta_bancaria_id]
      );
      if (activa.rows.length) {
        return res.status(400).json({
          error: 'Ya existe una chequera ACTIVA en esta cuenta. Ciérrala primero o marca "cerrar la anterior".'
        });
      }
    }

    const r = await query(
      `INSERT INTO fac_bancos_chequeras(cuenta_bancaria_id, folio_inicial, folio_final, notas, creado_por)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [cuenta_bancaria_id, ini, fin, notas || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/bancos/chequeras/:id/estatus — cerrar / reactivar / cancelar
router.patch('/chequeras/:id/estatus', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { estatus } = req.body;
    if (!['ACTIVA','CERRADA','AGOTADA','CANCELADA'].includes(estatus))
      return res.status(400).json({ error: 'Estatus inválido.' });
    const q = await query(`SELECT cuenta_bancaria_id FROM fac_bancos_chequeras WHERE id=$1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Chequera no encontrada.' });
    // Solo puede haber una ACTIVA por cuenta
    if (estatus === 'ACTIVA') {
      const otra = await query(
        `SELECT id FROM fac_bancos_chequeras WHERE cuenta_bancaria_id=$1 AND estatus='ACTIVA' AND id<>$2 LIMIT 1`,
        [q.rows[0].cuenta_bancaria_id, req.params.id]
      );
      if (otra.rows.length) return res.status(400).json({ error: 'Ya hay otra chequera activa en esta cuenta.' });
    }
    await query(
      `UPDATE fac_bancos_chequeras
       SET estatus=$1, fecha_cierre = CASE WHEN $1='ACTIVA' THEN NULL ELSE CURRENT_DATE END
       WHERE id=$2`,
      [estatus, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/bancos/chequeras/:id — solo si no tiene cheques
router.delete('/chequeras/:id', requireRol('admin'), async (req, res) => {
  try {
    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_bancos_cheques WHERE chequera_id=$1`, [req.params.id]);
    if (uso.rows[0].n > 0)
      return res.status(400).json({ error: `No se puede eliminar: la chequera ya tiene ${uso.rows[0].n} cheque(s) emitido(s).` });
    await query(`DELETE FROM fac_bancos_chequeras WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CHEQUES EMITIDOS ═══════════════════════════════
router.get('/cheques', async (req, res) => {
  try {
    const { desde, hasta, estatus, cuenta_id, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (desde)    { params.push(desde); where += ` AND c.fecha_emision >= $${params.length}`; }
    if (hasta)    { params.push(hasta); where += ` AND c.fecha_emision <= $${params.length}`; }
    if (estatus)  { params.push(estatus); where += ` AND c.estatus = $${params.length}`; }
    if (cuenta_id){ params.push(cuenta_id); where += ` AND c.cuenta_bancaria_id = $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (c.no_cheque ILIKE $${params.length} OR c.concepto ILIKE $${params.length} OR b.nombre_completo ILIKE $${params.length})`;
    }
    const r = await query(`
      SELECT c.*,
        TO_CHAR(c.fecha_emision,'YYYY-MM-DD') AS fecha_emision,
        TO_CHAR(c.recibio_cheque_fecha,'YYYY-MM-DD') AS recibio_cheque_fecha,
        TO_CHAR(c.recibio_dinero_fecha,'YYYY-MM-DD') AS recibio_dinero_fecha,
        b.nombre_completo AS beneficiario_nombre, b.rfc AS beneficiario_rfc,
        cu.banco, cu.alias AS cuenta_alias, cu.numero_cuenta, cu.moneda,
        e.nombre AS empresa_nombre, e.id AS empresa_id
      FROM fac_bancos_cheques c
      LEFT JOIN fac_bancos_beneficiarios b ON b.id = c.beneficiario_id
      JOIN fac_bancos_cuentas cu ON cu.id = c.cuenta_bancaria_id
      LEFT JOIN fac_bancos_empresas e ON e.id = cu.empresa_id
      ${where}
      ORDER BY c.fecha_emision DESC, cu.banco, c.no_cheque
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cheques', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      cuenta_bancaria_id, beneficiario_id, no_cheque, fecha_emision, monto,
      concepto, estatus, recibio_cheque_nombre, recibio_cheque_fecha,
      recibio_dinero_nombre, recibio_dinero_fecha
    } = req.body;
    if (!cuenta_bancaria_id || !no_cheque || !fecha_emision || !monto)
      return res.status(400).json({ error: 'Cuenta, N° cheque, fecha y monto son requeridos.' });
    const est = ['EMITIDO','ENTREGADO','COBRADO','CANCELADO'].includes(estatus) ? estatus : 'EMITIDO';
    const folioTxt = String(no_cheque).trim();

    // ── Control de chequera: el folio debe ser el consecutivo exacto ──
    const ec = await estadoChequera(cuenta_bancaria_id);
    let chequeraId = null;
    if (ec.chequera) {
      if (!/^\d+$/.test(folioTxt))
        return res.status(400).json({ error: 'Con chequera asignada el N° de cheque debe ser numérico.' });
      const folio = parseInt(folioTxt);
      if (ec.agotada) {
        return res.status(400).json({
          error: `La chequera ${ec.chequera.folio_inicial}–${ec.chequera.folio_final} está agotada. Asigna una nueva chequera antes de emitir más cheques.`
        });
      }
      if (folio < ec.chequera.folio_inicial || folio > ec.chequera.folio_final) {
        return res.status(400).json({
          error: `El folio ${folio} está fuera del rango de la chequera activa (${ec.chequera.folio_inicial}–${ec.chequera.folio_final}).`
        });
      }
      if (folio !== ec.siguiente) {
        return res.status(400).json({
          error: folio > ec.siguiente
            ? `No se puede saltar folios. El siguiente cheque a emitir es el ${ec.siguiente} (intentaste el ${folio}). Si el ${ec.siguiente} se dañó, regístralo como CANCELADO para liberar el consecutivo.`
            : `El folio ${folio} ya fue usado. El siguiente disponible es el ${ec.siguiente}.`
        });
      }
      chequeraId = ec.chequera.id;
    }

    const r = await query(
      `INSERT INTO fac_bancos_cheques(
         cuenta_bancaria_id, beneficiario_id, no_cheque, fecha_emision, monto,
         concepto, estatus, recibio_cheque_nombre, recibio_cheque_fecha,
         recibio_dinero_nombre, recibio_dinero_fecha, chequera_id, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [cuenta_bancaria_id, beneficiario_id || null, folioTxt, fecha_emision, parseFloat(monto),
       concepto || null, est, recibio_cheque_nombre || null, recibio_cheque_fecha || null,
       recibio_dinero_nombre || null, recibio_dinero_fecha || null, chequeraId, req.usuario.id]
    );

    // Si con este cheque se consumió el último folio, marcar la chequera como AGOTADA
    let avisoChequera = null;
    if (chequeraId && parseInt(folioTxt) === ec.chequera.folio_final) {
      await query(`UPDATE fac_bancos_chequeras SET estatus='AGOTADA', fecha_cierre=CURRENT_DATE WHERE id=$1`, [chequeraId]);
      avisoChequera = `Se emitió el último cheque (${folioTxt}). La chequera quedó AGOTADA — asigna una nueva para continuar.`;
    } else if (chequeraId && ec.restantes - 1 <= 5) {
      avisoChequera = `Quedan ${ec.restantes - 1} cheque(s) en esta chequera.`;
    }
    res.status(201).json({ ...r.rows[0], aviso_chequera: avisoChequera });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/cheques/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const {
      cuenta_bancaria_id, beneficiario_id, no_cheque, fecha_emision, monto,
      concepto, estatus, recibio_cheque_nombre, recibio_cheque_fecha,
      recibio_dinero_nombre, recibio_dinero_fecha
    } = req.body;
    const est = ['EMITIDO','ENTREGADO','COBRADO','CANCELADO'].includes(estatus) ? estatus : 'EMITIDO';

    // Si el cheque pertenece a una chequera, su folio y cuenta quedan bloqueados
    // para no romper el consecutivo. Todo lo demás sí es editable.
    const actual = await query(
      `SELECT chequera_id, no_cheque, cuenta_bancaria_id FROM fac_bancos_cheques WHERE id=$1`,
      [req.params.id]
    );
    if (!actual.rows.length) return res.status(404).json({ error: 'Cheque no encontrado.' });
    const a = actual.rows[0];
    if (a.chequera_id) {
      if (String(no_cheque).trim() !== String(a.no_cheque).trim())
        return res.status(400).json({
          error: `No se puede cambiar el folio de un cheque que pertenece a una chequera (rompería el consecutivo). Si el cheque ${a.no_cheque} se dañó, márcalo como CANCELADO.`
        });
      if (String(cuenta_bancaria_id) !== String(a.cuenta_bancaria_id))
        return res.status(400).json({ error: 'No se puede mover un cheque de chequera a otra cuenta.' });
    }

    await query(
      `UPDATE fac_bancos_cheques SET
         cuenta_bancaria_id=$1, beneficiario_id=$2, no_cheque=$3, fecha_emision=$4, monto=$5,
         concepto=$6, estatus=$7, recibio_cheque_nombre=$8, recibio_cheque_fecha=$9,
         recibio_dinero_nombre=$10, recibio_dinero_fecha=$11, actualizado_en=NOW()
       WHERE id=$12`,
      [cuenta_bancaria_id, beneficiario_id || null, String(no_cheque).trim(), fecha_emision, parseFloat(monto),
       concepto || null, est, recibio_cheque_nombre || null, recibio_cheque_fecha || null,
       recibio_dinero_nombre || null, recibio_dinero_fecha || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/cheques/:id/estatus', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { estatus } = req.body;
    if (!['EMITIDO','ENTREGADO','COBRADO','CANCELADO'].includes(estatus))
      return res.status(400).json({ error: 'Estatus inválido.' });
    await query(`UPDATE fac_bancos_cheques SET estatus=$1, actualizado_en=NOW() WHERE id=$2`, [estatus, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/cheques/:id', requireRol('admin'), async (req, res) => {
  try {
    // Solo se puede borrar el ÚLTIMO folio de la chequera; si no, se abriría un hueco
    const c = await query(
      `SELECT chequera_id, no_cheque FROM fac_bancos_cheques WHERE id=$1`, [req.params.id]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Cheque no encontrado.' });
    if (c.rows[0].chequera_id) {
      const mx = await query(
        `SELECT MAX(no_cheque::int) AS m FROM fac_bancos_cheques
         WHERE chequera_id=$1 AND no_cheque ~ '^[0-9]+$'`,
        [c.rows[0].chequera_id]
      );
      if (parseInt(c.rows[0].no_cheque) !== parseInt(mx.rows[0].m)) {
        return res.status(400).json({
          error: `Solo puedes eliminar el último cheque emitido de la chequera (el ${mx.rows[0].m}). Borrar el ${c.rows[0].no_cheque} dejaría un hueco en el consecutivo — márcalo como CANCELADO en su lugar.`
        });
      }
      // Al liberar folios, la chequera vuelve a estar activa
      await query(
        `UPDATE fac_bancos_chequeras SET estatus='ACTIVA', fecha_cierre=NULL
         WHERE id=$1 AND estatus='AGOTADA'`,
        [c.rows[0].chequera_id]
      );
    }
    await query(`DELETE FROM fac_bancos_cheques WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/cheques/reporte-a-cobrar?fecha=YYYY-MM-DD
// Agrupa cheques EMITIDOS/ENTREGADOS por Banco + Empresa
router.get('/cheques/reporte-a-cobrar', async (req, res) => {
  try {
    const { fecha, desde, hasta } = req.query;
    const params = [];
    let where = `WHERE c.estatus IN ('EMITIDO','ENTREGADO')`;
    if (fecha) {
      params.push(fecha); where += ` AND c.fecha_emision = $${params.length}`;
    } else {
      if (desde) { params.push(desde); where += ` AND c.fecha_emision >= $${params.length}`; }
      if (hasta) { params.push(hasta); where += ` AND c.fecha_emision <= $${params.length}`; }
    }
    const r = await query(`
      SELECT c.id, c.no_cheque, TO_CHAR(c.fecha_emision,'YYYY-MM-DD') AS fecha_emision, c.monto, c.concepto, c.estatus,
        b.nombre_completo AS beneficiario_nombre,
        cu.banco, cu.alias AS cuenta_alias, cu.numero_cuenta, cu.moneda,
        cu.titular, cu.empresa_id,
        e.nombre AS empresa_nombre
      FROM fac_bancos_cheques c
      LEFT JOIN fac_bancos_beneficiarios b ON b.id = c.beneficiario_id
      JOIN fac_bancos_cuentas cu ON cu.id = c.cuenta_bancaria_id
      LEFT JOIN fac_bancos_empresas e ON e.id = cu.empresa_id
      ${where}
      ORDER BY cu.banco, e.nombre, c.no_cheque
    `, params);

    // Agrupar por banco + empresa.
    // La empresa se configura en la cuenta bancaria, no en la chequera. Cuando la
    // cuenta no la tiene asignada se usa su titular, que es la razón social y
    // sirve igual para identificar de quién salen los cheques; "Sin empresa"
    // queda solo si la cuenta no tiene ni una cosa ni la otra.
    const rotulo = ch => ch.empresa_nombre
      || (ch.titular && ch.titular.trim())
      || (ch.cuenta_alias && ch.cuenta_alias.trim())
      || 'Sin empresa';

    const grupos = {};
    let importeTotal = 0;
    const cuentasSinEmpresa = new Set();
    for (const ch of r.rows) {
      const emp = rotulo(ch);
      if (!ch.empresa_id) cuentasSinEmpresa.add(`${ch.banco} · ${emp}`);
      const key = `${ch.banco}||${emp}`;
      if (!grupos[key]) grupos[key] = {
        banco: ch.banco, empresa: emp,
        empresa_asignada: !!ch.empresa_id,   // para avisar que falta configurarla
        cheques: [], subtotal: 0
      };
      grupos[key].cheques.push(ch);
      grupos[key].subtotal += parseFloat(ch.monto);
      importeTotal += parseFloat(ch.monto);
    }
    res.json({
      fecha_reporte: fecha || null,
      desde: desde || null,
      hasta: hasta || null,
      grupos: Object.values(grupos),
      importe_total: importeTotal,
      total_cheques: r.rows.length,
      cuentas_sin_empresa: [...cuentasSinEmpresa]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ LIBRO DE MOVIMIENTOS DE LA CUENTA ══════════════
// Naturaleza fija por tipo: ABONO = entra dinero, CARGO = sale dinero
const TIPO_MOV = {
  DEPOSITO:                'ABONO',
  TRANSFERENCIA_RECIBIDA:  'ABONO',
  COBRO_FACTURA:           'ABONO',
  INTERES:                 'ABONO',
  DEVOLUCION:              'ABONO',
  TRANSFERENCIA_ENVIADA:   'CARGO',
  PAGO_FACTURA:            'CARGO',
  PAGO_PROVEEDOR:          'CARGO',
  RETIRO:                  'CARGO',
  COMISION:                'CARGO',
  IMPUESTO:                'CARGO',
  NOMINA:                  'CARGO',
  OTRO:                    null   // el usuario elige la naturaleza
};

// Saldo de una cuenta = saldo inicial + abonos − cargos − cheques cobrados sin movimiento asociado
async function saldoCuenta(cuentaId, hasta) {
  const params = [cuentaId];
  let filtroFecha = '';
  if (hasta) { params.push(hasta); filtroFecha = ` AND fecha <= $${params.length}`; }
  const r = await query(`
    SELECT
      (SELECT saldo_inicial FROM fac_bancos_cuentas WHERE id=$1) AS inicial,
      COALESCE((SELECT SUM(monto) FROM fac_bancos_movimientos
                WHERE cuenta_bancaria_id=$1 AND naturaleza='ABONO'${filtroFecha}),0) AS abonos,
      COALESCE((SELECT SUM(monto) FROM fac_bancos_movimientos
                WHERE cuenta_bancaria_id=$1 AND naturaleza='CARGO'${filtroFecha}),0) AS cargos,
      COALESCE((SELECT SUM(c.monto) FROM fac_bancos_cheques c
                WHERE c.cuenta_bancaria_id=$1 AND c.estatus='COBRADO'
                  AND NOT EXISTS (SELECT 1 FROM fac_bancos_movimientos m WHERE m.cheque_id=c.id)),0) AS cheques
  `, params);
  const x = r.rows[0];
  const inicial = parseFloat(x.inicial)||0, abonos = parseFloat(x.abonos)||0;
  const cargos  = parseFloat(x.cargos)||0,  cheques = parseFloat(x.cheques)||0;
  return {
    saldo_inicial: inicial, abonos, cargos, cheques_cobrados: cheques,
    saldo_actual: +(inicial + abonos - cargos - cheques).toFixed(2)
  };
}

// GET /api/bancos/movimientos?cuenta_id=&desde=&hasta=&tipo=&naturaleza=&buscar=
router.get('/movimientos', async (req, res) => {
  try {
    const { cuenta_id, desde, hasta, tipo, naturaleza, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (cuenta_id)  { params.push(cuenta_id);  where += ` AND m.cuenta_bancaria_id=$${params.length}`; }
    if (desde)      { params.push(desde);      where += ` AND m.fecha >= $${params.length}`; }
    if (hasta)      { params.push(hasta);      where += ` AND m.fecha <= $${params.length}`; }
    if (tipo)       { params.push(tipo);       where += ` AND m.tipo=$${params.length}`; }
    if (naturaleza) { params.push(naturaleza); where += ` AND m.naturaleza=$${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (m.concepto ILIKE $${params.length} OR m.referencia ILIKE $${params.length} OR m.contraparte ILIKE $${params.length})`;
    }
    const r = await query(`
      SELECT m.*, TO_CHAR(m.fecha,'YYYY-MM-DD') AS fecha,
        cu.banco, cu.alias AS cuenta_alias, cu.moneda,
        f.folio AS factura_folio, f.uuid_cfdi AS factura_uuid,
        cl.razon_social AS cliente_nombre,
        ch.no_cheque AS cheque_folio
      FROM fac_bancos_movimientos m
      JOIN fac_bancos_cuentas cu ON cu.id = m.cuenta_bancaria_id
      LEFT JOIN fac_facturas f ON f.id = m.factura_id
      LEFT JOIN fac_clientes cl ON cl.id = f.cliente_id
      LEFT JOIN fac_bancos_cheques ch ON ch.id = m.cheque_id
      ${where}
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 500
    `, params);

    // Totales del periodo consultado
    const tot = r.rows.reduce((a, m) => {
      const v = parseFloat(m.monto) || 0;
      if (m.naturaleza === 'ABONO') a.abonos += v; else a.cargos += v;
      return a;
    }, { abonos: 0, cargos: 0 });
    tot.neto = +(tot.abonos - tot.cargos).toFixed(2);
    tot.abonos = +tot.abonos.toFixed(2);
    tot.cargos = +tot.cargos.toFixed(2);

    const saldo = cuenta_id ? await saldoCuenta(cuenta_id) : null;
    res.json({ movimientos: r.rows, totales: tot, saldo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/cuentas/:id/saldo
router.get('/cuentas/:id/saldo', async (req, res) => {
  try { res.json(await saldoCuenta(req.params.id, req.query.hasta)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bancos/facturas-pendientes — facturas con saldo, para vincular cobros
router.get('/facturas-pendientes', async (req, res) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let extra = '';
    if (buscar) {
      params.push(`%${buscar}%`);
      extra = ` AND (f.folio ILIKE $${params.length} OR c.razon_social ILIKE $${params.length})`;
    }
    // COALESCE en estatus: si viene NULL, 'x' <> 'cancelada' da NULL y la fila se perdería
    const r = await query(`
      SELECT f.id, f.folio, TO_CHAR(f.fecha_emision,'YYYY-MM-DD') AS fecha_emision,
        f.total, f.estatus, c.razon_social AS cliente,
        COALESCE((SELECT SUM(p.monto) FROM fac_pagos p WHERE p.factura_id=f.id),0) AS cobrado,
        (f.total - COALESCE((SELECT SUM(p.monto) FROM fac_pagos p WHERE p.factura_id=f.id),0)) AS saldo
      FROM fac_facturas f
      LEFT JOIN fac_clientes c ON c.id = f.cliente_id
      WHERE COALESCE(f.estatus,'') <> 'cancelada'${extra}
      ORDER BY
        CASE WHEN (f.total - COALESCE((SELECT SUM(p.monto) FROM fac_pagos p WHERE p.factura_id=f.id),0)) > 0.01
             THEN 0 ELSE 1 END,
        f.fecha_emision DESC
      LIMIT 150
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/movimientos', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cuenta_bancaria_id, fecha, tipo, naturaleza, monto, concepto,
            referencia, contraparte, factura_id, notas, registrar_pago } = req.body;
    if (!cuenta_bancaria_id || !fecha || !tipo || !monto)
      return res.status(400).json({ error: 'Cuenta, fecha, tipo y monto son requeridos.' });
    if (!(tipo in TIPO_MOV)) return res.status(400).json({ error: 'Tipo de movimiento inválido.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    // La naturaleza la define el tipo, salvo en OTRO
    const nat = TIPO_MOV[tipo] || (['CARGO','ABONO'].includes(naturaleza) ? naturaleza : 'CARGO');

    const r = await query(
      `INSERT INTO fac_bancos_movimientos(
         cuenta_bancaria_id, fecha, tipo, naturaleza, monto, concepto,
         referencia, contraparte, factura_id, notas, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cuenta_bancaria_id, fecha, tipo, nat, m, concepto || null,
       referencia || null, contraparte || null, factura_id || null, notas || null, req.usuario.id]
    );

    // Si es cobro de factura y se pidió, registrar también el pago en el módulo de cobranza
    let pagoCreado = null;
    if (registrar_pago && factura_id && nat === 'ABONO') {
      try {
        const p = await query(
          `INSERT INTO fac_pagos(factura_id, fecha_pago, monto, forma_pago, referencia, notas, creado_por)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [factura_id, fecha, m, 'transferencia', referencia || null,
           `Registrado desde Bancos · mov #${r.rows[0].id}`, req.usuario.id]
        );
        pagoCreado = p.rows[0].id;
        // Mantener el estatus de la factura al día (pendiente/parcial/pagada)
        try {
          const { recalcularEstatus } = require('./facturas');
          if (typeof recalcularEstatus === 'function') await recalcularEstatus(factura_id);
        } catch (e) { /* no bloquear si falla el recálculo */ }
      } catch (e) { /* si falla el pago, el movimiento bancario igual queda */ }
    }

    const saldo = await saldoCuenta(cuenta_bancaria_id);
    res.status(201).json({ ...r.rows[0], saldo, pago_id: pagoCreado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/movimientos/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { fecha, tipo, naturaleza, monto, concepto, referencia, contraparte, factura_id, notas } = req.body;
    if (!fecha || !tipo || !monto) return res.status(400).json({ error: 'Fecha, tipo y monto requeridos.' });
    if (!(tipo in TIPO_MOV)) return res.status(400).json({ error: 'Tipo de movimiento inválido.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    const nat = TIPO_MOV[tipo] || (['CARGO','ABONO'].includes(naturaleza) ? naturaleza : 'CARGO');
    await query(
      `UPDATE fac_bancos_movimientos SET
         fecha=$1, tipo=$2, naturaleza=$3, monto=$4, concepto=$5,
         referencia=$6, contraparte=$7, factura_id=$8, notas=$9, actualizado_en=NOW()
       WHERE id=$10`,
      [fecha, tipo, nat, m, concepto || null, referencia || null,
       contraparte || null, factura_id || null, notas || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/movimientos/:id', requireRol('admin', 'tesoreria'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_bancos_movimientos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ ESTADO DE CUENTA (movimientos) ═════════════════
router.get('/movimientos-ec', async (req, res) => {
  try {
    const { cuenta_id, desde, hasta, estado } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (cuenta_id) { params.push(cuenta_id); where += ` AND m.cuenta_bancaria_id=$${params.length}`; }
    if (desde)     { params.push(desde);     where += ` AND m.fecha_operacion >= $${params.length}`; }
    if (hasta)     { params.push(hasta);     where += ` AND m.fecha_operacion <= $${params.length}`; }
    if (estado)    { params.push(estado);    where += ` AND m.estado_conciliacion = $${params.length}`; }
    const r = await query(`
      SELECT m.*, TO_CHAR(m.fecha_operacion,'YYYY-MM-DD') AS fecha_operacion,
        cu.banco, cu.alias AS cuenta_alias,
        c.no_cheque AS cheque_no
      FROM fac_bancos_movimientos_ec m
      JOIN fac_bancos_cuentas cu ON cu.id = m.cuenta_bancaria_id
      LEFT JOIN fac_bancos_cheques c ON c.id = m.cheque_id
      ${where}
      ORDER BY m.fecha_operacion DESC, m.id DESC
      LIMIT 500
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/movimientos-ec', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cuenta_bancaria_id, fecha_operacion, concepto_banco, numero_referencia, monto_retiro, monto_deposito } = req.body;
    if (!cuenta_bancaria_id || !fecha_operacion) return res.status(400).json({ error: 'Cuenta y fecha requeridas.' });
    const r = await query(
      `INSERT INTO fac_bancos_movimientos_ec(
         cuenta_bancaria_id, fecha_operacion, concepto_banco, numero_referencia,
         monto_retiro, monto_deposito, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cuenta_bancaria_id, fecha_operacion, concepto_banco || null, numero_referencia || null,
       parseFloat(monto_retiro) || 0, parseFloat(monto_deposito) || 0, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/movimientos-ec/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_bancos_movimientos_ec WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bancos/conciliar — motor automático
// Recorre movimientos PENDIENTE y busca match en cheques EMITIDO/ENTREGADO
router.post('/conciliar', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { cuenta_id } = req.body;
    const params = [];
    let where = `WHERE m.estado_conciliacion='PENDIENTE' AND m.monto_retiro > 0`;
    if (cuenta_id) { params.push(cuenta_id); where += ` AND m.cuenta_bancaria_id=$${params.length}`; }
    const movs = await query(`
      SELECT m.* FROM fac_bancos_movimientos_ec m ${where}
    `, params);
    let conciliados = 0, no_identificados = 0;
    for (const m of movs.rows) {
      // Buscar cheque emitido/entregado con misma cuenta+monto donde no_cheque aparezca en referencia o concepto
      const monto = parseFloat(m.monto_retiro);
      const cand = await query(`
        SELECT id, no_cheque FROM fac_bancos_cheques
        WHERE cuenta_bancaria_id=$1
          AND estatus IN ('EMITIDO','ENTREGADO')
          AND ROUND(monto::numeric,2) = ROUND($2::numeric,2)
      `, [m.cuenta_bancaria_id, monto]);
      let matchId = null;
      for (const c of cand.rows) {
        const refCat = `${m.numero_referencia||''} ${m.concepto_banco||''}`.toLowerCase();
        if (refCat.includes(String(c.no_cheque).toLowerCase())) { matchId = c.id; break; }
      }
      // Fallback: si hay UN solo candidato con ese monto exacto, aceptarlo
      if (!matchId && cand.rows.length === 1) matchId = cand.rows[0].id;

      if (matchId) {
        await query(`UPDATE fac_bancos_movimientos_ec SET estado_conciliacion='CONCILIADO', cheque_id=$1 WHERE id=$2`, [matchId, m.id]);
        await query(`UPDATE fac_bancos_cheques SET estatus='COBRADO', movimiento_ec_id=$1, actualizado_en=NOW() WHERE id=$2`, [m.id, matchId]);
        conciliados++;
      } else {
        await query(`UPDATE fac_bancos_movimientos_ec SET estado_conciliacion='NO_IDENTIFICADO' WHERE id=$1`, [m.id]);
        no_identificados++;
      }
    }
    res.json({ ok:true, revisados: movs.rows.length, conciliados, no_identificados });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bancos/conciliar/manual — asocia manualmente movimiento ↔ cheque
router.post('/conciliar/manual', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { movimiento_id, cheque_id } = req.body;
    if (!movimiento_id || !cheque_id) return res.status(400).json({ error: 'movimiento_id y cheque_id requeridos.' });
    await query(`UPDATE fac_bancos_movimientos_ec SET estado_conciliacion='CONCILIADO', cheque_id=$1 WHERE id=$2`, [cheque_id, movimiento_id]);
    await query(`UPDATE fac_bancos_cheques SET estatus='COBRADO', movimiento_ec_id=$1, actualizado_en=NOW() WHERE id=$2`, [movimiento_id, cheque_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
