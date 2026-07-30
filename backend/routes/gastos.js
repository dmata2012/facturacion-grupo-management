const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Conceptos iniciales del catálogo — se siembran solo la primera vez.
// Se respeta la redacción original que usa la empresa.
const CONCEPTOS_SEED = [
  'NOMINA GRUPO MANAGEMENT',
  'COMISIONES VENTAS',
  'COMPRA DE EQUIPOS Y PROGRAMAS',
  'ASESORIA ADMINISTRATIVA, LEGAL Y COORPORATIVA',
  'CAPACITACION Y ENTRENAMIENTO',
  'COMBUSTIBLE Y LUBRICANTES',
  'CORTESIAS Y ATENCIONES',
  'Regalos y canastas Navideñas Clientes',
  'GASTOS DE VIAJE',
  'GASTOS DIVERSOS',
  'LUZ',
  'MANTTO. DE OFICINA 1218/ y 1219',
  'MANTTO. SISTEMAS Y EQUIPO DE COMPUTO',
  'MANTTO. VEHICULO',
  'REMODELACIÓN GM',
  'PAGO DE IMSS ESTMAR',
  'PAGO IMPUESTO PREDIAL OFICINA 1006',
  'PAPELERIA Y EQUIPO DE OFICINA',
  'PAQUETERIA Y ENVIOS POR MENSAJERIA',
  'ACTUALIZACIONES LICENCIAS DE SOFTWARE',
  'PUBLICIDAD Y PROPAGANDA',
  'AUTO DE DILIGENCIAS',
  'RENTA',
  'RENTA DE COPIADORA',
  'TELÉFONO',
  'TIMBRES FISCALES',
  'TRAMITES DE IMSS',
  'UNIFORMES',
  'ISN MULTAS Y CONVENIOS',
  'GASTOS DE APERTURA',
  'RENOVACIÓN CONTRATO CROC',
  'SEGUROS DE SEGUROS PIME',
  'COMISIONES VENTA CLIENTE P',
  'COMISIONES VENTA CLIENTE JS',
  'MD PLUS',
  'IGUAKA ABOGADO',
  'PTU',
  'AGUINALDO',
  'IMPUESTOS PATRONALES GM',
  'OFICINAS VIRTUALES ORBIS',
  'ACTUALIZACIÓN DE PROGRAMAS Y PAGINAS DE INTERNET',
  'INTERESES FONDO DE AHORRO',
  'TRAMITES DE ACILES Y LICENCIAS',
  'PAGO DE MULTAS (TRAMITE EXTEMPORÁNEO)',
  'ALARMAS DE SEGURIDAD',
  'POSADA GM',
  'TRAMITES MIGRATORIOS',
  'Bono Anual',
  'Bodega Archivo',
  'SUMINISTROS OFICINA',
  'COMISIONES Y SITUACIONES BANCARIAS'
];

// Migraciones idempotentes
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_gastos_conceptos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        grupo TEXT DEFAULT 'Gastos de Operación',
        orden INT DEFAULT 99,
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS fac_gastos (
        id SERIAL PRIMARY KEY,
        concepto_id INT NOT NULL REFERENCES fac_gastos_conceptos(id) ON DELETE RESTRICT,
        fecha DATE NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        descripcion TEXT,
        proveedor TEXT,
        forma_pago TEXT DEFAULT 'transferencia',
        referencia TEXT,
        factura_rfc TEXT,
        deducible BOOLEAN DEFAULT TRUE,
        notas TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW(),
        CHECK (monto > 0)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON fac_gastos(fecha)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_gastos_concepto ON fac_gastos(concepto_id)`);

    // Sembrar el catálogo solo si está vacío
    const c = await query(`SELECT COUNT(*)::int AS n FROM fac_gastos_conceptos`);
    if (c.rows[0].n === 0) {
      for (let i = 0; i < CONCEPTOS_SEED.length; i++) {
        await query(
          `INSERT INTO fac_gastos_conceptos(nombre, orden) VALUES($1,$2)
           ON CONFLICT (nombre) DO NOTHING`,
          [CONCEPTOS_SEED[i], i + 1]
        );
      }
      console.log(`✔ Catálogo de gastos sembrado con ${CONCEPTOS_SEED.length} conceptos.`);
    }
  } catch (e) { console.warn('Migración gastos:', e.message); }
})();

// ═══ CATÁLOGO DE CONCEPTOS ══════════════════════════
router.get('/conceptos', async (req, res) => {
  try {
    const { todos } = req.query;
    const r = await query(`
      SELECT c.*,
        (SELECT COUNT(*)::int FROM fac_gastos g WHERE g.concepto_id = c.id)        AS n_gastos,
        COALESCE((SELECT SUM(g.monto) FROM fac_gastos g WHERE g.concepto_id = c.id),0) AS total_historico
      FROM fac_gastos_conceptos c
      ${todos === 'true' ? '' : 'WHERE c.activo = TRUE'}
      ORDER BY c.orden, c.nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/conceptos', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, grupo, orden } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del concepto requerido.' });
    const r = await query(
      `INSERT INTO fac_gastos_conceptos(nombre, grupo, orden) VALUES($1,$2,$3)
       ON CONFLICT (nombre) DO UPDATE SET activo = TRUE RETURNING *`,
      [nombre.trim(), grupo || 'Gastos de Operación', parseInt(orden) || 99]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/conceptos/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, grupo, orden, activo } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del concepto requerido.' });
    await query(
      `UPDATE fac_gastos_conceptos SET nombre=$1, grupo=$2, orden=$3, activo=$4 WHERE id=$5`,
      [nombre.trim(), grupo || 'Gastos de Operación', parseInt(orden) || 99, activo !== false, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe otro concepto con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});

// Baja lógica: si el concepto ya tiene gastos, no se elimina para no romper el histórico
router.delete('/conceptos/:id', requireRol('admin'), async (req, res) => {
  try {
    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_gastos WHERE concepto_id=$1`, [req.params.id]);
    if (uso.rows[0].n > 0) {
      await query(`UPDATE fac_gastos_conceptos SET activo=FALSE WHERE id=$1`, [req.params.id]);
      return res.json({ ok: true, desactivado: true, gastos: uso.rows[0].n });
    }
    await query(`DELETE FROM fac_gastos_conceptos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, eliminado: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ GASTOS ═════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { desde, hasta, concepto_id, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (desde)       { params.push(desde);       where += ` AND g.fecha >= $${params.length}`; }
    if (hasta)       { params.push(hasta);       where += ` AND g.fecha <= $${params.length}`; }
    if (concepto_id) { params.push(concepto_id); where += ` AND g.concepto_id = $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (g.descripcion ILIKE $${params.length} OR g.proveedor ILIKE $${params.length}
                      OR g.referencia ILIKE $${params.length} OR c.nombre ILIKE $${params.length})`;
    }

    const r = await query(`
      SELECT g.*, TO_CHAR(g.fecha,'YYYY-MM-DD') AS fecha,
        c.nombre AS concepto, c.grupo,
        u.nombre AS capturado_por
      FROM fac_gastos g
      JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      LEFT JOIN fac_usuarios u ON u.id = g.creado_por
      ${where}
      ORDER BY g.fecha DESC, g.id DESC
      LIMIT 500
    `, params);

    // Totales y desglose por concepto del período consultado
    const tot = await query(`
      SELECT
        COUNT(g.id)::int                       AS n_gastos,
        COALESCE(SUM(g.monto),0)               AS total,
        COUNT(DISTINCT g.concepto_id)::int     AS conceptos,
        COALESCE(SUM(g.monto) FILTER (WHERE g.deducible),0) AS deducible
      FROM fac_gastos g
      JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      ${where}
    `, params);

    const porConcepto = await query(`
      SELECT c.id, c.nombre AS concepto,
        COUNT(g.id)::int         AS n,
        COALESCE(SUM(g.monto),0) AS total
      FROM fac_gastos g
      JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      ${where}
      GROUP BY c.id, c.nombre
      ORDER BY total DESC
    `, params);

    res.json({ gastos: r.rows, totales: tot.rows[0], por_concepto: porConcepto.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { concepto_id, fecha, monto, descripcion, proveedor,
            forma_pago, referencia, factura_rfc, deducible, notas } = req.body;
    if (!concepto_id || !fecha || !monto)
      return res.status(400).json({ error: 'Concepto, fecha y monto son requeridos.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    const r = await query(
      `INSERT INTO fac_gastos(concepto_id, fecha, monto, descripcion, proveedor,
         forma_pago, referencia, factura_rfc, deducible, notas, creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [concepto_id, fecha, m, descripcion || null, proveedor || null,
       forma_pago || 'transferencia', referencia || null, factura_rfc || null,
       deducible !== false, notas || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { concepto_id, fecha, monto, descripcion, proveedor,
            forma_pago, referencia, factura_rfc, deducible, notas } = req.body;
    if (!concepto_id || !fecha || !monto)
      return res.status(400).json({ error: 'Concepto, fecha y monto son requeridos.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    await query(
      `UPDATE fac_gastos SET concepto_id=$1, fecha=$2, monto=$3, descripcion=$4, proveedor=$5,
         forma_pago=$6, referencia=$7, factura_rfc=$8, deducible=$9, notas=$10, actualizado_en=NOW()
       WHERE id=$11`,
      [concepto_id, fecha, m, descripcion || null, proveedor || null,
       forma_pago || 'transferencia', referencia || null, factura_rfc || null,
       deducible !== false, notas || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mismos roles que canGastos() en la interfaz, para que quien vea el botón pueda usarlo
router.delete('/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_gastos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ RESUMEN MENSUAL POR CONCEPTO ═══════════════════
// Matriz concepto × mes para comparar el comportamiento del gasto en el año
router.get('/resumen-mensual', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear();
    const r = await query(`
      SELECT c.id, c.nombre AS concepto,
        EXTRACT(MONTH FROM g.fecha)::int AS mes,
        COALESCE(SUM(g.monto),0) AS total
      FROM fac_gastos g
      JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      WHERE EXTRACT(YEAR FROM g.fecha) = $1
      GROUP BY c.id, c.nombre, mes
      ORDER BY c.nombre, mes
    `, [anio]);

    // Reagrupar en { concepto, meses:[12], total }
    const mapa = {};
    r.rows.forEach(x => {
      if (!mapa[x.id]) mapa[x.id] = { id: x.id, concepto: x.concepto, meses: Array(12).fill(0), total: 0 };
      const v = parseFloat(x.total) || 0;
      mapa[x.id].meses[x.mes - 1] = v;
      mapa[x.id].total += v;
    });
    const filas = Object.values(mapa).sort((a, b) => b.total - a.total);
    const totalMeses = Array(12).fill(0);
    filas.forEach(f => f.meses.forEach((v, i) => totalMeses[i] += v));

    res.json({
      anio, filas,
      total_meses: totalMeses,
      total_anio : totalMeses.reduce((a, b) => a + b, 0)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
