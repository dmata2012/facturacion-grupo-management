const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');
const { permiso, NIVEL } = require('../middleware/permiso');

// Borrar un fondo entero y repartir quien entra a el se quedan en el rol de
// administrador a proposito: no son operacion diaria de la caja, y ponerlos en la
// matriz los volveria alcanzables con un nivel alto de Caja Chica.

router.use(verificarToken);

// Migración idempotente: columna tipo_gasto para marcar "Reembolso pendiente de caja"
//
// Y liquida_mov_id: la entrada con la que devuelven ese dinero apunta a la
// salida que esta saldando. Puede haber varias, porque se puede devolver a
// plazos. Lo que falta por cobrar se SUMA de ahi en vez de guardarse en un
// estado aparte, que es lo que se desincronizaria del dinero real.
(async () => {
  try {
    await query(`ALTER TABLE fac_caja_chica_movimientos ADD COLUMN IF NOT EXISTS tipo_gasto TEXT`);
    await query(`ALTER TABLE fac_caja_chica_movimientos ADD COLUMN IF NOT EXISTS liquida_mov_id INT`);
    await query(`CREATE INDEX IF NOT EXISTS ix_ccmov_liquida
                 ON fac_caja_chica_movimientos(liquida_mov_id)`);
  } catch (e) { console.warn('Migración tipo_gasto:', e.message); }
})();

const PENDIENTE_CAJA = 'Reembolso pendiente de caja';

// Cuanto falta por cobrar de una salida pendiente.
async function saldoPendiente(correr, movId, monto) {
  const r = await correr(
    `SELECT COALESCE(SUM(monto),0) AS abonado
       FROM fac_caja_chica_movimientos
      WHERE liquida_mov_id=$1 AND tipo='entrada'`, [movId]);
  const abonado = parseFloat(r.rows[0].abonado) || 0;
  return { abonado, saldo: +(parseFloat(monto) - abonado).toFixed(2) };
}

// Hay dos formas de manejar efectivo y no son la misma:
//
//   'chica'    fondo fijo. Se autoriza un monto, se gasta, y se repone hasta
//              volver al monto autorizado. El indicador que importa es cuanto
//              falta para reponerlo.
//   'efectivo' caja abierta. Entra efectivo (depositos, cobros) y sale (gastos).
//              No hay monto objetivo ni reposicion: lo que importa es el saldo y
//              el flujo del periodo.
//
// Los fondos que ya existen se quedan en 'chica' para que nadie vea cambiar su
// pantalla.
(async () => {
  try { await query(`ALTER TABLE fac_caja_chica_fondos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'chica'`); }
  catch (e) { console.warn('Migración tipo de caja:', e.message); }
})();

// ══ CLAVE DEL RESPONSABLE ═══════════════════════════════════
// Estaba en texto plano en la base Y viajaba al navegador de cualquiera que
// pudiera ver la caja (el listado hace SELECT f.*), asi que con las
// herramientas del navegador se leia sin esfuerzo. Eso no frena a nadie.
//
// Ahora se guarda el hash, igual que las contrasenas de usuario, y nunca sale
// del servidor: las pantallas solo reciben si la caja TIENE clave o no.
// Consecuencia deliberada: una clave olvidada ya no se puede consultar, se
// cambia por otra. Es el precio de que no se pueda leer.
(async () => {
  try {
    await query(`ALTER TABLE fac_caja_chica_fondos ADD COLUMN IF NOT EXISTS clave_hash TEXT`);
    await query(`CREATE TABLE IF NOT EXISTS fac_migraciones_aplicadas (
                   clave TEXT PRIMARY KEY, aplicada_en TIMESTAMP DEFAULT NOW())`);
    const ya = await query(`SELECT 1 FROM fac_migraciones_aplicadas WHERE clave=$1`,
                           ['claves_caja_a_hash']);
    if (!ya.rows.length) {
      // Se convierten las que ya existen y se borra el texto plano. La columna
      // vieja se conserva vacia: quitarla obligaria a coordinar el despliegue.
      const conClave = await query(
        `SELECT id, clave_movimientos FROM fac_caja_chica_fondos
          WHERE NULLIF(TRIM(clave_movimientos), '') IS NOT NULL`);
      for (const f of conClave.rows) {
        const hash = await bcrypt.hash(String(f.clave_movimientos).trim(), 10);
        await query(
          `UPDATE fac_caja_chica_fondos SET clave_hash=$1, clave_movimientos=NULL WHERE id=$2`,
          [hash, f.id]);
      }
      await query(`INSERT INTO fac_migraciones_aplicadas(clave) VALUES($1)
                   ON CONFLICT (clave) DO NOTHING`, ['claves_caja_a_hash']);
      if (conClave.rows.length)
        console.log(`Claves de caja convertidas a hash: ${conClave.rows.length}`);
    }
  } catch (e) { console.warn('Migración claves de caja:', e.message); }
})();

// Ni el hash ni el texto plano salen nunca en una respuesta. Solo se dice si la
// caja tiene clave, que es lo unico que la pantalla necesita saber.
function sinClave(f) {
  if (!f) return f;
  const { clave_movimientos, clave_hash, ...resto } = f;
  return { ...resto, tiene_clave: !!(clave_hash || (clave_movimientos || '').trim()) };
}

const TIPOS_CAJA = ['chica', 'efectivo'];
const tipoCaja = t => TIPOS_CAJA.includes(String(t || '').trim()) ? String(t).trim() : 'chica';

// ══ COMPROBANTES (archivo) ══════════════════════════════════
// Se guardan en la base de datos y no en la carpeta uploads/. En Render esa
// carpeta vive dentro del contenedor y se borra en cada despliegue: un comprobante
// obligatorio que desaparece al dia siguiente seria peor que no pedirlo.
//
// Tabla aparte de los movimientos para que listar un fondo no arrastre los bytes.
(async () => {
  const cols = `id SERIAL PRIMARY KEY,
    movimiento_id INT NOT NULL UNIQUE %FK%,
    nombre TEXT, tipo TEXT NOT NULL, tamano INT,
    datos BYTEA NOT NULL,
    subido_por INT, creado_en TIMESTAMP DEFAULT NOW()`;
  try {
    // Con cascada: borrar el movimiento, o el fondo completo, se lleva su archivo
    await query(`CREATE TABLE IF NOT EXISTS fac_caja_chica_comprobantes (${
      cols.replace('%FK%', 'REFERENCES fac_caja_chica_movimientos(id) ON DELETE CASCADE')})`);
  } catch (e) {
    try {
      await query(`CREATE TABLE IF NOT EXISTS fac_caja_chica_comprobantes (${cols.replace('%FK%', '')})`);
    } catch (e2) { console.warn('Migración comprobantes caja chica:', e2.message); }
  }
})();

const COMP_TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const COMP_MAX_BYTES = 5 * 1024 * 1024;

// Valida el archivo que manda la pantalla: { nombre, tipo, base64 }.
// Se comprueba el contenido real y no solo el tipo declarado, para que un archivo
// renombrado no pase por imagen o PDF.
function leerComprobante(a) {
  if (!a || !a.base64) return { ok: false, error: 'Adjunta el archivo del comprobante.' };
  const tipo = String(a.tipo || '').toLowerCase();
  if (!COMP_TIPOS[tipo]) return { ok: false, error: 'El comprobante debe ser una imagen (JPG, PNG, WEBP) o un PDF.' };
  let buf;
  try { buf = Buffer.from(String(a.base64).replace(/^data:[^,]*,/, ''), 'base64'); }
  catch { return { ok: false, error: 'No se pudo leer el archivo.' }; }
  if (!buf.length) return { ok: false, error: 'El archivo está vacío.' };
  if (buf.length > COMP_MAX_BYTES)
    return { ok: false, error: 'El comprobante pesa más de 5 MB. Toma la foto con menos resolución o comprime el PDF.' };
  const firma = buf.slice(0, 12);
  const esPdf  = firma.slice(0, 4).toString('latin1') === '%PDF';
  const esJpg  = firma[0] === 0xFF && firma[1] === 0xD8;
  const esPng  = firma[0] === 0x89 && firma.slice(1, 4).toString('latin1') === 'PNG';
  const esWebp = firma.slice(0, 4).toString('latin1') === 'RIFF' && firma.slice(8, 12).toString('latin1') === 'WEBP';
  const coincide = { 'application/pdf': esPdf, 'image/jpeg': esJpg, 'image/png': esPng, 'image/webp': esWebp }[tipo];
  if (!coincide) return { ok: false, error: 'El contenido del archivo no corresponde a su tipo.' };
  const nombre = String(a.nombre || ('comprobante.' + COMP_TIPOS[tipo])).replace(/[\\/\r\n"]/g, '_').slice(0, 150);
  return { ok: true, nombre, tipo, buf };
}

async function guardarComprobante(db, movimientoId, c, usuarioId) {
  await db.query(
    `INSERT INTO fac_caja_chica_comprobantes(movimiento_id, nombre, tipo, tamano, datos, subido_por)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (movimiento_id) DO UPDATE SET
       nombre=EXCLUDED.nombre, tipo=EXCLUDED.tipo, tamano=EXCLUDED.tamano,
       datos=EXCLUDED.datos, subido_por=EXCLUDED.subido_por, creado_en=NOW()`,
    [movimientoId, c.nombre, c.tipo, c.buf.length, c.buf, usuarioId]);
}

// Helper: verificar si usuario tiene acceso a un fondo (admin = siempre; otros = permiso explícito)
async function tienePermisoFondo(fondoId, usuario) {
  if (usuario.rol === 'admin') return true;
  const r = await query(
    `SELECT 1 FROM fac_caja_chica_permisos WHERE fondo_id=$1 AND usuario_id=$2 LIMIT 1`,
    [fondoId, usuario.id]
  );
  return r.rows.length > 0;
}

// ══ FONDOS DE CAJA CHICA ══════════════════════════════════
router.get('/fondos', async (req, res) => {
  try {
    const { activo } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (activo !== undefined) { params.push(activo === 'true'); where += ` AND f.activo=$${params.length}`; }

    // Si NO es admin, filtrar solo fondos donde tenga permiso
    if (req.usuario.rol !== 'admin') {
      params.push(req.usuario.id);
      where += ` AND EXISTS (SELECT 1 FROM fac_caja_chica_permisos p WHERE p.fondo_id=f.id AND p.usuario_id=$${params.length})`;
    }

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
    res.json(r.rows.map(sinClave));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LISTAR PERMISOS DE UN FONDO (solo admin) ──
router.get('/fondos/:id/permisos', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`
      SELECT p.usuario_id, u.nombre, u.email, u.rol
      FROM fac_caja_chica_permisos p
      JOIN fac_usuarios u ON u.id = p.usuario_id
      WHERE p.fondo_id=$1
      ORDER BY u.nombre
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACTUALIZAR PERMISOS DE UN FONDO (solo admin) ──
router.put('/fondos/:id/permisos', requireRol('admin'), async (req, res) => {
  try {
    const { usuario_ids } = req.body;
    if (!Array.isArray(usuario_ids)) return res.status(400).json({ error: 'usuario_ids debe ser un arreglo.' });
    await query(`DELETE FROM fac_caja_chica_permisos WHERE fondo_id=$1`, [req.params.id]);
    for (const uid of usuario_ids) {
      await query(
        `INSERT INTO fac_caja_chica_permisos(fondo_id, usuario_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.id, uid]
      );
    }
    res.json({ ok: true, count: usuario_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USUARIOS DISPONIBLES PARA ASIGNAR (solo admin) ──
router.get('/usuarios-disponibles', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`
      SELECT id, nombre, email, rol FROM fac_usuarios
      WHERE activo=TRUE AND rol != 'admin'
      ORDER BY nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fondos/:id', async (req, res) => {
  try {
    if (!(await tienePermisoFondo(req.params.id, req.usuario))) {
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    }
    const r = await query(`SELECT * FROM fac_caja_chica_fondos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Fondo no encontrado.' });

    const mov = await query(`
      SELECT m.*,
             (c.id IS NOT NULL) AS tiene_comprobante,
             c.nombre           AS comprobante_nombre,
             c.tipo             AS comprobante_tipo,
             u.nombre           AS capturado_por
        FROM fac_caja_chica_movimientos m
        LEFT JOIN fac_caja_chica_comprobantes c ON c.movimiento_id = m.id
        LEFT JOIN fac_usuarios u ON u.id = m.creado_por
       WHERE m.fondo_id=$1 ORDER BY m.fecha DESC, m.id DESC
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

    res.json({ ...sinClave(fondo), movimientos: mov.rows, kpi: { ...k, saldo_actual: saldo }, por_categoria: cat.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fondos', permiso('cajaChica', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, notas, clave_movimientos, icono } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido.' });
    const tipo = tipoCaja(req.body.tipo);
    const claveNueva = (clave_movimientos || '').trim();
    const hashNuevo = claveNueva ? await bcrypt.hash(claveNueva, 10) : null;
    // En una caja abierta no hay monto objetivo. Se guarda en cero y no en lo que
    // venga, para que ningun calculo de reposicion se despierte solo despues.
    const asignado = tipo === 'efectivo' ? 0 : (parseFloat(fondo_asignado) || 0);
    const r = await query(
      `INSERT INTO fac_caja_chica_fondos(nombre,responsable,departamento,fondo_asignado,saldo_inicial,moneda,notas,clave_hash,icono,tipo,creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [nombre, responsable, departamento, asignado, parseFloat(saldo_inicial)||0,
       moneda||'MXN', notas, hashNuevo, (icono||'').trim() || null,
       tipo, req.usuario.id]
    );
    res.status(201).json(sinClave(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fondos/:id', permiso('cajaChica', NIVEL.EDITAR), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, activo, notas, clave_movimientos, icono } = req.body;
    // El tipo solo cambia si la pantalla lo manda; si no, se conserva el que tiene.
    // Hay pantallas que editan un fondo sin saber de tipos (el lapiz del fondo
    // fijo, por ejemplo) y no deben convertir la caja en otra cosa.
    const actual = await query(`SELECT tipo FROM fac_caja_chica_fondos WHERE id=$1`, [req.params.id]);
    if (!actual.rows.length) return res.status(404).json({ error: 'Caja no encontrada.' });
    const tipo = req.body.tipo === undefined ? tipoCaja(actual.rows[0].tipo) : tipoCaja(req.body.tipo);
    const asignado = tipo === 'efectivo' ? 0 : (parseFloat(fondo_asignado) || 0);
    // La clave se maneja aparte del resto: no viene = se conserva; cadena vacia
    // = se quita a proposito; con texto = se cambia. Antes la pantalla mandaba
    // siempre el campo, asi que ahora que ya no recibe la clave, mandarlo vacio
    // la habria borrado sin que nadie lo pidiera.
    if (clave_movimientos !== undefined) {
      const nueva = String(clave_movimientos).trim();
      const hash = nueva ? await bcrypt.hash(nueva, 10) : null;
      await query(
        `UPDATE fac_caja_chica_fondos SET clave_hash=$1, clave_movimientos=NULL WHERE id=$2`,
        [hash, req.params.id]);
    }
    // El resto de los campos se guarda igual, sin tocar la clave
    await query(
      `UPDATE fac_caja_chica_fondos SET
         nombre=$1, responsable=$2, departamento=$3,
         fondo_asignado=$4, saldo_inicial=$5, moneda=$6,
         activo=$7, notas=$8, icono=$9, tipo=$10, actualizado_en=NOW()
       WHERE id=$11`,
      [nombre, responsable, departamento, asignado, parseFloat(saldo_inicial)||0,
       moneda||'MXN', activo !== false, notas, (icono||'').trim() || null, tipo, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: valida clave del fondo (admin no la requiere)
async function validarClaveFondo(fondoId, claveRecibida, usuario) {
  if (usuario.rol === 'admin') return { ok: true };
  const r = await query(
    `SELECT clave_hash, clave_movimientos FROM fac_caja_chica_fondos WHERE id=$1`, [fondoId]);
  if (!r.rows.length) return { ok: false, code: 404, error: 'Fondo no encontrado.' };
  const hash  = r.rows[0].clave_hash;
  // Texto plano solo mientras la migracion no haya corrido todavia
  const plano = (r.rows[0].clave_movimientos || '').trim();
  if (!hash && !plano) return { ok: true };            // sin clave configurada, pasa
  const recibida = String(claveRecibida || '').trim();
  if (!recibida) return { ok: false, code: 403, error: 'Clave del responsable incorrecta.' };
  const ok = hash ? await bcrypt.compare(recibida, hash) : recibida === plano;
  if (!ok) return { ok: false, code: 403, error: 'Clave del responsable incorrecta.' };
  return { ok: true };
}

// DELETE /fondos/:id  — desactivar (soft delete, se conserva historial)
router.delete('/fondos/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`UPDATE fac_caja_chica_fondos SET activo=FALSE, actualizado_en=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /fondos/:id/completo  — eliminación total (fondo + movimientos + permisos)
// Requiere admin + confirmación por nombre en el body
router.delete('/fondos/:id/completo', requireRol('admin'), async (req, res) => {
  try {
    const { confirmacion_nombre } = req.body;
    const r = await query(`SELECT nombre FROM fac_caja_chica_fondos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Fondo no encontrado.' });
    const nombreReal = r.rows[0].nombre;
    if (!confirmacion_nombre || String(confirmacion_nombre).trim() !== nombreReal) {
      return res.status(400).json({ error: `Debes escribir exactamente "${nombreReal}" para confirmar.` });
    }
    // ON DELETE CASCADE en movimientos y permisos → se eliminan solos
    const del = await query(`DELETE FROM fac_caja_chica_fondos WHERE id=$1 RETURNING nombre`, [req.params.id]);
    res.json({ ok: true, nombre: del.rows[0].nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ MOVIMIENTOS ═══════════════════════════════════════════
router.post('/movimientos', permiso('cajaChica', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const { fondo_id, fecha, tipo, categoria, concepto, monto, beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas, clave, periodo_pago } = req.body;
    if (!fondo_id || !fecha || !tipo || !concepto || !monto)
      return res.status(400).json({ error: 'Fondo, fecha, tipo, concepto y monto son requeridos.' });
    if (!['entrada','salida'].includes(tipo))
      return res.status(400).json({ error: 'Tipo debe ser entrada o salida.' });
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    // Opcional. Si viene, se valida antes de tocar nada: un archivo invalido debe
    // rechazar el alta completa, no dejar el movimiento guardado sin el.
    let comp = null;
    if (req.body.archivo) {
      comp = leerComprobante(req.body.archivo);
      if (!comp.ok) return res.status(400).json({ error: comp.error });
    }

    // Verificar permiso de acceso al fondo
    if (!(await tienePermisoFondo(fondo_id, req.usuario))) {
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    }

    // Validar clave del responsable
    const chk = await validarClaveFondo(fondo_id, clave, req.usuario);
    if (!chk.ok) return res.status(chk.code||403).json({ error: chk.error });

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

    // Movimiento y archivo juntos: si el usuario adjunto uno y no se pudo
    // guardar, el movimiento tampoco se queda. Sin archivo, solo el movimiento.
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO fac_caja_chica_movimientos(
           fondo_id, fecha, tipo, categoria, concepto, monto,
           beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas, periodo_pago, tipo_gasto, creado_por
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [fondo_id, fecha, tipo, categoria||null, concepto, m,
         beneficiario||null, forma_pago||'efectivo', referencia||null, comprobante||null,
         autorizado_por||null, notas||null, periodo_pago||null, req.body.tipo_gasto||null, req.usuario.id]
      );
      if (comp) await guardarComprobante(client, r.rows[0].id, comp, req.usuario.id);
      await client.query('COMMIT');
      res.status(201).json({ ...r.rows[0], tiene_comprobante: !!comp });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ver el archivo. Mismo candado que el fondo: quien no tiene acceso a esa caja no
// puede abrir sus comprobantes aunque adivine el id.
router.get('/movimientos/:id/comprobante', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.nombre, c.tipo, c.datos, m.fondo_id
         FROM fac_caja_chica_comprobantes c
         JOIN fac_caja_chica_movimientos m ON m.id = c.movimiento_id
        WHERE c.movimiento_id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Este movimiento no tiene comprobante.' });
    const c = r.rows[0];
    if (!(await tienePermisoFondo(c.fondo_id, req.usuario)))
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    res.setHeader('Content-Type', c.tipo);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(c.nombre || 'comprobante')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(c.datos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/movimientos/:id', permiso('cajaChica', NIVEL.EDITAR), async (req, res) => {
  try {
    const { fecha, categoria, concepto, monto, beneficiario, forma_pago, referencia, comprobante, autorizado_por, notas, clave, periodo_pago, tipo_gasto } = req.body;
    if (!fecha || !concepto || !monto)
      return res.status(400).json({ error: 'Fecha, concepto y monto requeridos.' });
    // Opcional, igual que en el alta. Si viene, se valida y reemplaza al anterior.
    let comp = null;
    if (req.body.archivo) {
      comp = leerComprobante(req.body.archivo);
      if (!comp.ok) return res.status(400).json({ error: comp.error });
    }
    const m = parseFloat(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });

    // Verificar que no deje el saldo negativo si es salida
    const cur = await query(`SELECT fondo_id, tipo FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const { fondo_id, tipo } = cur.rows[0];

    // Verificar permiso de acceso al fondo
    if (!(await tienePermisoFondo(fondo_id, req.usuario))) {
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    }

    // Validar clave del responsable
    const chk = await validarClaveFondo(fondo_id, clave, req.usuario);
    if (!chk.ok) return res.status(chk.code||403).json({ error: chk.error });
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
         autorizado_por=$9, notas=$10, periodo_pago=$11, tipo_gasto=$12, actualizado_en=NOW()
       WHERE id=$13`,
      [fecha, categoria||null, concepto, m, beneficiario||null, forma_pago||'efectivo',
       referencia||null, comprobante||null, autorizado_por||null, notas||null, periodo_pago||null, tipo_gasto||null, req.params.id]
    );
    if (comp) await guardarComprobante({ query }, req.params.id, comp, req.usuario.id);
    res.json({ ok: true, comprobante_reemplazado: !!comp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LIQUIDAR UN REEMBOLSO PENDIENTE ───────────────────────────
// Una salida marcada "Reembolso pendiente de caja" es dinero que salio de la
// caja pero que alguien debe devolver, por eso no se le pide a tesoreria. El
// dia que lo devuelven hay que hacer DOS cosas a la vez: registrar la entrada
// y bajar el pendiente. Separadas, el saldo sube y el pendiente sigue
// restando completo, y el reembolso a pedir sale al doble de corto.
//
// Se puede devolver en partes: cada abono es una entrada mas.
router.post('/movimientos/:id/liquidar', permiso('cajaChica', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const { fecha, forma_pago, referencia, notas, clave } = req.body || {};
    const r = await query(
      `SELECT * FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const mov = r.rows[0];

    if (mov.tipo !== 'salida' || mov.tipo_gasto !== PENDIENTE_CAJA)
      return res.status(400).json({ error: 'Ese movimiento no es un reembolso pendiente.' });

    if (!(await tienePermisoFondo(mov.fondo_id, req.usuario)))
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    const chk = await validarClaveFondo(mov.fondo_id, clave, req.usuario);
    if (!chk.ok) return res.status(chk.code || 403).json({ error: chk.error });

    const { abonado, saldo } = await saldoPendiente(query, mov.id, mov.monto);
    if (saldo <= 0.001)
      return res.status(400).json({ error: 'Ese reembolso ya está liquidado por completo.' });

    // Sin monto se entiende que devolvieron todo lo que faltaba.
    const abono = req.body.monto == null || req.body.monto === ''
      ? saldo : parseFloat(req.body.monto);
    if (!(abono > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    // Cobrar de mas convertiria el sobrante en una entrada sin origen, que
    // infla el saldo de la caja sin que nadie sepa de donde salio.
    if (abono > saldo + 0.01)
      return res.status(400).json({
        error: `De este pendiente solo faltan $${saldo.toFixed(2)} por cobrar`
             + (abonado > 0 ? ` (ya se abonaron $${abonado.toFixed(2)})` : '') + '.' });

    // El comprobante se valida antes de tocar nada: un archivo invalido debe
    // rechazar la liquidacion completa, no dejarla guardada sin el.
    let comp = null;
    if (req.body.archivo) {
      comp = leerComprobante(req.body.archivo);
      if (!comp.ok) return res.status(400).json({ error: comp.error });
    }

    const cuando = fecha || new Date().toISOString().slice(0, 10);
    const esTotal = abono >= saldo - 0.01;
    const client = await getClient();
    let ent;
    try {
      await client.query('BEGIN');
      // Categoria 'Devolucion', que es la que ya traen las devoluciones del
      // historial: este dinero lo regresa un tercero, no es la reposicion del
      // fondo por tesoreria.
      ent = await client.query(
        `INSERT INTO fac_caja_chica_movimientos(
           fondo_id, fecha, tipo, categoria, concepto, monto,
           beneficiario, forma_pago, referencia, notas, liquida_mov_id, creado_por
         ) VALUES($1,$2,'entrada','Devolución',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [mov.fondo_id, cuando,
         (esTotal ? 'Devolución de: ' : 'Abono a: ')
           + (mov.concepto || '').slice(0, 230),
         abono, mov.beneficiario || null, forma_pago || 'efectivo',
         referencia || null, notas || null, mov.id, req.usuario.id]);
      if (comp) await guardarComprobante(client, ent.rows[0].id, comp, req.usuario.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    const despues = await saldoPendiente(query, mov.id, mov.monto);
    res.status(201).json({ ok: true, entrada: ent.rows[0],
                           abonado: despues.abonado, saldo: despues.saldo,
                           liquidado: despues.saldo <= 0.01 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deshacer un abono. Solo borra entradas que de verdad son liquidaciones: sin
// ese candado, este seria un borrado de movimientos con un permiso mas bajo
// del que el borrado normal exige.
router.delete('/movimientos/:id/abono', permiso('cajaChica', NIVEL.EDITAR), async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    const ent = r.rows[0];
    if (ent.tipo !== 'entrada' || !ent.liquida_mov_id)
      return res.status(400).json({ error: 'Ese movimiento no es el abono de un pendiente.' });
    if (!(await tienePermisoFondo(ent.fondo_id, req.usuario)))
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    await query(`DELETE FROM fac_caja_chica_movimientos WHERE id=$1`, [ent.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/movimientos/:id', permiso('cajaChica', NIVEL.TODO), async (req, res) => {
  try {
    const clave = req.query.clave || req.body?.clave;
    const cur = await query(`SELECT fondo_id FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Movimiento no encontrado.' });
    if (!(await tienePermisoFondo(cur.rows[0].fondo_id, req.usuario))) {
      return res.status(403).json({ error: 'No tienes acceso a esta caja chica.' });
    }
    const chk = await validarClaveFondo(cur.rows[0].fondo_id, clave, req.usuario);
    if (!chk.ok) return res.status(chk.code||403).json({ error: chk.error });
    await query(`DELETE FROM fac_caja_chica_comprobantes WHERE movimiento_id=$1`, [req.params.id]);
    await query(`DELETE FROM fac_caja_chica_movimientos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ KPIs GLOBALES ═════════════════════════════════════════
router.get('/kpi', async (req, res) => {
  try {
    const params = [];
    let permFilter = '';
    if (req.usuario.rol !== 'admin') {
      params.push(req.usuario.id);
      permFilter = ` AND EXISTS (SELECT 1 FROM fac_caja_chica_permisos p WHERE p.fondo_id=f.id AND p.usuario_id=$${params.length})`;
    }
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
      FROM fac_caja_chica_fondos f WHERE f.activo = TRUE ${permFilter}
    `, params);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ DISPERSIONES A BENEFICIARIOS ══════════════════════════════
//
// Lo que se le paga a la gente de cada cliente: transferencia, cheque o
// efectivo. El catalogo de a quien se le paga vive en fac_bancos_beneficiarios
// (compartido con Bancos, para no partir en dos la misma lista).
//
// HOY ESTOS MOVIMIENTOS NO MUEVEN SALDOS, por decision del usuario. Pero se
// guardan completos desde el principio —con su cuenta de origen— para que el
// dia que si deban afectarlos no haya que recapturar nada: el saldo de una
// cuenta se CALCULA (saldo_inicial + abonos - cargos - cheques), asi que
// prenderlos sera agregar un sumando a esa formula, no migrar historicos.
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_tes_dispersiones (
        id SERIAL PRIMARY KEY,
        beneficiario_id INT NOT NULL REFERENCES fac_bancos_beneficiarios(id),
        -- Por cuenta de que cliente se paga. Se guarda aparte del beneficiario
        -- porque este puede cambiar de cliente y el pago ya hecho no.
        cliente_id INT REFERENCES fac_clientes(id) ON DELETE SET NULL,
        forma TEXT NOT NULL,
        -- De donde sale. En efectivo va nulo: esos pagos no salen de las cajas.
        cuenta_bancaria_id INT REFERENCES fac_bancos_cuentas(id) ON DELETE SET NULL,
        cheque_id INT,
        fecha DATE NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        referencia TEXT,
        concepto TEXT,
        -- El interruptor. Apagado hoy; al prenderlo el movimiento entra al saldo
        -- de su cuenta. Va por renglon y no como ajuste global, para poder
        -- encenderlo de a poco sin descuadrar lo ya conciliado.
        afecta_saldo BOOLEAN NOT NULL DEFAULT FALSE,
        notas TEXT,
        creado_por INT,
        creado_por_nombre TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);

    // Las cuentas del beneficiario. Antes eran tres columnas suyas, pero hay
    // quien cobra en dos bancos distintos segun el concepto.
    await query(`
      CREATE TABLE IF NOT EXISTS fac_bancos_ben_cuentas (
        id SERIAL PRIMARY KEY,
        beneficiario_id INT NOT NULL REFERENCES fac_bancos_beneficiarios(id) ON DELETE CASCADE,
        alias TEXT,
        banco TEXT,
        clabe TEXT,
        numero_cuenta TEXT,
        -- La que se propone por omision al dispersarle.
        principal BOOLEAN NOT NULL DEFAULT FALSE,
        -- No se borran las que ya recibieron un pago: se apagan, para que el
        -- historico siga diciendo a donde fue el dinero.
        activa BOOLEAN NOT NULL DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS ix_bencta_ben ON fac_bancos_ben_cuentas(beneficiario_id)`);
    // A que cuenta del beneficiario se deposito. Sin esto, con dos cuentas no
    // se puede saber despues a donde se le pago.
    await query(`ALTER TABLE fac_tes_dispersiones ADD COLUMN IF NOT EXISTS
                 cuenta_beneficiario_id INT REFERENCES fac_bancos_ben_cuentas(id) ON DELETE SET NULL`);

    // Lo ya capturado en las columnas viejas pasa a ser su primera cuenta.
    const yaPaso = await query(
      `SELECT 1 FROM fac_migraciones_aplicadas WHERE clave=$1`, ['ben_cuentas_v1']);
    if (!yaPaso.rows.length) {
      await query(`
        INSERT INTO fac_bancos_ben_cuentas(beneficiario_id, banco, clabe, numero_cuenta, principal)
        SELECT b.id, b.banco, b.clabe, b.numero_cuenta, TRUE
          FROM fac_bancos_beneficiarios b
         WHERE (COALESCE(TRIM(b.banco),'') <> '' OR COALESCE(TRIM(b.clabe),'') <> ''
                OR COALESCE(TRIM(b.numero_cuenta),'') <> '')
           AND NOT EXISTS (SELECT 1 FROM fac_bancos_ben_cuentas c WHERE c.beneficiario_id = b.id)`);
      await query(`INSERT INTO fac_migraciones_aplicadas(clave) VALUES($1)
                   ON CONFLICT DO NOTHING`, ['ben_cuentas_v1']);
      console.log('Cuentas de beneficiarios: migradas las que ya estaban capturadas.');
    }
    await query(`CREATE INDEX IF NOT EXISTS ix_disp_fecha ON fac_tes_dispersiones(fecha DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS ix_disp_benef ON fac_tes_dispersiones(beneficiario_id)`);
    await query(`CREATE INDEX IF NOT EXISTS ix_disp_cliente ON fac_tes_dispersiones(cliente_id)`);
  } catch (e) { console.warn('Tabla de dispersiones:', e.message); }
})();

const FORMAS_DISP = ['transferencia', 'cheque', 'efectivo'];
const soloDigitos = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const limpio = (v) => String(v == null ? '' : v).trim();

// ── CATALOGO: a quien le pagamos ──────────────────────────────
router.get('/beneficiarios', permiso('beneficiarios', NIVEL.VER), async (req, res) => {
  try {
    const { cliente_id, buscar, incluir_inactivos } = req.query;
    const params = [];
    let where = incluir_inactivos === 'true' ? 'WHERE TRUE' : 'WHERE b.activo = TRUE';
    if (cliente_id === 'sin') where += ' AND b.cliente_id IS NULL';
    else if (cliente_id) { params.push(cliente_id); where += ` AND b.cliente_id = $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (b.nombre_completo ILIKE $${params.length} OR b.rfc ILIKE $${params.length}
                   OR b.concepto ILIKE $${params.length})`;
    }
    const r = await query(`
      SELECT b.*,
             COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente,
             (SELECT COUNT(*)::int FROM fac_tes_dispersiones d WHERE d.beneficiario_id = b.id) AS pagos,
             (SELECT COALESCE(SUM(d.monto),0) FROM fac_tes_dispersiones d WHERE d.beneficiario_id = b.id) AS pagado,
             COALESCE((SELECT json_agg(json_build_object(
                         'id', cb.id, 'alias', cb.alias, 'banco', cb.banco,
                         'clabe', cb.clabe, 'numero_cuenta', cb.numero_cuenta,
                         'principal', cb.principal,
                         'pagos', (SELECT COUNT(*)::int FROM fac_tes_dispersiones d2
                                    WHERE d2.cuenta_beneficiario_id = cb.id))
                         ORDER BY cb.principal DESC, cb.id)
                        FROM fac_bancos_ben_cuentas cb
                       WHERE cb.beneficiario_id = b.id AND cb.activa = TRUE), '[]'::json) AS cuentas
        FROM fac_bancos_beneficiarios b
        LEFT JOIN fac_clientes c ON c.id = b.cliente_id
        ${where}
       ORDER BY b.activo DESC, c.razon_social NULLS LAST, b.nombre_completo`, params);
    // Cuantos quedan sin cliente: son los que ya existian en Bancos.
    const sin = await query(
      `SELECT COUNT(*)::int AS n FROM fac_bancos_beneficiarios WHERE activo=TRUE AND cliente_id IS NULL`);
    res.json({ beneficiarios: r.rows, sin_cliente: sin.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guarda la lista de cuentas de un beneficiario y espeja la principal en las
// columnas viejas de la tabla, que es de donde las leen los cheques.
//
// Las que el usuario quito no se borran si ya recibieron un pago: se apagan.
// Borrarlas dejaria el historico sin decir a donde fue el dinero.
async function guardarCuentasBen(id, lista) {
  const cuentas = Array.isArray(lista) ? lista : [];
  const limpias = cuentas
    .map(c => ({
      id: c.id || null,
      alias: limpio(c.alias) || null,
      banco: limpio(c.banco) || null,
      clabe: soloDigitos(c.clabe) || null,
      numero_cuenta: limpio(c.numero_cuenta) || null,
      principal: !!c.principal,
    }))
    // Una cuenta sin ningun dato no es una cuenta.
    .filter(c => c.banco || c.clabe || c.numero_cuenta);
  if (limpias.length && !limpias.some(c => c.principal)) limpias[0].principal = true;

  const previas = await query(
    `SELECT id FROM fac_bancos_ben_cuentas WHERE beneficiario_id=$1 AND activa=TRUE`, [id]);
  const quedan = new Set(limpias.filter(c => c.id).map(c => String(c.id)));

  for (const p of previas.rows) {
    if (quedan.has(String(p.id))) continue;
    const uso = await query(
      `SELECT COUNT(*)::int AS n FROM fac_tes_dispersiones WHERE cuenta_beneficiario_id=$1`, [p.id]);
    if (uso.rows[0].n > 0)
      await query(`UPDATE fac_bancos_ben_cuentas SET activa=FALSE, principal=FALSE WHERE id=$1`, [p.id]);
    else
      await query(`DELETE FROM fac_bancos_ben_cuentas WHERE id=$1`, [p.id]);
  }

  for (const c of limpias) {
    if (c.id)
      await query(`
        UPDATE fac_bancos_ben_cuentas
           SET alias=$1, banco=$2, clabe=$3, numero_cuenta=$4, principal=$5, activa=TRUE
         WHERE id=$6 AND beneficiario_id=$7`,
        [c.alias, c.banco, c.clabe, c.numero_cuenta, c.principal, c.id, id]);
    else
      await query(`
        INSERT INTO fac_bancos_ben_cuentas(beneficiario_id, alias, banco, clabe, numero_cuenta, principal)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, c.alias, c.banco, c.clabe, c.numero_cuenta, c.principal]);
  }

  const pri = limpias.find(c => c.principal) || {};
  await query(`
    UPDATE fac_bancos_beneficiarios SET banco=$1, clabe=$2, numero_cuenta=$3 WHERE id=$4`,
    [pri.banco || null, pri.clabe || null, pri.numero_cuenta || null, id]);
}

router.post('/beneficiarios', permiso('beneficiarios', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = limpio(b.nombre_completo);
    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
    const r = await query(`
      INSERT INTO fac_bancos_beneficiarios
        (nombre_completo, rfc, cliente_id, tipo, banco, clabe, numero_cuenta, concepto, notas, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nombre.toUpperCase(), limpio(b.rfc).toUpperCase() || null,
       b.cliente_id || null, b.tipo === 'empresa' ? 'empresa' : 'persona',
       limpio(b.banco) || null, soloDigitos(b.clabe) || null,
       limpio(b.numero_cuenta) || null, limpio(b.concepto) || null,
       limpio(b.notas) || null, req.usuario ? req.usuario.id : null]);
    if (b.cuentas) await guardarCuentasBen(r.rows[0].id, b.cuentas);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/beneficiarios/:id', permiso('beneficiarios', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = limpio(b.nombre_completo);
    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
    await query(`
      UPDATE fac_bancos_beneficiarios
         SET nombre_completo=$1, rfc=$2, cliente_id=$3, tipo=$4, banco=$5, clabe=$6,
             numero_cuenta=$7, concepto=$8, notas=$9, actualizado_en=NOW()
       WHERE id=$10`,
      [nombre.toUpperCase(), limpio(b.rfc).toUpperCase() || null,
       b.cliente_id || null, b.tipo === 'empresa' ? 'empresa' : 'persona',
       limpio(b.banco) || null, soloDigitos(b.clabe) || null,
       limpio(b.numero_cuenta) || null, limpio(b.concepto) || null,
       limpio(b.notas) || null, req.params.id]);
    if (b.cuentas) await guardarCuentasBen(req.params.id, b.cuentas);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// No se borra: si ya se le pago, borrarlo dejaria los pagos sin destinatario.
router.patch('/beneficiarios/:id/activo', permiso('beneficiarios', NIVEL.EDITAR), async (req, res) => {
  try {
    const activo = req.body && req.body.activo !== false;
    const r = await query(
      `UPDATE fac_bancos_beneficiarios SET activo=$1, actualizado_en=NOW()
        WHERE id=$2 RETURNING nombre_completo`, [activo, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ok: true, activo, nombre: r.rows[0].nombre_completo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Historial de un beneficiario ──────────────────────────────
router.get('/beneficiarios/:id/pagos', permiso('beneficiarios', NIVEL.VER), async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*, TO_CHAR(d.fecha,'YYYY-MM-DD') AS fecha,
             cu.alias AS cuenta, cu.banco AS cuenta_banco,
             cb.banco AS destino_banco, cb.clabe AS destino_clabe, cb.alias AS destino_alias,
             COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente
        FROM fac_tes_dispersiones d
        LEFT JOIN fac_bancos_ben_cuentas cb ON cb.id = d.cuenta_beneficiario_id
        LEFT JOIN fac_bancos_cuentas cu ON cu.id = d.cuenta_bancaria_id
        LEFT JOIN fac_clientes c ON c.id = d.cliente_id
       WHERE d.beneficiario_id = $1
       ORDER BY d.fecha DESC, d.id DESC LIMIT 300`, [req.params.id]);
    res.json({ pagos: r.rows,
               total: r.rows.reduce((a, x) => a + (parseFloat(x.monto) || 0), 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MOVIMIENTOS ───────────────────────────────────────────────
router.get('/dispersiones', permiso('beneficiarios', NIVEL.VER), async (req, res) => {
  try {
    const { desde, hasta, cliente_id, forma, beneficiario_id } = req.query;
    const params = [];
    let where = 'WHERE TRUE';
    if (desde) { params.push(desde); where += ` AND d.fecha >= $${params.length}::date`; }
    if (hasta) { params.push(hasta); where += ` AND d.fecha <= $${params.length}::date`; }
    if (cliente_id) { params.push(cliente_id); where += ` AND d.cliente_id = $${params.length}`; }
    if (forma) { params.push(forma); where += ` AND d.forma = $${params.length}`; }
    if (beneficiario_id) { params.push(beneficiario_id); where += ` AND d.beneficiario_id = $${params.length}`; }

    const r = await query(`
      SELECT d.*, TO_CHAR(d.fecha,'YYYY-MM-DD') AS fecha,
             b.nombre_completo AS beneficiario, b.rfc,
             COALESCE(cb.banco, b.banco) AS banco, COALESCE(cb.clabe, b.clabe) AS clabe,
             cb.alias AS destino_alias,
             cu.alias AS cuenta, cu.banco AS cuenta_banco,
             COALESCE(NULLIF(TRIM(c.nombre_comercial),''), c.razon_social) AS cliente
        FROM fac_tes_dispersiones d
        JOIN fac_bancos_beneficiarios b ON b.id = d.beneficiario_id
        LEFT JOIN fac_bancos_ben_cuentas cb ON cb.id = d.cuenta_beneficiario_id
        LEFT JOIN fac_bancos_cuentas cu ON cu.id = d.cuenta_bancaria_id
        LEFT JOIN fac_clientes c ON c.id = d.cliente_id
        ${where}
       ORDER BY d.fecha DESC, d.id DESC LIMIT 1000`, params);

    const porForma = {};
    r.rows.forEach(x => {
      porForma[x.forma] = porForma[x.forma] || { n: 0, monto: 0 };
      porForma[x.forma].n++;
      porForma[x.forma].monto += parseFloat(x.monto) || 0;
    });
    res.json({
      movimientos: r.rows,
      resumen: {
        n: r.rows.length,
        total: +r.rows.reduce((a, x) => a + (parseFloat(x.monto) || 0), 0).toFixed(2),
        por_forma: porForma,
        afectan_saldo: r.rows.filter(x => x.afecta_saldo).length
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dispersiones', permiso('beneficiarios', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const b = req.body || {};
    const monto = parseFloat(b.monto);
    if (!b.beneficiario_id) return res.status(400).json({ error: 'Elige a quién se le paga.' });
    if (!b.fecha)           return res.status(400).json({ error: 'Falta la fecha.' });
    if (!(monto > 0))       return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
    const forma = FORMAS_DISP.indexOf(b.forma) >= 0 ? b.forma : 'transferencia';
    // En efectivo no hay cuenta de origen; en las otras dos si hace falta aunque
    // hoy no mueva saldos: sin ese dato, el dia que deban afectarlo habria que
    // recapturar todo a mano.
    if (forma !== 'efectivo' && !b.cuenta_bancaria_id)
      return res.status(400).json({ error: 'Elige de qué cuenta sale el pago.' });

    const ben = await query(
      `SELECT cliente_id, activo FROM fac_bancos_beneficiarios WHERE id=$1`, [b.beneficiario_id]);
    if (!ben.rows.length) return res.status(404).json({ error: 'Ese beneficiario no existe.' });
    if (!ben.rows[0].activo)
      return res.status(400).json({ error: 'Ese beneficiario está dado de baja.' });

    // A que cuenta SUYA se le deposita. Si tiene varias hay que decirlo, si no
    // el historico no sabria a cual fue. Se verifica que sea de el: mandar la
    // cuenta de otro beneficiario dejaria el pago apuntando a quien no es.
    let destino = null;
    if (forma !== 'efectivo') {
      const suyas = await query(
        `SELECT id, principal FROM fac_bancos_ben_cuentas
          WHERE beneficiario_id=$1 AND activa=TRUE ORDER BY principal DESC, id`, [b.beneficiario_id]);
      if (b.cuenta_beneficiario_id) {
        const elegida = suyas.rows.find(c => String(c.id) === String(b.cuenta_beneficiario_id));
        if (!elegida)
          return res.status(400).json({ error: 'Esa cuenta no es de este beneficiario.' });
        destino = elegida.id;
      } else if (suyas.rows.length > 1) {
        return res.status(400).json({
          error: 'Este beneficiario tiene ' + suyas.rows.length
               + ' cuentas: elige a cuál se le deposita.' });
      } else if (suyas.rows.length === 1) {
        destino = suyas.rows[0].id;
      }
    }

    const r = await query(`
      INSERT INTO fac_tes_dispersiones
        (beneficiario_id, cliente_id, forma, cuenta_bancaria_id, cuenta_beneficiario_id,
         cheque_id, fecha, monto,
         referencia, concepto, notas, creado_por, creado_por_nombre)
      VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.beneficiario_id,
       // Se congela el cliente que tenia el beneficiario al momento del pago.
       b.cliente_id || ben.rows[0].cliente_id || null,
       forma, forma === 'efectivo' ? null : b.cuenta_bancaria_id, destino,
       b.cheque_id || null, b.fecha, monto,
       limpio(b.referencia) || null, limpio(b.concepto) || null, limpio(b.notas) || null,
       req.usuario ? req.usuario.id : null, req.usuario ? req.usuario.nombre : null]);
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/dispersiones/:id', permiso('beneficiarios', NIVEL.EDITAR), async (req, res) => {
  try {
    const r = await query(`DELETE FROM fac_tes_dispersiones WHERE id=$1 RETURNING monto`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
