const router = require('express').Router();
const { query, getClient } = require('../config/db');

// Helper: distribuir días de solicitud entre periodos (FIFO, más antiguos primero)
// Devuelve { asignaciones: [{periodo_id, num_periodo, dias}], resumen: "X días de P°Y + ..." }
async function distribuirDiasFIFO(client, empleadoId, diasTotales) {
  const r = await client.query(`
    SELECT id, num_periodo,
      dias_correspondientes - dias_tomados AS pendientes
    FROM fac_vacaciones_periodos
    WHERE empleado_id = $1
      AND dias_correspondientes - dias_tomados > 0
    ORDER BY num_periodo ASC
  `, [empleadoId]);

  const asignaciones = [];
  let faltan = parseFloat(diasTotales);
  for (const p of r.rows) {
    if (faltan <= 0) break;
    const pend = parseFloat(p.pendientes);
    const usar = Math.min(pend, faltan);
    asignaciones.push({ periodo_id: p.id, num_periodo: p.num_periodo, dias: +usar.toFixed(2) });
    faltan = +(faltan - usar).toFixed(2);
  }
  const ok = faltan <= 0.001;
  const resumen = asignaciones.length
    ? asignaciones.map(a => `${a.dias} día${a.dias!==1?'s':''} del P°${a.num_periodo}`).join(', ')
    : 'sin periodos disponibles';
  return { ok, asignaciones, resumen, faltantes: faltan };
}
const { verificarToken, requireRol } = require('../middleware/auth');
const { permiso, NIVEL, permisosDeUsuario } = require('../middleware/permiso');

// Primer modulo migrado al motor de permisos. El nivel Ver deja al colaborador
// solo con lo suyo; para ver a toda la plantilla hace falta Capturar o mas.
const verPlantilla = permiso('vacaciones', NIVEL.CAPTURAR);

router.use(verificarToken);

// Migración idempotente: columna 'tipo' para clasificar solicitudes
// vacaciones | permiso_goce | incapacidad
(async () => {
  try { await query(`ALTER TABLE fac_vacaciones_solicitudes ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'vacaciones'`); }
  catch (e) { console.warn('Migración tipo solicitudes:', e.message); }
  // Rastro de la autorización. Sin esto la solicitud cambia de estatus sin que
  // quede quien lo decidió, y el formato impreso no puede acreditar nada.
  for (const col of ['autorizado_por INT',
                     'autorizado_en TIMESTAMP',
                     'nota_autorizacion TEXT']) {
    try { await query(`ALTER TABLE fac_vacaciones_solicitudes ADD COLUMN IF NOT EXISTS ${col}`); }
    catch (e) { console.warn('Migración autorización:', e.message); }
  }
  // Visto bueno del jefe directo, previo a la autorización de RH. El rastro va
  // aparte del de autorización porque son dos firmas distintas y el formato
  // impreso tiene una línea para cada una.
  for (const col of ['vobo_por INT', 'vobo_en TIMESTAMP', 'vobo_nota TEXT']) {
    try { await query(`ALTER TABLE fac_vacaciones_solicitudes ADD COLUMN IF NOT EXISTS ${col}`); }
    catch (e) { console.warn('Migración visto bueno:', e.message); }
  }
  // A quién reporta cada colaborador. Se guarda por persona y no por
  // departamento porque el departamento es texto libre, y porque hay quien
  // reporta a alguien que no es el jefe de su área.
  try {
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS jefe_id INT`);
    await query(`CREATE INDEX IF NOT EXISTS idx_fac_empleados_jefe ON fac_empleados(jefe_id)`);
  } catch (e) { console.warn('Migración jefe_id:', e.message); }

  // Antes de que existiera el visto bueno, 'pendiente' significaba "esperando a
  // Recursos Humanos". Al agregar el paso del jefe, la bandeja de RH pasó a
  // mirar 'vo_bo' y las solicitudes que ya estaban en espera desaparecieron de
  // ahí; tampoco las veía ningún jefe, porque nadie tenía jefe asignado todavía.
  // Se les pone el visto bueno por omisión, sin nombre: nadie lo dio, y el
  // formato no debe acreditar una firma que no ocurrió.
  try {
    await query(`CREATE TABLE IF NOT EXISTS fac_migraciones_aplicadas (
                   clave TEXT PRIMARY KEY, aplicada_en TIMESTAMP DEFAULT NOW())`);
    const ya = await query(`SELECT 1 FROM fac_migraciones_aplicadas WHERE clave=$1`,
                           ['vacaciones_pendientes_a_vobo']);
    if (!ya.rows.length) {
      const r = await query(
        `UPDATE fac_vacaciones_solicitudes SET estatus='vo_bo'
          WHERE estatus='pendiente' RETURNING id`);
      await query(`INSERT INTO fac_migraciones_aplicadas(clave) VALUES($1)
                   ON CONFLICT (clave) DO NOTHING`, ['vacaciones_pendientes_a_vobo']);
      if (r.rows.length)
        console.log(`Solicitudes en espera devueltas a la bandeja de RH: ${r.rows.length}`);
    }
  } catch (e) { console.warn('Migración pendientes a visto bueno:', e.message); }
})();

// ══ ESTATUS DE UNA SOLICITUD ════════════════════════════════
//   pendiente  espera el visto bueno del jefe directo
//   vo_bo      el jefe ya dio su visto bueno; espera la autorización de RH
//   aprobada   autorizada en firme
//   rechazada  rechazada por el jefe o por RH (los días se devuelven)
//
// Quien no tiene jefe asignado se salta el primer paso: su solicitud nace en
// 'vo_bo'. Sin eso, nadie podría darle entrada y quedaría atorada para siempre.
async function jefeDe(empleadoId) {
  const r = await query(`SELECT jefe_id FROM fac_empleados WHERE id=$1`, [empleadoId]);
  return r.rows[0]?.jefe_id || null;
}

// Tabla LFT (post-reforma 2023): años cumplidos → días de vacaciones
function diasPorAnio(anio) {
  if (anio <= 0)  return 0;
  if (anio === 1) return 12;
  if (anio === 2) return 14;
  if (anio === 3) return 16;
  if (anio === 4) return 18;
  if (anio === 5) return 20;
  if (anio <= 10) return 22;
  if (anio <= 15) return 24;
  if (anio <= 20) return 26;
  if (anio <= 25) return 28;
  if (anio <= 30) return 30;
  return 32;
}

function anios(fechaIngreso) {
  if (!fechaIngreso) return 0;
  // Una fecha sin hora ('2015-01-01') la interpreta como medianoche UTC, y al
  // leerla con getDate() en hora local se recorre un dia hacia atras: en
  // America/Cancun (UTC-5) el 2 se vuelve el 1. El aniversario caia un dia
  // antes y los dias del periodo nuevo aparecian antes de tiempo.
  const txt = String(fechaIngreso).slice(0, 10);
  const ing = /^\d{4}-\d{2}-\d{2}$/.test(txt)
    ? new Date(txt + 'T00:00:00')   // medianoche LOCAL
    : new Date(fechaIngreso);       // ya viene como Date desde la base
  const hoy = new Date();
  let a = hoy.getFullYear() - ing.getFullYear();
  const m = hoy.getMonth() - ing.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < ing.getDate())) a--;
  return Math.max(0, a);
}

// ── LISTAR EMPLEADOS CON RESUMEN VACACIONAL ──
// ═══ AUTOSERVICIO: "MIS VACACIONES" ═════════════════
// Todo lo de aquí se acota al expediente del usuario de la sesión. Es lo que
// permite dar acceso a cualquier colaborador sin exponerle los saldos, sueldos
// ni solicitudes del resto de la plantilla.
async function miEmpleadoId(usuarioId) {
  const r = await query(`SELECT empleado_id FROM fac_usuarios WHERE id=$1`, [usuarioId]);
  return r.rows[0]?.empleado_id || null;
}

router.get('/mi-info', async (req, res) => {
  try {
    const empId = await miEmpleadoId(req.usuario.id);
    if (!empId) return res.json({ vinculado: false });
    // Al abrir su pantalla ve los periodos al día, sin esperar al barrido diario:
    // el día que cumple años ya le aparecen sus días nuevos.
    await generarPeriodosFaltantes(empId).catch(() => {});

    const emp = await query(
      `SELECT id, nombre, puesto, departamento, TO_CHAR(fecha_ingreso,'YYYY-MM-DD') AS fecha_ingreso
         FROM fac_empleados WHERE id=$1`, [empId]);
    if (!emp.rows.length) return res.json({ vinculado: false });

    const periodos = await query(
      `SELECT id, num_periodo, dias_correspondientes, dias_tomados,
              (dias_correspondientes - dias_tomados) AS pendientes
         FROM fac_vacaciones_periodos WHERE empleado_id=$1 ORDER BY num_periodo`, [empId]);

    const solicitudes = await query(
      `SELECT id, tipo, estatus,
              TO_CHAR(fecha_solicitud,'YYYY-MM-DD') AS fecha_solicitud,
              TO_CHAR(fecha_inicio,'YYYY-MM-DD')    AS fecha_inicio,
              TO_CHAR(fecha_fin,'YYYY-MM-DD')       AS fecha_fin,
              TO_CHAR(fecha_regreso,'YYYY-MM-DD')   AS fecha_regreso,
              dias_solicitados, observaciones
         FROM fac_vacaciones_solicitudes
        WHERE empleado_id=$1 ORDER BY fecha_inicio DESC, id DESC LIMIT 100`, [empId]);

    const disponibles = periodos.rows.reduce((a, p) => a + parseFloat(p.pendientes || 0), 0);
    // Una solicitud pendiente ya descontó sus días del periodo. Hay que decirlo
    // aparte: si no, el colaborador ve un saldo más bajo del que esperaba y nada
    // en la pantalla le explica adónde se fueron.
    const apart = await query(
      `SELECT COALESCE(SUM(dias_solicitados),0) AS n FROM fac_vacaciones_solicitudes
        WHERE empleado_id=$1 AND estatus IN ('pendiente','vo_bo')`, [empId]);
    res.json({
      vinculado: true,
      empleado: { ...emp.rows[0], antiguedad_anios: anios(emp.rows[0].fecha_ingreso) },
      periodos: periodos.rows,
      solicitudes: solicitudes.rows,
      dias_disponibles: +disponibles.toFixed(2),
      dias_apartados: +parseFloat(apart.rows[0].n).toFixed(2)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// El colaborador solicita para sí mismo. El empleado_id sale de la sesión, nunca
// del cuerpo de la petición: así nadie puede pedir a nombre de otro.
router.post('/mis-solicitudes', async (req, res) => {
  try {
    const empId = await miEmpleadoId(req.usuario.id);
    if (!empId) return res.status(400).json({
      error: 'Tu usuario todavía no está enlazado a un expediente de empleado. Pídele a Recursos Humanos que lo configure.' });

    const { fecha_inicio, fecha_fin, fecha_regreso, dias_solicitados, observaciones, tipo } = req.body;
    if (!fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: 'Indica desde y hasta qué día.' });
    const dias = parseFloat(dias_solicitados) || 0;
    if (dias <= 0) return res.status(400).json({ error: 'Los días solicitados deben ser mayor a 0.' });

    // Se reutiliza el alta normal para no duplicar la lógica de reparto por
    // periodos, pero forzando el empleado de la sesión y el estatus pendiente.
    req.body = {
      empleado_id: empId,
      fecha_solicitud: new Date().toISOString().slice(0,10),
      fecha_inicio, fecha_fin, fecha_regreso: fecha_regreso || null,
      dias_solicitados: dias,
      observaciones: observaciones || null,
      tipo: tipo || 'vacaciones',
      // Con jefe asignado pasa primero por él; sin jefe va directo a RH
      estatus: (await jefeDe(empId)) ? 'pendiente' : 'vo_bo'
    };
    return crearSolicitud(req, res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancelar la propia solicitud, solo si aún no empieza. Devuelve los días.
router.delete('/mis-solicitudes/:id', async (req, res) => {
  const client = await getClient();
  try {
    const empId = await miEmpleadoId(req.usuario.id);
    const s = await client.query(
      `SELECT id, empleado_id, fecha_inicio FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (!empId || s.rows[0].empleado_id !== empId)
      return res.status(403).json({ error: 'Esa solicitud no es tuya.' });

    const inicio = new Date(s.rows[0].fecha_inicio);
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (inicio <= hoy)
      return res.status(400).json({ error: 'Ya empezó. Pídele a Recursos Humanos que la cancele.' });

    await client.query('BEGIN');
    const asig = await client.query(
      `SELECT periodo_id, dias_aplicados FROM fac_vacaciones_solicitud_periodos WHERE solicitud_id=$1`,
      [req.params.id]);
    for (const a of asig.rows) {
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = GREATEST(0, dias_tomados - $1), actualizado_en=NOW()
         WHERE id = $2`, [parseFloat(a.dias_aplicados), a.periodo_id]);
    }
    await client.query(`DELETE FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get('/empleados', verPlantilla, async (req, res) => {
  try {
    const r = await query(`
      SELECT e.id, e.nombre, e.puesto, e.departamento, e.fecha_ingreso,
        COALESCE(SUM(p.dias_correspondientes),0) AS dias_total,
        COALESCE(SUM(p.dias_tomados),0)          AS dias_tomados,
        COALESCE(SUM(p.dias_correspondientes - p.dias_tomados),0) AS dias_pendientes
      FROM fac_empleados e
      LEFT JOIN fac_vacaciones_periodos p ON p.empleado_id = e.id
      WHERE e.activo = TRUE
      GROUP BY e.id
      ORDER BY e.nombre
    `);
    res.json(r.rows.map(emp => ({ ...emp, antiguedad_anios: anios(emp.fecha_ingreso) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTE: PERIODOS POR VENCER ──
// Cada periodo se gana cuando se cumple ese año de antigüedad
// Por LFT vencen 6 meses después de cumplido el año
router.get('/por-vencer', verPlantilla, async (req, res) => {
  try {
    const r = await query(`
      SELECT
        e.id          AS empleado_id,
        e.nombre, e.puesto, e.departamento, e.fecha_ingreso,
        p.num_periodo,
        p.dias_correspondientes,
        p.dias_tomados,
        (p.dias_correspondientes - p.dias_tomados)::numeric AS dias_pendientes,
        (e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL)::date              AS fecha_ganado,
        (e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL + INTERVAL '6 months')::date AS fecha_vence,
        ((e.fecha_ingreso + (p.num_periodo || ' years')::INTERVAL + INTERVAL '6 months')::date - CURRENT_DATE) AS dias_para_vencer
      FROM fac_empleados e
      JOIN fac_vacaciones_periodos p ON p.empleado_id = e.id
      WHERE e.activo = TRUE
        AND e.fecha_ingreso IS NOT NULL
        AND p.dias_correspondientes - p.dias_tomados > 0
      ORDER BY fecha_vence ASC, e.nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DETALLE DE UN EMPLEADO ──
router.get('/empleados/:id', verPlantilla, async (req, res) => {
  try {
    const emp = await query(`SELECT * FROM fac_empleados WHERE id=$1`, [req.params.id]);
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });
    // Abrir el expediente deja los periodos al corriente
    await generarPeriodosFaltantes(req.params.id, emp.rows[0].fecha_ingreso).catch(() => {});

    const periodos = await query(`
      SELECT * FROM fac_vacaciones_periodos WHERE empleado_id=$1 ORDER BY num_periodo
    `, [req.params.id]);

    const solicitudes = await query(`
      SELECT * FROM fac_vacaciones_solicitudes WHERE empleado_id=$1 ORDER BY fecha_solicitud DESC, id DESC
    `, [req.params.id]);

    const e = emp.rows[0];
    res.json({
      ...e,
      antiguedad_anios: anios(e.fecha_ingreso),
      periodos: periodos.rows,
      solicitudes: solicitudes.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GENERAR PERIODOS POR ANTIGÜEDAD ──
// ══ AUDITORIA DEL EXPEDIENTE VACACIONAL ═════════════════════
// Revisa que los numeros cuadren. El invariante que importa:
//
//   periodo.dias_tomados  ==  suma de dias_aplicados de ese periodo
//
// Se cumple porque los dias se descuentan al crear la solicitud y se devuelven
// al rechazarla o borrarla, borrando el reparto. Si no cuadra, o alguien edito
// dias_tomados a mano (hay una ruta para eso, con clave) o algo se perdio.
//
// Tambien se revisa lo que se puede saber sin interpretar: periodos que
// faltan por antiguedad, periodos con mas dias tomados que los que
// corresponden, y dias que no coinciden con la tabla de la LFT.
router.get('/auditoria', verPlantilla, async (req, res) => {
  try {
    const filas = await query(`
      SELECT e.id AS empleado_id, e.nombre, e.numero_colaborador,
             TO_CHAR(e.fecha_ingreso,'YYYY-MM-DD') AS fecha_ingreso,
             p.id AS periodo_id, p.num_periodo,
             p.dias_correspondientes, p.dias_tomados,
             COALESCE(ap.aplicado, 0) AS aplicado
        FROM fac_empleados e
        LEFT JOIN fac_vacaciones_periodos p ON p.empleado_id = e.id
        LEFT JOIN (
          SELECT periodo_id, SUM(dias_aplicados) AS aplicado
            FROM fac_vacaciones_solicitud_periodos GROUP BY periodo_id
        ) ap ON ap.periodo_id = p.id
       WHERE e.activo IS NOT FALSE
       ORDER BY e.nombre, p.num_periodo`);

    // Solicitudes vivas sin reparto: sus dias no estan descontados de ningun
    // periodo, asi que el saldo del colaborador esta mas alto de lo real.
    const huerfanas = await query(`
      SELECT s.id, s.empleado_id, e.nombre, s.dias_solicitados, s.estatus,
             TO_CHAR(s.fecha_inicio,'YYYY-MM-DD') AS fecha_inicio
        FROM fac_vacaciones_solicitudes s
        JOIN fac_empleados e ON e.id = s.empleado_id
       WHERE COALESCE(s.tipo,'vacaciones') = 'vacaciones'
         AND s.estatus <> 'rechazada'
         AND NOT EXISTS (SELECT 1 FROM fac_vacaciones_solicitud_periodos sp
                          WHERE sp.solicitud_id = s.id)
       ORDER BY e.nombre, s.fecha_inicio`);

    const porEmp = new Map();
    for (const f of filas.rows) {
      if (!porEmp.has(f.empleado_id)) {
        porEmp.set(f.empleado_id, {
          empleado_id: f.empleado_id, nombre: f.nombre,
          numero_colaborador: f.numero_colaborador, fecha_ingreso: f.fecha_ingreso,
          antiguedad: anios(f.fecha_ingreso), periodos: [], problemas: []
        });
      }
      if (f.periodo_id) porEmp.get(f.empleado_id).periodos.push(f);
    }

    const n2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;

    for (const emp of porEmp.values()) {
      const nums = new Set(emp.periodos.map(p => p.num_periodo));
      const faltan = [];
      for (let n = 1; n <= emp.antiguedad; n++) if (!nums.has(n)) faltan.push(n);
      if (faltan.length) emp.problemas.push({
        tipo: 'periodos_faltantes', gravedad: 'alta',
        detalle: `Le faltan ${faltan.length} periodo(s): ${faltan.join('°, ')}°. ` +
                 `Tiene ${emp.antiguedad} año(s) cumplidos.`
      });

      for (const p of emp.periodos) {
        const tom = n2(p.dias_tomados), apl = n2(p.aplicado), corr = n2(p.dias_correspondientes);
        if (Math.abs(tom - apl) > 0.01) emp.problemas.push({
          tipo: 'descuadre', gravedad: 'alta', num_periodo: p.num_periodo,
          detalle: `${p.num_periodo}° periodo: dice ${tom} día(s) tomados, pero las solicitudes ` +
                   `registradas suman ${apl}. Diferencia de ${n2(tom - apl)}.`
        });
        if (tom - corr > 0.01) emp.problemas.push({
          tipo: 'sobregiro', gravedad: 'alta', num_periodo: p.num_periodo,
          detalle: `${p.num_periodo}° periodo: tomó ${tom} de ${corr} día(s). Se pasó por ${n2(tom - corr)}.`
        });
        const lft = diasPorAnio(p.num_periodo);
        if (Math.abs(corr - lft) > 0.01) emp.problemas.push({
          tipo: 'dias_distintos_lft', gravedad: 'info', num_periodo: p.num_periodo,
          detalle: `${p.num_periodo}° periodo: tiene ${corr} día(s); la LFT marca ${lft}. ` +
                   `Puede ser un ajuste a propósito.`
        });
      }
    }

    for (const h of huerfanas.rows) {
      const emp = porEmp.get(h.empleado_id);
      const d = `Solicitud del ${h.fecha_inicio} (${h.dias_solicitados} día(s), ${h.estatus}) ` +
                `no está descontada de ningún periodo.`;
      if (emp) emp.problemas.push({ tipo: 'solicitud_sin_reparto', gravedad: 'alta', detalle: d });
    }

    const todos = [...porEmp.values()];
    res.json({
      revisados: todos.length,
      con_hallazgos: todos.filter(e => e.problemas.length).length,
      empleados: todos.map(e => ({ ...e, periodos: undefined })).filter(e => e.problemas.length)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crea los periodos que le falten a un colaborador segun su antiguedad.
// Es idempotente: ON CONFLICT DO NOTHING respeta los que ya existen, incluidos
// los que RH haya ajustado a mano.
async function generarPeriodosFaltantes(empleadoId, fechaIngreso) {
  let ingreso = fechaIngreso;
  if (ingreso === undefined) {
    const e = await query(`SELECT fecha_ingreso FROM fac_empleados WHERE id=$1`, [empleadoId]);
    if (!e.rows.length) return { ok: false, error: 'Empleado no encontrado.' };
    ingreso = e.rows[0].fecha_ingreso;
  }
  const a = anios(ingreso);
  if (a < 1) return { ok: true, periodos_creados: 0, antiguedad: a, mensaje: 'Aún no cumple 1 año.' };
  let creados = 0;
  for (let n = 1; n <= a; n++) {
    const r = await query(
      `INSERT INTO fac_vacaciones_periodos(empleado_id, num_periodo, dias_correspondientes)
       VALUES($1, $2, $3)
       ON CONFLICT (empleado_id, num_periodo) DO NOTHING
       RETURNING id`,
      [empleadoId, n, diasPorAnio(n)]);
    if (r.rowCount) creados++;
  }
  return { ok: true, periodos_creados: creados, antiguedad: a };
}

// ══ ALTA AUTOMATICA DE PERIODOS ═════════════════════════════
// Antes habia que acordarse de pulsar "generar periodos" por cada quien cumplia
// años. Quien se olvidaba, al colaborador le faltaban dias sin que nadie se
// enterara. Ahora se revisa a toda la plantilla al arrancar y una vez al dia.
async function generarPeriodosDeTodos() {
  try {
    const emps = await query(
      `SELECT id, fecha_ingreso FROM fac_empleados
        WHERE activo IS NOT FALSE AND fecha_ingreso IS NOT NULL`);
    let total = 0, conNuevos = 0;
    for (const e of emps.rows) {
      const r = await generarPeriodosFaltantes(e.id, e.fecha_ingreso);
      if (r.periodos_creados) { total += r.periodos_creados; conNuevos++; }
    }
    if (total) console.log(`Periodos de vacaciones creados: ${total} en ${conNuevos} colaborador(es)`);
    return { periodos: total, colaboradores: conNuevos };
  } catch (e) { console.warn('Alta automática de periodos:', e.message); return null; }
}

// Al arrancar se espera un poco, para no competir con las migraciones
setTimeout(generarPeriodosDeTodos, 30000);
setInterval(generarPeriodosDeTodos, 24 * 60 * 60 * 1000);

router.post('/empleados/:id/generar-periodos', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const r = await generarPeriodosFaltantes(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EDITAR dias_tomados de un periodo (requiere clave admin) ──
router.put('/periodos/:id/dias-tomados', requireRol('admin'), async (req, res) => {
  try {
    const { dias_tomados, clave } = req.body;
    const claveCorrecta = process.env.VAC_UNLOCK_KEY || 'admin2026';
    if (!clave || String(clave).trim() !== claveCorrecta) {
      return res.status(403).json({ error: 'Clave de administrador incorrecta.' });
    }
    const val = parseFloat(dias_tomados);
    if (!(val >= 0)) return res.status(400).json({ error: 'Días tomados debe ser mayor o igual a 0.' });
    const r = await query(
      `UPDATE fac_vacaciones_periodos SET dias_tomados=$1, actualizado_en=NOW() WHERE id=$2 RETURNING id`,
      [val, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Periodo no encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GUARDAR PERIODOS (upsert selectivo, preserva dias_tomados y solicitudes) ──
router.put('/empleados/:id/periodos', requireRol('admin', 'capturista'), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { periodos } = req.body; // [{num_periodo, dias_correspondientes, notas}]
    const empId = req.params.id;

    // Traer los periodos existentes
    const existentes = await client.query(
      `SELECT id, num_periodo, dias_tomados FROM fac_vacaciones_periodos WHERE empleado_id=$1`,
      [empId]
    );
    const porNum = new Map(existentes.rows.map(r => [r.num_periodo, r]));
    const numsEnviados = new Set();

    for (const p of (periodos || [])) {
      const num = parseInt(p.num_periodo) || 0;
      if (num <= 0) continue;
      numsEnviados.add(num);
      const dc  = parseFloat(p.dias_correspondientes) || 0;
      const not = p.notas || null;
      if (porNum.has(num)) {
        // UPDATE — solo dias_correspondientes y notas (dias_tomados se preserva)
        await client.query(
          `UPDATE fac_vacaciones_periodos
             SET dias_correspondientes=$1, notas=$2, actualizado_en=NOW()
           WHERE id=$3`,
          [dc, not, porNum.get(num).id]
        );
      } else {
        // INSERT nuevo periodo (dias_tomados=0)
        await client.query(
          `INSERT INTO fac_vacaciones_periodos(empleado_id, num_periodo, dias_correspondientes, dias_tomados, notas)
           VALUES($1,$2,$3,0,$4)`,
          [empId, num, dc, not]
        );
      }
    }

    // DELETE periodos que ya no se enviaron (solo si no tienen solicitudes asociadas)
    for (const [num, per] of porNum) {
      if (numsEnviados.has(num)) continue;
      const uso = await client.query(
        `SELECT COUNT(*)::int AS n FROM fac_vacaciones_solicitud_periodos WHERE periodo_id=$1`,
        [per.id]
      );
      if (uso.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `No se puede eliminar el periodo ${num}° porque tiene solicitudes vacacionales aplicadas. Elimina las solicitudes primero.`
        });
      }
      await client.query(`DELETE FROM fac_vacaciones_periodos WHERE id=$1`, [per.id]);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── CREAR SOLICITUD ──
// Alta de solicitud. Se extrae a funcion con nombre porque el autoservicio la
// reutiliza: asi el reparto de dias por periodo vive en un solo lugar.
//
// La RUTA exige permiso de captura porque da de alta a nombre de OTRO: sin eso,
// cualquier usuario con sesion podia crear vacaciones ya aprobadas para quien
// quisiera. El autoservicio (/mis-solicitudes) no pasa por aqui: llama a la
// funcion directamente, forzando su propio empleado_id.
router.post('/solicitudes', permiso('vacaciones', NIVEL.CAPTURAR),
            (req, res) => crearSolicitud(req, res));

async function crearSolicitud(req, res) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
            fecha_regreso, observaciones, estatus, distribucion, tipo } = req.body;
    if (!empleado_id || !fecha_inicio || !fecha_fin)
      return res.status(400).json({ error: 'Empleado y fechas son requeridas.' });
    const dias = parseFloat(dias_solicitados) || 0;
    if (dias <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Los días solicitados deben ser mayor a 0.' });
    }

    // Tipo de solicitud: vacaciones (default) | permiso_goce | incapacidad
    const tipoSol = ['vacaciones','permiso_goce','incapacidad'].includes(tipo) ? tipo : 'vacaciones';
    const esVacaciones = tipoSol === 'vacaciones';

    // Distribuir días — manual si viene distribucion, o FIFO automática
    // Solo vacaciones consume periodos. Permisos e incapacidades no descuentan.
    // Las vacaciones de quien tiene jefe asignado NO pueden nacer autorizadas:
    // la regla es que no se autorizan sin su visto bueno, y capturarlas ya
    // aprobadas seria la puerta de atras a esa regla. Se mandan a su bandeja.
    let est = estatus || 'aprobada';
    if (esVacaciones && est === 'aprobada' && await jefeDe(empleado_id)) est = 'pendiente';
    let asignaciones = [];
    let resumen = null;
    if (est !== 'rechazada' && esVacaciones) {
      if (Array.isArray(distribucion) && distribucion.length) {
        // Distribución MANUAL: validar que cada periodo pertenece al empleado y tiene pendientes suficientes
        let sumaSolicitada = 0;
        for (const d of distribucion) {
          const usar = parseFloat(d.dias) || 0;
          if (usar <= 0) continue;
          const p = await client.query(
            `SELECT id, num_periodo, dias_correspondientes - dias_tomados AS pendientes
             FROM fac_vacaciones_periodos WHERE id=$1 AND empleado_id=$2`,
            [d.periodo_id, empleado_id]
          );
          if (!p.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Periodo ${d.periodo_id} no encontrado para este empleado.` });
          }
          const pend = parseFloat(p.rows[0].pendientes);
          if (usar > pend + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Periodo ${p.rows[0].num_periodo}° solo tiene ${pend.toFixed(1)} días pendientes, no se pueden aplicar ${usar}.` });
          }
          asignaciones.push({ periodo_id: p.rows[0].id, num_periodo: p.rows[0].num_periodo, dias: +usar.toFixed(2) });
          sumaSolicitada += usar;
        }
        if (Math.abs(sumaSolicitada - dias) > 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `La distribución (${sumaSolicitada.toFixed(1)}) no coincide con los días solicitados (${dias.toFixed(1)}).` });
        }
        resumen = asignaciones.map(a => `${a.dias} día${a.dias!==1?'s':''} del P°${a.num_periodo}`).join(', ');
      } else {
        // Distribución AUTOMÁTICA (FIFO)
        const dist = await distribuirDiasFIFO(client, empleado_id, dias);
        if (!dist.ok) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `No hay días suficientes en los periodos. Faltan ${dist.faltantes.toFixed(1)} día${dist.faltantes!==1?'s':''}. Genera más periodos o ajusta los días.`
          });
        }
        asignaciones = dist.asignaciones;
        resumen = dist.resumen;
      }
    }

    // Insertar solicitud
    const resumenFinal = esVacaciones ? resumen : (tipoSol === 'permiso_goce' ? 'Permiso con goce de sueldo' : 'Incapacidad');
    const r = await client.query(
      `INSERT INTO fac_vacaciones_solicitudes(
         empleado_id, fecha_solicitud, fecha_inicio, fecha_fin, dias_solicitados,
         fecha_regreso, periodos_aplicados, observaciones, estatus, tipo, creado_por
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [empleado_id, fecha_solicitud || new Date(), fecha_inicio, fecha_fin, dias,
       fecha_regreso || null, resumenFinal, observaciones || null, est, tipoSol, req.usuario.id]
    );
    const solId = r.rows[0].id;

    // Aplicar asignaciones: guardar y descontar de cada periodo
    for (const a of asignaciones) {
      await client.query(
        `INSERT INTO fac_vacaciones_solicitud_periodos(solicitud_id, periodo_id, dias_aplicados)
         VALUES($1, $2, $3)`,
        [solId, a.periodo_id, a.dias]
      );
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = dias_tomados + $1, actualizado_en=NOW()
         WHERE id = $2`,
        [a.dias, a.periodo_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...r.rows[0], asignaciones });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
}

// ═══ AUTORIZACIÓN DE SOLICITUDES ════════════════════
// Autorizar es decidir sobre el saldo de otro, no capturar: por eso pide nivel
// Editar y no Capturar.
const autorizaVacaciones = permiso('vacaciones', NIVEL.EDITAR);

// Nadie autoriza lo suyo, ni el administrador. Si se permitiera, el paso de
// autorización no controlaría nada para justamente quien más acceso tiene.
async function noEsMia(req, solicitudId) {
  const mi = await miEmpleadoId(req.usuario.id);
  if (!mi) return true;
  const r = await query(
    `SELECT empleado_id FROM fac_vacaciones_solicitudes WHERE id=$1`, [solicitudId]);
  return !r.rows.length || r.rows[0].empleado_id !== mi;
}

// ── BANDEJA: lo que espera decisión ──
router.get('/solicitudes-pendientes', autorizaVacaciones, async (req, res) => {
  try {
    const mi = await miEmpleadoId(req.usuario.id);
    const r = await query(`
      SELECT s.id, s.empleado_id, s.tipo, s.dias_solicitados, s.observaciones,
             s.periodos_aplicados,
             TO_CHAR(s.fecha_solicitud,'YYYY-MM-DD') AS fecha_solicitud,
             TO_CHAR(s.fecha_inicio,'YYYY-MM-DD')    AS fecha_inicio,
             TO_CHAR(s.fecha_fin,'YYYY-MM-DD')       AS fecha_fin,
             TO_CHAR(s.fecha_regreso,'YYYY-MM-DD')   AS fecha_regreso,
             e.nombre, e.puesto, e.departamento, e.numero_colaborador,
             (SELECT COALESCE(SUM(dias_correspondientes - dias_tomados),0)
                FROM fac_vacaciones_periodos WHERE empleado_id = s.empleado_id) AS le_quedan,
             u.nombre AS capturada_por
        FROM fac_vacaciones_solicitudes s
        JOIN fac_empleados e ON e.id = s.empleado_id
        LEFT JOIN fac_usuarios u ON u.id = s.creado_por
       WHERE s.estatus = 'vo_bo'
         AND ($1::int IS NULL OR s.empleado_id <> $1::int)
       ORDER BY s.fecha_inicio, s.id
    `, [mi]);
    // Las propias se cuentan aparte para poder explicar por qué no salen en la lista
    const propias = mi ? await query(
      `SELECT COUNT(*)::int AS n FROM fac_vacaciones_solicitudes
        WHERE estatus IN ('pendiente','vo_bo') AND empleado_id=$1`, [mi]) : { rows: [{ n: 0 }] };
    res.json({ solicitudes: r.rows, propias_en_espera: propias.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuantas esperan: para el contador del menú. Sin él nadie se entera de que hay
// algo pendiente, y mientras tanto al colaborador le cuenta falta en asistencia.
router.get('/solicitudes-pendientes/conteo', async (req, res) => {
  try {
    // Se replica la decision de permiso(), valvula incluida: mientras las tablas
    // de permisos no existan, ese middleware deja pasar a todos y el contador
    // tiene que coincidir o marcaria cero sobre una bandeja que si abre.
    const perm = await permisosDeUsuario(req.usuario.id, req.usuario.rol);
    if (perm.listo && (perm.niveles.vacaciones ?? 0) < NIVEL.EDITAR)
      return res.json({ n: 0 });
    const mi = await miEmpleadoId(req.usuario.id);
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM fac_vacaciones_solicitudes
        WHERE estatus='vo_bo' AND ($1::int IS NULL OR empleado_id <> $1::int)`, [mi]);
    res.json({ n: r.rows[0].n });
  } catch (e) { res.json({ n: 0 }); }
});

// ══ VISTO BUENO DEL JEFE DIRECTO ════════════════════
// Primer paso del flujo. Lo da el jefe asignado al colaborador, que puede ser
// un usuario sin ningun permiso sobre el modulo de vacaciones: por eso esta
// ruta NO usa autorizaVacaciones, sino que comprueba el parentesco directo.
//
// Se deja pasar tambien a quien administra vacaciones (nivel Administrar) para
// que una solicitud no se quede atorada cuando el jefe esta de vacaciones el
// mismo. Quede quien quede, el nombre que se guarda es el de quien lo dio, y
// ese es el que sale impreso.
async function puedeDarVoBo(req, solicitudId) {
  const r = await query(
    `SELECT s.empleado_id, s.estatus, e.jefe_id, e.nombre
       FROM fac_vacaciones_solicitudes s
       JOIN fac_empleados e ON e.id = s.empleado_id
      WHERE s.id = $1`, [solicitudId]);
  if (!r.rows.length) return { ok: false, code: 404, error: 'Solicitud no encontrada.' };
  const sol = r.rows[0];

  const mi = await miEmpleadoId(req.usuario.id);
  if (mi && sol.empleado_id === mi)
    return { ok: false, code: 403, error: 'No puedes dar el visto bueno a tu propia solicitud.' };

  if (mi && sol.jefe_id && sol.jefe_id === mi) return { ok: true, sol };

  const perm = await permisosDeUsuario(req.usuario.id, req.usuario.rol);
  if (!perm.listo || (perm.niveles.vacaciones ?? 0) >= NIVEL.TODO) return { ok: true, sol };

  return { ok: false, code: 403,
           error: `Solo el jefe directo de ${sol.nombre} puede dar el visto bueno.` };
}

// Lo que espera MI visto bueno: solicitudes de la gente que me reporta.
router.get('/por-visto-bueno', async (req, res) => {
  try {
    const mi = await miEmpleadoId(req.usuario.id);
    if (!mi) return res.json({ solicitudes: [], es_jefe: false });
    const r = await query(`
      SELECT s.*, e.nombre, e.puesto, e.departamento, e.numero_colaborador,
             (SELECT COALESCE(SUM(dias_correspondientes - dias_tomados), 0)
                FROM fac_vacaciones_periodos WHERE empleado_id = s.empleado_id) AS le_quedan
        FROM fac_vacaciones_solicitudes s
        JOIN fac_empleados e ON e.id = s.empleado_id
       WHERE s.estatus = 'pendiente' AND e.jefe_id = $1 AND s.empleado_id <> $1
       ORDER BY s.fecha_inicio, s.id`, [mi]);
    const equipo = await query(
      `SELECT COUNT(*)::int AS n FROM fac_empleados WHERE jefe_id=$1 AND activo IS NOT FALSE`, [mi]);
    res.json({ solicitudes: r.rows, es_jefe: equipo.rows[0].n > 0, a_mi_cargo: equipo.rows[0].n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Contador para el menu del jefe
router.get('/por-visto-bueno/conteo', async (req, res) => {
  try {
    const mi = await miEmpleadoId(req.usuario.id);
    if (!mi) return res.json({ n: 0 });
    const r = await query(
      `SELECT COUNT(*)::int AS n
         FROM fac_vacaciones_solicitudes s
         JOIN fac_empleados e ON e.id = s.empleado_id
        WHERE s.estatus='pendiente' AND e.jefe_id=$1 AND s.empleado_id <> $1`, [mi]);
    // es_jefe va aparte del conteo: quien tiene gente a su cargo necesita entrar
    // a la pantalla aunque hoy no tenga nada pendiente. Sin esto el menu solo se
    // lo muestra a quien su perfil traiga 'misVacaciones', y un jefe suele ser
    // capturista o tesoreria, perfiles que no lo traen.
    const eq = await query(
      `SELECT COUNT(*)::int AS n FROM fac_empleados
        WHERE jefe_id=$1 AND activo IS NOT FALSE`, [mi]);
    res.json({ n: r.rows[0].n, es_jefe: eq.rows[0].n > 0, a_mi_cargo: eq.rows[0].n });
  } catch (e) { res.json({ n: 0, es_jefe: false }); }
});

router.patch('/solicitudes/:id/visto-bueno', async (req, res) => {
  try {
    const permiso = await puedeDarVoBo(req, req.params.id);
    if (!permiso.ok) return res.status(permiso.code).json({ error: permiso.error });
    const r = await query(
      `UPDATE fac_vacaciones_solicitudes
          SET estatus='vo_bo', vobo_por=$1, vobo_en=NOW(), vobo_nota=$2
        WHERE id=$3 AND estatus='pendiente' RETURNING *`,
      [req.usuario.id, (req.body.nota || '').trim() || null, req.params.id]);
    if (!r.rows.length)
      return res.status(400).json({ error: 'Esa solicitud ya no está esperando visto bueno.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTORIZAR ──
// Los días ya se descontaron al crearse la solicitud, así que aquí no se toca el
// saldo: solo cambia el estatus, que es lo que hace que asistencia deje de
// contarle falta.
router.patch('/solicitudes/:id/autorizar', autorizaVacaciones, async (req, res) => {
  try {
    if (!await noEsMia(req, req.params.id))
      return res.status(403).json({ error: 'No puedes autorizar tu propia solicitud. Que la revise alguien más.' });
    const r = await query(
      `UPDATE fac_vacaciones_solicitudes
          SET estatus='aprobada', autorizado_por=$1, autorizado_en=NOW(), nota_autorizacion=$2
        WHERE id=$3 AND estatus='vo_bo' RETURNING *`,
      [req.usuario.id, (req.body.nota || '').trim() || null, req.params.id]);
    if (!r.rows.length) {
      // Distinguir "ya resuelta" de "todavía le falta el jefe": son dos
      // situaciones distintas y la segunda tiene algo que hacer al respecto.
      const q = await query(`SELECT estatus FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
      if (q.rows[0]?.estatus === 'pendiente')
        return res.status(400).json({ error: 'Falta el visto bueno del jefe directo. Hasta entonces no se puede autorizar.' });
      return res.status(400).json({ error: 'Esa solicitud ya fue resuelta o no existe.' });
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RECHAZAR ──
// Devuelve los días a sus periodos. Si no se devolvieran, un "no" le costaría al
// colaborador los mismos días que si se hubiera ido de vacaciones.
const MIN_MOTIVO = 5;
// Rechazar lo puede hacer RH en cualquiera de los dos pasos, y tambien el jefe
// directo mientras la solicitud espera su visto bueno: quien puede aprobar algo
// tiene que poder negarlo, si no el unico camino que se le deja es decir que si.
async function puedeRechazar(req, res, next) {
  const vb = await puedeDarVoBo(req, req.params.id).catch(() => ({ ok: false }));
  if (vb.ok && vb.sol && vb.sol.estatus === 'pendiente') return next();
  return autorizaVacaciones(req, res, next);
}

router.patch('/solicitudes/:id/rechazar', puedeRechazar, async (req, res) => {
  const client = await getClient();
  try {
    const nota = (req.body.nota || '').trim();
    if (nota.length < MIN_MOTIVO)
      return res.status(400).json({ error: 'Escribe el motivo del rechazo. El colaborador tiene que poder leer por qué.' });
    if (!await noEsMia(req, req.params.id))
      return res.status(403).json({ error: 'No puedes rechazar tu propia solicitud.' });

    await client.query('BEGIN');
    const s = await client.query(
      `SELECT id FROM fac_vacaciones_solicitudes
        WHERE id=$1 AND estatus IN ('pendiente','vo_bo') FOR UPDATE`,
      [req.params.id]);
    if (!s.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esa solicitud ya fue resuelta o no existe.' });
    }
    const asig = await client.query(
      `SELECT periodo_id, dias_aplicados FROM fac_vacaciones_solicitud_periodos WHERE solicitud_id=$1`,
      [req.params.id]);
    for (const a of asig.rows) {
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = GREATEST(0, dias_tomados - $1), actualizado_en=NOW()
          WHERE id = $2`, [parseFloat(a.dias_aplicados), a.periodo_id]);
    }
    // Se borra el reparto: los días ya volvieron y dejarlo haría que un segundo
    // rechazo los devolviera otra vez.
    await client.query(`DELETE FROM fac_vacaciones_solicitud_periodos WHERE solicitud_id=$1`, [req.params.id]);
    const r = await client.query(
      `UPDATE fac_vacaciones_solicitudes
          SET estatus='rechazada', autorizado_por=$1, autorizado_en=NOW(), nota_autorizacion=$2
        WHERE id=$3 RETURNING *`,
      [req.usuario.id, nota, req.params.id]);
    await client.query('COMMIT');
    res.json({ ...r.rows[0], dias_devueltos: asig.rows.reduce((a, x) => a + parseFloat(x.dias_aplicados), 0) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ¿Puede ver expedientes ajenos? Se replica la decision de permiso(), valvula
// incluida: mientras las tablas de permisos no existan ese middleware deja pasar
// a todos, y aqui hay que hacer lo mismo o Recursos Humanos se quedaria fuera.
async function vePlantilla(req) {
  const p = await permisosDeUsuario(req.usuario.id, req.usuario.rol);
  if (!p.listo) return true;
  return (p.niveles.vacaciones ?? 0) >= NIVEL.CAPTURAR;
}

// ── GET SOLICITUD ──
// Sin middleware de plantilla: el colaborador tiene que poder abrir la suya para
// imprimirla, y se filtra por dueno aqui dentro. Devuelve tambien empleado y
// periodos para que el formato se arme con una sola llamada; si no, tendria que
// pegarle a /empleados/:id, que es justo el expediente ajeno que no debe ver.
router.get('/solicitudes/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT s.*, e.nombre, e.puesto, e.departamento, e.fecha_ingreso,
             e.numero_colaborador,
             a.nombre  AS autorizante,
             vb.nombre AS vobo_nombre,
             j.nombre  AS jefe_nombre, j.puesto AS jefe_puesto
      FROM fac_vacaciones_solicitudes s
      JOIN fac_empleados e ON e.id = s.empleado_id
      LEFT JOIN fac_usuarios a  ON a.id = s.autorizado_por
      LEFT JOIN fac_usuarios vb ON vb.id = s.vobo_por
      LEFT JOIN fac_empleados j ON j.id = e.jefe_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const sol = r.rows[0];

    if (!await vePlantilla(req)) {
      const mi = await miEmpleadoId(req.usuario.id);
      if (!mi || sol.empleado_id !== mi)
        return res.status(403).json({ error: 'Esa solicitud no es tuya.' });
    }

    const per = await query(
      `SELECT id, num_periodo, dias_correspondientes, dias_tomados,
              (dias_correspondientes - dias_tomados) AS pendientes
         FROM fac_vacaciones_periodos WHERE empleado_id=$1 ORDER BY num_periodo`,
      [sol.empleado_id]);

    // De que periodo salieron los dias de ESTA solicitud. Hace falta para el
    // formato impreso: dias_tomados de cada periodo ya trae descontada esta
    // solicitud (se aplica al crearla), asi que sin este dato no hay forma de
    // reconstruir el saldo que tenia el colaborador ANTES de pedirla, que es lo
    // que espera leer quien firma la hoja.
    const apl = await query(
      `SELECT sp.periodo_id, sp.dias_aplicados, p.num_periodo
         FROM fac_vacaciones_solicitud_periodos sp
         JOIN fac_vacaciones_periodos p ON p.id = sp.periodo_id
        WHERE sp.solicitud_id = $1
        ORDER BY p.num_periodo`,
      [req.params.id]);

    // Dias consumidos por solicitudes POSTERIORES a esta. Sin esto, el formato
    // imprime el saldo de hoy en todas las solicitudes por igual: quien imprime
    // una solicitud de hace tres meses ve los dias que le quedan ahora, no los
    // que le quedaban entonces. Con este dato se reconstruye el saldo al momento
    // de cada solicitud. Se ordena por id porque ese es el orden en que se
    // aplicaron a los periodos.
    // Desglosado POR PERIODO, no solo el total: la tabla del formato imprime los
    // dias tomados de cada periodo, y ese numero tambien tiene que ser el que
    // habia en el momento de esta solicitud. Con el total suelto, la columna
    // seguia mostrando el valor de hoy y no cuadraba con sus propios totales.
    const post = await query(
      `SELECT sp.periodo_id, COALESCE(SUM(sp.dias_aplicados), 0) AS dias
         FROM fac_vacaciones_solicitud_periodos sp
         JOIN fac_vacaciones_solicitudes s2 ON s2.id = sp.solicitud_id
        WHERE s2.empleado_id = $1 AND s2.id > $2
        GROUP BY sp.periodo_id`,
      [sol.empleado_id, req.params.id]);

    res.json({
      ...sol,
      aplicaciones: apl.rows,
      posteriores_por_periodo: post.rows,
      dias_posteriores: post.rows.reduce((a, x) => a + (parseFloat(x.dias) || 0), 0),
      empleado: {
        id: sol.empleado_id, nombre: sol.nombre, puesto: sol.puesto,
        departamento: sol.departamento, numero_colaborador: sol.numero_colaborador,
        fecha_ingreso: sol.fecha_ingreso,
        antiguedad_anios: anios(sol.fecha_ingreso),
        periodos: per.rows
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ELIMINAR SOLICITUD ──
router.delete('/solicitudes/:id', requireRol('admin'), async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Recuperar las asignaciones para revertirlas
    const asig = await client.query(
      `SELECT periodo_id, dias_aplicados FROM fac_vacaciones_solicitud_periodos WHERE solicitud_id=$1`,
      [req.params.id]
    );
    for (const a of asig.rows) {
      await client.query(
        `UPDATE fac_vacaciones_periodos SET dias_tomados = GREATEST(0, dias_tomados - $1), actualizado_en=NOW()
         WHERE id = $2`,
        [parseFloat(a.dias_aplicados), a.periodo_id]
      );
    }
    // ON DELETE CASCADE en fac_vacaciones_solicitud_periodos elimina las asignaciones
    await client.query(`DELETE FROM fac_vacaciones_solicitudes WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, revertidos: asig.rows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
