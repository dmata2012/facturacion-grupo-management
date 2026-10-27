const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');
const { permiso, NIVEL } = require('../middleware/permiso');

// La Lista de Asistencia es su propio módulo: se puede dar a alguien de RH sin
// abrirle el reloj, y capturar notas de justificación exige nivel Editar.
const verAsistencia    = permiso('asistencia', NIVEL.VER);
// El expediente individual es su propio modulo: muestra el detalle de una
// persona, no el panorama del equipo, y se asigna a quien corresponda.
const verExpediente    = permiso('expedienteAsistencia', NIVEL.VER);

// La matriz de asistencia la consumen dos pantallas con alcances distintos:
// la Lista de Asistencia pide toda la plantilla, y el Expediente pide una sola
// persona. Se exige el modulo que corresponde al alcance de la consulta, para no
// obligar a dar la lista completa a quien solo debe ver expedientes.
function verMatrizAsistencia(req, res, next) {
  return req.query.empleado_id ? verExpediente(req, res, next)
                               : verAsistencia(req, res, next);
}
const editarAsistencia = permiso('asistencia', NIVEL.EDITAR);

router.use(verificarToken);

// Migración idempotente: columna tolerancia_min en empleados (default 0)
(async () => {
  try {
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS tolerancia_min INT DEFAULT 0`);
    // Monto del bono de puntualidad, por persona: distintos puestos suelen traer
    // distinto bono, y un solo monto global obligaria a inventar excepciones.
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS bono_puntualidad NUMERIC(12,2) DEFAULT 0`);
    // Horario distinto por dia de la semana. Antes habia un solo par de horas para
    // toda la semana, asi que a quien sale antes el sabado se le calculaba retardo
    // y jornada contra un horario que ese dia no era el suyo.
    // Forma: { "1": {"e":"09:00","s":"18:00"}, "6": {"e":"09:00","s":"14:00"}, "0": null }
    // La llave es el dia (0=domingo). null significa descanso. Un dia ausente cae
    // al horario general de siempre, para no obligar a reconfigurar a nadie.
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS horario_semanal JSONB`);
    // Fecha de baja. Los dias posteriores no son falta ni descanso pagado:
    // simplemente no aplican, y el reporte de nomina tiene que poder decirlo.
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS fecha_baja DATE`);
  } catch (e) { console.warn('Migración tolerancia_min:', e.message); }
})();

// Monto del bono extra semanal al mas puntual. Es uno solo para toda la
// empresa —lo gana una persona por semana—, a diferencia del bono de
// puntualidad normal, que es por persona.
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_config (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        actualizado_por_nombre TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`INSERT INTO fac_config(clave, valor) VALUES('bono_semanal_puntualidad','0')
                 ON CONFLICT (clave) DO NOTHING`);
    // A quien gano la semana pasada se le felicita al marcar entrada. Se anota
    // para que el aviso salga UNA vez: sin esto reaparece cada vez que vuelve a
    // marcar, y deja de significar algo.
    await query(`
      CREATE TABLE IF NOT EXISTS fac_puntualidad_avisos (
        empleado_id INT NOT NULL,
        semana DATE NOT NULL,
        visto_en TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (empleado_id, semana)
      )`);
  } catch (e) { console.warn('Config del bono semanal:', e.message); }
})();

// Migración idempotente: notificaciones dirigidas a colaboradores para mostrar al marcar entrada
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_checador_notificaciones (
        id SERIAL PRIMARY KEY,
        empleado_id INT REFERENCES fac_empleados(id) ON DELETE CASCADE,
        mensaje TEXT NOT NULL,
        prioridad TEXT DEFAULT 'info',
        vence_en DATE,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        activa BOOLEAN DEFAULT TRUE
      )`);
    // Columna 'inicia_en' agregada en una segunda pasada para tablas existentes
    await query(`ALTER TABLE fac_checador_notificaciones ADD COLUMN IF NOT EXISTS inicia_en DATE`);
    await query(`
      CREATE TABLE IF NOT EXISTS fac_checador_notif_vistas (
        notificacion_id INT REFERENCES fac_checador_notificaciones(id) ON DELETE CASCADE,
        empleado_id INT REFERENCES fac_empleados(id) ON DELETE CASCADE,
        vista_en TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (notificacion_id, empleado_id)
      )`);
  } catch (e) { console.warn('Migración notificaciones:', e.message); }
})();

// ══ HORARIO DEL EMPLEADO ═════════════════════════════
// dias_descanso se guarda como texto ("0,6"), pero varias pantallas lo leian con
// Array.isArray, que siempre daba falso: quien descansaba sabado y domingo veia el
// sabado marcado como falta. Se normaliza en un solo lugar.
function diasDescansoDe(emp) {
  const d = emp && emp.dias_descanso;
  const lista = Array.isArray(d)
    ? d.map(Number)
    : String(d == null ? '' : d).split(',').map(x => x.trim()).filter(x => x !== '').map(Number);
  const limpia = lista.filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return limpia.length ? limpia : [0];   // sin configurar: domingo, como marca la LFT
}

// Que horario le toca a este empleado ese dia. Devuelve siempre la misma forma,
// venga del horario por dia o del general, para que quien lo use no tenga que
// preguntar de donde salio.
function horarioDelDia(emp, dow) {
  const hs = emp && emp.horario_semanal;
  if (hs && typeof hs === 'object' && Object.prototype.hasOwnProperty.call(hs, String(dow))) {
    const d = hs[String(dow)];
    if (!d || !d.e) return { descansa: true, entrada: null, salida: null };
    return { descansa: false, entrada: d.e, salida: d.s || null };
  }
  return {
    descansa: diasDescansoDe(emp).includes(dow),
    entrada: emp?.hora_entrada_esperada || null,
    salida:  emp?.hora_salida_esperada  || null
  };
}

// Dias en los que no habia relacion laboral. Se compara como texto porque las
// fechas ya vienen normalizadas a 'YYYY-MM-DD', que ordena igual que la fecha.
function fueraDeRelacion(emp, fechaISO) {
  if (!emp) return false;
  if (emp.fecha_ingreso && fechaISO < emp.fecha_ingreso) return true;
  if (emp.fecha_baja    && fechaISO > emp.fecha_baja)    return true;
  return false;
}

// Minutos desde medianoche, tolerando '09:00' y '09:00:00'
function minutosDe(hora) {
  if (!hora) return null;
  const p = String(hora).slice(0, 5).split(':');
  const h = parseInt(p[0]), m = parseInt(p[1]);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
}

// Minutos de jornada de ese dia; 0 si descansa
function jornadaDelDia(emp, dow) {
  const h = horarioDelDia(emp, dow);
  if (h.descansa) return 0;
  const e = minutosDe(h.entrada), sal = minutosDe(h.salida);
  return (e == null || sal == null) ? 0 : Math.max(0, sal - e);
}

// Helper: obtener notificaciones pendientes para un empleado (no vistas y activas)
async function notificacionesPendientes(empleadoId) {
  const r = await query(`
    SELECT n.id, n.mensaje, n.prioridad, TO_CHAR(n.creado_en,'YYYY-MM-DD HH24:MI') AS creado_en,
           u.nombre AS de
    FROM fac_checador_notificaciones n
    LEFT JOIN fac_usuarios u ON u.id = n.creado_por
    WHERE n.activa = TRUE
      AND (n.inicia_en IS NULL OR n.inicia_en <= CURRENT_DATE)
      AND (n.vence_en  IS NULL OR n.vence_en  >= CURRENT_DATE)
      AND (n.empleado_id IS NULL OR n.empleado_id = $1)
      AND NOT EXISTS (
        SELECT 1 FROM fac_checador_notif_vistas v
        WHERE v.notificacion_id = n.id AND v.empleado_id = $1
      )
    ORDER BY
      CASE n.prioridad WHEN 'urgente' THEN 1 WHEN 'importante' THEN 2 ELSE 3 END,
      n.creado_en DESC
  `, [empleadoId]);
  return r.rows;
}

// GET /api/checador/notificaciones — listado admin
router.get('/notificaciones', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const r = await query(`
      SELECT n.*, TO_CHAR(n.creado_en,'YYYY-MM-DD HH24:MI') AS creado_en_str,
             TO_CHAR(n.inicia_en,'YYYY-MM-DD') AS inicia_en_str,
             TO_CHAR(n.vence_en, 'YYYY-MM-DD') AS vence_en_str,
             e.nombre AS empleado_nombre, u.nombre AS creado_por_nombre,
             (SELECT COUNT(*) FROM fac_checador_notif_vistas v WHERE v.notificacion_id=n.id)::int AS n_vistas,
             CASE
               WHEN n.activa = FALSE THEN 'pausada'
               WHEN n.inicia_en IS NOT NULL AND n.inicia_en > CURRENT_DATE THEN 'programada'
               WHEN n.vence_en  IS NOT NULL AND n.vence_en  < CURRENT_DATE THEN 'vencida'
               ELSE 'activa'
             END AS estado_actual
      FROM fac_checador_notificaciones n
      LEFT JOIN fac_empleados e ON e.id = n.empleado_id
      LEFT JOIN fac_usuarios  u ON u.id = n.creado_por
      ORDER BY n.creado_en DESC
      LIMIT 200
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/checador/notificaciones — crear
router.post('/notificaciones', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { empleado_id, mensaje, prioridad, inicia_en, vence_en } = req.body;
    if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'Mensaje requerido.' });
    const pri = ['info','importante','urgente'].includes(prioridad) ? prioridad : 'info';
    if (inicia_en && vence_en && inicia_en > vence_en) {
      return res.status(400).json({ error: 'La fecha de inicio debe ser menor o igual a la de vencimiento.' });
    }
    const r = await query(
      `INSERT INTO fac_checador_notificaciones(empleado_id, mensaje, prioridad, inicia_en, vence_en, creado_por)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [empleado_id || null, mensaje.trim(), pri, inicia_en || null, vence_en || null, req.usuario.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/checador/notificaciones/:id — activar/desactivar
router.put('/notificaciones/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const { activa } = req.body;
    await query(`UPDATE fac_checador_notificaciones SET activa=$1 WHERE id=$2`, [!!activa, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/checador/notificaciones/:id
router.delete('/notificaciones/:id', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_checador_notificaciones WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/checador/notificaciones/:id/vista — marcar como vista por el empleado
router.post('/notificaciones/:id/vista', async (req, res) => {
  try {
    const { empleado_id } = req.body;
    if (!empleado_id) return res.status(400).json({ error: 'empleado_id requerido.' });
    await query(
      `INSERT INTO fac_checador_notif_vistas(notificacion_id, empleado_id)
       VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, empleado_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fórmula de Haversine — distancia en metros entre 2 coords lat/lng
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000; // radio Tierra en metros
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// Migración idempotente: asignación de ubicaciones autorizadas por empleado
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_empleado_ubicaciones (
        empleado_id INT NOT NULL REFERENCES fac_empleados(id) ON DELETE CASCADE,
        ubicacion_id INT NOT NULL REFERENCES fac_checador_ubicaciones(id) ON DELETE CASCADE,
        PRIMARY KEY (empleado_id, ubicacion_id)
      )`);
  } catch (e) { console.warn('Migración fac_empleado_ubicaciones:', e.message); }
})();

// Devuelve la ubicación autorizada más cercana para un empleado.
// Si el empleado tiene ubicaciones asignadas explícitamente, solo esas cuentan.
// Si NO tiene asignaciones, se permiten TODAS las ubicaciones activas (backward compatible).
async function ubicacionCercana(lat, lng, empleadoId) {
  if (lat == null || lng == null) return null;
  let ubis;
  if (empleadoId) {
    const asig = await query(
      `SELECT u.* FROM fac_checador_ubicaciones u
       JOIN fac_empleado_ubicaciones eu ON eu.ubicacion_id = u.id
       WHERE u.activo = TRUE AND eu.empleado_id = $1`,
      [empleadoId]
    );
    ubis = asig.rows.length
      ? { rows: asig.rows }
      : await query(`SELECT * FROM fac_checador_ubicaciones WHERE activo=TRUE`);
  } else {
    ubis = await query(`SELECT * FROM fac_checador_ubicaciones WHERE activo=TRUE`);
  }
  let mejor = null;
  for (const u of ubis.rows) {
    const d = distanciaMetros(lat, lng, parseFloat(u.latitud), parseFloat(u.longitud));
    if (d <= u.radio_metros && (!mejor || d < mejor.distancia)) {
      mejor = { id: u.id, nombre: u.nombre, distancia: d };
    }
  }
  return mejor;
}

// Permiso individual para marcar fuera de las ubicaciones autorizadas, y marca en
// el registro de cuando se ejercio. Pensado para quien trabaja en campo; el
// registro queda señalado para que no se confunda con una asistencia normal.
(async () => {
  try {
    await query(`ALTER TABLE fac_empleados ADD COLUMN IF NOT EXISTS checa_fuera_ubicacion BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE fac_reloj_checador ADD COLUMN IF NOT EXISTS fuera_ubicacion_entr BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE fac_reloj_checador ADD COLUMN IF NOT EXISTS fuera_ubicacion_sal  BOOLEAN DEFAULT FALSE`);
  } catch (e) { console.warn('Migración fuera de ubicación:', e.message); }
})();

// Explica POR QUÉ no se pudo validar la ubicación. Sin esto, "estás fuera del
// área" no distingue entre estar a 30 metros del radio, no tener ninguna
// ubicación registrada en el sistema, o tener asignada una sucursal equivocada.
async function porQueFueraDeUbicacion(lat, lng, empleadoId) {
  const asignadas = await query(
    `SELECT u.* FROM fac_checador_ubicaciones u
     JOIN fac_empleado_ubicaciones eu ON eu.ubicacion_id = u.id
     WHERE u.activo = TRUE AND eu.empleado_id = $1`, [empleadoId]);
  const todas = await query(`SELECT * FROM fac_checador_ubicaciones WHERE activo = TRUE`);

  if (!todas.rows.length)
    return 'No hay ninguna ubicación registrada en el sistema. Pide a Recursos Humanos que dé de alta la ubicación de trabajo, o que desactive la validación por GPS.';

  const evaluadas = asignadas.rows.length ? asignadas.rows : todas.rows;
  let cerca = null;
  for (const u of evaluadas) {
    const d = distanciaMetros(lat, lng, parseFloat(u.latitud), parseFloat(u.longitud));
    if (!cerca || d < cerca.d) cerca = { d, nombre: u.nombre, radio: u.radio_metros };
  }

  const alcance = asignadas.rows.length
    ? `Solo puedes marcar en ${asignadas.rows.length === 1 ? 'la ubicación que tienes asignada' : `tus ${asignadas.rows.length} ubicaciones asignadas`}.`
    : 'No tienes ubicaciones asignadas, así que se validó contra todas las registradas.';

  return `Estás a ${Math.round(cerca.d)} m de "${cerca.nombre}", que admite hasta ${cerca.radio} m. ${alcance}`;
}

// PATCH /api/checador/empleados/:id/fuera-ubicacion — permitir marcar fuera del área
router.patch('/empleados/:id/fuera-ubicacion',
  requireRol('admin', 'gerente', 'capturista'), async (req, res) => {
  try {
    await query(`UPDATE fac_empleados SET checa_fuera_ubicacion=$1 WHERE id=$2`,
      [req.body.permitir === true, req.params.id]);
    res.json({ ok: true, permitir: req.body.permitir === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/empleados/:id/ubicaciones — obtener ubicaciones asignadas
async function _getEmpUbicaciones(empId) {
  const r = await query(
    `SELECT ubicacion_id FROM fac_empleado_ubicaciones WHERE empleado_id=$1`,
    [empId]
  );
  return r.rows.map(x => x.ubicacion_id);
}

// Config global: validar ubicación obligatoria
async function validarUbicacionRequerida() {
  const r = await query(`SELECT valor FROM fac_checador_config WHERE clave='validar_ubicacion'`);
  return r.rows[0]?.valor === 'true';
}

// ══ UBICACIONES AUTORIZADAS ══
router.get('/ubicaciones', async (req, res) => {
  try {
    const [ubis, cfg] = await Promise.all([
      query(`SELECT * FROM fac_checador_ubicaciones ORDER BY activo DESC, nombre`),
      query(`SELECT valor FROM fac_checador_config WHERE clave='validar_ubicacion'`)
    ]);
    res.json({
      ubicaciones: ubis.rows,
      validar_ubicacion: cfg.rows[0]?.valor === 'true'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ubicaciones', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, latitud, longitud, radio_metros } = req.body;
    if (!nombre || latitud == null || longitud == null)
      return res.status(400).json({ error: 'Nombre, latitud y longitud requeridos.' });
    const r = await query(
      `INSERT INTO fac_checador_ubicaciones(nombre, latitud, longitud, radio_metros)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [nombre.trim(), parseFloat(latitud), parseFloat(longitud), parseInt(radio_metros)||100]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ubicaciones/:id', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, latitud, longitud, radio_metros, activo } = req.body;
    await query(
      `UPDATE fac_checador_ubicaciones SET nombre=$1, latitud=$2, longitud=$3, radio_metros=$4, activo=$5
       WHERE id=$6`,
      [nombre.trim(), parseFloat(latitud), parseFloat(longitud), parseInt(radio_metros)||100,
       activo !== false, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/ubicaciones/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_checador_ubicaciones WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/empleados/:id/ubicaciones — devuelve ids de ubicaciones asignadas
router.get('/empleados/:id/ubicaciones', async (req, res) => {
  try {
    const ids = await _getEmpUbicaciones(req.params.id);
    res.json({ ubicacion_ids: ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/checador/empleados/:id/ubicaciones — reemplaza el conjunto asignado
// Body: { ubicacion_ids: [1,2,3] }  (array vacío = quitar todas las restricciones)
router.put('/empleados/:id/ubicaciones', requireRol('admin', 'capturista'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ubicacion_ids) ? req.body.ubicacion_ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    await query(`DELETE FROM fac_empleado_ubicaciones WHERE empleado_id=$1`, [req.params.id]);
    for (const uid of ids) {
      await query(
        `INSERT INTO fac_empleado_ubicaciones(empleado_id, ubicacion_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.id, uid]
      );
    }
    res.json({ ok: true, count: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Config global — validación obligatoria
router.put('/config', requireRol('admin'), async (req, res) => {
  try {
    const { validar_ubicacion } = req.body;
    await query(
      `INSERT INTO fac_checador_config(clave, valor) VALUES('validar_ubicacion',$1)
       ON CONFLICT(clave) DO UPDATE SET valor=$1`,
      [validar_ubicacion ? 'true' : 'false']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/hoy — registros del día + colaboradores en vacaciones
router.get('/hoy', async (req, res) => {
  try {
    const { fecha } = req.query;
    const f = fecha || new Date().toISOString().slice(0,10);
    const r = await query(`
      SELECT r.id, r.empleado_id, r.fecha, r.hora_entrada, r.hora_salida,
        r.minutos_trabajados, r.minutos_retardo, r.notas,
        r.lat_entrada, r.lng_entrada, r.lat_salida, r.lng_salida,
        r.ubicacion_id_entr, r.ubicacion_id_sal, r.distancia_entr_mts, r.distancia_sal_mts,
        ue.nombre AS ubicacion_entrada,
        us.nombre AS ubicacion_salida,
        (r.foto_entrada IS NOT NULL) AS tiene_foto_entrada,
        (r.foto_salida  IS NOT NULL) AS tiene_foto_salida,
        COALESCE(r.fuera_ubicacion_entr, FALSE) AS fuera_ubicacion_entr,
        COALESCE(r.fuera_ubicacion_sal,  FALSE) AS fuera_ubicacion_sal,
        e.nombre, e.puesto, e.departamento, e.numero_colaborador, e.hora_entrada_esperada
      FROM fac_reloj_checador r
      JOIN fac_empleados e ON e.id = r.empleado_id
      LEFT JOIN fac_checador_ubicaciones ue ON ue.id = r.ubicacion_id_entr
      LEFT JOIN fac_checador_ubicaciones us ON us.id = r.ubicacion_id_sal
      WHERE r.fecha = $1
      ORDER BY r.hora_entrada NULLS LAST, e.nombre
    `, [f]);
    // Colaboradores en vacaciones esa fecha
    const vac = await query(`
      SELECT s.empleado_id, e.nombre, e.puesto, e.departamento, e.numero_colaborador,
             s.fecha_inicio, s.fecha_fin, s.dias_solicitados
      FROM fac_vacaciones_solicitudes s
      JOIN fac_empleados e ON e.id = s.empleado_id
      WHERE s.estatus = 'aprobada'
        AND $1::date BETWEEN s.fecha_inicio AND s.fecha_fin
      ORDER BY e.nombre
    `, [f]);
    res.json({ fecha: f, registros: r.rows, vacaciones: vac.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/reporte — reporte por rango + empleado (marca días de vacaciones)
router.get('/reporte', async (req, res) => {
  try {
    const { empleado_id, desde, hasta } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (empleado_id) { params.push(empleado_id); where += ` AND r.empleado_id=$${params.length}`; }
    if (desde) { params.push(desde); where += ` AND r.fecha>=$${params.length}`; }
    if (hasta) { params.push(hasta); where += ` AND r.fecha<=$${params.length}`; }

    // Marca en_vacaciones si la fecha del registro cae dentro de una solicitud aprobada
    const r = await query(`
      SELECT r.id, r.empleado_id, r.fecha, r.hora_entrada, r.hora_salida,
        r.minutos_trabajados, r.minutos_retardo, r.notas,
        r.lat_entrada, r.lng_entrada, r.lat_salida, r.lng_salida,
        r.distancia_entr_mts, r.distancia_sal_mts,
        ue.nombre AS ubicacion_entrada,
        us.nombre AS ubicacion_salida,
        (r.foto_entrada IS NOT NULL) AS tiene_foto_entrada,
        (r.foto_salida  IS NOT NULL) AS tiene_foto_salida,
        e.nombre, e.puesto, e.departamento, e.numero_colaborador,
        EXISTS (
          SELECT 1 FROM fac_vacaciones_solicitudes s
          WHERE s.empleado_id = r.empleado_id
            AND s.estatus = 'aprobada'
            AND r.fecha BETWEEN s.fecha_inicio AND s.fecha_fin
        ) AS en_vacaciones
      FROM fac_reloj_checador r
      JOIN fac_empleados e ON e.id = r.empleado_id
      LEFT JOIN fac_checador_ubicaciones ue ON ue.id = r.ubicacion_id_entr
      LEFT JOIN fac_checador_ubicaciones us ON us.id = r.ubicacion_id_sal
      ${where}
      ORDER BY r.fecha DESC, e.nombre
    `, params);

    // Totales
    const totales = r.rows.reduce((acc, x) => {
      acc.total_dias++;
      acc.total_minutos    += parseInt(x.minutos_trabajados||0);
      acc.total_retardo    += parseInt(x.minutos_retardo||0);
      if (x.hora_entrada && !x.hora_salida) acc.sin_salida++;
      if (x.en_vacaciones) acc.dias_vacaciones++;
      return acc;
    }, { total_dias:0, total_minutos:0, total_retardo:0, sin_salida:0, dias_vacaciones:0 });

    res.json({ registros: r.rows, totales });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Migración idempotente: tabla de overrides/notas manuales por celda
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_asistencia_ajustes (
        id SERIAL PRIMARY KEY,
        empleado_id INT NOT NULL REFERENCES fac_empleados(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        codigo TEXT,
        notas TEXT,
        creado_por INT,
        actualizado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE(empleado_id, fecha)
      )`);
  } catch (e) { console.warn('Migración ajustes asistencia:', e.message); }
})();

// Historial de cambios de incidencia. La nota obligatoria no sirve de nada si
// se pierde al siguiente cambio: aquí queda quién la cambió, de qué a qué y por qué.
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_asistencia_ajustes_hist (
        id SERIAL PRIMARY KEY,
        empleado_id INT NOT NULL,
        fecha DATE NOT NULL,
        codigo_antes TEXT,
        codigo_despues TEXT,
        notas TEXT,
        hecho_por INT,
        hecho_por_nombre TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_asist_hist ON fac_asistencia_ajustes_hist(empleado_id, fecha)`);
  } catch (e) { console.warn('Migración historial asistencia:', e.message); }
})();

const MIN_NOTA = 5;

// POST /api/checador/asistencia/ajuste — insertar o actualizar override + nota
router.post('/asistencia/ajuste', editarAsistencia, async (req, res) => {
  try {
    const { empleado_id, fecha, codigo, notas, efectivo_antes } = req.body;
    if (!empleado_id || !fecha) return res.status(400).json({ error: 'empleado_id y fecha requeridos.' });
    const cod = (codigo && codigo !== 'auto') ? String(codigo).trim() : null;
    const not = (notas || '').trim() || null;

    const prev = await query(
      `SELECT codigo, notas FROM fac_asistencia_ajustes WHERE empleado_id=$1 AND fecha=$2`,
      [empleado_id, fecha]);
    const overrideAntes = prev.rows[0]?.codigo ?? null;

    // Lo que cambia el registro es el ajuste manual: por eso la nota se exige
    // comparando overrides. Poner "automático" donde ya era automático no cambia nada.
    const cambiaIncidencia = cod !== overrideAntes;

    // Pero para el historial interesa el código que la celda MOSTRABA, no el
    // override. Si la lista decía "F" porque se calculó así, "cómo estaba" es F,
    // no "automático". La pantalla lo manda porque es quien lo tiene a la vista.
    const codAntes = (efectivo_antes && efectivo_antes !== 'auto')
      ? String(efectivo_antes).trim()
      : overrideAntes;

    // Regla: la incidencia solo se cambia explicando por qué. Cambiar solo la
    // nota sí se permite, porque eso es precisamente documentar mejor.
    if (cambiaIncidencia && (!not || not.length < MIN_NOTA))
      return res.status(400).json({
        error: `Para cambiar la incidencia hay que anotar el motivo (al menos ${MIN_NOTA} caracteres). Ej: "Presentó incapacidad IMSS folio 12345".`
      });

    // Solo se borra el registro si no queda nada que conservar. Si hay nota, la
    // fila se mantiene aunque el código vuelva a automático: es la justificación.
    if (!cod && !not) {
      await query(`DELETE FROM fac_asistencia_ajustes WHERE empleado_id=$1 AND fecha=$2`, [empleado_id, fecha]);
      return res.json({ ok: true, deleted: true });
    }

    await query(`
      INSERT INTO fac_asistencia_ajustes(empleado_id, fecha, codigo, notas, creado_por, actualizado_en)
      VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(empleado_id, fecha) DO UPDATE
      SET codigo=EXCLUDED.codigo, notas=EXCLUDED.notas, creado_por=EXCLUDED.creado_por, actualizado_en=NOW()
    `, [empleado_id, fecha, cod, not, req.usuario.id]);

    if (cambiaIncidencia || (not && not !== (prev.rows[0]?.notas ?? null))) {
      await query(`
        INSERT INTO fac_asistencia_ajustes_hist(empleado_id, fecha, codigo_antes, codigo_despues, notas, hecho_por, hecho_por_nombre)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [empleado_id, fecha, codAntes, cod, not, req.usuario.id, req.usuario.nombre]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/asistencia/historial-empleado?empleado_id&desde&hasta
// Todos los cambios de incidencia de un colaborador en el rango. Alimenta el
// expediente individual: la nota justifica el cambio, y sin el historial solo se
// vería la última, perdiendo por qué se movió cada día.
router.get('/asistencia/historial-empleado', verExpediente, async (req, res) => {
  try {
    const { empleado_id, desde, hasta } = req.query;
    if (!empleado_id || !desde || !hasta)
      return res.status(400).json({ error: 'Se requieren empleado_id, desde y hasta.' });
    const r = await query(`
      SELECT TO_CHAR(fecha,'YYYY-MM-DD') AS fecha,
             codigo_antes, codigo_despues, notas,
             hecho_por_nombre, creado_en
        FROM fac_asistencia_ajustes_hist
       WHERE empleado_id = $1 AND fecha BETWEEN $2::date AND $3::date
       ORDER BY fecha, creado_en`, [empleado_id, desde, hasta]);

    // Los ajustes anteriores al historial no dejaron rastro de quién ni cuándo,
    // pero su nota sigue guardada: se incluyen para que el expediente no pierda
    // justificaciones viejas.
    const sinHist = await query(`
      SELECT TO_CHAR(a.fecha,'YYYY-MM-DD') AS fecha, a.codigo AS codigo_despues, a.notas
        FROM fac_asistencia_ajustes a
       WHERE a.empleado_id = $1 AND a.fecha BETWEEN $2::date AND $3::date
         AND NULLIF(TRIM(a.notas),'') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM fac_asistencia_ajustes_hist h
            WHERE h.empleado_id = a.empleado_id AND h.fecha = a.fecha)
       ORDER BY a.fecha`, [empleado_id, desde, hasta]);

    res.json({
      cambios: r.rows,
      sin_historial: sinHist.rows   // notas anteriores a que existiera el rastro
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/asistencia/historial?empleado_id&fecha — quién cambió qué y por qué
router.get('/asistencia/historial', verAsistencia, async (req, res) => {
  try {
    const { empleado_id, fecha } = req.query;
    if (!empleado_id || !fecha) return res.status(400).json({ error: 'empleado_id y fecha requeridos.' });
    const r = await query(`
      SELECT codigo_antes, codigo_despues, notas, hecho_por_nombre, creado_en
        FROM fac_asistencia_ajustes_hist
       WHERE empleado_id=$1 AND fecha=$2
       ORDER BY creado_en DESC LIMIT 20`, [empleado_id, fecha]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/asistencia — matriz de asistencia por rango de fechas
// Codigos por celda:
//   A  = Asistencia (con registro de entrada)
//   F  = Falta (sin registro y no aplica exclusion)
//   V  = Vacaciones (solicitud aprobada tipo='vacaciones')
//   P/G= Permiso con Goce (solicitud aprobada tipo='permiso_goce')
//   In = Incapacidad (solicitud aprobada tipo='incapacidad')
//   D  = Dia de descanso (segun empleado)
//   -  = Sin datos (empleado inactivo o fuera de rango)
// La matriz de asistencia la consumen la lista, el expediente y el bono de
// puntualidad. Vive en una sola funcion a proposito: si el bono calculara los
// codigos por su cuenta, tarde o temprano diria algo distinto de lo que la lista
// muestra en pantalla, y no habria forma de saber cual de las dos miente.
async function construirMatriz({ desde, hasta, empleado_id, incluir_inactivos }) {
    // Empleados
    const paramsE = [];
    let whereE = incluir_inactivos === 'true' ? '' : 'WHERE activo=TRUE';
    if (empleado_id) {
      paramsE.push(empleado_id);
      whereE = whereE ? `${whereE} AND id=$${paramsE.length}` : `WHERE id=$${paramsE.length}`;
    }
    const empleados = await query(
      `SELECT id, nombre, numero_colaborador, puesto, departamento, dias_descanso, horario_semanal,
              activo, hora_entrada_esperada, hora_salida_esperada,
              TO_CHAR(fecha_ingreso,'YYYY-MM-DD') AS fecha_ingreso,
              TO_CHAR(fecha_baja,'YYYY-MM-DD')    AS fecha_baja,
              COALESCE(bono_puntualidad, 0) AS bono_puntualidad
       FROM fac_empleados ${whereE} ORDER BY nombre`,
      paramsE
    );

    // Registros del reloj en el rango — fecha casteada a TEXT para evitar problemas de TZ
    const regs = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, hora_entrada, hora_salida, minutos_retardo
       FROM fac_reloj_checador
       WHERE fecha BETWEEN $1::date AND $2::date`,
      [desde, hasta]
    );

    // Solicitudes aprobadas que caen dentro del rango
    const sols = await query(
      `SELECT empleado_id,
              TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
              TO_CHAR(fecha_fin,'YYYY-MM-DD')    AS fecha_fin,
              COALESCE(tipo,'vacaciones') AS tipo
       FROM fac_vacaciones_solicitudes
       WHERE estatus = 'aprobada'
         AND daterange(fecha_inicio, fecha_fin, '[]') && daterange($1::date, $2::date, '[]')`,
      [desde, hasta]
    );

    // Ajustes/overrides manuales del rango. Se trae también el código que tenía
    // antes del último cambio, para poder mostrar de qué a qué se movió.
    const ajus = await query(
      `SELECT a.empleado_id, TO_CHAR(a.fecha,'YYYY-MM-DD') AS fecha, a.codigo, a.notas,
              h.codigo_antes, h.hecho_por_nombre, h.creado_en AS cambiado_en
         FROM fac_asistencia_ajustes a
         LEFT JOIN LATERAL (
           SELECT codigo_antes, hecho_por_nombre, creado_en
             FROM fac_asistencia_ajustes_hist x
            WHERE x.empleado_id = a.empleado_id AND x.fecha = a.fecha
            ORDER BY x.creado_en DESC LIMIT 1
         ) h ON TRUE
        WHERE a.fecha BETWEEN $1::date AND $2::date`,
      [desde, hasta]
    );

    // Quincenas de nomina que se cruzan con el rango consultado. Sus incidencias
    // generales se imprimen al pie de la lista: es informacion del periodo, no de
    // una celda, y hoy se capturaba en Nomina sin llegar nunca a este reporte.
    let quincenas = [];
    try {
      const qz = await query(`
        SELECT quincena,
               TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
               TO_CHAR(fecha_fin,'YYYY-MM-DD')    AS fecha_fin,
               estatus, notas
          FROM fac_nomina_quincenas
         WHERE fecha_inicio <= $2::date AND fecha_fin >= $1::date
           AND NULLIF(TRIM(notas),'') IS NOT NULL
         ORDER BY fecha_inicio
      `, [desde, hasta]);
      quincenas = qz.rows;
    } catch (e) { quincenas = []; }

    // Generar lista de dias
    const dias = [];
    const d0 = new Date(desde+'T12:00:00');
    const d1 = new Date(hasta+'T12:00:00');
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)) {
      dias.push(d.toISOString().slice(0,10));
    }

    // Indexar registros (fecha ya viene como string 'YYYY-MM-DD' via TO_CHAR)
    const regByEmpDia = {};
    regs.rows.forEach(r => {
      if (!regByEmpDia[r.empleado_id]) regByEmpDia[r.empleado_id] = {};
      regByEmpDia[r.empleado_id][r.fecha] = r;
    });
    // Solicitudes: expandir cada rango a las fechas cubiertas
    // Usar aritmética de string en lugar de Date para evitar problemas de TZ
    const addDayStr = (isoStr) => {
      const [y,m,d] = isoStr.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m-1, d));
      dt.setUTCDate(dt.getUTCDate()+1);
      return dt.toISOString().slice(0,10);
    };
    const solByEmpDia = {};
    sols.rows.forEach(s => {
      let cur = s.fecha_inicio;
      while (cur <= s.fecha_fin) {
        if (!solByEmpDia[s.empleado_id]) solByEmpDia[s.empleado_id] = {};
        solByEmpDia[s.empleado_id][cur] = s.tipo;
        cur = addDayStr(cur);
      }
    });
    // Ajustes manuales
    const ajusByEmpDia = {};
    ajus.rows.forEach(a => {
      if (!ajusByEmpDia[a.empleado_id]) ajusByEmpDia[a.empleado_id] = {};
      // Se guarda la fila completa: aquí se quedaban fuera codigo_antes,
      // hecho_por_nombre y cambiado_en, que es justo para lo que la consulta
      // hace el LATERAL contra el historial. Las celdas los leían como
      // undefined, así que las columnas "Lo cambió / Cuándo" del Excel de
      // asistencia salían siempre vacías.
      ajusByEmpDia[a.empleado_id][a.fecha] = a;
    });

    const codigoTipoSolicitud = { vacaciones:'V', permiso_goce:'P/G',
                                  permiso_sin_goce:'P/S', incapacidad:'In' };

    // Fecha de hoy (server) para no marcar F en fechas futuras
    const hoyISO = new Date().toISOString().slice(0,10);
    // Construir matriz
    const matriz = empleados.rows.map(e => {
      // Default LFT: domingo es dia de descanso obligatorio si no hay config
      // El descanso ya no es una lista fija: cada dia se pregunta por separado,
      // porque el horario semanal puede marcar descanso solo en algunos.
      const celdas = {};
      const totales = { A:0, F:0, FJ:0, V:0, 'P/G':0, 'P/S':0, In:0, D:0, R:0 };
      let minutosRetardoTotal = 0;
      dias.forEach(fecha => {
        const dow = new Date(fecha+'T12:00:00').getDay(); // 0=Dom .. 6=Sab
        const sol = solByEmpDia[e.id]?.[fecha];
        const reg = regByEmpDia[e.id]?.[fecha];
        const aj  = ajusByEmpDia[e.id]?.[fecha];
        const esFutura = fecha > hoyISO;
        // Lo que el sistema calcula por sí solo, sin considerar ajustes manuales.
        // Se guarda aparte para poder decir de qué se corrigió una celda sin
        // depender del historial: así también aplica a los ajustes viejos.
        let codAuto;
        if (reg && reg.hora_entrada) codAuto = 'A';
        else if (fueraDeRelacion(e, fecha)) codAuto = '';  // antes del ingreso o despues de la baja
        else if (sol) codAuto = codigoTipoSolicitud[sol] || 'V';
        else if (horarioDelDia(e, dow).descansa) codAuto = 'D';
        else if (esFutura) codAuto = '';   // fecha futura sin registro: no es falta
        else codAuto = 'F';

        // Prioridad: override manual > lo calculado
        const cod = (aj && aj.codigo) ? aj.codigo : codAuto;

        // Retardo: solo aplica si asistió. Ya viene descontada la tolerancia
        // del colaborador desde el registro de entrada.
        const minRet = parseInt(reg?.minutos_retardo) || 0;
        const conRetardo = cod === 'A' && minRet > 0;
        if (conRetardo) { totales.R++; minutosRetardoTotal += minRet; }

        celdas[fecha] = { c: cod, n: aj?.notas || null };
        if (conRetardo) { celdas[fecha].r = minRet; }   // minutos de retardo del día
        // Checo entrada pero nunca salida: no se sabe si completo la jornada.
        // Nomina necesita verlo antes de pagar el dia como normal.
        if (reg && reg.hora_entrada && !reg.hora_salida) celdas[fecha].ss = 1;
        // Rastro del cambio manual. "Cómo estaba" es el código que el sistema
        // había calculado, no la etiqueta "automático": es lo que hace falta
        // para entender de qué se corrigió la celda. Se prefiere el del
        // historial —que registra el estado real al momento del cambio— y se cae
        // al calculado, que siempre existe aunque el ajuste sea anterior al
        // historial o los registros hayan cambiado después.
        if (aj?.notas || aj?.codigo) {
          celdas[fecha].a  = aj.codigo_antes || codAuto || null;  // cómo estaba
          celdas[fecha].qp = aj.hecho_por_nombre || null;         // quién lo cambió
          celdas[fecha].cf = aj.cambiado_en || null;              // cuándo
        }
        if (totales[cod] !== undefined) totales[cod]++;
      });
      return {
        empleado_id: e.id,
        nombre: e.nombre,
        numero_colaborador: e.numero_colaborador,
        puesto: e.puesto,
        departamento: e.departamento,
        fecha_ingreso: e.fecha_ingreso,
        fecha_baja: e.fecha_baja,
        activo: e.activo,
        sin_horario: !e.horario_semanal && !e.hora_entrada_esperada,
        bono_puntualidad: e.bono_puntualidad,
        celdas,
        totales,
        minutos_retardo: minutosRetardoTotal
      };
    });

    return { desde, hasta, dias, empleados: matriz, incidencias_nomina: quincenas };
}

// ══ MI ASISTENCIA ════════════════════════════════════
// Lo que el colaborador ve de si mismo. El empleado sale de la sesion y nunca del
// parametro: aunque alguien cambie la peticion a mano, no puede pedir a otro.
//
// Usa la misma matriz que la Lista de Asistencia, asi que lo que ve aqui es
// exactamente lo que ve Recursos Humanos, correcciones incluidas. Si tuviera su
// propio calculo, tarde o temprano diria algo distinto y no habria forma de saber
// cual de los dos manda.
router.get('/mi-asistencia', async (req, res) => {
  try {
    const u = await query(`SELECT empleado_id FROM fac_usuarios WHERE id=$1`, [req.usuario.id]);
    const empId = u.rows[0]?.empleado_id;
    if (!empId) return res.json({ vinculado: false });

    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Indica el periodo.' });

    const m = await construirMatriz({ desde, hasta, empleado_id: empId });
    const yo = m.empleados[0];
    if (!yo) return res.json({ vinculado: false });

    // Como va el bono del periodo. Se dice si lo gana o no, sin el importe: eso es
    // dato de sueldo y vive en su propio modulo con su propio permiso.
    const retardos = [], ausencias = [];
    let diasTrabajados = 0;
    m.dias.forEach(f => {
      if (yo.fecha_ingreso && f < yo.fecha_ingreso) return;
      const c = yo.celdas[f];
      if (!c || !c.c || c.c === 'D') return;
      if (c.c === 'A') { diasTrabajados++; if (c.r) retardos.push({ fecha: f, minutos: c.r }); return; }
      ausencias.push({ fecha: f, codigo: c.c });
    });

    res.json({
      vinculado: true,
      desde, hasta, dias: m.dias,
      empleado: { nombre: yo.nombre, puesto: yo.puesto, departamento: yo.departamento,
                  numero_colaborador: yo.numero_colaborador },
      celdas: yo.celdas,
      totales: yo.totales,
      minutos_retardo: yo.minutos_retardo,
      dias_trabajados: diasTrabajados,
      retardos, ausencias,
      bono: { gana: diasTrabajados > 0 && !retardos.length && !ausencias.length,
              sin_actividad: diasTrabajados === 0 && !ausencias.length }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/asistencia', verMatrizAsistencia, async (req, res) => {
  try {
    const { desde, hasta, empleado_id, incluir_inactivos } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta (YYYY-MM-DD).' });
    res.json(await construirMatriz({ desde, hasta, empleado_id, incluir_inactivos }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ BONO DE PUNTUALIDAD Y ASISTENCIA ════════════════
// Se gana solo si en el periodo trabajo todos sus dias laborables y llego a
// tiempo en todos. Cualquier ausencia lo tumba, incluidas vacaciones e
// incapacidad: es un bono de puntualidad Y asistencia, no de puntualidad a secas.
const CODIGOS_QUE_TUMBAN = {
  'F'  : 'falta',
  'FJ' : 'falta justificada',
  'V'  : 'vacaciones',
  'In' : 'incapacidad',
  'P/G': 'permiso con goce',
  'P/S': 'permiso sin goce'
};

// ══ PUNTOS DE PUNTUALIDAD · BONO EXTRA SEMANAL ════════════════
//
// Cada dia laborable gana 1 punto QUIEN REGISTRO ENTRADA MAS TEMPRANO. Se mide
// la hora del reloj tal cual, sin compararla contra el horario de cada quien:
// es la regla que pidio direccion y la mas facil de explicar, porque cualquiera
// puede ver la lista de llegadas y saber quien gano.
//
// Consecuencia a tener presente: si hay turnos distintos, quien entra mas
// temprano lleva ventaja. Poniendo POR_ANTICIPACION en true se cambia a medir
// cuantos minutos antes de SU hora llego cada quien, y entonces compiten todos
// parejo sin importar el turno.
const POR_ANTICIPACION = false;

// De lunes a viernes. El sabado no entra aunque se trabaje: la competencia es
// semanal y cinco dias le dan la misma oportunidad a todos.
const DIAS_DE_LA_COMPETENCIA = [1, 2, 3, 4, 5];

// Lunes de la semana a la que pertenece una fecha.
function lunesDe(fechaISO) {
  const d = new Date(fechaISO + 'T00:00:00');
  const dow = d.getDay();                 // 0 = domingo
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
const sumaDias = (fechaISO, n) => {
  const d = new Date(fechaISO + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// Reparte los puntos del periodo y saca un ganador por semana.
// Recibe la matriz ya construida para no volver a consultar lo mismo.
async function puntosDePuntualidad({ desde, hasta, matriz }) {
  const regs = await query(
    `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, hora_entrada
       FROM fac_reloj_checador
      WHERE fecha BETWEEN $1::date AND $2::date AND hora_entrada IS NOT NULL`,
    [desde, hasta]);

  const porEmpleado = new Map(matriz.empleados.map(e => [e.empleado_id, e]));
  const llegadas = new Map();   // fecha -> [{empleado_id, anticipacion, hora}]
  // Por que se quedo fuera cada registro. Sin esto, cuando nadie compite la
  // pantalla solo puede decir "no hay nada" y no se sabe si es que no hay
  // marcas, si todos llegaron tarde o si falta configurar horarios.
  const descartes = { fin_de_semana: 0, descanso: 0, antes_de_su_alta: 0,
                      sin_horario: 0, llegaron_tarde: 0 };
  const sinHorario = new Set();

  for (const r of regs.rows) {
    const e = porEmpleado.get(r.empleado_id);
    if (!e) continue;
    const d = new Date(r.fecha + 'T00:00:00').getDay();
    if (!DIAS_DE_LA_COMPETENCIA.includes(d)) { descartes.fin_de_semana++; continue; }
    if (e.fecha_ingreso && r.fecha < e.fecha_ingreso) { descartes.antes_de_su_alta++; continue; }

    const h = horarioDelDia(e, d);
    if (h.descansa) { descartes.descanso++; continue; }
    const real = minutosDe(r.hora_entrada);
    if (real === null) continue;

    let valor;
    if (POR_ANTICIPACION) {
      const esperada = minutosDe(h.entrada);
      // Sin hora de entrada configurada no hay con qué comparar: ese
      // colaborador no compite, y hay que decirlo.
      if (esperada === null) {
        descartes.sin_horario++;
        sinHorario.add(e.empleado_id);
        continue;
      }
      valor = esperada - real;                // positivo = llegó antes
      // Llegar tarde no compite, aunque sea el menos tarde de todos.
      if (valor < 0) { descartes.llegaron_tarde++; continue; }
    } else {
      valor = -real;                          // mientras más temprano, más alto
    }
    if (!llegadas.has(r.fecha)) llegadas.set(r.fecha, []);
    llegadas.get(r.fecha).push({ empleado_id: r.empleado_id, valor, hora: String(r.hora_entrada).slice(0, 5) });
  }

  // El punto del día: para el mejor. Si dos empatan al minuto, punto para los dos.
  const dias = [];
  const puntos = new Map();
  const anticipacionTotal = new Map();
  for (const fecha of [...llegadas.keys()].sort()) {
    const lista = llegadas.get(fecha);
    const mejor = Math.max(...lista.map(x => x.valor));
    const ganan = lista.filter(x => x.valor === mejor);
    ganan.forEach(g => puntos.set(g.empleado_id, (puntos.get(g.empleado_id) || 0) + 1));
    lista.forEach(x => anticipacionTotal.set(x.empleado_id,
      (anticipacionTotal.get(x.empleado_id) || 0) + x.valor));
    dias.push({
      fecha, semana: lunesDe(fecha), compitieron: lista.length,
      ganadores: ganan.map(g => ({
        empleado_id: g.empleado_id,
        nombre: porEmpleado.get(g.empleado_id)?.nombre || '',
        hora: g.hora,
        minutos_antes: POR_ANTICIPACION ? g.valor : null
      }))
    });
  }

  // ── El ganador de cada semana ──
  const semanas = [];
  const porSemana = {};
  dias.forEach(d => { (porSemana[d.semana] = porSemana[d.semana] || []).push(d); });

  for (const lunes of Object.keys(porSemana).sort()) {
    const delSemana = porSemana[lunes];
    const pts = new Map(), antic = new Map();
    delSemana.forEach(d => d.ganadores.forEach(g =>
      pts.set(g.empleado_id, (pts.get(g.empleado_id) || 0) + 1)));

    // Para desempatar hace falta la anticipacion de ESA semana, no la del periodo.
    const fechas = new Set(delSemana.map(d => d.fecha));
    for (const [fecha, lista] of llegadas) {
      if (!fechas.has(fecha)) continue;
      lista.forEach(x => antic.set(x.empleado_id, (antic.get(x.empleado_id) || 0) + x.valor));
    }

    // Gana uno solo. Quien tenga falta o retardo en la semana queda fuera: el
    // premio es a la puntualidad de la semana completa, no a un buen lunes.
    const limpio = (empId) => {
      const e = porEmpleado.get(empId);
      if (!e) return false;
      for (let i = 0; i < 5; i++) {
        const f = sumaDias(lunes, i);
        if (f < desde || f > hasta) continue;
        const c = e.celdas?.[f];
        if (!c || !c.c || c.c === 'D') continue;
        if (c.c !== 'A') return false;          // falta, permiso, vacaciones…
        if (c.r) return false;                  // retardo
      }
      return true;
    };

    // Quien junto puntos pero no cierra la semana limpio. Se devuelve aparte
    // para poder explicar por que no gano, en vez de que desaparezca del
    // tablero sin motivo.
    const descalificados = [...pts.entries()]
      .filter(([id]) => !limpio(id))
      .map(([id, n]) => ({ empleado_id: id, nombre: porEmpleado.get(id)?.nombre || '', puntos: n }))
      .sort((a, b) => b.puntos - a.puntos);

    const candidatos = [...pts.entries()]
      .filter(([id]) => limpio(id))
      .map(([id, n]) => ({
        empleado_id: id, nombre: porEmpleado.get(id)?.nombre || '',
        numero_colaborador: porEmpleado.get(id)?.numero_colaborador || null,
        puntos: n, minutos_antes: antic.get(id) || 0
      }))
      // Más puntos; si empatan, más minutos de anticipación en la semana; y si
      // aun así empatan, el número de colaborador, que es estable y no deja el
      // resultado al azar.
      .sort((a, b) => b.puntos - a.puntos
                   || b.minutos_antes - a.minutos_antes
                   || String(a.numero_colaborador).localeCompare(String(b.numero_colaborador)));

    semanas.push({
      desde: lunes, hasta: sumaDias(lunes, 4),
      dias: delSemana,
      tabla: candidatos,
      descalificados,
      ganador: candidatos[0] || null,
      // Si dos quedan iguales hasta el final, se avisa: gana uno, pero conviene
      // que quien paga lo sepa.
      empate: candidatos.length > 1
           && candidatos[0].puntos === candidatos[1].puntos
           && candidatos[0].minutos_antes === candidatos[1].minutos_antes
    });
  }

  return { por_anticipacion: POR_ANTICIPACION, semanas,
           puntos_periodo: Object.fromEntries(puntos),
           dias,
           // Para poder explicar un periodo sin ganadores.
           diagnostico: {
             registros: regs.rows.length,
             descartes,
             sin_horario: [...sinHorario].map(id => ({
               empleado_id: id, nombre: porEmpleado.get(id)?.nombre || '' }))
           } };
}

// ¿Esta persona gano la semana PASADA? Se usa al marcar entrada, para
// felicitarla en el kiosco.
//
// Se revisa la semana anterior completa, no la de hoy: la de hoy apenas va
// empezando y todavia no hay ganador.
//
// El aviso se da una sola vez por semana ganada. No se amarra al lunes: si esa
// persona el lunes descansa o falta, el reconocimiento se perderia. Sale la
// primera vez que vuelve a marcar entrada, que para casi todos es el lunes.
async function felicitacionPendiente(empleadoId, hoyISO) {
  try {
    const lunesEsta = lunesDe(hoyISO);
    const lunesPasada = sumaDias(lunesEsta, -7);
    const viernesPasada = sumaDias(lunesPasada, 4);

    const ya = await query(
      `SELECT 1 FROM fac_puntualidad_avisos WHERE empleado_id=$1 AND semana=$2::date`,
      [empleadoId, lunesPasada]);
    if (ya.rows.length) return null;

    const m = await construirMatriz({ desde: lunesPasada, hasta: viernesPasada });
    const pts = await puntosDePuntualidad({ desde: lunesPasada, hasta: viernesPasada, matriz: m });
    const sem = pts.semanas.find(s => s.desde === lunesPasada);
    if (!sem || !sem.ganador || sem.ganador.empleado_id !== empleadoId) return null;

    // Se marca como visto en cuanto se devuelve: si el kiosco se cierra antes de
    // que lo lean, se pierde, pero es preferible a que reaparezca en cada marca.
    await query(
      `INSERT INTO fac_puntualidad_avisos(empleado_id, semana) VALUES($1,$2::date)
       ON CONFLICT DO NOTHING`, [empleadoId, lunesPasada]);

    // El importe NO viaja: el kiosco esta a la vista de todos y el sueldo de
    // cada quien no se anuncia en una pantalla por la que pasa la oficina.
    // El monto se ve en Bono de Puntualidad, que tiene su propio permiso.
    return {
      semana_desde: lunesPasada, semana_hasta: viernesPasada,
      puntos: sem.ganador.puntos,
      dias: sem.dias.length
    };
  } catch (e) { console.warn('Felicitación de puntualidad:', e.message); return null; }
}

// Modulo propio, no el del Reloj Checador: aqui se ven importes por persona, y
// quien marca entradas o revisa la lista de asistencia no tiene por que verlos.
router.get('/bono-puntualidad', permiso('bonoPuntualidad', NIVEL.VER), async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta (YYYY-MM-DD).' });

    const m = await construirMatriz({ desde, hasta });

    const filas = m.empleados.map(e => {
      const retardos = [];
      const motivos  = [];
      let diasTrabajados = 0, minutosRetardo = 0;

      m.dias.forEach(f => {
        // Antes de su ingreso no habia nada que cumplir: la matriz marca F en
        // esos dias y sin esto un colaborador recien contratado nunca ganaria.
        if (e.fecha_ingreso && f < e.fecha_ingreso) return;
        const c = e.celdas[f];
        if (!c || !c.c) return;      // fecha futura o sin dato
        if (c.c === 'D') return;     // descanso: no se trabaja, no cuenta
        if (c.c === 'A') {
          diasTrabajados++;
          if (c.r) { retardos.push({ fecha: f, minutos: c.r }); minutosRetardo += c.r; }
          return;
        }
        const etiqueta = CODIGOS_QUE_TUMBAN[c.c];
        if (etiqueta) motivos.push({ fecha: f, codigo: c.c, etiqueta, nota: c.n || null });
      });

      // Quien no tuvo un solo dia laborable en el periodo (alta posterior, baja)
      // no gana ni pierde: no hubo asistencia que premiar.
      const sinActividad = diasTrabajados === 0 && motivos.length === 0;
      const gana = !sinActividad && retardos.length === 0 && motivos.length === 0;
      const monto = parseFloat(e.bono_puntualidad || 0);

      return {
        empleado_id: e.empleado_id, nombre: e.nombre, puesto: e.puesto,
        departamento: e.departamento, numero_colaborador: e.numero_colaborador,
        dias_trabajados: diasTrabajados,
        retardos, minutos_retardo: minutosRetardo,
        motivos, sin_actividad: sinActividad,
        gana, monto,
        a_pagar: gana ? monto : 0
      };
    });

    // ── Bono extra al mas puntual de cada semana ──
    // Se suma al bono de siempre, no lo sustituye: quien gana la semana cobra
    // su bono normal MAS el extra.
    const cfg = await query(`SELECT valor FROM fac_config WHERE clave='bono_semanal_puntualidad'`);
    const montoSemanal = Math.max(0, parseFloat(cfg.rows[0]?.valor || 0) || 0);
    const pts = await puntosDePuntualidad({ desde, hasta, matriz: m });

    const porEmp = new Map(filas.map(f => [f.empleado_id, f]));
    filas.forEach(f => {
      f.puntos = 0; f.semanas_ganadas = 0; f.bono_semanal = 0;
    });
    pts.dias.forEach(d => d.ganadores.forEach(g => {
      const f = porEmp.get(g.empleado_id); if (f) f.puntos++;
    }));
    pts.semanas.forEach(sem => {
      if (!sem.ganador) return;
      const f = porEmp.get(sem.ganador.empleado_id);
      if (!f) return;
      f.semanas_ganadas++;
      f.bono_semanal = +(f.bono_semanal + montoSemanal).toFixed(2);
      f.a_pagar = +(f.a_pagar + montoSemanal).toFixed(2);
    });

    const activas = filas.filter(f => !f.sin_actividad);
    res.json({
      desde, hasta, filas,
      semanal: {
        monto: montoSemanal,
        por_anticipacion: pts.por_anticipacion,
        semanas: pts.semanas,
        diagnostico: pts.diagnostico
      },
      resumen: {
        con_derecho : activas.filter(f => f.gana).length,
        sin_derecho : activas.filter(f => !f.gana).length,
        sin_actividad: filas.length - activas.length,
        total_pagar : +filas.reduce((a, f) => a + f.a_pagar, 0).toFixed(2),
        sin_monto   : activas.filter(f => f.gana && !f.monto).length,
        semanas     : pts.semanas.length,
        total_semanal: +(montoSemanal * pts.semanas.filter(x => x.ganador).length).toFixed(2),
        sin_monto_semanal: pts.semanas.some(x => x.ganador) && !montoSemanal
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Monto del bono extra semanal. Es uno solo para toda la empresa: lo gana una
// persona por semana, no depende del puesto.
router.put('/bono-semanal-monto', permiso('bonoPuntualidad', NIVEL.EDITAR), async (req, res) => {
  try {
    const monto = Math.max(0, parseFloat(req.body?.monto) || 0);
    await query(
      `INSERT INTO fac_config(clave, valor, actualizado_por_nombre, actualizado_en)
       VALUES('bono_semanal_puntualidad',$1,$2,NOW())
       ON CONFLICT (clave) DO UPDATE
         SET valor=EXCLUDED.valor, actualizado_por_nombre=EXCLUDED.actualizado_por_nombre,
             actualizado_en=NOW()`,
      [String(monto), req.usuario?.nombre || null]);
    res.json({ ok: true, monto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Puntos de puntualidad de un colaborador, para su propia pantalla de
// asistencia. No devuelve importes: ahi no van.
router.get('/mis-puntos', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta.' });
    // El colaborador sale de la SESION, no de la peticion: recibiendolo por
    // parametro cualquiera podria consultar los puntos —y las horas de
    // llegada— de otra persona.
    const u = await query(`SELECT empleado_id FROM fac_usuarios WHERE id=$1`, [req.usuario.id]);
    const id = u.rows[0]?.empleado_id || null;
    if (!id) return res.json({ vinculado: false, puntos: 0, dias: [], semanas: [], semanas_ganadas: 0 });

    const m = await construirMatriz({ desde, hasta });
    const pts = await puntosDePuntualidad({ desde, hasta, matriz: m });

    const mios = pts.dias.filter(d => d.ganadores.some(g => g.empleado_id === id));
    const semanasGanadas = pts.semanas.filter(x => x.ganador && x.ganador.empleado_id === id);
    res.json({
      desde, hasta,
      puntos: mios.length,
      dias: mios.map(d => ({ fecha: d.fecha,
        hora: d.ganadores.find(g => g.empleado_id === id)?.hora || null,
        minutos_antes: d.ganadores.find(g => g.empleado_id === id)?.minutos_antes ?? null,
        compartido: d.ganadores.length > 1 })),
      semanas_ganadas: semanasGanadas.length,
      semanas: semanasGanadas.map(x => ({ desde: x.desde, hasta: x.hasta, puntos: x.ganador.puntos })),
      // Cuantos puntos repartio el periodo, para saber contra que se compara.
      puntos_del_periodo: pts.dias.length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Monto del bono por colaborador
router.put('/empleados/:id/bono', permiso('bonoPuntualidad', NIVEL.EDITAR), async (req, res) => {
  try {
    const monto = Math.max(0, parseFloat(req.body.bono_puntualidad) || 0);
    await query(`UPDATE fac_empleados SET bono_puntualidad=$1 WHERE id=$2`, [monto, req.params.id]);
    res.json({ ok: true, bono_puntualidad: monto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mismo monto a varios de un golpe. Sin ids explicitos no hace nada: un update
// sin WHERE aqui le cambiaria el bono a toda la plantilla.
router.put('/bono-masivo', permiso('bonoPuntualidad', NIVEL.EDITAR), async (req, res) => {
  try {
    const monto = Math.max(0, parseFloat(req.body.bono_puntualidad) || 0);
    const ids = (req.body.empleados || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Indica a quiénes aplícarselo.' });
    await query(`UPDATE fac_empleados SET bono_puntualidad=$1 WHERE id = ANY($2::int[])`, [monto, ids]);
    res.json({ ok: true, actualizados: ids.length, bono_puntualidad: monto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ INCIDENCIAS PARA NÓMINA ══════════════════════════════════
//
// Lo que Recursos Humanos le entrega al departamento de Nóminas para procesar
// la quincena. No es la cuadrícula de asistencia: es un renglón por persona con
// las cifras que se capturan en el sistema de nómina.
//
// La única garantía de que esas cifras están bien es que CUADREN contra el
// calendario. Cada día del periodo cae en exactamente una bolsa:
//
//   días del periodo = no aplicables + futuros + pagados + no pagados + IMSS
//
// Si un renglón no cuadra, el reporte lo marca y no se deja cerrar. Sin ese
// amarre el reporte es una sugerencia; con él es un documento que se puede
// auditar meses después.

const COD_INC = ['A', 'F', 'FJ', 'V', 'P/G', 'P/S', 'In', 'D'];

const COD_NOMBRE = {
  A:'Asistencia', F:'Falta', FJ:'Falta justificada', V:'Vacaciones',
  'P/G':'Permiso con goce', 'P/S':'Permiso sin goce',
  In:'Incapacidad', D:'Descanso'
};

// Cómo trata nómina cada código. Vive en configuración y no aquí dentro porque
// es política de la empresa, no una regla del sistema: cuando cambie se cambia
// en pantalla y el reporte se recalcula, sin tocar el código.
//
//   paga     la empresa lo paga. Incluye el descanso: es el séptimo día, y por
//            eso una quincena limpia da 16 días a pagar y no 14.
//   no_paga  se descuenta del sueldo
//   imss     lo cubre el IMSS; la empresa no paga esos días
const POLITICA_INC_DEF = {
  trato: { A:'paga', D:'paga', V:'paga', 'P/G':'paga',
           FJ:'no_paga', 'P/S':'no_paga', F:'no_paga', In:'imss' },
  retardos_por_falta: 0,   // 0 = los retardos solo se informan, no descuentan
  toda_plantilla: true     // se manda a todos: si solo van las incidencias,
                           // Nóminas no tiene cómo saber si se omitió a alguien
};

async function politicaInc() {
  const pol = { trato: { ...POLITICA_INC_DEF.trato },
                retardos_por_falta: POLITICA_INC_DEF.retardos_por_falta,
                toda_plantilla: POLITICA_INC_DEF.toda_plantilla };
  try {
    const r = await query(`SELECT valor FROM fac_config WHERE clave='incidencias_politica'`);
    if (!r.rows.length) return pol;
    const g = JSON.parse(r.rows[0].valor || '{}');
    COD_INC.forEach(c => {
      if (['paga', 'no_paga', 'imss'].includes(g?.trato?.[c])) pol.trato[c] = g.trato[c];
    });
    pol.retardos_por_falta = Math.max(0, Math.min(99, parseInt(g.retardos_por_falta) || 0));
    pol.toda_plantilla = g.toda_plantilla !== false;
  } catch (e) { /* configuración ilegible: se usa la de siempre */ }
  return pol;
}

// Consultas de apoyo que dependen de columnas agregadas por otra migración. Si
// el deploy va a medias devuelven vacío en lugar de tumbar todo el reporte.
async function pendientesDeAutorizar(desde, hasta) {
  try {
    const r = await query(`
      SELECT s.id, e.nombre, COALESCE(s.tipo,'vacaciones') AS tipo, s.estatus,
             TO_CHAR(s.fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
             TO_CHAR(s.fecha_fin,'YYYY-MM-DD')    AS fecha_fin
        FROM fac_vacaciones_solicitudes s
        JOIN fac_empleados e ON e.id = s.empleado_id
       WHERE s.estatus IN ('pendiente','vo_bo')
         AND daterange(s.fecha_inicio, s.fecha_fin, '[]') && daterange($1::date, $2::date, '[]')
       ORDER BY s.fecha_inicio, e.nombre`, [desde, hasta]);
    return r.rows;
  } catch (e) { return []; }
}

async function incapacidadesSinFolio(desde, hasta) {
  try {
    const r = await query(`
      SELECT s.id, e.nombre,
             TO_CHAR(s.fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
             TO_CHAR(s.fecha_fin,'YYYY-MM-DD')    AS fecha_fin
        FROM fac_vacaciones_solicitudes s
        JOIN fac_empleados e ON e.id = s.empleado_id
       WHERE s.estatus = 'aprobada'
         AND COALESCE(s.tipo,'vacaciones') = 'incapacidad'
         AND NULLIF(TRIM(COALESCE(s.folio_imss,'')),'') IS NULL
         AND daterange(s.fecha_inicio, s.fecha_fin, '[]') && daterange($1::date, $2::date, '[]')
       ORDER BY s.fecha_inicio, e.nombre`, [desde, hasta]);
    return r.rows;
  } catch (e) { return []; }
}

async function armarIncidencias({ desde, hasta }) {
  const pol = await politicaInc();
  // Se pide la plantilla completa, inactivos incluidos: a quien se dio de baja a
  // media quincena hay que pagarle los días que trabajó, y si no aparece en el
  // reporte, Nóminas no se lo paga.
  const m = await construirMatriz({ desde, hasta, incluir_inactivos: 'true' });
  const hoyISO = new Date().toISOString().slice(0, 10);
  const diasPeriodo = m.dias.length;

  // De los inactivos solo interesan los que tuvieron algo que ver con el
  // periodo. Quien lleva meses fuera no debe engordar el reporte.
  const tocaElPeriodo = (e) => {
    if (e.activo) return true;
    if (e.fecha_baja && e.fecha_baja >= desde) return true;
    return m.dias.some(f => {
      const c = e.celdas[f];
      return c && (c.c === 'A' || c.r);
    });
  };

  const bolsaDe = (cod) => pol.trato[cod] || 'paga';

  const filas = m.empleados.filter(tocaElPeriodo).map(e => {
    const cod = {};
    COD_INC.forEach(c => { cod[c] = 0; });
    let na = 0, futuros = 0, otros = 0, retardos = 0, minutosRetardo = 0, sinSalida = 0;
    const otrosCodigos = new Set();
    const eventos = [];

    m.dias.forEach(f => {
      const c = e.celdas[f] || {};
      const k = c.c || '';
      if (c.ss) sinSalida++;

      if (!k) {
        if (fueraDeRelacion(e, f)) na++;
        else futuros++;          // el periodo todavía no termina
        return;
      }
      if (COD_INC.includes(k)) cod[k]++;
      else { otros++; otrosCodigos.add(k); }

      if (k === 'A' && c.r) { retardos++; minutosRetardo += c.r; }

      // El detalle solo lleva lo que Nóminas tiene que revisar: un día de
      // asistencia normal no es una incidencia.
      const esIncidencia = k !== 'D' && k !== 'A';
      if (esIncidencia || c.r || c.ss) {
        eventos.push({
          fecha: f,
          codigo: k,
          codigo_nombre: COD_NOMBRE[k] || k,
          minutos_retardo: c.r || 0,
          sin_salida: !!c.ss,
          nota: c.n || null,
          codigo_antes: c.a || null,
          lo_cambio: c.qp || null,
          cambiado_en: c.cf || null,
          bolsa: esIncidencia ? bolsaDe(k) : null
        });
      }
    });

    let diasPagar = 0, diasNoPagar = 0, diasImss = 0;
    COD_INC.forEach(c => {
      const b = bolsaDe(c);
      if (b === 'paga')         diasPagar   += cod[c];
      else if (b === 'no_paga') diasNoPagar += cod[c];
      else                      diasImss    += cod[c];
    });

    const faltasPorRetardo = pol.retardos_por_falta > 0
      ? Math.floor(retardos / pol.retardos_por_falta) : 0;

    const suma = COD_INC.reduce((a, c) => a + cod[c], 0) + na + futuros + otros;
    const cuadra = suma === diasPeriodo && otros === 0;

    // El bono se dice solo como SÍ/NO. El importe es dato de sueldo y vive en su
    // propio módulo con su propio permiso: aquí no tiene por qué aparecer.
    const tumban = COD_INC.filter(c => CODIGOS_QUE_TUMBAN[c] && cod[c] > 0);
    const ganaBono = cod.A > 0 && retardos === 0 && tumban.length === 0;

    const avisos = [];
    if (!cuadra) avisos.push(otros
      ? `Tiene códigos que el reporte no sabe tratar: ${[...otrosCodigos].join(', ')}`
      : `Los días no suman el periodo (${suma} de ${diasPeriodo})`);
    const faltasSinNota = eventos.filter(x => x.codigo === 'F' && !x.nota).length;
    if (faltasSinNota) avisos.push(`${faltasSinNota} falta(s) sin justificación capturada`);
    if (sinSalida) avisos.push(`${sinSalida} día(s) con entrada pero sin salida`);
    if (!e.numero_colaborador) avisos.push('Sin número de colaborador');
    if (e.sin_horario) avisos.push('Sin horario configurado: sus descansos y faltas son suposición');
    if (!e.activo && !e.fecha_baja) avisos.push('Inactivo sin fecha de baja capturada');

    return {
      empleado_id: e.empleado_id,
      numero_colaborador: e.numero_colaborador,
      nombre: e.nombre,
      puesto: e.puesto,
      departamento: e.departamento,
      fecha_ingreso: e.fecha_ingreso,
      fecha_baja: e.fecha_baja,
      activo: !!e.activo,
      alta_en_periodo: !!(e.fecha_ingreso && e.fecha_ingreso >= desde && e.fecha_ingreso <= hasta),
      baja_en_periodo: !!(e.fecha_baja && e.fecha_baja >= desde && e.fecha_baja <= hasta),
      dias_periodo: diasPeriodo,
      codigos: cod,
      na, futuros, otros,
      retardos, minutos_retardo: minutosRetardo, faltas_por_retardo: faltasPorRetardo,
      sin_salida: sinSalida,
      dias_pagar: diasPagar,
      dias_no_pagar: diasNoPagar,
      dias_imss: diasImss,
      dias_descontar: diasNoPagar + faltasPorRetardo,
      gana_bono: ganaBono,
      bono_tumbado_por: tumban.map(c => COD_NOMBRE[c]),
      suma, cuadra,
      avisos,
      eventos
    };
  });

  // ── El semáforo ──
  // Rojo es "no lo mandes": son cosas que cambiarían las cifras ya capturadas.
  // Amarillo es "revísalo": no invalida el reporte, pero hay que saberlo.
  const rojas = [], amarillas = [];

  const pend = await pendientesDeAutorizar(desde, hasta);
  if (pend.length) rojas.push({
    clave: 'solicitudes_sin_autorizar',
    titulo: `${pend.length} solicitud(es) de este periodo siguen sin autorizar`,
    detalle: 'Si se aprueban después, los días que Nóminas ya capturó quedan mal.',
    items: pend.map(s => `${s.nombre} · ${s.tipo.replace(/_/g, ' ')} · ${s.fecha_inicio} a ${s.fecha_fin} (${s.estatus === 'vo_bo' ? 'espera a RH' : 'espera al jefe'})`)
  });

  const sinFolio = await incapacidadesSinFolio(desde, hasta);
  if (sinFolio.length) rojas.push({
    clave: 'incapacidad_sin_folio',
    titulo: `${sinFolio.length} incapacidad(es) sin folio del IMSS`,
    detalle: 'Nóminas necesita el folio y el ramo para el trámite ante el IMSS.',
    items: sinFolio.map(s => `${s.nombre} · ${s.fecha_inicio} a ${s.fecha_fin}`)
  });

  const noCuadran = filas.filter(f => !f.cuadra);
  if (noCuadran.length) rojas.push({
    clave: 'no_cuadra',
    titulo: `${noCuadran.length} colaborador(es) con días que no cuadran`,
    detalle: `Cada quien debe sumar ${diasPeriodo} días entre pagados, no pagados, IMSS y no aplicables.`,
    items: noCuadran.map(f => `${f.nombre} · ${f.avisos[0] || 'revisar'}`)
  });

  const conFaltasSinNota = filas.filter(f => f.eventos.some(x => x.codigo === 'F' && !x.nota));
  if (conFaltasSinNota.length) rojas.push({
    clave: 'faltas_sin_nota',
    titulo: `${conFaltasSinNota.reduce((a, f) => a + f.eventos.filter(x => x.codigo === 'F' && !x.nota).length, 0)} falta(s) sin justificación capturada`,
    detalle: 'Son días que se van a descontar. Conviene que quede escrito por qué.',
    items: conFaltasSinNota.map(f => `${f.nombre} · ${f.eventos.filter(x => x.codigo === 'F' && !x.nota).map(x => x.fecha).join(', ')}`)
  });

  const conFuturos = filas.filter(f => f.futuros > 0);
  if (conFuturos.length) amarillas.push({
    clave: 'periodo_abierto',
    titulo: 'El periodo todavía no termina',
    detalle: `Hay días posteriores a hoy (${hoyISO}) sin registro. No cuentan como falta, pero las cifras van a cambiar.`,
    items: []
  });

  const conSinSalida = filas.filter(f => f.sin_salida > 0);
  if (conSinSalida.length) amarillas.push({
    clave: 'sin_salida',
    titulo: `${conSinSalida.reduce((a, f) => a + f.sin_salida, 0)} día(s) con entrada pero sin salida`,
    detalle: 'No se sabe si completó la jornada.',
    items: conSinSalida.map(f => `${f.nombre} · ${f.sin_salida} día(s)`)
  });

  const sinHorario = filas.filter(f => f.avisos.some(a => a.startsWith('Sin horario')));
  if (sinHorario.length) amarillas.push({
    clave: 'sin_horario',
    titulo: `${sinHorario.length} colaborador(es) sin horario configurado`,
    detalle: 'Sin horario, lo que el sistema llama descanso o falta es una suposición.',
    items: sinHorario.map(f => f.nombre)
  });

  const movimientos = filas.filter(f => f.alta_en_periodo || f.baja_en_periodo);
  if (movimientos.length) amarillas.push({
    clave: 'altas_bajas',
    titulo: `${movimientos.length} alta(s) o baja(s) dentro del periodo`,
    detalle: 'Se les pagan días proporcionales; los días fuera de la relación laboral van como "no aplica".',
    items: movimientos.map(f => `${f.nombre} · ${f.alta_en_periodo ? 'alta ' + f.fecha_ingreso : ''}${f.alta_en_periodo && f.baja_en_periodo ? ' · ' : ''}${f.baja_en_periodo ? 'baja ' + f.fecha_baja : ''} · ${f.na} día(s) no aplicables`)
  });

  const sinNumero = filas.filter(f => !f.numero_colaborador);
  if (sinNumero.length) amarillas.push({
    clave: 'sin_numero',
    titulo: `${sinNumero.length} colaborador(es) sin número`,
    detalle: 'Nóminas captura por número de colaborador; sin él tiene que buscarlo por nombre.',
    items: sinNumero.map(f => f.nombre)
  });

  const inactivosSinBaja = filas.filter(f => !f.activo && !f.fecha_baja);
  if (inactivosSinBaja.length) amarillas.push({
    clave: 'inactivo_sin_baja',
    titulo: `${inactivosSinBaja.length} inactivo(s) sin fecha de baja`,
    detalle: 'Sin fecha de baja, el sistema no sabe desde cuándo dejar de contarle días.',
    items: inactivosSinBaja.map(f => f.nombre)
  });

  // ── Qué quincena de nómina es este periodo ──
  let quincena = null;
  try {
    const q = await query(`
      SELECT quincena, estatus, notas FROM fac_nomina_quincenas
       WHERE fecha_inicio = $1::date AND fecha_fin = $2::date LIMIT 1`, [desde, hasta]);
    quincena = q.rows[0] || null;
  } catch (e) { quincena = null; }

  const totales = {
    colaboradores: filas.length,
    dias_periodo: diasPeriodo,
    con_incidencias: filas.filter(f =>
      f.codigos.F || f.codigos.FJ || f.codigos.V || f.codigos['P/G'] ||
      f.codigos['P/S'] || f.codigos.In || f.retardos).length,
    dias_pagar:    filas.reduce((a, f) => a + f.dias_pagar, 0),
    dias_descontar: filas.reduce((a, f) => a + f.dias_descontar, 0),
    dias_imss:     filas.reduce((a, f) => a + f.dias_imss, 0),
    retardos:      filas.reduce((a, f) => a + f.retardos, 0),
    minutos_retardo: filas.reduce((a, f) => a + f.minutos_retardo, 0),
    ganan_bono:    filas.filter(f => f.gana_bono).length,
    cuadran:       filas.filter(f => f.cuadra).length
  };
  COD_INC.forEach(c => { totales[c] = filas.reduce((a, f) => a + f.codigos[c], 0); });

  return {
    desde, hasta, dias: m.dias, dias_periodo: diasPeriodo, generado_en: new Date().toISOString(),
    quincena, politica: pol, codigos: COD_NOMBRE,
    filas, totales,
    alertas: { rojas, amarillas, puede_cerrar: rojas.length === 0 },
    incidencias_nomina: m.incidencias_nomina || []
  };
}

// Qué cambió respecto a lo que ya se le mandó a Nóminas. Es la razón de ser del
// folio: si alguien corrige una celda después del envío, aquí sale el
// complemento en lugar de que las dos áreas discutan números distintos.
function diferenciasContraEnvio(filas, snapshot) {
  const antes = new Map((snapshot?.filas || []).map(f => [f.empleado_id, f]));
  const cambios = [];
  filas.forEach(f => {
    const a = antes.get(f.empleado_id);
    if (!a) { cambios.push({ nombre: f.nombre, campo: 'Alta en el reporte', antes: '—', ahora: 'aparece ahora' }); return; }
    [['dias_pagar', 'Días a pagar'], ['dias_descontar', 'Días a descontar'],
     ['dias_imss', 'Días IMSS'], ['retardos', 'Retardos']].forEach(([k, et]) => {
      if (Number(a[k]) !== Number(f[k]))
        cambios.push({ nombre: f.nombre, campo: et, antes: a[k], ahora: f[k] });
    });
  });
  antes.forEach((a, id) => {
    if (!filas.some(f => f.empleado_id === id))
      cambios.push({ nombre: a.nombre, campo: 'Salió del reporte', antes: 'aparecía', ahora: '—' });
  });
  return cambios;
}

const verIncidencias   = permiso('incidenciasNomina', NIVEL.VER);
const cerrarIncidencias = permiso('incidenciasNomina', NIVEL.EDITAR);

router.get('/incidencias', verIncidencias, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta (YYYY-MM-DD).' });
    if (desde > hasta) return res.status(400).json({ error: '"Desde" debe ser menor o igual a "hasta".' });

    const d = await armarIncidencias({ desde, hasta });

    // ¿Ya se envió este periodo?
    try {
      const e = await query(`
        SELECT folio, TO_CHAR(enviado_en,'YYYY-MM-DD HH24:MI') AS enviado_en,
               enviado_por_nombre, notas, snapshot
          FROM fac_incidencias_envios
         WHERE desde = $1::date AND hasta = $2::date
         ORDER BY enviado_en DESC LIMIT 1`, [desde, hasta]);
      if (e.rows.length) {
        const env = e.rows[0];
        d.envio = {
          folio: env.folio, enviado_en: env.enviado_en,
          enviado_por: env.enviado_por_nombre, notas: env.notas,
          cambios: diferenciasContraEnvio(d.filas, env.snapshot)
        };
      } else d.envio = null;
    } catch (e) { d.envio = null; }

    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/incidencias/politica', verIncidencias, async (req, res) => {
  try {
    res.json({ politica: await politicaInc(), codigos: COD_NOMBRE,
               default: POLITICA_INC_DEF });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/incidencias/politica', cerrarIncidencias, async (req, res) => {
  try {
    const trato = {};
    COD_INC.forEach(c => {
      const v = req.body?.trato?.[c];
      trato[c] = ['paga', 'no_paga', 'imss'].includes(v) ? v : POLITICA_INC_DEF.trato[c];
    });
    const pol = {
      trato,
      retardos_por_falta: Math.max(0, Math.min(99, parseInt(req.body.retardos_por_falta) || 0)),
      toda_plantilla: req.body.toda_plantilla !== false
    };
    await query(`
      INSERT INTO fac_config(clave, valor, actualizado_por_nombre, actualizado_en)
      VALUES('incidencias_politica', $1, $2, NOW())
      ON CONFLICT (clave) DO UPDATE
        SET valor = $1, actualizado_por_nombre = $2, actualizado_en = NOW()`,
      [JSON.stringify(pol), req.usuario?.nombre || null]);
    res.json({ ok: true, politica: pol });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cierre del periodo. Congela el reporte tal como se envió y le pone folio: a
// partir de aquí, lo que Nóminas recibió ya no cambia aunque alguien corrija
// una celda. Ese es el punto; si el documento pudiera cambiar solo, no serviría
// para acreditar nada.
router.post('/incidencias/cerrar', cerrarIncidencias, async (req, res) => {
  try {
    const { desde, hasta } = req.body;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta.' });

    const d = await armarIncidencias({ desde, hasta });
    const motivo = (req.body.motivo_forzado || '').trim();
    if (d.alertas.rojas.length) {
      // Se puede forzar, pero no a la ligera: hay que escribir por qué, y eso
      // queda guardado junto al folio.
      if (!req.body.forzar)
        return res.status(400).json({
          error: 'Hay pendientes que cambiarían las cifras. Resuélvelos o indica por qué se envía así.',
          rojas: d.alertas.rojas
        });
      if (motivo.length < 10)
        return res.status(400).json({ error: 'Para enviarlo con pendientes hay que explicar por qué (mínimo 10 caracteres).' });
    }

    const anio = String(desde).slice(0, 4);
    const notas = (req.body.notas || '').trim() || null;
    const quien = req.usuario?.nombre || null;
    const payload = { ...d };
    delete payload.envio;

    // El folio se arma dentro de un reintento porque dos personas podrían
    // cerrar al mismo tiempo y pelearse el consecutivo.
    let fila = null, intento = 0;
    while (!fila && intento++ < 25) {
      const n = await query(
        `SELECT COUNT(*)::int AS n FROM fac_incidencias_envios WHERE folio LIKE $1`,
        [`INC-${anio}-%`]);
      const folio = `INC-${anio}-${String(n.rows[0].n + intento).padStart(3, '0')}`;
      try {
        const r = await query(`
          INSERT INTO fac_incidencias_envios
            (folio, desde, hasta, quincena, snapshot, politica, totales,
             forzado, motivo_forzado, notas, enviado_por, enviado_por_nombre)
          VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING folio, TO_CHAR(enviado_en,'YYYY-MM-DD HH24:MI') AS enviado_en`,
          [folio, desde, hasta, d.quincena?.quincena || null,
           JSON.stringify(payload), JSON.stringify(d.politica), JSON.stringify(d.totales),
           !!d.alertas.rojas.length, motivo || null, notas,
           req.usuario?.id || null, quien]);
        fila = r.rows[0];
      } catch (e) {
        if (!/duplicate key|unique/i.test(e.message)) throw e;
      }
    }
    if (!fila) return res.status(500).json({ error: 'No se pudo asignar folio. Intenta de nuevo.' });

    res.status(201).json({ ok: true, folio: fila.folio, enviado_en: fila.enviado_en,
                           con_pendientes: !!d.alertas.rojas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/incidencias/envios', verIncidencias, async (req, res) => {
  try {
    const r = await query(`
      SELECT folio, TO_CHAR(desde,'YYYY-MM-DD') AS desde, TO_CHAR(hasta,'YYYY-MM-DD') AS hasta,
             quincena, forzado, motivo_forzado, notas, enviado_por_nombre,
             TO_CHAR(enviado_en,'YYYY-MM-DD HH24:MI') AS enviado_en,
             totales
        FROM fac_incidencias_envios
       ORDER BY enviado_en DESC LIMIT 60`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/incidencias/envios/:folio', verIncidencias, async (req, res) => {
  try {
    const r = await query(`
      SELECT folio, TO_CHAR(desde,'YYYY-MM-DD') AS desde, TO_CHAR(hasta,'YYYY-MM-DD') AS hasta,
             quincena, forzado, motivo_forzado, notas, enviado_por_nombre,
             TO_CHAR(enviado_en,'YYYY-MM-DD HH24:MI') AS enviado_en, snapshot
        FROM fac_incidencias_envios WHERE folio = $1`, [req.params.folio]);
    if (!r.rows.length) return res.status(404).json({ error: 'Folio no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envíos del reporte de incidencias a Nómina. Guarda el reporte completo tal
// como se mandó: es un documento que salió del área, y tiene que poder
// reconstruirse igual meses después aunque las celdas hayan cambiado.
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_incidencias_envios (
        id SERIAL PRIMARY KEY,
        folio TEXT UNIQUE NOT NULL,
        desde DATE NOT NULL,
        hasta DATE NOT NULL,
        quincena TEXT,
        snapshot JSONB,
        politica JSONB,
        totales JSONB,
        forzado BOOLEAN DEFAULT FALSE,
        motivo_forzado TEXT,
        notas TEXT,
        enviado_por INT,
        enviado_por_nombre TEXT,
        enviado_en TIMESTAMP DEFAULT NOW()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS ix_inc_envios_periodo
                   ON fac_incidencias_envios(desde, hasta)`);
  } catch (e) { console.warn('Migración envíos de incidencias:', e.message); }
})();

// GET /api/checador/productividad — resumen por colaborador
// Calcula: dias laborables, horas esperadas, horas laboradas, retardos, incidencias, % productividad
// Igual que la matriz: por empleado corresponde al Expediente, y de toda la
// plantilla al Reloj Checador.
function verProductividad(req, res, next) {
  return req.query.empleado_id ? verExpediente(req, res, next)
                               : permiso('checador', NIVEL.VER)(req, res, next);
}
router.get('/productividad', verProductividad, async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta (YYYY-MM-DD).' });
    const hoyISO = new Date().toISOString().slice(0,10);
    const cortaHasta = hasta > hoyISO ? hoyISO : hasta; // no contar dias futuros como laborables

    // Empleados
    const paramsE = [];
    let whereE = 'WHERE activo=TRUE';
    if (empleado_id) { paramsE.push(empleado_id); whereE += ` AND id=$${paramsE.length}`; }
    const emps = await query(
      `SELECT id, nombre, numero_colaborador, puesto, departamento,
        hora_entrada_esperada, hora_salida_esperada, dias_descanso, horario_semanal
       FROM fac_empleados ${whereE} ORDER BY nombre`, paramsE);

    // Registros del reloj
    const regs = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha,
        minutos_trabajados, minutos_retardo, hora_entrada
       FROM fac_reloj_checador
       WHERE fecha BETWEEN $1::date AND $2::date`,
      [desde, cortaHasta]);

    // Solicitudes aprobadas
    const sols = await query(
      `SELECT empleado_id,
        TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
        TO_CHAR(fecha_fin,'YYYY-MM-DD')    AS fecha_fin,
        COALESCE(tipo,'vacaciones') AS tipo
       FROM fac_vacaciones_solicitudes
       WHERE estatus='aprobada'
         AND daterange(fecha_inicio, fecha_fin, '[]') && daterange($1::date, $2::date, '[]')`,
      [desde, cortaHasta]);

    // Ajustes manuales (FJ, override de código)
    const ajus = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, codigo
       FROM fac_asistencia_ajustes
       WHERE fecha BETWEEN $1::date AND $2::date`,
      [desde, cortaHasta]);

    // Enumerar dias del rango (hasta hoy o hasta cortaHasta)
    const dias = [];
    const d0 = new Date(desde+'T12:00:00');
    const d1 = new Date(cortaHasta+'T12:00:00');
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)) dias.push(d.toISOString().slice(0,10));

    // Índices
    const regByEmp = {};
    regs.rows.forEach(r => {
      if (!regByEmp[r.empleado_id]) regByEmp[r.empleado_id] = {};
      regByEmp[r.empleado_id][r.fecha] = r;
    });
    const solByEmp = {};
    const addDay = (iso) => {
      const [y,m,d] = iso.split('-').map(Number);
      const dt = new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+1);
      return dt.toISOString().slice(0,10);
    };
    sols.rows.forEach(s => {
      let cur = s.fecha_inicio;
      while (cur <= s.fecha_fin) {
        if (!solByEmp[s.empleado_id]) solByEmp[s.empleado_id] = {};
        solByEmp[s.empleado_id][cur] = s.tipo;
        cur = addDay(cur);
      }
    });
    const ajusByEmp = {};
    ajus.rows.forEach(a => {
      if (!ajusByEmp[a.empleado_id]) ajusByEmp[a.empleado_id] = {};
      ajusByEmp[a.empleado_id][a.fecha] = a.codigo;
    });

    // Parsear jornada esperada por empleado
    const parseHora = (h) => {
      if (!h) return 0;
      const [hh, mm] = String(h).split(':').map(Number);
      return (hh||0)*60 + (mm||0);
    };

    // Construir resumen por empleado
    const resumen = emps.rows.map(e => {
      // Las horas esperadas se acumulan por dia y no multiplicando una jornada
      // fija: con horario semanal, un sabado corto vale menos que un lunes.
      let minutosEsperados = 0;
      let diasLaborables = 0;   // dias esperados a trabajar (no descanso, no vacacion/pg/in)
      let diasTrabajados = 0;   // dias con entrada registrada
      let faltas = 0, vac = 0, pg = 0, inc = 0, fj = 0;
      let minutosTrab = 0, minutosRet = 0;
      dias.forEach(fecha => {
        const dow = new Date(fecha+'T12:00:00').getDay();
        const esDescanso = horarioDelDia(e, dow).descansa;
        const sol = solByEmp[e.id]?.[fecha];
        const aj  = ajusByEmp[e.id]?.[fecha];
        const reg = regByEmp[e.id]?.[fecha];
        // Codigo efectivo (mismo priority que asistencia)
        let cod;
        if (aj) cod = aj;
        else if (reg && reg.hora_entrada) cod = 'A';
        else if (sol) cod = ({vacaciones:'V',permiso_goce:'P/G',incapacidad:'In'})[sol] || 'V';
        else if (esDescanso) cod = 'D';
        else cod = 'F';

        if (['A','F','FJ'].includes(cod)) minutosEsperados += jornadaDelDia(e, dow);
        if (cod === 'A')  { diasTrabajados++; diasLaborables++; }
        else if (cod === 'F') { faltas++; diasLaborables++; }
        else if (cod === 'FJ') { fj++; diasLaborables++; }
        else if (cod === 'V') { vac++; /* NO cuenta como laborable */ }
        else if (cod === 'P/G') { pg++; /* NO cuenta */ }
        else if (cod === 'In') { inc++; /* NO cuenta */ }
        // D: no suma nada
        if (reg && reg.minutos_trabajados) minutosTrab += parseInt(reg.minutos_trabajados)||0;
        if (reg && reg.minutos_retardo)    minutosRet  += parseInt(reg.minutos_retardo)||0;
      });
      const horasEsperadas = minutosEsperados / 60;
      // Se conserva para la pantalla, que muestra "jornada diaria": con horario
      // semanal es un promedio de los dias que si se esperaban.
      const jornadaMin = diasLaborables ? Math.round(minutosEsperados / diasLaborables) : 0;
      const horasLaboradas = minutosTrab / 60;
      const productividad  = horasEsperadas > 0 ? Math.min(200, (horasLaboradas / horasEsperadas) * 100) : 0;
      return {
        empleado_id: e.id,
        nombre: e.nombre,
        numero_colaborador: e.numero_colaborador,
        puesto: e.puesto,
        departamento: e.departamento,
        jornada_diaria_min: jornadaMin,
        jornada_diaria_hrs: +(jornadaMin/60).toFixed(2),
        dias_laborables: diasLaborables,
        dias_trabajados: diasTrabajados,
        faltas, fj, vacaciones: vac, permiso_goce: pg, incapacidad: inc,
        horas_esperadas: +horasEsperadas.toFixed(2),
        horas_laboradas: +horasLaboradas.toFixed(2),
        retardo_min: minutosRet,
        productividad_pct: +productividad.toFixed(1)
      };
    });

    // Totales generales
    const tot = resumen.reduce((a, r) => {
      a.horas_esperadas += r.horas_esperadas;
      a.horas_laboradas += r.horas_laboradas;
      a.dias_laborables += r.dias_laborables;
      a.dias_trabajados += r.dias_trabajados;
      a.faltas += r.faltas; a.fj += r.fj; a.vacaciones += r.vacaciones;
      a.permiso_goce += r.permiso_goce; a.incapacidad += r.incapacidad;
      a.retardo_min += r.retardo_min;
      return a;
    }, { horas_esperadas:0, horas_laboradas:0, dias_laborables:0, dias_trabajados:0,
         faltas:0, fj:0, vacaciones:0, permiso_goce:0, incapacidad:0, retardo_min:0 });
    tot.productividad_pct = tot.horas_esperadas > 0 ? +((tot.horas_laboradas/tot.horas_esperadas)*100).toFixed(1) : 0;
    Object.keys(tot).forEach(k => { if (typeof tot[k] === 'number') tot[k] = +tot[k].toFixed(2); });

    res.json({ desde, hasta, corta_hasta: cortaHasta, empleados: resumen, totales: tot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/productividad-por-dia — breakdown dia a dia (global o por empleado)
router.get('/productividad-por-dia', async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta.' });
    const hoyISO = new Date().toISOString().slice(0,10);
    const cortaHasta = hasta > hoyISO ? hoyISO : hasta;

    const paramsE = [];
    let whereE = 'WHERE activo=TRUE';
    if (empleado_id) { paramsE.push(empleado_id); whereE += ` AND id=$${paramsE.length}`; }
    const emps = await query(
      `SELECT id, nombre, numero_colaborador, puesto,
        hora_entrada_esperada, hora_salida_esperada, dias_descanso, horario_semanal
       FROM fac_empleados ${whereE} ORDER BY nombre`, paramsE);

    const regs = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha,
        minutos_trabajados, minutos_retardo, hora_entrada
       FROM fac_reloj_checador
       WHERE fecha BETWEEN $1::date AND $2::date`, [desde, cortaHasta]);

    const sols = await query(
      `SELECT empleado_id,
        TO_CHAR(fecha_inicio,'YYYY-MM-DD') AS fecha_inicio,
        TO_CHAR(fecha_fin,'YYYY-MM-DD')    AS fecha_fin,
        COALESCE(tipo,'vacaciones') AS tipo
       FROM fac_vacaciones_solicitudes
       WHERE estatus='aprobada'
         AND daterange(fecha_inicio, fecha_fin, '[]') && daterange($1::date, $2::date, '[]')`,
      [desde, cortaHasta]);

    const ajus = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, codigo
       FROM fac_asistencia_ajustes
       WHERE fecha BETWEEN $1::date AND $2::date`, [desde, cortaHasta]);

    // Rango de dias
    const dias = [];
    const d0 = new Date(desde+'T12:00:00'), d1 = new Date(cortaHasta+'T12:00:00');
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)) dias.push(d.toISOString().slice(0,10));

    // Índices
    const regByEmpDia = {};
    regs.rows.forEach(r => { if(!regByEmpDia[r.empleado_id]) regByEmpDia[r.empleado_id]={}; regByEmpDia[r.empleado_id][r.fecha]=r; });
    const solByEmpDia = {};
    const addDay = iso => { const [y,m,d]=iso.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+1); return dt.toISOString().slice(0,10); };
    sols.rows.forEach(s => { let cur=s.fecha_inicio; while(cur<=s.fecha_fin){ if(!solByEmpDia[s.empleado_id]) solByEmpDia[s.empleado_id]={}; solByEmpDia[s.empleado_id][cur]=s.tipo; cur=addDay(cur); } });
    const ajusByEmpDia = {};
    ajus.rows.forEach(a => { if(!ajusByEmpDia[a.empleado_id]) ajusByEmpDia[a.empleado_id]={}; ajusByEmpDia[a.empleado_id][a.fecha]=a.codigo; });

    const parseHora = (h) => { if(!h) return 0; const [hh,mm]=String(h).split(':').map(Number); return (hh||0)*60+(mm||0); };

    // Para cada dia, agregar
    const porDia = dias.map(fecha => {
      const dow = new Date(fecha+'T12:00:00').getDay();
      let horasEsp = 0, horasLab = 0, empEsperados = 0, empTrabajados = 0;
      let faltas = 0, retardoMin = 0, ausencias = 0;
      emps.rows.forEach(e => {
        const esDesc = horarioDelDia(e, dow).descansa;
        const jornadaMin = jornadaDelDia(e, dow);
        const sol = solByEmpDia[e.id]?.[fecha];
        const aj  = ajusByEmpDia[e.id]?.[fecha];
        const reg = regByEmpDia[e.id]?.[fecha];
        let cod;
        if (aj) cod = aj;
        else if (reg && reg.hora_entrada) cod = 'A';
        else if (sol) cod = ({vacaciones:'V',permiso_goce:'P/G',incapacidad:'In'})[sol] || 'V';
        else if (esDesc) cod = 'D';
        else cod = 'F';

        if (['A','F','FJ'].includes(cod)) {
          empEsperados++;
          horasEsp += jornadaMin / 60;
          if (cod === 'A') { empTrabajados++; horasLab += (reg?.minutos_trabajados || 0) / 60; }
          if (cod === 'F') faltas++;
          if (reg?.minutos_retardo) retardoMin += parseInt(reg.minutos_retardo)||0;
        } else if (['V','P/G','In'].includes(cod)) ausencias++;
      });
      const prod = horasEsp > 0 ? Math.min(200, (horasLab/horasEsp)*100) : 0;
      return {
        fecha,
        dow,
        empleados_esperados: empEsperados,
        empleados_trabajados: empTrabajados,
        faltas, ausencias,
        horas_esperadas: +horasEsp.toFixed(2),
        horas_laboradas: +horasLab.toFixed(2),
        retardo_min: retardoMin,
        productividad_pct: +prod.toFixed(1)
      };
    });

    // Totales del rango
    const tot = porDia.reduce((a,d) => {
      a.horas_esperadas += d.horas_esperadas;
      a.horas_laboradas += d.horas_laboradas;
      a.faltas += d.faltas; a.ausencias += d.ausencias;
      a.retardo_min += d.retardo_min;
      return a;
    }, { horas_esperadas:0, horas_laboradas:0, faltas:0, ausencias:0, retardo_min:0 });
    tot.productividad_pct = tot.horas_esperadas > 0 ? +((tot.horas_laboradas/tot.horas_esperadas)*100).toFixed(1) : 0;
    Object.keys(tot).forEach(k => { if (typeof tot[k]==='number') tot[k] = +tot[k].toFixed(2); });

    res.json({ desde, hasta, corta_hasta: cortaHasta, dias: porDia, totales: tot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/empleados — lista de empleados con configuración de horarios
router.get('/empleados', async (req, res) => {
  try {
    const r = await query(`
      SELECT id, nombre, puesto, departamento, numero_colaborador,
        pin_checador,
        (pin_checador IS NOT NULL AND pin_checador != '') AS tiene_pin,
        hora_entrada_esperada, hora_salida_esperada, dias_descanso, horario_semanal,
        COALESCE(tolerancia_min, 0) AS tolerancia_min
      FROM fac_empleados WHERE activo=TRUE ORDER BY nombre
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/checador/entrada — registrar entrada (empleado + PIN)
router.post('/entrada', async (req, res) => {
  try {
    const { empleado_id, pin, notas, hora_local, fecha_local, lat, lng, foto } = req.body;
    if (!empleado_id) return res.status(400).json({ error: 'Empleado requerido.' });

    // Validar ubicación si está activada
    const validarUbi = await validarUbicacionRequerida();
    let ubiInfo = null;
    let fueraUbicacion = false;
    if (validarUbi) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Ubicación requerida. Autoriza el acceso al GPS en tu navegador.' });
      }
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
      if (!ubiInfo) {
        // Quien trabaja en campo puede tener autorizado marcar fuera del area.
        // Se permite, pero el registro queda señalado.
        const permiso = await query(
          `SELECT COALESCE(checa_fuera_ubicacion, FALSE) AS puede FROM fac_empleados WHERE id=$1`,
          [empleado_id]);
        if (!permiso.rows[0]?.puede) {
          return res.status(403).json({
            error: 'No puedes marcar entrada desde aquí. ' +
                   await porQueFueraDeUbicacion(parseFloat(lat), parseFloat(lng), empleado_id)
          });
        }
        fueraUbicacion = true;
      }
    } else if (lat != null && lng != null) {
      // Guardar ubicación aunque no sea obligatoria
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
    }

    const emp = await query(
      `SELECT id, nombre, pin_checador, hora_entrada_esperada, dias_descanso, horario_semanal,
              COALESCE(tolerancia_min, 0) AS tolerancia_min
       FROM fac_empleados WHERE id=$1 AND activo=TRUE`,
      [empleado_id]
    );
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });

    // Validar PIN (si está configurado)
    const pinCorrecto = emp.rows[0].pin_checador;
    if (pinCorrecto && String(pin || '').trim() !== pinCorrecto) {
      return res.status(403).json({ error: 'PIN incorrecto.' });
    }

    // Usar la hora/fecha LOCAL del navegador si viene; si no, usar la del servidor
    const hoy       = (fecha_local && /^\d{4}-\d{2}-\d{2}$/.test(fecha_local)) ? fecha_local : new Date().toISOString().slice(0,10);
    const horaAhora = (hora_local  && /^\d{2}:\d{2}(:\d{2})?$/.test(hora_local))
                        ? (hora_local.length === 5 ? hora_local + ':00' : hora_local)
                        : new Date().toTimeString().slice(0,8);
    // Reconstruir Date en zona local a partir de fecha+hora recibidos, para cálculos
    const ahora = new Date(`${hoy}T${horaAhora}`);
    const diaSemana = ahora.getDay(); // 0=Dom ... 6=Sáb

    // Horario que le toca hoy: puede ser distinto por dia de la semana
    const horarioHoy = horarioDelDia(emp.rows[0], diaSemana);
    const esDescanso = horarioHoy.descansa;

    // Verificar si hoy está dentro de una solicitud de vacaciones aprobada
    const vac = await query(
      `SELECT id, fecha_inicio, fecha_fin FROM fac_vacaciones_solicitudes
       WHERE empleado_id=$1 AND estatus='aprobada' AND $2::date BETWEEN fecha_inicio AND fecha_fin
       LIMIT 1`,
      [empleado_id, hoy]
    );
    const enVacaciones = vac.rows.length > 0;

    // Calcular retardo (minutos) — NO aplica en descanso ni vacaciones
    // Se resta la tolerancia configurada del empleado (dentro de ese margen no cuenta como retardo)
    let minutosRetardo = 0;
    const minEsperado = esDescanso ? null : minutosDe(horarioHoy.entrada);
    if (!esDescanso && !enVacaciones && minEsperado != null) {
      const min_actual = ahora.getHours()*60 + ahora.getMinutes();
      const tolerancia = parseInt(emp.rows[0].tolerancia_min) || 0;
      const dif = min_actual - minEsperado;
      minutosRetardo = dif > tolerancia ? dif : 0;
    }

    // Ver si ya existe registro para hoy
    const ya = await query(
      `SELECT id, hora_entrada FROM fac_reloj_checador WHERE empleado_id=$1 AND fecha=$2`,
      [empleado_id, hoy]
    );
    if (ya.rows.length && ya.rows[0].hora_entrada) {
      return res.status(400).json({
        error: `Ya registraste tu entrada hoy a las ${ya.rows[0].hora_entrada.toString().slice(0,5)}.`
      });
    }

    // Validar tamaño de foto (~200KB máx para prevenir abuso)
    const fotoOk = (foto && typeof foto === 'string' && foto.length < 300000) ? foto : null;

    if (ya.rows.length) {
      await query(
        `UPDATE fac_reloj_checador SET hora_entrada=$1, minutos_retardo=$2, notas=$3,
           lat_entrada=$4, lng_entrada=$5, ubicacion_id_entr=$6, distancia_entr_mts=$7,
           foto_entrada=COALESCE($8, foto_entrada),
           actualizado_en=NOW()
         WHERE id=$9`,
        [horaAhora, minutosRetardo, notas||null,
         lat != null ? parseFloat(lat) : null,
         lng != null ? parseFloat(lng) : null,
         ubiInfo?.id || null, ubiInfo?.distancia ?? null,
         fotoOk,
         ya.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO fac_reloj_checador(empleado_id, fecha, hora_entrada, minutos_retardo, notas,
           lat_entrada, lng_entrada, ubicacion_id_entr, distancia_entr_mts, foto_entrada,
           fuera_ubicacion_entr, creado_por)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [empleado_id, hoy, horaAhora, minutosRetardo, notas||null,
         lat != null ? parseFloat(lat) : null,
         lng != null ? parseFloat(lng) : null,
         ubiInfo?.id || null, ubiInfo?.distancia ?? null,
         fotoOk,
         fueraUbicacion,
         req.usuario.id]
      );
    }

    // Traer notificaciones pendientes para este empleado
    let notificaciones = [];
    try { notificaciones = await notificacionesPendientes(empleado_id); } catch(e) {}

    // Si gano la puntualidad de la semana pasada, se le felicita aqui mismo.
    const felicitacion = await felicitacionPendiente(empleado_id, hoy);

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      retardo_minutos: minutosRetardo,
      es_descanso: esDescanso,
      en_vacaciones: enVacaciones,
      ubicacion: ubiInfo ? { nombre: ubiInfo.nombre, distancia: ubiInfo.distancia } : null,
      notificaciones,
      felicitacion
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/checador/salida — registrar salida
router.post('/salida', async (req, res) => {
  try {
    const { empleado_id, pin, notas, hora_local, fecha_local, lat, lng, foto } = req.body;
    if (!empleado_id) return res.status(400).json({ error: 'Empleado requerido.' });

    // Validar ubicación si está activada
    const validarUbi = await validarUbicacionRequerida();
    let ubiInfo = null;
    let fueraUbicacion = false;
    if (validarUbi) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Ubicación requerida. Autoriza el acceso al GPS en tu navegador.' });
      }
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
      if (!ubiInfo) {
        const permiso = await query(
          `SELECT COALESCE(checa_fuera_ubicacion, FALSE) AS puede FROM fac_empleados WHERE id=$1`,
          [empleado_id]);
        if (!permiso.rows[0]?.puede) {
          return res.status(403).json({
            error: 'No puedes marcar salida desde aquí. ' +
                   await porQueFueraDeUbicacion(parseFloat(lat), parseFloat(lng), empleado_id)
          });
        }
        fueraUbicacion = true;
      }
    } else if (lat != null && lng != null) {
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
    }

    const emp = await query(
      `SELECT id, nombre, pin_checador FROM fac_empleados WHERE id=$1 AND activo=TRUE`, [empleado_id]);
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });

    const pinCorrecto = emp.rows[0].pin_checador;
    if (pinCorrecto && String(pin || '').trim() !== pinCorrecto) {
      return res.status(403).json({ error: 'PIN incorrecto.' });
    }

    // Usar hora/fecha LOCAL del navegador si viene
    const hoy       = (fecha_local && /^\d{4}-\d{2}-\d{2}$/.test(fecha_local)) ? fecha_local : new Date().toISOString().slice(0,10);
    const horaAhora = (hora_local  && /^\d{2}:\d{2}(:\d{2})?$/.test(hora_local))
                        ? (hora_local.length === 5 ? hora_local + ':00' : hora_local)
                        : new Date().toTimeString().slice(0,8);

    const reg = await query(
      `SELECT id, hora_entrada, hora_salida FROM fac_reloj_checador WHERE empleado_id=$1 AND fecha=$2`,
      [empleado_id, hoy]
    );
    if (!reg.rows.length || !reg.rows[0].hora_entrada) {
      return res.status(400).json({ error: 'Primero debes registrar tu entrada.' });
    }
    if (reg.rows[0].hora_salida) {
      return res.status(400).json({
        error: `Ya registraste tu salida hoy a las ${reg.rows[0].hora_salida.toString().slice(0,5)}.`
      });
    }

    // Calcular minutos trabajados
    const [eh,em] = reg.rows[0].hora_entrada.toString().slice(0,5).split(':').map(Number);
    const [sh,sm] = horaAhora.slice(0,5).split(':').map(Number);
    const minEntr = eh*60 + em;
    const minSal  = sh*60 + sm;
    const minTrab = Math.max(0, minSal - minEntr);

    const fotoOk = (foto && typeof foto === 'string' && foto.length < 300000) ? foto : null;

    await query(
      `UPDATE fac_reloj_checador SET
         hora_salida=$1, minutos_trabajados=$2,
         notas=COALESCE(NULLIF($3,''), notas),
         lat_salida=$4, lng_salida=$5, ubicacion_id_sal=$6, distancia_sal_mts=$7,
         foto_salida=COALESCE($8, foto_salida),
         fuera_ubicacion_sal=$10,
         actualizado_en=NOW()
       WHERE id=$9`,
      [horaAhora, minTrab, notas||'',
       lat != null ? parseFloat(lat) : null,
       lng != null ? parseFloat(lng) : null,
       ubiInfo?.id || null, ubiInfo?.distancia ?? null,
       fotoOk,
       reg.rows[0].id,
       fueraUbicacion]
    );

    // Traer notificaciones pendientes también al marcar salida
    // (si el colaborador ya había entrado antes de que se creara el mensaje)
    let notificaciones = [];
    try { notificaciones = await notificacionesPendientes(empleado_id); } catch(e) {}

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      minutos_trabajados: minTrab,
      ubicacion: ubiInfo ? { nombre: ubiInfo.nombre, distancia: ubiInfo.distancia } : null,
      notificaciones
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/notificaciones-pendientes/:empleado_id
// Permite consultar los mensajes sin necesidad de marcar entrada/salida
router.get('/notificaciones-pendientes/:empleado_id', async (req, res) => {
  try {
    const rows = await notificacionesPendientes(req.params.empleado_id);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/notificaciones-conteo — cuántos mensajes pendientes tiene cada empleado
// Se usa en el kiosco para mostrar el badge 🔔 en las tarjetas
router.get('/notificaciones-conteo', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.id AS empleado_id, COUNT(n.id)::int AS pendientes
      FROM fac_empleados e
      LEFT JOIN fac_checador_notificaciones n
        ON n.activa = TRUE
       AND (n.inicia_en IS NULL OR n.inicia_en <= CURRENT_DATE)
       AND (n.vence_en  IS NULL OR n.vence_en  >= CURRENT_DATE)
       AND (n.empleado_id IS NULL OR n.empleado_id = e.id)
       AND NOT EXISTS (
         SELECT 1 FROM fac_checador_notif_vistas v
         WHERE v.notificacion_id = n.id AND v.empleado_id = e.id
       )
      WHERE e.activo = TRUE
      GROUP BY e.id
    `);
    const mapa = {};
    r.rows.forEach(x => { if (x.pendientes > 0) mapa[x.empleado_id] = x.pendientes; });
    res.json(mapa);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/checador/:id — editar registro (admin)
router.put('/:id', requireRol('admin'), async (req, res) => {
  try {
    const { hora_entrada, hora_salida, minutos_retardo, notas } = req.body;
    // Recalcular minutos trabajados si vienen ambas horas
    let minTrab = null;
    if (hora_entrada && hora_salida) {
      const [eh,em] = hora_entrada.split(':').map(Number);
      const [sh,sm] = hora_salida.split(':').map(Number);
      minTrab = Math.max(0, (sh*60+sm) - (eh*60+em));
    }
    await query(
      `UPDATE fac_reloj_checador SET
         hora_entrada=$1, hora_salida=$2,
         minutos_trabajados=$3, minutos_retardo=$4, notas=$5, actualizado_en=NOW()
       WHERE id=$6`,
      [hora_entrada||null, hora_salida||null, minTrab, parseInt(minutos_retardo)||0, notas||null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/checador/:id — admin
router.delete('/:id', requireRol('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM fac_reloj_checador WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/checador/empleado/:id/pin — configurar PIN + horario + días descanso (admin)
router.put('/empleado/:id/pin', requireRol('admin'), async (req, res) => {
  try {
    const { pin, hora_entrada_esperada, hora_salida_esperada, dias_descanso, tolerancia_min } = req.body;
    // Horario por dia. Se limpia aqui: solo dias 0-6 y horas con forma HH:MM, para
    // que nunca llegue a la base algo que despues rompa el calculo del retardo.
    // null explicito = descansa ese dia; enviar {} borra el horario por dia y
    // vuelve al general.
    let horarioSemanal = null;
    if (req.body.horario_semanal && typeof req.body.horario_semanal === 'object') {
      const hora = h => (/^\d{1,2}:\d{2}$/.test(String(h||'')) ? String(h).padStart(5,'0') : null);
      horarioSemanal = {};
      for (let d = 0; d <= 6; d++) {
        if (!Object.prototype.hasOwnProperty.call(req.body.horario_semanal, String(d))) continue;
        const v = req.body.horario_semanal[String(d)];
        if (!v || !hora(v.e)) { horarioSemanal[String(d)] = null; continue; }
        horarioSemanal[String(d)] = { e: hora(v.e), s: hora(v.s) };
      }
      if (!Object.keys(horarioSemanal).length) horarioSemanal = null;
    }
    // Normalizar días descanso: string tipo "0,6"
    let dd = '';
    if (Array.isArray(dias_descanso)) dd = dias_descanso.join(',');
    else if (typeof dias_descanso === 'string') dd = dias_descanso;
    const tol = Math.max(0, Math.min(120, parseInt(tolerancia_min) || 0));
    await query(
      `UPDATE fac_empleados SET
         pin_checador=$1,
         hora_entrada_esperada=$2,
         hora_salida_esperada=$3,
         dias_descanso=$4,
         tolerancia_min=$5,
         horario_semanal=$6,
         actualizado_en=NOW()
       WHERE id=$7`,
      [(pin||'').trim() || null,
       hora_entrada_esperada || '09:00',
       hora_salida_esperada  || '18:00',
       dd,
       tol,
       horarioSemanal ? JSON.stringify(horarioSemanal) : null,
       req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/:id/foto/:tipo — obtener foto individual (entrada|salida)
router.get('/:id/foto/:tipo', async (req, res) => {
  try {
    const tipo = req.params.tipo === 'entrada' ? 'foto_entrada' : 'foto_salida';
    const r = await query(`SELECT ${tipo} AS foto FROM fac_reloj_checador WHERE id=$1`, [req.params.id]);
    if (!r.rows.length || !r.rows[0].foto) return res.status(404).json({ error: 'Sin foto.' });
    res.json({ foto: r.rows[0].foto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-limpieza: borra fotos > 90 días (se ejecuta al arrancar y cada 24h)
async function limpiarFotosAntiguas() {
  try {
    const r = await query(`
      UPDATE fac_reloj_checador
        SET foto_entrada=NULL, foto_salida=NULL
      WHERE fecha < CURRENT_DATE - INTERVAL '90 days'
        AND (foto_entrada IS NOT NULL OR foto_salida IS NOT NULL)
      RETURNING id
    `);
    if (r.rows.length) console.log(`🗑 Checador: fotos borradas de ${r.rows.length} registros con más de 90 días.`);
  } catch (e) { console.warn('⚠ Auto-limpieza checador:', e.message); }
}
// Ejecutar al arrancar y cada 24 horas
limpiarFotosAntiguas();
setInterval(limpiarFotosAntiguas, 24*60*60*1000);

module.exports = router;
