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

// Agrupación inicial de los conceptos en categorías. Es solo un punto de partida:
// desde el catálogo se puede reasignar cualquier concepto a otra categoría.
const CATEGORIAS_SEED = [
  { nombre:'Personal y Nómina', color:'#7c3aed', conceptos:[
    'NOMINA GRUPO MANAGEMENT','PTU','AGUINALDO','IMPUESTOS PATRONALES GM',
    'PAGO DE IMSS ESTMAR','TRAMITES DE IMSS','INTERESES FONDO DE AHORRO',
    'UNIFORMES','CAPACITACION Y ENTRENAMIENTO','Bono Anual','POSADA GM' ]},
  { nombre:'Comisiones', color:'#0891b2', conceptos:[
    'COMISIONES VENTAS','COMISIONES VENTA CLIENTE P','COMISIONES VENTA CLIENTE JS' ]},
  { nombre:'Instalaciones y Servicios', color:'#059669', conceptos:[
    'RENTA','LUZ','TELÉFONO','MANTTO. DE OFICINA 1218/ y 1219','REMODELACIÓN GM',
    'PAGO IMPUESTO PREDIAL OFICINA 1006','ALARMAS DE SEGURIDAD','Bodega Archivo',
    'OFICINAS VIRTUALES ORBIS','SUMINISTROS OFICINA' ]},
  { nombre:'Tecnología y Sistemas', color:'#2563eb', conceptos:[
    'COMPRA DE EQUIPOS Y PROGRAMAS','MANTTO. SISTEMAS Y EQUIPO DE COMPUTO',
    'ACTUALIZACIONES LICENCIAS DE SOFTWARE',
    'ACTUALIZACIÓN DE PROGRAMAS Y PAGINAS DE INTERNET','RENTA DE COPIADORA' ]},
  { nombre:'Vehículos y Viáticos', color:'#ea580c', conceptos:[
    'COMBUSTIBLE Y LUBRICANTES','MANTTO. VEHICULO','GASTOS DE VIAJE','AUTO DE DILIGENCIAS' ]},
  { nombre:'Legal, Fiscal y Seguros', color:'#be185d', conceptos:[
    'ASESORIA ADMINISTRATIVA, LEGAL Y COORPORATIVA','IGUAKA ABOGADO',
    'ISN MULTAS Y CONVENIOS','PAGO DE MULTAS (TRAMITE EXTEMPORÁNEO)',
    'TRAMITES DE ACILES Y LICENCIAS','TRAMITES MIGRATORIOS',
    'RENOVACIÓN CONTRATO CROC','SEGUROS DE SEGUROS PIME','GASTOS DE APERTURA' ]},
  { nombre:'Ventas y Relaciones', color:'#c026d3', conceptos:[
    'PUBLICIDAD Y PROPAGANDA','CORTESIAS Y ATENCIONES',
    'Regalos y canastas Navideñas Clientes','MD PLUS' ]},
  { nombre:'Administrativos', color:'#475569', conceptos:[
    'PAPELERIA Y EQUIPO DE OFICINA','PAQUETERIA Y ENVIOS POR MENSAJERIA',
    'TIMBRES FISCALES','COMISIONES Y SITUACIONES BANCARIAS' ]},
  { nombre:'Otros gastos', color:'#78716c', conceptos:['GASTOS DIVERSOS'] }
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

    // ── Ampliación: jerarquía, CFDI de proveedor y auto-clasificación ──

    // Categorías (nivel superior). Los conceptos existentes pasan a ser subcategorías.
    await query(`
      CREATE TABLE IF NOT EXISTS fac_gastos_categorias (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#d97706',
        orden INT DEFAULT 99,
        activa BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`ALTER TABLE fac_gastos_conceptos ADD COLUMN IF NOT EXISTS categoria_id INT REFERENCES fac_gastos_categorias(id) ON DELETE SET NULL`);

    // El concepto pasa a ser opcional: un gasto importado por XML llega sin clasificar
    await query(`ALTER TABLE fac_gastos ALTER COLUMN concepto_id DROP NOT NULL`);

    // Datos del CFDI del proveedor
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS uuid TEXT`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'MANUAL'`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS rfc_proveedor TEXT`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS nombre_proveedor TEXT`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2)`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS iva NUMERIC(14,2)`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS retenciones NUMERIC(14,2) DEFAULT 0`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS estatus_sat TEXT`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS sat_validado_en TIMESTAMP`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS serie_folio TEXT`);

    // Blindaje anti-duplicados: un mismo folio fiscal no puede registrarse dos veces.
    // El índice es parcial para que los gastos manuales (uuid NULL) no choquen entre sí.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gastos_uuid_unico ON fac_gastos(uuid) WHERE uuid IS NOT NULL`);
    await query(`CREATE INDEX IF NOT EXISTS idx_gastos_rfc ON fac_gastos(rfc_proveedor)`);

    // Mapeo RFC del proveedor → concepto, para clasificar solo los recurrentes
    await query(`
      CREATE TABLE IF NOT EXISTS fac_gastos_mapeo_proveedores (
        id SERIAL PRIMARY KEY,
        rfc TEXT NOT NULL UNIQUE,
        nombre_proveedor TEXT,
        concepto_id INT REFERENCES fac_gastos_conceptos(id) ON DELETE CASCADE,
        veces_usado INT DEFAULT 0,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      )`);

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

    // Sembrar categorías y agrupar los conceptos existentes bajo ellas.
    // Solo corre una vez; después la clasificación se ajusta desde la interfaz.
    const cats = await query(`SELECT COUNT(*)::int AS n FROM fac_gastos_categorias`);
    if (cats.rows[0].n === 0) {
      for (let i = 0; i < CATEGORIAS_SEED.length; i++) {
        const cat = CATEGORIAS_SEED[i];
        const r = await query(
          `INSERT INTO fac_gastos_categorias(nombre, color, orden) VALUES($1,$2,$3)
           ON CONFLICT (nombre) DO UPDATE SET color=EXCLUDED.color RETURNING id`,
          [cat.nombre, cat.color, i + 1]
        );
        const catId = r.rows[0].id;
        // Asignar sus conceptos (solo los que aún no tienen categoría)
        for (const nombre of cat.conceptos) {
          await query(
            `UPDATE fac_gastos_conceptos SET categoria_id=$1
             WHERE nombre=$2 AND categoria_id IS NULL`,
            [catId, nombre]
          );
        }
      }
      // Los que no quedaron en ninguna categoría van a "Otros"
      const otros = await query(
        `SELECT id FROM fac_gastos_categorias WHERE nombre='Otros gastos' LIMIT 1`);
      if (otros.rows.length) {
        await query(`UPDATE fac_gastos_conceptos SET categoria_id=$1 WHERE categoria_id IS NULL`,
          [otros.rows[0].id]);
      }
      console.log(`✔ Categorías de gasto sembradas y conceptos agrupados.`);
    }
  } catch (e) { console.warn('Migración gastos:', e.message); }
})();

// ═══ CATEGORÍAS (nivel superior del catálogo) ═══════
router.get('/categorias', async (req, res) => {
  try {
    const r = await query(`
      SELECT k.*,
        (SELECT COUNT(*)::int FROM fac_gastos_conceptos c
          WHERE c.categoria_id = k.id AND c.activo) AS n_conceptos
      FROM fac_gastos_categorias k
      WHERE k.activa = TRUE
      ORDER BY k.orden, k.nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categorias', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, color, orden } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_gastos_categorias(nombre, color, orden) VALUES($1,$2,$3)
       ON CONFLICT (nombre) DO UPDATE SET activa=TRUE, color=EXCLUDED.color RETURNING *`,
      [nombre.trim(), color || '#d97706', parseInt(orden) || 99]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/categorias/:id', requireRol('admin'), async (req, res) => {
  try {
    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_gastos_conceptos WHERE categoria_id=$1`, [req.params.id]);
    if (uso.rows[0].n > 0)
      return res.status(400).json({ error: `No se puede eliminar: ${uso.rows[0].n} concepto(s) pertenecen a esta categoría.` });
    await query(`DELETE FROM fac_gastos_categorias WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ MAPEO DE PROVEEDORES (auto-clasificación) ══════
router.get('/mapeo-proveedores', async (req, res) => {
  try {
    const r = await query(`
      SELECT m.*, c.nombre AS concepto, k.nombre AS categoria
      FROM fac_gastos_mapeo_proveedores m
      LEFT JOIN fac_gastos_conceptos c  ON c.id = m.concepto_id
      LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
      ORDER BY m.veces_usado DESC, m.nombre_proveedor
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mapeo-proveedores', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { rfc, nombre_proveedor, concepto_id } = req.body;
    if (!rfc || !concepto_id) return res.status(400).json({ error: 'RFC y concepto requeridos.' });
    const r = await query(
      `INSERT INTO fac_gastos_mapeo_proveedores(rfc, nombre_proveedor, concepto_id, creado_por)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (rfc) DO UPDATE
         SET concepto_id = EXCLUDED.concepto_id,
             nombre_proveedor = COALESCE(EXCLUDED.nombre_proveedor, fac_gastos_mapeo_proveedores.nombre_proveedor),
             actualizado_en = NOW()
       RETURNING *`,
      [rfc.trim().toUpperCase(), nombre_proveedor || null, concepto_id, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/mapeo-proveedores/:id', requireRol('admin', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_gastos_mapeo_proveedores WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ IMPORTACIÓN DE CFDI DE PROVEEDOR ═══════════════
// El navegador parsea los XML y manda aquí el arreglo de comprobantes.
// Se resuelve en el servidor para poder validar duplicados de forma confiable.
router.post('/importar-xml', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { comprobantes } = req.body;
    if (!Array.isArray(comprobantes) || !comprobantes.length)
      return res.status(400).json({ error: 'No se recibió ningún comprobante.' });

    // Mapeo RFC → concepto para auto-clasificar
    const mapeo = {};
    const mp = await query(`SELECT rfc, concepto_id FROM fac_gastos_mapeo_proveedores`);
    mp.rows.forEach(m => { mapeo[m.rfc.toUpperCase()] = m.concepto_id; });

    const resultado = { insertados: 0, duplicados: [], errores: [], sin_clasificar: 0 };

    for (const c of comprobantes) {
      const uuid = (c.uuid || '').trim().toUpperCase();
      const archivo = c.archivo || uuid || 's/n';
      try {
        if (!uuid) { resultado.errores.push({ archivo, error: 'El XML no tiene UUID (timbre fiscal).' }); continue; }
        if (!c.fecha || !c.total) { resultado.errores.push({ archivo, error: 'Faltan fecha o total en el XML.' }); continue; }

        // Bloqueo anti-duplicidad: se consulta antes de intentar insertar
        const ya = await query(`SELECT id, fecha, total FROM fac_gastos WHERE uuid=$1`, [uuid]);
        if (ya.rows.length) {
          resultado.duplicados.push({ archivo, uuid, registrado_el: ya.rows[0].fecha });
          continue;
        }

        const rfc = (c.rfc_emisor || '').trim().toUpperCase();
        const conceptoId = mapeo[rfc] || null;
        if (!conceptoId) resultado.sin_clasificar++;

        await query(
          `INSERT INTO fac_gastos(
             concepto_id, fecha, monto, subtotal, iva, retenciones,
             uuid, origen, rfc_proveedor, nombre_proveedor, serie_folio,
             descripcion, proveedor, factura_rfc, forma_pago, creado_por)
           VALUES($1,$2,$3,$4,$5,$6,$7,'XML',$8,$9,$10,$11,$12,$13,$14,$15)`,
          [conceptoId, c.fecha.slice(0,10), parseFloat(c.total),
           parseFloat(c.subtotal) || null, parseFloat(c.iva) || null, parseFloat(c.retenciones) || 0,
           uuid, rfc, c.nombre_emisor || null, c.serie_folio || null,
           c.concepto || null, c.nombre_emisor || null, rfc,
           c.forma_pago || 'transferencia', req.usuario.id]
        );
        resultado.insertados++;

        // Contabilizar el uso del mapeo que sí aplicó
        if (conceptoId) {
          await query(`UPDATE fac_gastos_mapeo_proveedores SET veces_usado = veces_usado + 1 WHERE rfc=$1`, [rfc]);
        }
      } catch (e) {
        // El índice único es la última barrera si dos archivos traen el mismo UUID
        if (e.code === '23505') resultado.duplicados.push({ archivo, uuid, error: 'UUID duplicado' });
        else resultado.errores.push({ archivo, error: e.message });
      }
    }
    res.json(resultado);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ BANDEJA DE PENDIENTES DE CLASIFICAR ════════════
router.get('/pendientes', async (req, res) => {
  try {
    const r = await query(`
      SELECT g.*, TO_CHAR(g.fecha,'YYYY-MM-DD') AS fecha
      FROM fac_gastos g
      WHERE g.concepto_id IS NULL
      ORDER BY g.fecha DESC, g.id DESC
      LIMIT 300
    `);
    const tot = await query(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(monto),0) AS total
      FROM fac_gastos WHERE concepto_id IS NULL
    `);
    res.json({ gastos: r.rows, totales: tot.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clasificar un gasto y, opcionalmente, recordar el proveedor para la próxima
router.patch('/:id/clasificar', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { concepto_id, recordar_proveedor } = req.body;
    if (!concepto_id) return res.status(400).json({ error: 'Concepto requerido.' });

    const g = await query(`SELECT rfc_proveedor, nombre_proveedor FROM fac_gastos WHERE id=$1`, [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ error: 'Gasto no encontrado.' });

    await query(`UPDATE fac_gastos SET concepto_id=$1, actualizado_en=NOW() WHERE id=$2`,
      [concepto_id, req.params.id]);

    let mapeado = false;
    const rfc = (g.rows[0].rfc_proveedor || '').trim().toUpperCase();
    if (recordar_proveedor && rfc) {
      await query(
        `INSERT INTO fac_gastos_mapeo_proveedores(rfc, nombre_proveedor, concepto_id, creado_por)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (rfc) DO UPDATE SET concepto_id=EXCLUDED.concepto_id, actualizado_en=NOW()`,
        [rfc, g.rows[0].nombre_proveedor || null, concepto_id, req.usuario.id]
      );
      mapeado = true;
    }
    res.json({ ok: true, mapeado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CATÁLOGO DE CONCEPTOS ══════════════════════════
router.get('/conceptos', async (req, res) => {
  try {
    const { todos } = req.query;
    const r = await query(`
      SELECT c.*,
        k.nombre AS categoria, k.color AS categoria_color, k.orden AS categoria_orden,
        (SELECT COUNT(*)::int FROM fac_gastos g WHERE g.concepto_id = c.id)        AS n_gastos,
        COALESCE((SELECT SUM(g.monto) FROM fac_gastos g WHERE g.concepto_id = c.id),0) AS total_historico
      FROM fac_gastos_conceptos c
      LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
      ${todos === 'true' ? '' : 'WHERE c.activo = TRUE'}
      ORDER BY k.orden NULLS LAST, k.nombre NULLS LAST, c.orden, c.nombre
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
    const { desde, hasta, concepto_id, categoria_id, origen, buscar } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (desde)        { params.push(desde);        where += ` AND g.fecha >= $${params.length}`; }
    if (hasta)        { params.push(hasta);        where += ` AND g.fecha <= $${params.length}`; }
    if (concepto_id)  { params.push(concepto_id);  where += ` AND g.concepto_id = $${params.length}`; }
    if (categoria_id) { params.push(categoria_id); where += ` AND c.categoria_id = $${params.length}`; }
    if (origen)       { params.push(origen);       where += ` AND g.origen = $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (g.descripcion ILIKE $${params.length} OR g.proveedor ILIKE $${params.length}
                      OR g.referencia ILIKE $${params.length} OR c.nombre ILIKE $${params.length}
                      OR g.nombre_proveedor ILIKE $${params.length} OR g.rfc_proveedor ILIKE $${params.length}
                      OR g.uuid ILIKE $${params.length})`;
    }

    // LEFT JOIN: los gastos importados por XML aún no tienen concepto asignado
    const r = await query(`
      SELECT g.*, TO_CHAR(g.fecha,'YYYY-MM-DD') AS fecha,
        c.nombre AS concepto, c.grupo,
        k.nombre AS categoria, k.color AS categoria_color,
        u.nombre AS capturado_por
      FROM fac_gastos g
      LEFT JOIN fac_gastos_conceptos  c ON c.id = g.concepto_id
      LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
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
        COALESCE(SUM(g.monto) FILTER (WHERE g.deducible),0)              AS deducible,
        COUNT(g.id) FILTER (WHERE g.concepto_id IS NULL)::int            AS sin_clasificar,
        COALESCE(SUM(g.monto) FILTER (WHERE g.concepto_id IS NULL),0)    AS monto_sin_clasificar,
        COUNT(g.id) FILTER (WHERE g.origen = 'XML')::int                 AS de_xml,
        COUNT(g.id) FILTER (WHERE g.estatus_sat ILIKE '%cancelad%')::int AS cancelados_sat,
        COALESCE(SUM(g.iva),0)                 AS iva,
        COALESCE(SUM(g.retenciones),0)         AS retenciones
      FROM fac_gastos g
      LEFT JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      ${where}
    `, params);

    const porConcepto = await query(`
      SELECT c.id, c.nombre AS concepto, k.nombre AS categoria, k.color AS categoria_color,
        COUNT(g.id)::int         AS n,
        COALESCE(SUM(g.monto),0) AS total
      FROM fac_gastos g
      LEFT JOIN fac_gastos_conceptos  c ON c.id = g.concepto_id
      LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
      ${where}
      GROUP BY c.id, c.nombre, k.nombre, k.color
      ORDER BY total DESC
    `, params);

    // Agrupado por categoría, para la vista de alto nivel
    const porCategoria = await query(`
      SELECT COALESCE(k.nombre,'Sin clasificar') AS categoria,
        COALESCE(k.color,'#94a3b8') AS color,
        COUNT(g.id)::int         AS n,
        COALESCE(SUM(g.monto),0) AS total
      FROM fac_gastos g
      LEFT JOIN fac_gastos_conceptos  c ON c.id = g.concepto_id
      LEFT JOIN fac_gastos_categorias k ON k.id = c.categoria_id
      ${where}
      GROUP BY k.nombre, k.color
      ORDER BY total DESC
    `, params);

    res.json({
      gastos: r.rows, totales: tot.rows[0],
      por_concepto: porConcepto.rows, por_categoria: porCategoria.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { concepto_id, fecha, monto, descripcion, proveedor,
            forma_pago, referencia, factura_rfc, deducible, notas,
            uuid, subtotal, iva, retenciones, rfc_proveedor } = req.body;
    // La captura manual sí exige clasificar de inmediato; solo la importación
    // por XML puede dejar el concepto pendiente.
    if (!concepto_id || !fecha || !monto)
      return res.status(400).json({ error: 'Concepto, fecha y monto son requeridos.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    const uuidLimpio = (uuid || '').trim().toUpperCase() || null;
    if (uuidLimpio) {
      const ya = await query(`SELECT id FROM fac_gastos WHERE uuid=$1`, [uuidLimpio]);
      if (ya.rows.length)
        return res.status(400).json({ error: 'Ese folio fiscal (UUID) ya está registrado como gasto.' });
    }

    const r = await query(
      `INSERT INTO fac_gastos(concepto_id, fecha, monto, descripcion, proveedor,
         forma_pago, referencia, factura_rfc, deducible, notas,
         uuid, origen, subtotal, iva, retenciones, rfc_proveedor, nombre_proveedor, creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MANUAL',$12,$13,$14,$15,$16,$17) RETURNING *`,
      [concepto_id, fecha, m, descripcion || null, proveedor || null,
       forma_pago || 'transferencia', referencia || null, factura_rfc || null,
       deducible !== false, notas || null,
       uuidLimpio, parseFloat(subtotal) || null, parseFloat(iva) || null,
       parseFloat(retenciones) || 0,
       (rfc_proveedor || factura_rfc || '').trim().toUpperCase() || null,
       proveedor || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese folio fiscal (UUID) ya está registrado.' });
    res.status(500).json({ error: e.message });
  }
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
      SELECT COALESCE(c.id,0) AS id,
        COALESCE(c.nombre,'(Sin clasificar)') AS concepto,
        EXTRACT(MONTH FROM g.fecha)::int AS mes,
        COALESCE(SUM(g.monto),0) AS total
      FROM fac_gastos g
      LEFT JOIN fac_gastos_conceptos c ON c.id = g.concepto_id
      WHERE EXTRACT(YEAR FROM g.fecha) = $1
      GROUP BY c.id, c.nombre, mes
      ORDER BY concepto, mes
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
