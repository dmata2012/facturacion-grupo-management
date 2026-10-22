// ══ CONCILIACION CONTRA MICROSIP ══════════════════════════════
//
// Cruza las facturas que tiene el sistema contra las que reporta Microsip, por
// periodo. La llave es el UUID: lo asigna el SAT, es unico y los dos sistemas
// lo traen para el mismo CFDI. Serie+folio no sirve, cada sistema numera a su
// modo.
//
// La carga NO se guarda: el archivo se cruza y se contesta. Lo unico que queda
// en la base es el cierre del mes, cuando las diferencias llegan a cero.
const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_cierres_mes (
        id SERIAL PRIMARY KEY,
        desde DATE NOT NULL,
        hasta DATE NOT NULL,
        -- Las cifras con las que se cerro, para poder saber despues si algo se
        -- movio despues del cierre.
        facturas_microsip INT,
        total_microsip NUMERIC(14,2),
        facturas_sistema INT,
        total_sistema NUMERIC(14,2),
        notas TEXT,
        cerrado_por INT,
        cerrado_por_nombre TEXT,
        cerrado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cierres_periodo
                   ON fac_cierres_mes(desde, hasta)`);
  } catch (e) { console.warn('Tabla de cierres de mes:', e.message); }
})();

const norm   = (v) => String(v == null ? '' : v).trim();
const normU  = (v) => norm(v).toUpperCase();
const numero = (v) => parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;
const centavos = (a, b) => Math.abs(numero(a) - numero(b)) < 0.01;
const UUID_OK = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

// Microsip reporta VIGENTE / CANCELADO en su columna Estado SAT.
const estaCancelada = (estado) => /CANCEL/i.test(norm(estado));

// ── CONCILIAR ─────────────────────────────────────────────────
// Recibe las filas ya leidas del Excel (el navegador las parsea) y el periodo.
// No escribe nada.
router.post('/microsip', async (req, res) => {
  try {
    const { desde, hasta } = req.body || {};
    const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
    if (!desde || !hasta) return res.status(400).json({ error: 'Falta el periodo a conciliar.' });
    if (!filas.length)    return res.status(400).json({ error: 'El archivo no trae ninguna factura.' });

    // ── Lado Microsip ──
    const microsip = [];
    const descartadas = [];
    const fueraDelPeriodo = [];
    const vistos = new Map();
    for (const x of filas) {
      const uuid = normU(x.uuid);
      if (!UUID_OK.test(uuid)) { descartadas.push({ ...x, motivo: 'Sin UUID válido' }); continue; }
      if (vistos.has(uuid)) { descartadas.push({ ...x, motivo: 'UUID repetido en el archivo' }); continue; }
      // El periodo tiene que recortar LOS DOS lados. Si solo se recortara el
      // del sistema, una factura del archivo con fecha fuera del rango saldria
      // como "falta en el sistema" cuando en realidad es de otro mes.
      const fx = norm(x.fecha).slice(0, 10);
      if (fx && (fx < desde || fx > hasta)) {
        fueraDelPeriodo.push({ uuid, folio: norm(x.folio), serie: norm(x.serie), fecha: fx,
                               total: numero(x.total), receptor: norm(x.nombre_receptor),
                               emisor: norm(x.nombre_emisor),
                               motivo: 'Fecha fuera del periodo conciliado' });
        continue;
      }
      const f = {
        uuid, folio: norm(x.folio), serie: norm(x.serie),
        fecha: norm(x.fecha).slice(0, 10),
        rfc_emisor: normU(x.rfc_emisor), emisor: norm(x.nombre_emisor),
        rfc_receptor: normU(x.rfc_receptor), receptor: norm(x.nombre_receptor),
        subtotal: numero(x.subtotal), iva: numero(x.iva), total: numero(x.total),
        cancelada: estaCancelada(x.estado_sat), estado_sat: norm(x.estado_sat),
        tipo: norm(x.tipo)
      };
      vistos.set(uuid, f);
      microsip.push(f);
    }

    // ── Lado sistema ──
    const r = await query(`
      SELECT f.id, UPPER(TRIM(f.uuid_cfdi)) AS uuid, f.folio,
             TO_CHAR(f.fecha_emision,'YYYY-MM-DD') AS fecha,
             f.subtotal, f.iva, f.total, f.estatus,
             UPPER(TRIM(COALESCE(f.rfc_detectado, c.rfc))) AS rfc_receptor,
             COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS receptor,
             UPPER(TRIM(er.rfc)) AS rfc_emisor,
             COALESCE(NULLIF(TRIM(er.nombre_comercial),''), er.razon_social) AS emisor
        FROM fac_facturas f
        LEFT JOIN fac_clientes c ON c.id = f.cliente_id
        LEFT JOIN fac_empresas_receptoras er ON er.id = f.empresa_receptora_id
       WHERE f.fecha_emision >= $1::date AND f.fecha_emision <= $2::date`, [desde, hasta]);

    const porUuid = new Map();
    const sinUuid = [];
    for (const x of r.rows) {
      if (UUID_OK.test(x.uuid || '')) porUuid.set(x.uuid, x);
      else sinUuid.push(x);
    }

    // ── El cruce ──
    const cuadran = [], difieren = [], soloMicrosip = [], soloSistema = [];
    const usados = new Set();

    for (const m of microsip) {
      const s = porUuid.get(m.uuid);
      if (!s) { soloMicrosip.push(m); continue; }
      usados.add(m.uuid);

      const dif = [];
      if (!centavos(m.total, s.total))
        dif.push({ campo: 'Total', microsip: m.total, sistema: numero(s.total), grave: true });
      if (!centavos(m.subtotal, s.subtotal))
        dif.push({ campo: 'Subtotal', microsip: m.subtotal, sistema: numero(s.subtotal), grave: true });
      if (!centavos(m.iva, s.iva))
        dif.push({ campo: 'IVA', microsip: m.iva, sistema: numero(s.iva), grave: true });

      // El estatus es lo mas delicado: cancelada de un lado y viva del otro
      // descuadra todos los reportes sin que nada lo diga.
      const sCancelada = s.estatus === 'cancelada';
      if (m.cancelada !== sCancelada)
        dif.push({ campo: 'Cancelación',
                   microsip: m.cancelada ? 'CANCELADA' : 'vigente',
                   sistema:  sCancelada  ? 'cancelada' : 'vigente', grave: true });

      // Una diferencia de uno o dos dias puede ser solo que un lado tomo la
      // fecha del XML y el otro la del timbrado. Se marca, pero aparte.
      if (m.fecha && s.fecha && m.fecha !== s.fecha) {
        const dias = Math.abs((new Date(m.fecha) - new Date(s.fecha)) / 86400000);
        dif.push({ campo: 'Fecha', microsip: m.fecha, sistema: s.fecha, grave: dias > 2 });
      }
      if (m.rfc_receptor && s.rfc_receptor && m.rfc_receptor !== s.rfc_receptor)
        dif.push({ campo: 'RFC del cliente', microsip: m.rfc_receptor, sistema: s.rfc_receptor, grave: true });

      const fila = { ...m, id: s.id, folio_sistema: s.folio, estatus_sistema: s.estatus,
                     receptor_sistema: s.receptor, emisor_sistema: s.emisor, diferencias: dif };
      (dif.length ? difieren : cuadran).push(fila);
    }

    for (const s of r.rows) {
      if (UUID_OK.test(s.uuid || '') && usados.has(s.uuid)) continue;
      soloSistema.push({ id: s.id, uuid: s.uuid || '', folio: s.folio,
                         fecha: s.fecha, total: numero(s.total), subtotal: numero(s.subtotal),
                         iva: numero(s.iva), estatus: s.estatus,
                         receptor: s.receptor, emisor: s.emisor,
                         sin_uuid: !UUID_OK.test(s.uuid || '') });
    }

    // ── El número de control ──
    // Las canceladas se cuentan aparte: los reportes del sistema ya las
    // excluyen, asi que el total que debe cuadrar es el de las vigentes.
    const suma = (l) => l.reduce((a, x) => a + numero(x.total), 0);
    const mVig = microsip.filter(x => !x.cancelada);
    const sVig = r.rows.filter(x => x.estatus !== 'cancelada');

    const difGraves = difieren.filter(x => x.diferencias.some(d => d.grave)).length;
    const resumen = {
      microsip:  { facturas: mVig.length, total: suma(mVig),
                   canceladas: microsip.length - mVig.length },
      sistema:   { facturas: sVig.length, total: suma(sVig),
                   canceladas: r.rows.length - sVig.length },
      diferencia_facturas: mVig.length - sVig.length,
      diferencia_monto: suma(mVig) - suma(sVig),
      cuadran: cuadran.length,
      difieren: difieren.length,
      difieren_grave: difGraves,
      solo_microsip: soloMicrosip.length,
      solo_sistema: soloSistema.length,
      sin_uuid_en_sistema: sinUuid.length,
      descartadas: descartadas.length,
      // Las de otro mes no son un problema, solo no se conciliaron aqui.
      fuera_del_periodo: fueraDelPeriodo.length,
      // Se puede cerrar el mes solo si no quedo ni una diferencia de ningun tipo.
      puede_cerrar: difieren.length === 0 && soloMicrosip.length === 0
                 && soloSistema.length === 0 && descartadas.length === 0
    };

    const cerrado = await query(
      `SELECT cerrado_por_nombre, TO_CHAR(cerrado_en,'YYYY-MM-DD HH24:MI') AS cuando
         FROM fac_cierres_mes WHERE desde=$1::date AND hasta=$2::date`, [desde, hasta]);

    res.json({ desde, hasta, resumen, cuadran, difieren, solo_microsip: soloMicrosip,
               solo_sistema: soloSistema, descartadas,
               fuera_del_periodo: fueraDelPeriodo,
               cerrado: cerrado.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CERRAR EL MES ─────────────────────────────────────────────
// Solo se guardan las cifras del cierre, no el archivo.
router.post('/cerrar', requireRol('admin', 'gerente'), async (req, res) => {
  try {
    const { desde, hasta, resumen, notas } = req.body || {};
    if (!desde || !hasta) return res.status(400).json({ error: 'Falta el periodo.' });
    // El servidor no se fia de lo que diga el navegador: si el resumen trae
    // diferencias, no se cierra.
    const sinDif = resumen && resumen.difieren === 0 && resumen.solo_microsip === 0
                && resumen.solo_sistema === 0 && resumen.descartadas === 0;
    if (!sinDif)
      return res.status(400).json({ error: 'No se puede cerrar: todavía hay diferencias.' });

    await query(`
      INSERT INTO fac_cierres_mes
        (desde, hasta, facturas_microsip, total_microsip, facturas_sistema,
         total_sistema, notas, cerrado_por, cerrado_por_nombre)
      VALUES ($1::date,$2::date,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (desde, hasta) DO UPDATE SET
        facturas_microsip = EXCLUDED.facturas_microsip,
        total_microsip    = EXCLUDED.total_microsip,
        facturas_sistema  = EXCLUDED.facturas_sistema,
        total_sistema     = EXCLUDED.total_sistema,
        notas             = EXCLUDED.notas,
        cerrado_por       = EXCLUDED.cerrado_por,
        cerrado_por_nombre= EXCLUDED.cerrado_por_nombre,
        cerrado_en        = NOW()`,
      [desde, hasta, resumen.microsip?.facturas || 0, resumen.microsip?.total || 0,
       resumen.sistema?.facturas || 0, resumen.sistema?.total || 0,
       (notas || '').trim() || null,
       req.usuario?.id || null, req.usuario?.nombre || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PERIODOS YA CERRADOS ──────────────────────────────────────
router.get('/cierres', async (req, res) => {
  try {
    const r = await query(`
      SELECT TO_CHAR(desde,'YYYY-MM-DD') AS desde, TO_CHAR(hasta,'YYYY-MM-DD') AS hasta,
             facturas_microsip, total_microsip, facturas_sistema, total_sistema,
             notas, cerrado_por_nombre, TO_CHAR(cerrado_en,'YYYY-MM-DD HH24:MI') AS cerrado_en
        FROM fac_cierres_mes ORDER BY desde DESC LIMIT 60`);
    res.json({ cierres: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reabrir un mes cerrado, por si aparece algo despues.
router.delete('/cierres', requireRol('admin', 'gerente'), async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const r = await query(
      `DELETE FROM fac_cierres_mes WHERE desde=$1::date AND hasta=$2::date RETURNING id`,
      [desde, hasta]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ese periodo no estaba cerrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
