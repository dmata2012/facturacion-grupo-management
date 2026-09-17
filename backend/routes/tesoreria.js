const router = require('express').Router();
const { query, getClient } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// Migración idempotente: columna tipo_gasto para marcar "Reembolso pendiente de caja"
(async () => {
  try { await query(`ALTER TABLE fac_caja_chica_movimientos ADD COLUMN IF NOT EXISTS tipo_gasto TEXT`); }
  catch (e) { console.warn('Migración tipo_gasto:', e.message); }
})();

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
    res.json(r.rows);
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
             c.tipo             AS comprobante_tipo
        FROM fac_caja_chica_movimientos m
        LEFT JOIN fac_caja_chica_comprobantes c ON c.movimiento_id = m.id
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

    res.json({ ...fondo, movimientos: mov.rows, kpi: { ...k, saldo_actual: saldo }, por_categoria: cat.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fondos', requireRol('admin', 'capturista', 'tesoreria'), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, notas, clave_movimientos, icono } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido.' });
    const r = await query(
      `INSERT INTO fac_caja_chica_fondos(nombre,responsable,departamento,fondo_asignado,saldo_inicial,moneda,notas,clave_movimientos,icono,creado_por)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nombre, responsable, departamento, parseFloat(fondo_asignado)||0, parseFloat(saldo_inicial)||0,
       moneda||'MXN', notas, (clave_movimientos||'').trim() || null, (icono||'').trim() || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fondos/:id', requireRol('admin', 'capturista', 'tesoreria'), async (req, res) => {
  try {
    const { nombre, responsable, departamento, fondo_asignado, saldo_inicial, moneda, activo, notas, clave_movimientos, icono } = req.body;
    // Si clave_movimientos NO viene en el body, conservar la existente
    if (clave_movimientos === undefined) {
      await query(
        `UPDATE fac_caja_chica_fondos SET
           nombre=$1, responsable=$2, departamento=$3,
           fondo_asignado=$4, saldo_inicial=$5, moneda=$6,
           activo=$7, notas=$8, icono=$9, actualizado_en=NOW()
         WHERE id=$10`,
        [nombre, responsable, departamento, parseFloat(fondo_asignado)||0, parseFloat(saldo_inicial)||0,
         moneda||'MXN', activo !== false, notas, (icono||'').trim() || null, req.params.id]
      );
    } else {
      await query(
        `UPDATE fac_caja_chica_fondos SET
           nombre=$1, responsable=$2, departamento=$3,
           fondo_asignado=$4, saldo_inicial=$5, moneda=$6,
           activo=$7, notas=$8, clave_movimientos=$9, icono=$10, actualizado_en=NOW()
         WHERE id=$11`,
        [nombre, responsable, departamento, parseFloat(fondo_asignado)||0, parseFloat(saldo_inicial)||0,
         moneda||'MXN', activo !== false, notas, (clave_movimientos||'').trim() || null,
         (icono||'').trim() || null, req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: valida clave del fondo (admin no la requiere)
async function validarClaveFondo(fondoId, claveRecibida, usuario) {
  if (usuario.rol === 'admin') return { ok: true };
  const r = await query(`SELECT clave_movimientos FROM fac_caja_chica_fondos WHERE id=$1`, [fondoId]);
  if (!r.rows.length) return { ok: false, code: 404, error: 'Fondo no encontrado.' };
  const claveFondo = (r.rows[0].clave_movimientos || '').trim();
  if (!claveFondo) return { ok: true }; // sin clave configurada, pasa
  if (!claveRecibida || String(claveRecibida).trim() !== claveFondo) {
    return { ok: false, code: 403, error: 'Clave del responsable incorrecta.' };
  }
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
router.post('/movimientos', requireRol('admin', 'capturista', 'tesoreria'), async (req, res) => {
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

router.put('/movimientos/:id', requireRol('admin', 'capturista', 'tesoreria'), async (req, res) => {
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

router.delete('/movimientos/:id', requireRol('admin', 'capturista', 'tesoreria'), async (req, res) => {
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

module.exports = router;
