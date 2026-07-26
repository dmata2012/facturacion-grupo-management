const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

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

// POST /api/checador/asistencia/ajuste — insertar o actualizar override + nota
router.post('/asistencia/ajuste', requireRol('admin', 'capturista', 'tesoreria', 'gerente'), async (req, res) => {
  try {
    const { empleado_id, fecha, codigo, notas } = req.body;
    if (!empleado_id || !fecha) return res.status(400).json({ error: 'empleado_id y fecha requeridos.' });
    const cod = (codigo && codigo !== 'auto') ? String(codigo).trim() : null;
    const not = (notas || '').trim() || null;
    if (!cod && !not) {
      // Si ambos vacíos, borrar el override
      await query(`DELETE FROM fac_asistencia_ajustes WHERE empleado_id=$1 AND fecha=$2`, [empleado_id, fecha]);
      return res.json({ ok: true, deleted: true });
    }
    await query(`
      INSERT INTO fac_asistencia_ajustes(empleado_id, fecha, codigo, notas, creado_por, actualizado_en)
      VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(empleado_id, fecha) DO UPDATE
      SET codigo=EXCLUDED.codigo, notas=EXCLUDED.notas, actualizado_en=NOW()
    `, [empleado_id, fecha, cod, not, req.usuario.id]);
    res.json({ ok: true });
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
router.get('/asistencia', async (req, res) => {
  try {
    const { desde, hasta, empleado_id, incluir_inactivos } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Se requieren desde y hasta (YYYY-MM-DD).' });

    // Empleados
    const paramsE = [];
    let whereE = incluir_inactivos === 'true' ? '' : 'WHERE activo=TRUE';
    if (empleado_id) {
      paramsE.push(empleado_id);
      whereE = whereE ? `${whereE} AND id=$${paramsE.length}` : `WHERE id=$${paramsE.length}`;
    }
    const empleados = await query(
      `SELECT id, nombre, numero_colaborador, puesto, departamento, dias_descanso
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

    // Ajustes/overrides manuales del rango
    const ajus = await query(
      `SELECT empleado_id, TO_CHAR(fecha,'YYYY-MM-DD') AS fecha, codigo, notas
       FROM fac_asistencia_ajustes
       WHERE fecha BETWEEN $1::date AND $2::date`,
      [desde, hasta]
    );

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
      ajusByEmpDia[a.empleado_id][a.fecha] = { codigo: a.codigo, notas: a.notas };
    });

    const codigoTipoSolicitud = { vacaciones:'V', permiso_goce:'P/G', incapacidad:'In' };

    // Fecha de hoy (server) para no marcar F en fechas futuras
    const hoyISO = new Date().toISOString().slice(0,10);
    // Construir matriz
    const matriz = empleados.rows.map(e => {
      // Default LFT: domingo es dia de descanso obligatorio si no hay config
      const descanso = Array.isArray(e.dias_descanso) && e.dias_descanso.length
        ? e.dias_descanso
        : [0]; // 0 = domingo
      const celdas = {};
      const totales = { A:0, F:0, FJ:0, V:0, 'P/G':0, In:0, D:0 };
      dias.forEach(fecha => {
        const dow = new Date(fecha+'T12:00:00').getDay(); // 0=Dom .. 6=Sab
        const sol = solByEmpDia[e.id]?.[fecha];
        const reg = regByEmpDia[e.id]?.[fecha];
        const aj  = ajusByEmpDia[e.id]?.[fecha];
        const esFutura = fecha > hoyISO;
        let cod;
        // Prioridad: override manual > registro > solicitud > descanso > (falta o pendiente si futura)
        if (aj && aj.codigo) cod = aj.codigo;
        else if (reg && reg.hora_entrada) cod = 'A';
        else if (sol) cod = codigoTipoSolicitud[sol] || 'V';
        else if (descanso.includes(dow)) cod = 'D';
        else if (esFutura) cod = '';   // fecha futura sin registro: no es falta
        else cod = 'F';
        celdas[fecha] = { c: cod, n: aj?.notas || null };
        if (totales[cod] !== undefined) totales[cod]++;
      });
      return {
        empleado_id: e.id,
        nombre: e.nombre,
        numero_colaborador: e.numero_colaborador,
        puesto: e.puesto,
        departamento: e.departamento,
        celdas,
        totales
      };
    });

    res.json({ desde, hasta, dias, empleados: matriz });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/checador/productividad — resumen por colaborador
// Calcula: dias laborables, horas esperadas, horas laboradas, retardos, incidencias, % productividad
router.get('/productividad', async (req, res) => {
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
        hora_entrada_esperada, hora_salida_esperada, dias_descanso
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
      const descanso = Array.isArray(e.dias_descanso) && e.dias_descanso.length ? e.dias_descanso : [0];
      const jornadaMin = Math.max(0, parseHora(e.hora_salida_esperada) - parseHora(e.hora_entrada_esperada));
      let diasLaborables = 0;   // dias esperados a trabajar (no descanso, no vacacion/pg/in)
      let diasTrabajados = 0;   // dias con entrada registrada
      let faltas = 0, vac = 0, pg = 0, inc = 0, fj = 0;
      let minutosTrab = 0, minutosRet = 0;
      dias.forEach(fecha => {
        const dow = new Date(fecha+'T12:00:00').getDay();
        const esDescanso = descanso.includes(dow);
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
      const horasEsperadas = (diasLaborables * jornadaMin) / 60;
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
        hora_entrada_esperada, hora_salida_esperada, dias_descanso
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
        const descanso = Array.isArray(e.dias_descanso) && e.dias_descanso.length ? e.dias_descanso : [0];
        const esDesc = descanso.includes(dow);
        const jornadaMin = Math.max(0, parseHora(e.hora_salida_esperada) - parseHora(e.hora_entrada_esperada));
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
        (pin_checador IS NOT NULL AND pin_checador != '') AS tiene_pin,
        hora_entrada_esperada, hora_salida_esperada, dias_descanso
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
    if (validarUbi) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Ubicación requerida. Autoriza el acceso al GPS en tu navegador.' });
      }
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
      if (!ubiInfo) {
        return res.status(403).json({
          error: 'Estás fuera del área autorizada de trabajo. Solo puedes marcar entrada dentro de una ubicación registrada.'
        });
      }
    } else if (lat != null && lng != null) {
      // Guardar ubicación aunque no sea obligatoria
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
    }

    const emp = await query(
      `SELECT id, nombre, pin_checador, hora_entrada_esperada, dias_descanso FROM fac_empleados WHERE id=$1 AND activo=TRUE`,
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

    // Verificar si hoy es día de descanso
    const diasDescanso = new Set(String(emp.rows[0].dias_descanso||'').split(',').filter(x=>x!=='').map(x=>parseInt(x)));
    const esDescanso = diasDescanso.has(diaSemana);

    // Verificar si hoy está dentro de una solicitud de vacaciones aprobada
    const vac = await query(
      `SELECT id, fecha_inicio, fecha_fin FROM fac_vacaciones_solicitudes
       WHERE empleado_id=$1 AND estatus='aprobada' AND $2::date BETWEEN fecha_inicio AND fecha_fin
       LIMIT 1`,
      [empleado_id, hoy]
    );
    const enVacaciones = vac.rows.length > 0;

    // Calcular retardo (minutos) — NO aplica en descanso ni vacaciones
    let minutosRetardo = 0;
    if (!esDescanso && !enVacaciones && emp.rows[0].hora_entrada_esperada) {
      const esperada = emp.rows[0].hora_entrada_esperada.toString().slice(0,5).split(':');
      const min_esperado = parseInt(esperada[0])*60 + parseInt(esperada[1]);
      const min_actual   = ahora.getHours()*60 + ahora.getMinutes();
      minutosRetardo = Math.max(0, min_actual - min_esperado);
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
           lat_entrada, lng_entrada, ubicacion_id_entr, distancia_entr_mts, foto_entrada, creado_por)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [empleado_id, hoy, horaAhora, minutosRetardo, notas||null,
         lat != null ? parseFloat(lat) : null,
         lng != null ? parseFloat(lng) : null,
         ubiInfo?.id || null, ubiInfo?.distancia ?? null,
         fotoOk,
         req.usuario.id]
      );
    }

    // Traer notificaciones pendientes para este empleado
    let notificaciones = [];
    try { notificaciones = await notificacionesPendientes(empleado_id); } catch(e) {}

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      retardo_minutos: minutosRetardo,
      es_descanso: esDescanso,
      en_vacaciones: enVacaciones,
      ubicacion: ubiInfo ? { nombre: ubiInfo.nombre, distancia: ubiInfo.distancia } : null,
      notificaciones
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
    if (validarUbi) {
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Ubicación requerida. Autoriza el acceso al GPS en tu navegador.' });
      }
      ubiInfo = await ubicacionCercana(parseFloat(lat), parseFloat(lng), empleado_id);
      if (!ubiInfo) {
        return res.status(403).json({
          error: 'Estás fuera del área autorizada de trabajo. Solo puedes marcar salida dentro de una ubicación registrada.'
        });
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
         actualizado_en=NOW()
       WHERE id=$9`,
      [horaAhora, minTrab, notas||'',
       lat != null ? parseFloat(lat) : null,
       lng != null ? parseFloat(lng) : null,
       ubiInfo?.id || null, ubiInfo?.distancia ?? null,
       fotoOk,
       reg.rows[0].id]
    );

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      minutos_trabajados: minTrab,
      ubicacion: ubiInfo ? { nombre: ubiInfo.nombre, distancia: ubiInfo.distancia } : null
    });
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
    const { pin, hora_entrada_esperada, hora_salida_esperada, dias_descanso } = req.body;
    // Normalizar días descanso: string tipo "0,6"
    let dd = '';
    if (Array.isArray(dias_descanso)) dd = dias_descanso.join(',');
    else if (typeof dias_descanso === 'string') dd = dias_descanso;
    await query(
      `UPDATE fac_empleados SET
         pin_checador=$1,
         hora_entrada_esperada=$2,
         hora_salida_esperada=$3,
         dias_descanso=$4,
         actualizado_en=NOW()
       WHERE id=$5`,
      [(pin||'').trim() || null,
       hora_entrada_esperada || '09:00',
       hora_salida_esperada  || '18:00',
       dd,
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
