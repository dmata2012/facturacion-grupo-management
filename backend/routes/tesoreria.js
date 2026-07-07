const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// ══ FONDOS DE CAJA CHICA ══════════════════════════════════
router.get('/fondos', async (req, res) => {
  try {
    const { activo } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (activo !== undefined) { params.push(activo === 'true'); where += ` AND f.activo=$${params.length}`; }

    const r = await query(`
      SELECT f.*,
        COALESCE(sub_e.entradas, 0) AS total_entradas,
        COALESCE(sub_s.salidas, 0)  AS total_salidas,
        f.saldo_inicial + COALESCE(sub_e.entradas,0) - COALESCE(sub_s.salidas,0) AS saldo_actual,
        COALESCE(sub_e.n_ent, 0) + COALESCE(sub_s.n_sal, 0) AS total_movimientos
      FROM fac_caja_chica_fondos f
      LEFT JOIN (
        SELECT fondo_id, SUM(monto) AS entradas, COUNT(*)::int AS n_ent
        FROM fac_caja_chica_movimientos WHERE tipo='entrada' GROUP BY fondo_id
      ) sub_e ON sub_e.fondo_id = f.id
      LEFT JOIN (
        SELECT fondo_id, SUM(monto) AS salidas, COUNT(*)::int AS n_sal
        FROM fac_caja_chica_movimientos WHERE tipo='salida' GROUP BY fondo_id
      ) sub_s ON sub_s.fondo_id = f.id
      ${where}
      ORDER BY f.activo DESC, f.nombre
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fondos/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_caja_chica_fondos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Fondo no encontrado.' });

    const mov = await query(`
      SELECT * FROM fac_caja_chica_movimientos
      WHERE fondo_id=$1 ORDER BY fecha DESC, id DESC
    `, [req.params.id]);

    const kpi = await query(`
      SELECT
        COALESCE(SUM(monto) FILTER (WHERE tipo='entrada'),0) AS total_entradas,
        COALESCE(SUM(monto) FILTER (WHERE tipo='salida'),0)  AS total_salidas,
        COUNT(*) FILTER (WHERE tipo='entrada')::int          AS n_entradas,
        COUNT(*) FILTER (WHERE tipo='salida')::int           AS n_salidas
      FROM fac_caja_chica_movimientos WHERE fondo_id=$1
    `, [req.params.id]);

    const cat = await query(`
      SELECT categoria, SUM(monto) AS total, COUNT(*)::int AS n
      FROM fac_caja_chica_movimientos
      WHERE fondo_id=$1 AND tipo='salida' AND categoria IS NOT NULL
      GROUP BY categoria ORDER BY total DESC
    `, [req.params.id]);

    const fondo = r.rows[0];
    const k = kpi.rows[0];
    const saldo = parseFloat(fondo.saldo_inicial) + parseFloat(k.total_entradas) - parseFloat(k.total_salidas);

    res.json({ ...fondo, movimientos: mov.rows, kpi: { ...k, saldo_actual: saldo }, por_categoria: cat.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fondos', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, notas } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_caja_chica_fondos(nombre,responsable,departamento,fondo_asignado,saldo_inicial,moneda,notas,creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nombre, responsable, departamento, parseFloat(fondo_asignado)||0, parseFloat(saldo_inicial)||0,
       moneda||'MXN', notas, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fondos/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, activo, notas } = req.body;
    await query(
      `UPDATE fac_caja_chica_fondos SET
         nombre=$1, responsable=$2, departamento=$3,
         fondo_asignado=$4, saldo_inicial=$5, moneda=$6,
         activo=$7, notas=$8, actualizado_en=NOW()
       WHERE id=$9`,
      [nombre, responsable, departamento, parseFloat(fondo_asignado)||0, parseFloat(saldo_inicial)||0,
       moneda||'MXN', activo !== false, notas, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/fondos/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_caja_chica_fondos SET activo=FALSE, actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ MOVIMIENTOS ═══════════════════════════════════════════
router.post('/movimientos', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { fondo_id, fecha, tipo, categoria, concepto, monto, beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas } = req.body;
    if (!fondo_id || !fecha || !tipo || !concepto || !monto)
      return res.status(400).json({ error: 'Fondo, fecha, tipo, concepto y monto son requeridos.' });
    if (!['entrada','salida'].includes(tipo))
      return res.status(400).json({ error: 'Tipo debe ser entrada o salida.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    // Validar saldo suficiente en salidas
    if (tipo === 'salida') {
      const fs = await query(`
        SELECT f.saldo_inicial
          + COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='entrada'),0)
          - COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='salida'),0) AS saldo
        FROM fac_caja_chica_fondos f WHERE f.id=$1
      `, [fondo_id]);
      if (!fs.rows.length) return res.status(404).json({ error: 'Fondo no encontrado.' });
      const saldo = parseFloat(fs.rows[0].saldo);
      if (m > saldo + 0.01) {
        return res.status(400).json({
          error: `Salida $${m.toFixed(2)} supera el saldo disponible ($${saldo.toFixed(2)}).`
        });
      }
    }

    const r = await query(
      `INSERT INTO fac_caja_chica_movimientos(
         fondo_id, fecha, tipo, categoria, concepto, monto,
         beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [fondo_id, fecha, tipo, categoria||null, concepto, m,
       beneficiario||null, forma_pago||'efectivo', referencia||null, comprobante||null,
       autorizado_por||null, notas||null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/movimientos/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { fecha, categoria, concepto, monto, beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas } = req.body;
    if (!fecha || !concepto || !monto)
      return res.status(400).json({ error: 'Fecha, concepto y monto requeridos.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    // Verificar que no deje el saldo negativo si es salida
    const cur = await query(`SELECT fondo_id, tipo FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const { fondo_id, tipo } = cur.rows[0];
    if (tipo === 'salida') {
      const fs = await query(`
        SELECT f.saldo_inicial
          + COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='entrada'),0)
          - COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='salida' AND id != $2),0) AS saldo_disp
        FROM fac_caja_chica_fondos f WHERE f.id=$1
      `, [fondo_id, req.params.id]);
      const saldoDisp = parseFloat(fs.rows[0].saldo_disp);
      if (m > saldoDisp + 0.01) {
        return res.status(400).json({
          error: `Salida $${m.toFixed(2)} supera el saldo disponible ($${saldoDisp.toFixed(2)}).`
        });
      }
    }

    await query(
      `UPDATE fac_caja_chica_movimientos SET
         fecha=$1, categoria=$2, concepto=$3, monto=$4,
         beneficiario=$5, forma_pago=$6, referencia=$7, comprobante=$8,
         autorizado_por=$9, notas=$10, actualizado_en=NOW()
       WHERE id=$11`,
      [fecha, categoria||null, concepto, m, beneficiario||null, forma_pago||'efectivo',
       referencia||null, comprobante||null, autorizado_por||null, notas||null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/movimientos/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ KPIs GLOBALES ═════════════════════════════════════════
router.get('/kpi', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        COUNT(*)::int AS fondos_activos,
        COALESCE(SUM(f.fondo_asignado),0) AS total_asignado,
        COALESCE(SUM(
          f.saldo_inicial
          + COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='entrada'),0)
          - COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='salida'),0)
        ),0) AS saldo_total,
        COALESCE(SUM(
          COALESCE((SELECT SUM(monto) FROM fac_caja_chica_movimientos WHERE fondo_id=f.id AND tipo='salida'
            AND fecha >= DATE_TRUNC('month', CURRENT_DATE)),0)
        ),0) AS gastos_mes
      FROM fac_caja_chica_fondos f WHERE f.activo = TRUE
    `);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
