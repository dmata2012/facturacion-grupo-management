const router   = require('express').Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

const UPLOADS = path.join(__dirname, '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS, 'facturas');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.use(verificarToken);

// ── LISTAR ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { cliente_id, emisora_id, estatus, desde, hasta, buscar, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (cliente_id) { params.push(cliente_id); where += ` AND f.cliente_id=$${params.length}`; }
    if (emisora_id) { params.push(emisora_id); where += ` AND f.empresa_receptora_id=$${params.length}`; }
    if (estatus)    { params.push(estatus);     where += ` AND f.estatus=$${params.length}`; }
    if (desde)      { params.push(desde);       where += ` AND f.fecha_emision>=$${params.length}`; }
    if (hasta)      { params.push(hasta);       where += ` AND f.fecha_emision<=$${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (f.folio ILIKE $${params.length} OR c.razon_social ILIKE $${params.length} OR f.concepto ILIKE $${params.length})`;
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit)); params.push(offset);

    const r = await query(`
      SELECT f.*,
        c.razon_social, c.rfc,
        er.razon_social     AS emisora_razon_social,
        er.nombre_comercial AS emisora_nombre_comercial,
        er.rfc              AS emisora_rfc,
        c.aplica_desglose   AS cliente_aplica_desglose,
        COALESCE(sub_p.cobrado, 0)                AS cobrado,
        f.total - COALESCE(sub_p.cobrado, 0)      AS saldo,
        COALESCE(sub_d.rh_total, 0)               AS rh_total,
        COALESCE(sub_d.rh_partidas, 0)::int       AS rh_partidas
      FROM fac_facturas f
      LEFT JOIN fac_clientes c              ON c.id = f.cliente_id
      LEFT JOIN fac_empresas_receptoras er  ON er.id = f.empresa_receptora_id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
      ) sub_p ON sub_p.factura_id = f.id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS rh_total, COUNT(*) AS rh_partidas
        FROM fac_desglose_rh GROUP BY factura_id
      ) sub_d ON sub_d.factura_id = f.id
      ${where}
      ORDER BY f.desglose_validado DESC NULLS LAST, f.fecha_emision DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const cnt = await query(`
      SELECT COUNT(DISTINCT f.id) AS total
      FROM fac_facturas f
      LEFT JOIN fac_clientes c ON c.id = f.cliente_id
      ${where.replace(/LIMIT.*/, '')}
    `, params.slice(0, -2));

    // Totales de TODO el período filtrado (no sólo de la página visible).
    // Se excluyen las canceladas de los montos, igual que en dashboard y reportes.
    const tot = await query(`
      SELECT
        COUNT(f.id) FILTER (WHERE f.estatus != 'cancelada')::int          AS facturas,
        COUNT(f.id) FILTER (WHERE f.estatus  = 'cancelada')::int          AS canceladas,
        COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.estatus != 'cancelada')::int AS clientes,
        COALESCE(SUM(f.total)    FILTER (WHERE f.estatus != 'cancelada'),0) AS facturado,
        COALESCE(SUM(f.subtotal) FILTER (WHERE f.estatus != 'cancelada'),0) AS subtotal,
        COALESCE(SUM(f.iva)      FILTER (WHERE f.estatus != 'cancelada'),0) AS iva,
        -- Facturación de clientes marcados como "sin desglose" y el neto que sí lo requiere
        COALESCE(SUM(f.total) FILTER (
          WHERE f.estatus != 'cancelada' AND c.aplica_desglose = FALSE),0)          AS facturado_sin_desglose,
        COALESCE(SUM(f.total) FILTER (
          WHERE f.estatus != 'cancelada' AND COALESCE(c.aplica_desglose,TRUE)),0)   AS facturado_con_desglose,
        COUNT(f.id) FILTER (
          WHERE f.estatus != 'cancelada' AND c.aplica_desglose = FALSE)::int        AS facturas_sin_desglose,
        COUNT(DISTINCT f.cliente_id) FILTER (
          WHERE f.estatus != 'cancelada' AND c.aplica_desglose = FALSE)::int        AS clientes_sin_desglose,
        COALESCE(SUM(COALESCE(sub_p.cobrado,0)) FILTER (WHERE f.estatus != 'cancelada'),0) AS cobrado,
        COALESCE(SUM(f.total - COALESCE(sub_p.cobrado,0))
                 FILTER (WHERE f.estatus NOT IN ('cancelada','pagada')),0)  AS saldo
      FROM fac_facturas f
      LEFT JOIN fac_clientes c ON c.id = f.cliente_id
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS cobrado FROM fac_pagos GROUP BY factura_id
      ) sub_p ON sub_p.factura_id = f.id
      ${where}
    `, params.slice(0, -2));

    res.json({
      data   : r.rows,
      total  : parseInt(cnt.rows[0].total),
      page   : parseInt(page),
      limit  : parseInt(limit),
      totales: tot.rows[0]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OBTENER UNA ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT f.*, c.razon_social, c.rfc, c.email AS cliente_email,
        c.aplica_desglose  AS cliente_aplica_desglose,
        er.razon_social    AS emisora_razon_social,
        COALESCE(SUM(p.monto),0) AS cobrado,
        f.total - COALESCE(SUM(p.monto),0) AS saldo
      FROM fac_facturas f
      LEFT JOIN fac_clientes c              ON c.id = f.cliente_id
      LEFT JOIN fac_empresas_receptoras er  ON er.id = f.empresa_receptora_id
      LEFT JOIN fac_pagos p                 ON p.factura_id = f.id
      WHERE f.id=$1
      GROUP BY f.id, c.razon_social, c.rfc, c.email, c.aplica_desglose, er.razon_social
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Factura no encontrada.' });

    const desglose = await query(`SELECT * FROM fac_desglose_rh WHERE factura_id=$1 ORDER BY id`, [req.params.id]);
    const pagos    = await query(`SELECT * FROM fac_pagos WHERE factura_id=$1 ORDER BY fecha_pago DESC`, [req.params.id]);

    res.json({ ...r.rows[0], desglose: desglose.rows, pagos: pagos.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREAR ─────────────────────────────────────
router.post('/', requireRol('admin', 'capturista', 'gerente'),
  upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'xml', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { cliente_id, folio, uuid_cfdi, fecha_emision, fecha_vencimiento, subtotal, iva, total, moneda, concepto } = req.body;
      if (!fecha_emision || !total) return res.status(400).json({ error: 'Fecha y total requeridos.' });

      const archivo_pdf = req.files?.pdf?.[0]?.filename || null;
      const archivo_xml = req.files?.xml?.[0]?.filename || null;

      const { tipo_comprobante, empresa_receptora_id } = req.body;
      const r = await query(
        `INSERT INTO fac_facturas(cliente_id,empresa_receptora_id,folio,uuid_cfdi,tipo_comprobante,fecha_emision,fecha_vencimiento,subtotal,iva,total,moneda,concepto,archivo_pdf,archivo_xml,creado_por)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [cliente_id || null, empresa_receptora_id || null, folio, uuid_cfdi, tipo_comprobante || 'I',
         fecha_emision, fecha_vencimiento || null,
         parseFloat(subtotal) || 0, parseFloat(iva) || 0, parseFloat(total),
         moneda || 'MXN', concepto, archivo_pdf, archivo_xml, req.usuario.id]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── ACTUALIZAR ────────────────────────────────
router.put('/:id', requireRol('admin', 'capturista', 'gerente'), async (req, res) => {
  try {
    const { cliente_id, empresa_receptora_id, folio, uuid_cfdi, tipo_comprobante, fecha_emision, fecha_vencimiento, subtotal, iva, total, moneda, concepto, estatus } = req.body;
    await query(
      `UPDATE fac_facturas SET cliente_id=$1,empresa_receptora_id=$2,folio=$3,uuid_cfdi=$4,tipo_comprobante=$5,
       fecha_emision=$6,fecha_vencimiento=$7,subtotal=$8,iva=$9,total=$10,moneda=$11,concepto=$12,estatus=$13,actualizado_en=NOW() WHERE id=$14`,
      [cliente_id || null, empresa_receptora_id || null, folio, uuid_cfdi, tipo_comprobante || 'I', fecha_emision, fecha_vencimiento || null,
       parseFloat(subtotal) || 0, parseFloat(iva) || 0, parseFloat(total),
       moneda || 'MXN', concepto, estatus, req.params.id]
    );
    await recalcularEstatus(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DESGLOSE RH ───────────────────────────────
router.get('/:id/desglose', async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*, c.clave, c.nombre AS concepto_nombre
      FROM fac_desglose_rh d
      LEFT JOIN fac_conceptos_rh c ON c.id = d.concepto_id
      WHERE d.factura_id=$1 ORDER BY d.id
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/desglose', requireRol('admin', 'capturista', 'gerente'), async (req, res) => {
  try {
    const { partidas } = req.body; // [{ concepto_id, concepto, monto, notas }]
    const facId = req.params.id;

    if (partidas && partidas.length > 5)
      return res.status(400).json({ error: 'El desglose acepta un máximo de 5 conceptos por factura.' });

    await query(`DELETE FROM fac_desglose_rh WHERE factura_id=$1`, [facId]);
    for (const p of (partidas || [])) {
      await query(
        `INSERT INTO fac_desglose_rh(factura_id,concepto_id,concepto,monto,notas) VALUES($1,$2,$3,$4,$5)`,
        [facId, p.concepto_id || null, p.concepto, parseFloat(p.monto) || 0, p.notas || null]
      );
    }

    // Validar si (subtotal + IVA 16%) coincide con el total de la factura
    const tot      = await query(`SELECT total FROM fac_facturas WHERE id=$1`, [facId]);
    const subtotal = (partidas || []).reduce((a, p) => a + (parseFloat(p.monto) || 0), 0);
    const iva      = Math.round(subtotal * 0.16 * 100) / 100;
    const total    = Math.round((subtotal + iva) * 100) / 100;
    const facTotal = parseFloat(tot.rows[0]?.total || 0);
    const validado = Math.abs(total - facTotal) < 0.01;
    await query(`UPDATE fac_facturas SET desglose_validado=$1,actualizado_en=NOW() WHERE id=$2`, [validado, facId]);

    res.json({ ok: true, validado, subtotal, iva, total, factura_total: facTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORTAR MASIVO XML ───────────────────────
router.post('/importar-masivo', requireRol('admin', 'capturista', 'gerente'), async (req, res) => {
  const { facturas: items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'No hay facturas para importar.' });

  let creadas = 0, duplicadas = 0;
  const errores = [];

  // Función para limpiar texto del XML (quita caracteres problemáticos)
  const limpiar = s => (s || '').toString().trim().substring(0, 200) || null;
  const limpiarRFC = s => (s || '').toString().trim().toUpperCase().substring(0, 13);

  for (const item of items) {
    try {
      // Evitar duplicados por UUID
      if (item.uuid) {
        const dup = await query(`SELECT id FROM fac_facturas WHERE uuid_cfdi=$1`, [item.uuid]);
        if (dup.rows.length) { duplicadas++; continue; }
      }

      const rfcEmisor   = limpiarRFC(item.rfc_emisor);
      const rfcReceptor = limpiarRFC(item.rfc_receptor);

      // RFC Receptor del XML = CLIENTE en el sistema (quien recibe y paga la factura)
      let cliente_id = null;
      if (rfcReceptor) {
        try {
          const cli = await query(`SELECT id FROM fac_clientes WHERE rfc=$1`, [rfcReceptor]);
          if (cli.rows.length) {
            cliente_id = cli.rows[0].id;
          } else {
            const razon = limpiar(item.nombre_receptor) || rfcReceptor;
            const nuevo = await query(
              `INSERT INTO fac_clientes(rfc, razon_social, nombre_comercial, activo, comision)
               VALUES($1,$2,$3,TRUE,0) RETURNING id`,
              [rfcReceptor, razon, razon]
            );
            cliente_id = nuevo.rows[0].id;
            console.log(`✅ Cliente creado (receptor): ${rfcReceptor} — ${razon}`);
          }
        } catch(e2) {
          console.error(`⚠️ Error creando cliente ${rfcReceptor}:`, e2.message);
        }
      }

      // RFC Emisor del XML = EMPRESA RECEPTORA en el sistema (quien emite la factura)
      let empresa_receptora_id = null;
      if (rfcEmisor) {
        try {
          const rec = await query(`SELECT id FROM fac_empresas_receptoras WHERE rfc=$1`, [rfcEmisor]);
          if (rec.rows.length) {
            empresa_receptora_id = rec.rows[0].id;
          } else {
            const razon = limpiar(item.nombre_emisor) || rfcEmisor;
            const nueva = await query(
              `INSERT INTO fac_empresas_receptoras(rfc, razon_social, nombre_comercial, activo)
               VALUES($1,$2,$3,TRUE) RETURNING id`,
              [rfcEmisor, razon, razon]
            );
            empresa_receptora_id = nueva.rows[0].id;
            console.log(`✅ Empresa receptora creada (emisor): ${rfcEmisor} — ${razon}`);
          }
        } catch(e2) {
          console.error(`⚠️ Error creando empresa receptora ${rfcEmisor}:`, e2.message);
        }
      }

      await query(
        `INSERT INTO fac_facturas(cliente_id,empresa_receptora_id,folio,uuid_cfdi,tipo_comprobante,
          fecha_emision,subtotal,iva,total,moneda,concepto,rfc_detectado,creado_por)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [cliente_id    || null,
         empresa_receptora_id || null,
         limpiar(item.folio) || null,
         item.uuid    || null,
         item.tipo    || 'I',
         item.fecha_emision,
         parseFloat(item.subtotal) || 0,
         parseFloat(item.iva)      || 0,
         parseFloat(item.total)    || 0,
         item.moneda  || 'MXN',
         limpiar(item.concepto) || null,
         rfcReceptor  || null,
         req.usuario.id]
      );
      creadas++;
    } catch(e) {
      console.error(`❌ Error importando ${item.filename}:`, e.message);
      errores.push({ file: item.filename, error: e.message });
    }
  }

  res.json({ creadas, duplicadas, errores });
});

// ── CANCELAR ──────────────────────────────────
// Los mismos roles que muestran el botón en la interfaz (canFacturar), para que
// nadie vea la opción y reciba un 403 al usarla.
router.patch('/:id/cancelar', requireRol('admin', 'capturista', 'gerente', 'tesoreria'), async (req, res) => {
  try {
    await query(`UPDATE fac_facturas SET estatus='cancelada',actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ELIMINAR ──────────────────────────────────
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    // Eliminar en cascada: desglose y pagos se borran por ON DELETE CASCADE
    const r = await query(`DELETE FROM fac_facturas WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Factura no encontrada.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recalcular estatus automáticamente ─────────
async function recalcularEstatus(facturaId) {
  const r = await query(`
    SELECT f.total, f.estatus, f.fecha_vencimiento,
           COALESCE(SUM(p.monto),0) AS cobrado
    FROM fac_facturas f
    LEFT JOIN fac_pagos p ON p.factura_id = f.id
    WHERE f.id=$1 GROUP BY f.id
  `, [facturaId]);
  if (!r.rows.length) return;
  const { total, estatus, fecha_vencimiento, cobrado } = r.rows[0];
  if (estatus === 'cancelada') return;

  let nuevo = 'pendiente';
  const saldo = parseFloat(total) - parseFloat(cobrado);
  if (saldo <= 0) nuevo = 'pagada';
  else if (parseFloat(cobrado) > 0) nuevo = 'parcial';
  else if (fecha_vencimiento && new Date(fecha_vencimiento) < new Date()) nuevo = 'vencida';

  await query(`UPDATE fac_facturas SET estatus=$1,actualizado_en=NOW() WHERE id=$2`, [nuevo, facturaId]);
}

// ── VALIDACIÓN DE ESTATUS ANTE EL SAT ─────────────────────────
// Consulta el servicio público del SAT (SOAP) que verifica si un CFDI está
// vigente o cancelado. Se hace desde el servidor y no desde el navegador para
// evitar CORS: el SAT no expone cabeceras que permitan llamarlo desde el front.
(async () => {
  try {
    await query(`ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS estatus_sat TEXT`);
    await query(`ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS sat_validado_en TIMESTAMP`);
    await query(`ALTER TABLE fac_facturas ADD COLUMN IF NOT EXISTS sat_detalle TEXT`);
  } catch (e) { console.warn('Migración estatus_sat:', e.message); }
})();

const SAT_WSDL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';

// Extrae el valor de una etiqueta del XML de respuesta, sin dependencias externas
function _tagSAT(xml, tag) {
  const m = xml.match(new RegExp(`<a:${tag}[^>]*>([\\s\\S]*?)</a:${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

async function consultarSAT({ re, rr, tt, id }) {
  // tt ya viene formateado por el llamador (el SAT es estricto con este campo)
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
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction'  : 'http://tempuri.org/IConsultaCFDIService/Consulta'
      },
      body  : envelope,
      signal: ctrl.signal
    });
    const xml = await resp.text();
    if (!resp.ok) throw new Error(`El SAT respondió ${resp.status}`);
    return {
      estado             : _tagSAT(xml, 'Estado'),              // Vigente | Cancelado | No Encontrado
      codigo_estatus     : _tagSAT(xml, 'CodigoEstatus'),
      es_cancelable      : _tagSAT(xml, 'EsCancelable'),
      estatus_cancelacion: _tagSAT(xml, 'EstatusCancelacion'),
      validacion_efos    : _tagSAT(xml, 'ValidacionEFOS')
    };
  } finally { clearTimeout(timer); }
}

// POST /api/facturas/:id/validar-sat
router.post('/:id/validar-sat', async (req, res) => {
  try {
    // Los datos se toman de la base, no del cliente, para que no se puedan alterar
    const r = await query(`
      SELECT f.uuid_cfdi, f.total, c.rfc AS rfc_emisor, er.rfc AS rfc_receptor
      FROM fac_facturas f
      LEFT JOIN fac_clientes c             ON c.id  = f.cliente_id
      LEFT JOIN fac_empresas_receptoras er ON er.id = f.empresa_receptora_id
      WHERE f.id = $1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Factura no encontrada.' });

    const f = r.rows[0];
    const faltan = [];
    if (!f.uuid_cfdi)    faltan.push('UUID');
    if (!f.rfc_emisor)   faltan.push('RFC del cliente (emisor)');
    if (!f.rfc_receptor) faltan.push('RFC de la emisora (receptor)');
    if (!f.total)        faltan.push('total');
    if (faltan.length)
      return res.status(400).json({ error: `Falta capturar: ${faltan.join(', ')}.` });

    // La nomenclatura del sistema es ambigua: la columna "Emisora" corresponde a las
    // empresas del grupo y "Cliente" a terceros, pero el parser de XML asigna el RFC
    // del emisor al cliente. Para no depender de esa suposición se prueba una
    // combinación y, si el SAT no encuentra el comprobante, se intenta la inversa.
    const rfcCliente = f.rfc_emisor.trim().toUpperCase();    // columna Cliente
    const rfcEmisora = f.rfc_receptor.trim().toUpperCase();  // columna Emisora
    const uuid = f.uuid_cfdi.trim().toUpperCase();

    // El SAT es estricto con el formato del total; se prueban las variantes válidas
    const n = parseFloat(f.total);
    const formatosTT = [...new Set([
      n.toFixed(2),          // 585664.81  — lo más común
      String(n),             // 585664.81 sin ceros de relleno
      n.toFixed(6),          // 585664.810000 — algunos CFDI lo timbran así
      n.toFixed(0)           // 585665 — por si el CFDI no llevó decimales
    ])];

    // Se combinan ambos órdenes de RFC con cada formato de total
    const intentos = [];
    for (const tt of formatosTT) {
      intentos.push({ etiqueta: `emisora→cliente tt=${tt}`, re: rfcEmisora, rr: rfcCliente, tt });
      intentos.push({ etiqueta: `cliente→emisora tt=${tt}`, re: rfcCliente, rr: rfcEmisora, tt });
    }

    let sat = null, usado = null;
    const probados = [];
    for (const it of intentos) {
      const r = await consultarSAT({ re: it.re, rr: it.rr, tt: it.tt, id: uuid });
      probados.push(`${it.etiqueta} → ${r.estado || 's/estado'}`);
      if (!sat) { sat = r; usado = it; }               // conserva el primero como respuesta base
      if (r.estado && !/no encontrado/i.test(r.estado)) {  // encontrado: se detiene
        sat = r; usado = it;
        break;
      }
    }
    console.log(`[SAT] factura ${req.params.id}: ${sat.estado || 's/estado'} (${usado.etiqueta}) · intentos: ${probados.length}`);

    const estatus = sat.estado || 'Sin respuesta';
    const orden = usado.etiqueta;
    const detalle = [sat.codigo_estatus, sat.estatus_cancelacion, sat.validacion_efos]
      .filter(Boolean).join(' · ');

    await query(
      `UPDATE fac_facturas SET estatus_sat=$1, sat_detalle=$2, sat_validado_en=NOW() WHERE id=$3`,
      [estatus, detalle || null, req.params.id]
    );

    // Cuando el SAT no encuentra el comprobante se devuelven los datos usados,
    // para poder cotejarlos contra el CFDI y detectar qué campo no coincide.
    const diagnostico = /no encontrado/i.test(estatus) ? {
      enviado: {
        rfc_emisora: rfcEmisora,
        rfc_cliente: rfcCliente,
        total      : parseFloat(f.total).toFixed(2),
        uuid       : uuid,
        uuid_largo : uuid.length   // debe ser 36 con guiones
      },
      probados,
      nota: uuid.length !== 36
        ? `El UUID tiene ${uuid.length} caracteres y debería tener 36 (formato 8-4-4-4-12). Revísalo en la factura.`
        : 'Se probaron ambos órdenes de RFC y 4 formatos de total sin éxito. Compara los RFC y el total contra el CFDI: basta un centavo de diferencia para que el SAT no lo encuentre.'
    } : null;

    res.json({ estatus_sat: estatus, detalle, orden, diagnostico, ...sat });
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'El SAT no respondió a tiempo. Intenta de nuevo en un momento.'
      : e.message;
    res.status(502).json({ error: msg });
  }
});

module.exports = router;
module.exports.recalcularEstatus = recalcularEstatus;
