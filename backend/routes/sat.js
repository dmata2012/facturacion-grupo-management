// ══ LISTA NEGRA DEL SAT · ARTICULO 69-B DEL CFF ═══════════════
//
// El SAT publica los RFC con operaciones presuntamente inexistentes (EFOS).
// Lo importante es la SITUACION, no la simple aparicion en la lista:
//
//   Presunto             el SAT lo senala, el contribuyente aun puede aclarar
//   Definitivo           no aclaro: sus CFDI no producen efectos fiscales
//   Desvirtuado          aclaro y SALIO: no hay problema
//   Sentencia Favorable  gano en tribunales: tampoco hay problema
//
// Marcar en rojo a un "Desvirtuado" seria acusar a alguien que ya se limpio,
// asi que solo Presunto y Definitivo cuentan como riesgo.
const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

const URL_69B = 'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv';
const RIESGO = ['Presunto', 'Definitivo'];

(async () => {
  try {
    // El RFC NO es llave: 81 contribuyentes aparecen varias veces en el archivo,
    // y 38 de ellos como "Definitivo" Y "Sentencia Favorable" a la vez (son
    // procedimientos distintos). Quedarse con uno seria decidir al azar si
    // alguien esta limpio. Se guardan todos los renglones y al consultar se
    // muestra la historia completa.
    await query(`
      CREATE TABLE IF NOT EXISTS fac_sat_69b (
        id SERIAL PRIMARY KEY,
        rfc TEXT NOT NULL,
        nombre TEXT,
        situacion TEXT,
        -- Las fechas de publicacion de cada etapa, tal como vienen en el CSV.
        fecha_presunto TEXT,
        fecha_definitivo TEXT,
        fecha_desvirtuado TEXT,
        fecha_sentencia TEXT
      )`);
    await query(`CREATE INDEX IF NOT EXISTS ix_sat69b_rfc ON fac_sat_69b(rfc)`);
    await query(`CREATE INDEX IF NOT EXISTS ix_sat69b_situacion ON fac_sat_69b(situacion)`);
    await query(`
      CREATE TABLE IF NOT EXISTS fac_sat_importaciones (
        id SERIAL PRIMARY KEY,
        listado TEXT NOT NULL,
        -- La fecha que el propio archivo declara ("actualizada al ..."), que no
        -- es la de la descarga: el SAT publica cada cierto tiempo.
        actualizado_al TEXT,
        registros INT,
        importado_por INT,
        importado_por_nombre TEXT,
        importado_en TIMESTAMP DEFAULT NOW()
      )`);
  } catch (e) { console.warn('Tablas del listado 69-B:', e.message); }
})();

// CSV con comillas: un nombre como "INGENIOS SANTOS, S.A. DE C.V." trae comas
// dentro del campo, asi que no se puede partir por coma a secas.
function filasCSV(texto) {
  const filas = [];
  let campo = '', fila = [], dentro = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentro) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
      else campo += c;
    } else if (c === '"') dentro = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const RFC_VALIDO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const normRFC = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '').trim();

// ── ACTUALIZAR EL LISTADO DESDE EL SAT ────────────────────────
router.post('/69b/importar', requireRol('admin', 'gerente'), async (req, res) => {
  try {
    const r = await fetch(URL_69B, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return res.status(502).json({ error: `El SAT respondió ${r.status}. Intenta más tarde.` });

    // El archivo viene en latin1, no en UTF-8: leerlo como UTF-8 deja los
    // acentos rotos en los nombres ("AVALÚOS" -> "AVALUOS" con basura).
    const texto = Buffer.from(await r.arrayBuffer()).toString('latin1');
    const filas = filasCSV(texto);

    const iEnc = filas.findIndex(x => (x[0] || '').trim() === 'No' && (x[1] || '').trim() === 'RFC');
    if (iEnc < 0) return res.status(502).json({ error: 'El archivo del SAT no trae el encabezado esperado. Pudo cambiar de formato.' });

    const actualizadoAl = ((filas[0] || [''])[0].match(/actualizada al ([^;,]+)/i) || [])[1] || null;

    const registros = [];
    for (const x of filas.slice(iEnc + 1)) {
      const rfc = normRFC(x[1]);
      if (!RFC_VALIDO.test(rfc)) continue;
      registros.push([rfc, (x[2] || '').trim(), (x[3] || '').trim(),
                      (x[5] || '').trim() || null, (x[13] || '').trim() || null,
                      (x[9] || '').trim() || null, (x[17] || '').trim() || null]);
    }
    if (!registros.length) return res.status(502).json({ error: 'El archivo del SAT llegó vacío.' });

    // Se reemplaza entero dentro de una transaccion: si algo falla a medias, la
    // lista anterior sigue intacta en vez de quedar a la mitad.
    const cli = await getClient();
    try {
      await cli.query('BEGIN');
      await cli.query('DELETE FROM fac_sat_69b');
      const LOTE = 500;
      for (let i = 0; i < registros.length; i += LOTE) {
        const trozo = registros.slice(i, i + LOTE);
        const vals = trozo.map((_, j) =>
          `($${j*7+1},$${j*7+2},$${j*7+3},$${j*7+4},$${j*7+5},$${j*7+6},$${j*7+7})`).join(',');
        await cli.query(
          `INSERT INTO fac_sat_69b
             (rfc,nombre,situacion,fecha_presunto,fecha_definitivo,fecha_desvirtuado,fecha_sentencia)
           VALUES ${vals}`, trozo.flat());
      }
      await cli.query(
        `INSERT INTO fac_sat_importaciones
           (listado, actualizado_al, registros, importado_por, importado_por_nombre)
         VALUES ('69b',$1,$2,$3,$4)`,
        [actualizadoAl, registros.length, req.usuario?.id || null, req.usuario?.nombre || null]);
      await cli.query('COMMIT');
    } catch (e) { await cli.query('ROLLBACK'); throw e; }
    finally { cli.release(); }

    res.json({ ok: true, registros: registros.length, actualizado_al: actualizadoAl });
  } catch (e) {
    const msg = /timeout|abort/i.test(e.message)
      ? 'El SAT tardó demasiado en responder. Intenta de nuevo en un rato.'
      : e.message;
    res.status(500).json({ error: msg });
  }
});

// ── ESTADO DEL LISTADO ────────────────────────────────────────
router.get('/69b/estado', async (req, res) => {
  try {
    const [c, u] = await Promise.all([
      query(`SELECT COUNT(DISTINCT rfc)::int AS total,
                    COUNT(DISTINCT rfc) FILTER (WHERE situacion = ANY($1))::int AS de_riesgo
               FROM fac_sat_69b`, [RIESGO]),
      query(`SELECT actualizado_al, registros, importado_por_nombre,
                    TO_CHAR(importado_en,'YYYY-MM-DD HH24:MI') AS importado_en
               FROM fac_sat_importaciones WHERE listado='69b'
              ORDER BY importado_en DESC LIMIT 1`)
    ]);
    res.json({ total: c.rows[0].total, de_riesgo: c.rows[0].de_riesgo,
               ultima: u.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── A QUIEN DE LOS MIOS LE PEGA ───────────────────────────────
// Clientes y empresas emisoras cuyo RFC esta en el listado. Se devuelven todas
// las coincidencias, tambien las limpias (Desvirtuado / Sentencia Favorable),
// con un campo que dice si son riesgo: que aparezca un RFC "desvirtuado" es
// informacion util, pero NO es una alerta.
router.get('/69b/coincidencias', async (req, res) => {
  try {
    // Un RFC puede traer varios renglones; se juntan en uno solo con todas sus
    // situaciones, para no mostrar al mismo cliente dos veces diciendo cosas
    // distintas.
    const r = await query(`
      WITH lista AS (
        SELECT rfc,
               MAX(nombre) AS nombre_sat,
               ARRAY_AGG(DISTINCT situacion ORDER BY situacion) AS situaciones,
               MAX(COALESCE(fecha_definitivo, fecha_presunto)) AS fecha
          FROM fac_sat_69b GROUP BY rfc
      )
      SELECT 'cliente' AS tipo, c.id, c.rfc, c.razon_social AS nombre_propio,
             l.nombre_sat, l.situaciones, l.fecha,
             (SELECT COUNT(*)::int FROM fac_facturas f
               WHERE f.cliente_id = c.id AND f.estatus <> 'cancelada') AS facturas
        FROM fac_clientes c
        JOIN lista l ON l.rfc = UPPER(TRIM(c.rfc))
       WHERE c.rfc IS NOT NULL
      UNION ALL
      SELECT 'emisora', e.id, e.rfc, e.razon_social,
             l.nombre_sat, l.situaciones, l.fecha,
             (SELECT COUNT(*)::int FROM fac_facturas f
               WHERE f.empresa_receptora_id = e.id AND f.estatus <> 'cancelada')
        FROM fac_empresas_receptoras e
        JOIN lista l ON l.rfc = UPPER(TRIM(e.rfc))
       WHERE e.rfc IS NOT NULL
      ORDER BY 8 DESC`);

    const filas = r.rows.map(x => {
      const s = x.situaciones || [];
      const riesgo = s.some(v => RIESGO.includes(v));
      return {
        ...x, riesgo,
        // Estaba senalado Y ademas gano o aclaro: ni es alarma ni esta limpio.
        // Hay que verlo con el contador antes de decidir.
        mixto: riesgo && s.some(v => !RIESGO.includes(v))
      };
    });
    res.json({
      coincidencias: filas,
      de_riesgo: filas.filter(x => x.riesgo && !x.mixto).length,
      mixtas:    filas.filter(x => x.mixto).length,
      limpias:   filas.filter(x => !x.riesgo).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONSULTAR UN RFC SUELTO ───────────────────────────────────
router.get('/69b/rfc/:rfc', async (req, res) => {
  try {
    const rfc = normRFC(req.params.rfc);
    const r = await query(`SELECT * FROM fac_sat_69b WHERE rfc=$1 ORDER BY id`, [rfc]);
    if (!r.rows.length) return res.json({ rfc, en_lista: false });
    const sit = r.rows.map(x => x.situacion);
    const riesgo = sit.some(v => RIESGO.includes(v));
    res.json({ rfc, en_lista: true, nombre: r.rows[0].nombre,
               riesgo, mixto: riesgo && sit.some(v => !RIESGO.includes(v)),
               procedimientos: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
