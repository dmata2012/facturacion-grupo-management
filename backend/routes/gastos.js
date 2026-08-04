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
    // Receptor del CFDI: es una de nuestras empresas. Se guarda porque el SAT
    // exige ambos RFC para consultar el estatus del comprobante.
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS rfc_receptor TEXT`);
    await query(`ALTER TABLE fac_gastos ADD COLUMN IF NOT EXISTS sat_detalle TEXT`);
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

router.put('/categorias/:id', requireRol('admin', 'gerente', 'tesoreria', 'capturista'), async (req, res) => {
  try {
    const { nombre, color, orden } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    await query(
      `UPDATE fac_gastos_categorias SET nombre=$1, color=$2, orden=$3 WHERE id=$4`,
      [nombre.trim(), color || '#d97706', parseInt(orden) || 99, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe otra categoría con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/categorias/:id', requireRol('admin', 'gerente'), async (req, res) => {
  try {
    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_gastos_conceptos WHERE categoria_id=$1`, [req.params.id]);
    if (uso.rows[0].n > 0)
      return res.status(400).json({ error: `No se puede eliminar: ${uso.rows[0].n} cuenta(s) de gasto pertenecen a esta categoría. Muévelas primero.` });
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

// GET /api/gastos/proveedores
// Directorio unificado de a quién se le paga. Junta tres orígenes, porque en el
// sistema un mismo proveedor puede haberse dado de alta en cualquiera de ellos:
//   1. Reglas de auto-clasificación de gastos
//   2. Beneficiarios de Bancos (los que reciben cheques)
//   3. Los que ya aparecen escritos en algún gasto
router.get('/proveedores', async (req, res) => {
  try {
    // Bancos puede no existir todavía en instalaciones viejas
    const hayBenef = await query(`SELECT to_regclass('public.fac_bancos_beneficiarios') AS t`);
    const bloqueBancos = hayBenef.rows[0].t ? `
        UNION ALL
        SELECT TRIM(b.nombre_completo)          AS nombre,
               UPPER(TRIM(COALESCE(b.rfc,'')))  AS rfc,
               NULL::int                        AS concepto_id,
               1                                AS veces,
               FALSE                            AS con_regla,
               TRUE                             AS de_bancos
        FROM fac_bancos_beneficiarios b
        WHERE b.activo AND NULLIF(TRIM(b.nombre_completo),'') IS NOT NULL` : '';

    const r = await query(`
      SELECT
        MIN(nombre)                            AS nombre,
        MAX(rfc) FILTER (WHERE rfc <> '')      AS rfc,
        MAX(concepto_id)                       AS concepto_id,
        SUM(veces)::int                        AS veces,
        BOOL_OR(con_regla)                     AS con_regla,
        BOOL_OR(de_bancos)                     AS de_bancos
      FROM (
        SELECT COALESCE(NULLIF(TRIM(m.nombre_proveedor),''), m.rfc) AS nombre,
               UPPER(TRIM(COALESCE(m.rfc,'')))  AS rfc,
               m.concepto_id,
               GREATEST(m.veces_usado, 1)       AS veces,
               TRUE                             AS con_regla,
               FALSE                            AS de_bancos
        FROM fac_gastos_mapeo_proveedores m
        UNION ALL
        SELECT TRIM(COALESCE(NULLIF(TRIM(g.nombre_proveedor),''), g.proveedor)) AS nombre,
               UPPER(TRIM(COALESCE(g.rfc_proveedor, g.factura_rfc, ''))) AS rfc,
               NULL::int                        AS concepto_id,
               1                                AS veces,
               FALSE                            AS con_regla,
               FALSE                            AS de_bancos
        FROM fac_gastos g
        WHERE COALESCE(NULLIF(TRIM(g.nombre_proveedor),''), g.proveedor) IS NOT NULL
        ${bloqueBancos}
      ) t
      WHERE nombre IS NOT NULL AND TRIM(nombre) <> ''
      GROUP BY UPPER(TRIM(nombre))
      ORDER BY BOOL_OR(con_regla) DESC, SUM(veces) DESC, MIN(nombre)
      LIMIT 500
    `);
    res.json(r.rows);
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
             uuid, origen, rfc_proveedor, nombre_proveedor, serie_folio, rfc_receptor,
             descripcion, proveedor, factura_rfc, forma_pago, creado_por)
           VALUES($1,$2,$3,$4,$5,$6,$7,'XML',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [conceptoId, c.fecha.slice(0,10), parseFloat(c.total),
           parseFloat(c.subtotal) || null, parseFloat(c.iva) || null, parseFloat(c.retenciones) || 0,
           uuid, rfc, c.nombre_emisor || null, c.serie_folio || null,
           (c.rfc_receptor || '').trim().toUpperCase() || null,
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

// ═══ VALIDACIÓN DEL CFDI ANTE EL SAT ════════════════
const SAT_WSDL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';

function _tagSAT(xml, tag) {
  const m = xml.match(new RegExp(`<a:${tag}[^>]*>([\\s\\S]*?)</a:${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

async function consultarSAT({ re, rr, tt, id }) {
  const expresion = `?re=${re}&rr=${rr}&tt=${tt}&id=${id}`;
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">` +
    `<s:Header/><s:Body><tem:Consulta><tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa>` +
    `</tem:Consulta></s:Body></s:Envelope>`;
  // El servicio del SAT llega a tardar; se corta a los 20 s para no colgar la petición
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(SAT_WSDL, {
      method : 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8',
                 'SOAPAction'  : 'http://tempuri.org/IConsultaCFDIService/Consulta' },
      body: envelope, signal: ctrl.signal
    });
    const xml = await resp.text();
    if (!resp.ok) throw new Error(`El SAT respondió ${resp.status}`);
    return {
      estado             : _tagSAT(xml, 'Estado'),
      codigo_estatus     : _tagSAT(xml, 'CodigoEstatus'),
      estatus_cancelacion: _tagSAT(xml, 'EstatusCancelacion'),
      validacion_efos    : _tagSAT(xml, 'ValidacionEFOS')
    };
  } finally { clearTimeout(timer); }
}

// Valida un gasto contra el SAT y guarda el resultado.
// En un gasto el emisor es el proveedor y el receptor es una empresa nuestra.
// Lanza Error con mensaje legible cuando falta algún dato para poder consultar.
async function validarGastoSAT(gastoId, receptoresCache) {
  const r = await query(
    `SELECT uuid, monto, rfc_proveedor, rfc_receptor FROM fac_gastos WHERE id=$1`, [gastoId]);
  if (!r.rows.length) { const e = new Error('Gasto no encontrado.'); e.status = 404; throw e; }

  const g = r.rows[0];
  if (!g.uuid)          { const e = new Error('Este gasto no tiene folio fiscal (UUID) que consultar.'); e.status = 400; throw e; }
  if (!g.rfc_proveedor) { const e = new Error('Falta el RFC del proveedor para consultar al SAT.');      e.status = 400; throw e; }

  // Si el XML no traía receptor guardado, se prueban los RFC de nuestras emisoras
  let receptores = [];
  if (g.rfc_receptor) receptores = [g.rfc_receptor.trim().toUpperCase()];
  else if (receptoresCache) receptores = receptoresCache;
  else {
    const er = await query(`SELECT rfc FROM fac_empresas_receptoras WHERE rfc IS NOT NULL`);
    receptores = er.rows.map(x => String(x.rfc).trim().toUpperCase()).filter(Boolean);
  }
  if (!receptores.length) {
    const e = new Error('No se sabe a qué empresa se facturó este gasto. Reimporta el XML o captura el RFC receptor.');
    e.status = 400; throw e;
  }

  const emisor = g.rfc_proveedor.trim().toUpperCase();
  const uuid   = String(g.uuid).trim().toUpperCase();
  const n = parseFloat(g.monto);
  // El SAT es estricto con el formato del total; se prueban las variantes válidas
  const formatosTT = [...new Set([n.toFixed(2), String(n), n.toFixed(6), n.toFixed(0)])];

  // Cada consulta puede tardar; se acotan los intentos para no colgar la petición.
  // Con varios receptores posibles se prueba primero el formato de total más común
  // en todos ellos, y solo después las variantes.
  const intentos = [];
  if (receptores.length === 1) {
    formatosTT.forEach(tt => intentos.push({ rr: receptores[0], tt }));
  } else {
    receptores.forEach(rr => intentos.push({ rr, tt: formatosTT[0] }));
    formatosTT.slice(1).forEach(tt => intentos.push({ rr: receptores[0], tt }));
  }

  let sat = null;
  for (const it of intentos.slice(0, 12)) {
    const q = await consultarSAT({ re: emisor, rr: it.rr, tt: it.tt, id: uuid });
    if (!sat) sat = q;
    if (q.estado && !/no encontrado/i.test(q.estado)) { sat = q; break; }
  }

  const estatus = (sat && sat.estado) || 'Sin respuesta';
  const detalle = [sat?.codigo_estatus, sat?.estatus_cancelacion, sat?.validacion_efos]
    .filter(Boolean).join(' · ');
  await query(
    `UPDATE fac_gastos SET estatus_sat=$1, sat_detalle=$2, sat_validado_en=NOW() WHERE id=$3`,
    [estatus, detalle || null, gastoId]
  );
  return { estatus, detalle: detalle || null, emisor, uuid, receptores };
}

// ── Validación en lote ──
// El SAT tarda segundos por comprobante, así que el lote corre en segundo plano
// y el navegador solo consulta el avance. El estado vive en memoria: si Render
// reinicia el proceso, el lote se pierde y basta con volver a lanzarlo — lo ya
// validado quedó guardado en la base.
const _lotesSAT = new Map();
const LOTE_MAX = 400;

function _limpiarLotesViejos() {
  const hace2h = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of _lotesSAT) if (v.terminado_en && v.terminado_en < hace2h) _lotesSAT.delete(k);
}

async function _correrLoteSAT(loteId, ids) {
  const lote = _lotesSAT.get(loteId);
  let receptores = null;
  try {
    const er = await query(`SELECT rfc FROM fac_empresas_receptoras WHERE rfc IS NOT NULL`);
    receptores = er.rows.map(x => String(x.rfc).trim().toUpperCase()).filter(Boolean);
  } catch (e) { receptores = []; }

  for (const id of ids) {
    if (lote.cancelado) break;
    try {
      const r = await validarGastoSAT(id, receptores);
      if (/cancelad/i.test(r.estatus))          lote.cancelados++;
      else if (/vigente/i.test(r.estatus))      lote.vigentes++;
      else if (/no encontrado/i.test(r.estatus)) lote.no_encontrados++;
      else                                       lote.sin_respuesta++;
    } catch (e) {
      lote.errores.push({ id, error: e.message });
    }
    lote.hechos++;
    // Respiro entre consultas: el servicio del SAT rechaza ráfagas
    await new Promise(r => setTimeout(r, 300));
  }
  lote.estado = lote.cancelado ? 'cancelado' : 'terminado';
  lote.terminado_en = Date.now();
  console.log(`[SAT lote ${loteId}] ${lote.estado}: ${lote.hechos}/${lote.total} · ` +
              `${lote.vigentes} vigentes, ${lote.cancelados} cancelados, ${lote.errores.length} con error`);
}

// POST /api/gastos/validar-sat-lote — arranca el lote y devuelve su id
router.post('/validar-sat-lote', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    _limpiarLotesViejos();
    const enCurso = [..._lotesSAT.values()].find(l => l.estado === 'corriendo');
    if (enCurso) return res.status(409).json({
      error: 'Ya hay una validación en curso. Espera a que termine o cancélala.', lote_id: enCurso.id });

    const { desde, hasta, solo_sin_validar } = req.body || {};
    const params = [];
    let where = `WHERE uuid IS NOT NULL AND rfc_proveedor IS NOT NULL`;
    if (desde) { params.push(desde); where += ` AND fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); where += ` AND fecha <= $${params.length}`; }
    // Por omisión se revalida todo: un CFDI vigente puede cancelarse después
    if (solo_sin_validar) where += ` AND sat_validado_en IS NULL`;

    const r = await query(
      `SELECT id FROM fac_gastos ${where} ORDER BY fecha DESC LIMIT ${LOTE_MAX}`, params);
    const ids = r.rows.map(x => x.id);
    if (!ids.length) return res.status(400).json({
      error: 'No hay gastos con folio fiscal que validar en ese período.' });

    const loteId = 'L' + Date.now().toString(36);
    _lotesSAT.set(loteId, {
      id: loteId, estado: 'corriendo', total: ids.length, hechos: 0,
      vigentes: 0, cancelados: 0, no_encontrados: 0, sin_respuesta: 0,
      errores: [], cancelado: false, iniciado_en: Date.now(), terminado_en: null,
      por: req.usuario.nombre
    });
    // Deliberadamente sin await: la respuesta sale ya y el lote sigue corriendo
    _correrLoteSAT(loteId, ids).catch(e => {
      const l = _lotesSAT.get(loteId);
      if (l) { l.estado = 'error'; l.error = e.message; l.terminado_en = Date.now(); }
      console.error(`[SAT lote ${loteId}]`, e.message);
    });

    res.json({ lote_id: loteId, total: ids.length,
               aviso: ids.length === LOTE_MAX ? `Se validarán los ${LOTE_MAX} más recientes del período.` : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gastos/validar-sat-lote/:loteId — avance del lote
router.get('/validar-sat-lote/:loteId', (req, res) => {
  const l = _lotesSAT.get(req.params.loteId);
  if (!l) return res.status(404).json({ error: 'Ese lote ya no existe. Vuelve a lanzarlo si hace falta.' });
  res.json(l);
});

// DELETE /api/gastos/validar-sat-lote/:loteId — detener el lote en curso
router.delete('/validar-sat-lote/:loteId', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), (req, res) => {
  const l = _lotesSAT.get(req.params.loteId);
  if (!l) return res.status(404).json({ error: 'Lote no encontrado.' });
  l.cancelado = true;
  res.json({ ok: true });
});

// POST /api/gastos/:id/validar-sat
router.post('/:id/validar-sat', async (req, res) => {
  try {
    const r = await validarGastoSAT(req.params.id);
    res.json({ ok: true, estatus_sat: r.estatus, detalle: r.detalle,
               consultado: { emisor: r.emisor, receptores_probados: r.receptores.length, uuid: r.uuid } });
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'El SAT no respondió a tiempo. Vuelve a intentar en unos segundos.'
      : e.message;
    res.status(e.status || 500).json({ error: msg });
  }
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
    const { nombre, grupo, orden, categoria_id } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del concepto requerido.' });
    const r = await query(
      `INSERT INTO fac_gastos_conceptos(nombre, grupo, orden, categoria_id) VALUES($1,$2,$3,$4)
       ON CONFLICT (nombre) DO UPDATE
         SET activo = TRUE,
             categoria_id = COALESCE(EXCLUDED.categoria_id, fac_gastos_conceptos.categoria_id)
       RETURNING *`,
      [nombre.trim(), grupo || 'Gastos de Operación', parseInt(orden) || 99, categoria_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/conceptos/:id', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { nombre, grupo, orden, activo, categoria_id } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del concepto requerido.' });
    // Solo se toca la categoría si el cliente la mandó: así se puede dejar un
    // concepto sin categoría (null) sin que las demás ediciones la borren.
    const tocarCat = Object.prototype.hasOwnProperty.call(req.body, 'categoria_id');
    await query(
      `UPDATE fac_gastos_conceptos
          SET nombre=$1, grupo=$2, orden=$3, activo=$4,
              categoria_id = CASE WHEN $5 THEN $6::int ELSE categoria_id END
        WHERE id=$7`,
      [nombre.trim(), grupo || 'Gastos de Operación', parseInt(orden) || 99,
       activo !== false, tocarCat, categoria_id || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe otro concepto con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});

// Baja lógica: si el concepto ya tiene gastos, no se elimina para no romper el histórico
router.delete('/conceptos/:id', requireRol('admin', 'gerente'), async (req, res) => {
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

    // Panorama sin filtros: sirve para explicar en pantalla por qué un listado
    // salió vacío (hay gastos, pero fuera del rango consultado) en vez de dejar
    // creer que no se guardó nada.
    const global = await query(`
      SELECT COUNT(*)::int                          AS n,
             TO_CHAR(MIN(fecha),'YYYY-MM-DD')       AS primera,
             TO_CHAR(MAX(fecha),'YYYY-MM-DD')       AS ultima,
             COUNT(*) FILTER (WHERE origen='XML')::int        AS de_xml,
             COUNT(*) FILTER (WHERE concepto_id IS NULL)::int AS sin_clasificar
      FROM fac_gastos
    `);

    res.json({
      gastos: r.rows, totales: tot.rows[0],
      por_concepto: porConcepto.rows, por_categoria: porCategoria.rows,
      global: global.rows[0]
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
            forma_pago, referencia, factura_rfc, deducible, notas,
            uuid, subtotal, iva, retenciones, rfc_proveedor } = req.body;
    if (!concepto_id || !fecha || !monto)
      return res.status(400).json({ error: 'Concepto, fecha y monto son requeridos.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    // El folio fiscal solo se puede fijar si el gasto aún no tenía uno, y nunca
    // repitiendo el de otro registro.
    const actual = await query(`SELECT uuid FROM fac_gastos WHERE id=$1`, [req.params.id]);
    if (!actual.rows.length) return res.status(404).json({ error: 'Gasto no encontrado.' });
    let uuidFinal = actual.rows[0].uuid;
    if (!uuidFinal) {
      const nuevo = (uuid || '').trim().toUpperCase() || null;
      if (nuevo) {
        const ya = await query(`SELECT id FROM fac_gastos WHERE uuid=$1 AND id<>$2`, [nuevo, req.params.id]);
        if (ya.rows.length)
          return res.status(400).json({ error: 'Ese folio fiscal (UUID) ya está registrado en otro gasto.' });
        uuidFinal = nuevo;
      }
    }

    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    await query(
      `UPDATE fac_gastos SET concepto_id=$1, fecha=$2, monto=$3, descripcion=$4, proveedor=$5,
         forma_pago=$6, referencia=$7, factura_rfc=$8, deducible=$9, notas=$10,
         uuid=$11, subtotal=$12, iva=$13, retenciones=COALESCE($14, retenciones),
         rfc_proveedor=COALESCE($15, rfc_proveedor), actualizado_en=NOW()
       WHERE id=$16`,
      [concepto_id, fecha, m, descripcion || null, proveedor || null,
       forma_pago || 'transferencia', referencia || null, factura_rfc || null,
       deducible !== false, notas || null,
       uuidFinal, num(subtotal), num(iva), num(retenciones),
       (rfc_proveedor || factura_rfc || '').trim().toUpperCase() || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ese folio fiscal (UUID) ya está registrado.' });
    res.status(500).json({ error: e.message });
  }
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
