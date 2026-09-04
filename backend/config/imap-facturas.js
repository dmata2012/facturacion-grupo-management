// ════════════════════════════════════════════════════════════
// IMPORTADOR AUTOMÁTICO DE FACTURAS (XML) DESDE CORREO (IMAP)
// Revisa la bandeja de entrada cada X minutos, detecta correos con
// XML adjunto (CFDI), los parsea e importa a fac_facturas.
// ════════════════════════════════════════════════════════════
const { ImapFlow }        = require('imapflow');
const { simpleParser }    = require('mailparser');
const { XMLParser }       = require('fast-xml-parser');
const path = require('path');
const fs   = require('fs');
const { query } = require('./db');

// ── Configuración desde variables de entorno ──────────────
const IMAP_HOST = process.env.FAC_IMAP_HOST || 'mail.gmconsultoria.com.mx';
const IMAP_PORT = parseInt(process.env.FAC_IMAP_PORT) || 993;
const IMAP_USER = process.env.FAC_IMAP_USER;
const IMAP_PASS = process.env.FAC_IMAP_PASS;
const INTERVALO_MIN = parseInt(process.env.FAC_IMAP_INTERVALO_MIN) || 5;

const UPLOADS = path.join(__dirname, '..', 'uploads', 'facturas');

// ── Parser de XML (CFDI) ──────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,   // cfdi:Comprobante → Comprobante, tfd:... → TimbreFiscalDigital
});

// Busca recursivamente un nodo por nombre (por si el Timbre está anidado)
function buscarNodo(obj, nombre) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[nombre]) return Array.isArray(obj[nombre]) ? obj[nombre][0] : obj[nombre];
  for (const k of Object.keys(obj)) {
    const found = buscarNodo(obj[k], nombre);
    if (found) return found;
  }
  return null;
}

function parsearCFDI(xmlText) {
  // El parser revienta con un adjunto que no es XML bien formado, y venia sin
  // proteger: un solo archivo corrupto abortaba el resto de los XML de ese mismo
  // correo. Se convierte en un rechazo normal, con su motivo.
  let j;
  try { j = xmlParser.parse(xmlText); }
  catch (e) { return { ok: false, error: 'El archivo no es XML valido: ' + e.message }; }
  const comp = j && j.Comprobante;
  if (!comp) return { ok: false, error: 'No es un CFDI (falta Comprobante)' };

  const emisor   = comp.Emisor;
  const receptor = comp.Receptor;
  const tfd      = buscarNodo(comp.Complemento, 'TimbreFiscalDigital');
  if (!emisor)   return { ok: false, error: 'CFDI sin emisor' };
  if (!receptor) return { ok: false, error: 'CFDI sin receptor' };
  if (!tfd)      return { ok: false, error: 'CFDI sin timbrar (sin UUID)' };

  const total    = parseFloat(comp['@_Total'] || 0);
  const subtotal = parseFloat(comp['@_SubTotal'] || 0);
  const fecha    = (comp['@_Fecha'] || '').slice(0, 10);
  if (!fecha || !total) return { ok: false, error: 'CFDI sin fecha o total' };

  const serie = comp['@_Serie'] || '';
  const folio = comp['@_Folio'] || '';

  // Concepto (puede ser uno o varios)
  let concepto = '';
  const cs = comp.Conceptos?.Concepto;
  if (cs) {
    const arr = Array.isArray(cs) ? cs : [cs];
    concepto = arr.map(c => c['@_Descripcion'] || '').filter(Boolean).slice(0, 3).join(' · ').slice(0, 300);
  }

  return { ok: true, datos: {
    uuid:            (tfd['@_UUID'] || '').toUpperCase(),
    folio:           (serie + folio) || null,
    fecha_emision:   fecha,
    subtotal:        subtotal || null,
    iva:             Math.max(0, parseFloat((total - subtotal).toFixed(2))),
    total,
    moneda:          comp['@_Moneda'] || 'MXN',
    tipo:            comp['@_TipoDeComprobante'] || 'I',
    rfc_emisor:      (emisor['@_Rfc'] || '').toUpperCase(),
    nombre_emisor:   emisor['@_Nombre'] || '',
    rfc_receptor:    (receptor['@_Rfc'] || '').toUpperCase(),
    nombre_receptor: receptor['@_Nombre'] || '',
    concepto,
  }};
}

// ── Importar una factura (misma lógica que /importar-masivo) ──
const limpiar    = s => (s || '').toString().trim().substring(0, 200) || null;
const limpiarRFC = s => (s || '').toString().trim().toUpperCase().substring(0, 13);

async function importarFactura(item, creadoPor, archivoXml, archivoPdf) {
  // Duplicado por UUID
  if (item.uuid) {
    const dup = await query('SELECT id FROM fac_facturas WHERE uuid_cfdi=$1', [item.uuid]);
    if (dup.rows.length) return 'duplicada';
  }

  const rfcEmisor   = limpiarRFC(item.rfc_emisor);
  const rfcReceptor = limpiarRFC(item.rfc_receptor);

  // RFC Receptor = CLIENTE
  let cliente_id = null;
  if (rfcReceptor) {
    const cli = await query('SELECT id FROM fac_clientes WHERE rfc=$1', [rfcReceptor]);
    if (cli.rows.length) cliente_id = cli.rows[0].id;
    else {
      const razon = limpiar(item.nombre_receptor) || rfcReceptor;
      const nuevo = await query(
        `INSERT INTO fac_clientes(rfc, razon_social, nombre_comercial, activo, comision)
         VALUES($1,$2,$3,TRUE,0) RETURNING id`, [rfcReceptor, razon, razon]);
      cliente_id = nuevo.rows[0].id;
    }
  }

  // RFC Emisor = EMPRESA RECEPTORA (emisora)
  let empresa_receptora_id = null;
  if (rfcEmisor) {
    const rec = await query('SELECT id FROM fac_empresas_receptoras WHERE rfc=$1', [rfcEmisor]);
    if (rec.rows.length) empresa_receptora_id = rec.rows[0].id;
    else {
      const razon = limpiar(item.nombre_emisor) || rfcEmisor;
      const nueva = await query(
        `INSERT INTO fac_empresas_receptoras(rfc, razon_social, nombre_comercial, activo)
         VALUES($1,$2,$3,TRUE) RETURNING id`, [rfcEmisor, razon, razon]);
      empresa_receptora_id = nueva.rows[0].id;
    }
  }

  await query(
    `INSERT INTO fac_facturas(cliente_id,empresa_receptora_id,folio,uuid_cfdi,tipo_comprobante,
       fecha_emision,subtotal,iva,total,moneda,concepto,rfc_detectado,archivo_xml,archivo_pdf,creado_por)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [cliente_id || null, empresa_receptora_id || null, limpiar(item.folio), item.uuid || null,
     item.tipo || 'I', item.fecha_emision, parseFloat(item.subtotal) || 0, parseFloat(item.iva) || 0,
     parseFloat(item.total) || 0, item.moneda || 'MXN', limpiar(item.concepto), rfcReceptor || null,
     archivoXml || null, archivoPdf || null, creadoPor]
  );
  return 'creada';
}

// Guarda un adjunto en uploads/facturas y devuelve el nombre de archivo
function guardarAdjunto(att, ext) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const nombre = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  fs.writeFileSync(path.join(UPLOADS, nombre), att.content);
  return nombre;
}

// Una sola revision a la vez. El importador corre solo cada X minutos y ademas
// se puede disparar a mano; dos conexiones simultaneas al mismo buzon se pisarian
// marcando como leidos correos que la otra todavia esta procesando.
let enCurso = false;

// ── Revisar bandeja de entrada e importar ─────────────────
// Devuelve siempre un resumen para que la pantalla pueda decir que paso: sin el,
// un XML que falla solo deja rastro en el log del servidor y nadie se entera.
async function revisarCorreo() {
  if (!IMAP_USER || !IMAP_PASS) {
    return { configurado: false, revisados: 0, creadas: 0, duplicadas: 0,
             errores: 0, detalles: [], buzon: null };
  }
  if (enCurso) {
    return { configurado: true, ocupado: true, revisados: 0, creadas: 0,
             duplicadas: 0, errores: 0, detalles: [], buzon: IMAP_USER };
  }
  enCurso = true;

  // Usuario del sistema para creado_por (primer admin activo)
  let creadoPor = null;
  try {
    const adm = await query("SELECT id FROM fac_usuarios WHERE rol='admin' AND activo=TRUE ORDER BY id LIMIT 1");
    creadoPor = adm.rows[0]?.id || null;
  } catch { /* si la tabla difiere, queda null */ }

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  let creadas = 0, duplicadas = 0, errores = 0, revisados = 0;
  const detalles = [];
  const resumen = () => ({ configurado: true, revisados, creadas, duplicadas,
                           errores, detalles, buzon: IMAP_USER });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Buscar correos NO leídos
      const uids = await client.search({ seen: false });
      if (!uids || !uids.length) return resumen();
      revisados = uids.length;

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true });
          const parsed = await simpleParser(msg.source);
          const adjuntos = parsed.attachments || [];

          const xmls = adjuntos.filter(a =>
            (a.filename || '').toLowerCase().endsWith('.xml') ||
            (a.contentType || '').includes('xml'));
          const pdfs = adjuntos.filter(a => (a.filename || '').toLowerCase().endsWith('.pdf'));

          if (!xmls.length) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          for (const xmlAtt of xmls) {
            const texto = xmlAtt.content.toString('utf8');
            const p = parsearCFDI(texto);
            if (!p.ok) {
              errores++;
              detalles.push({ archivo: xmlAtt.filename || 'sin nombre',
                              de: parsed.from?.text || '', error: p.error });
              continue;
            }
            // Solo facturas emitidas (Ingreso). Ignorar pagos (P) y traslados (T)
            if (['P','T'].includes(p.datos.tipo)) continue;

            const nombreXml = guardarAdjunto(xmlAtt, '.xml');
            const nombrePdf = pdfs.length ? guardarAdjunto(pdfs[0], '.pdf') : null;

            const r = await importarFactura(p.datos, creadoPor, nombreXml, nombrePdf);
            if (r === 'creada') creadas++;
            else if (r === 'duplicada') duplicadas++;
          }

          // Marcar como leído (procesado)
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch (eMsg) {
          errores++;
          detalles.push({ archivo: '(correo completo)', de: '', error: eMsg.message });
          console.warn('   ⚠️ Error procesando correo:', eMsg.message);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.warn('⚠️ IMAP facturas:', e.message);
    detalles.push({ archivo: '(conexión)', de: '', error: e.message });
    errores++;
  } finally {
    try { await client.logout(); } catch {}
    enCurso = false;
  }

  if (creadas || duplicadas || errores) {
    console.log(`📥 Correo facturas: ${creadas} importadas, ${duplicadas} duplicadas, ${errores} errores`);
  }
  return resumen();
}

// ── Iniciar el importador programado ──────────────────────
function iniciarImportadorCorreo() {
  if (!IMAP_USER || !IMAP_PASS) {
    console.log('ℹ️  Importador de correo desactivado (faltan FAC_IMAP_USER / FAC_IMAP_PASS)');
    return;
  }
  console.log(`📬 Importador de facturas por correo ACTIVO — revisa cada ${INTERVALO_MIN} min (${IMAP_USER})`);
  // Primera revisión a los 15 segundos, luego cada intervalo
  setTimeout(revisarCorreo, 15000);
  setInterval(revisarCorreo, INTERVALO_MIN * 60 * 1000);
}

module.exports = { iniciarImportadorCorreo, revisarCorreo, parsearCFDI };
