const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');

router.use(verificarToken);

// GET /api/checador/hoy — registros del día + colaboradores en vacaciones
router.get('/hoy', async (req, res) => {
  try {
    const { fecha } = req.query;
    const f = fecha || new Date().toISOString().slice(0,10);
    const r = await query(`
      SELECT r.*, e.nombre, e.puesto, e.departamento, e.numero_colaborador, e.hora_entrada_esperada
      FROM fac_reloj_checador r
      JOIN fac_empleados e ON e.id = r.empleado_id
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
      SELECT r.*, e.nombre, e.puesto, e.departamento, e.numero_colaborador,
        EXISTS (
          SELECT 1 FROM fac_vacaciones_solicitudes s
          WHERE s.empleado_id = r.empleado_id
            AND s.estatus = 'aprobada'
            AND r.fecha BETWEEN s.fecha_inicio AND s.fecha_fin
        ) AS en_vacaciones
      FROM fac_reloj_checador r
      JOIN fac_empleados e ON e.id = r.empleado_id
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
    const { empleado_id, pin, notas } = req.body;
    if (!empleado_id) return res.status(400).json({ error: 'Empleado requerido.' });

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

    const hoy = new Date().toISOString().slice(0,10);
    const ahora = new Date();
    const horaAhora = ahora.toTimeString().slice(0,8); // HH:MM:SS
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

    if (ya.rows.length) {
      await query(
        `UPDATE fac_reloj_checador SET hora_entrada=$1, minutos_retardo=$2, notas=$3, actualizado_en=NOW()
         WHERE id=$4`,
        [horaAhora, minutosRetardo, notas||null, ya.rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO fac_reloj_checador(empleado_id, fecha, hora_entrada, minutos_retardo, notas, creado_por)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [empleado_id, hoy, horaAhora, minutosRetardo, notas||null, req.usuario.id]
      );
    }

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      retardo_minutos: minutosRetardo,
      es_descanso: esDescanso,
      en_vacaciones: enVacaciones
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/checador/salida — registrar salida
router.post('/salida', async (req, res) => {
  try {
    const { empleado_id, pin, notas } = req.body;
    if (!empleado_id) return res.status(400).json({ error: 'Empleado requerido.' });

    const emp = await query(
      `SELECT id, nombre, pin_checador FROM fac_empleados WHERE id=$1 AND activo=TRUE`, [empleado_id]);
    if (!emp.rows.length) return res.status(404).json({ error: 'Empleado no encontrado.' });

    const pinCorrecto = emp.rows[0].pin_checador;
    if (pinCorrecto && String(pin || '').trim() !== pinCorrecto) {
      return res.status(403).json({ error: 'PIN incorrecto.' });
    }

    const hoy = new Date().toISOString().slice(0,10);
    const horaAhora = new Date().toTimeString().slice(0,8);

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
    const ahoraDt = new Date();
    const minEntr = eh*60 + em;
    const minSal  = ahoraDt.getHours()*60 + ahoraDt.getMinutes();
    const minTrab = Math.max(0, minSal - minEntr);

    await query(
      `UPDATE fac_reloj_checador SET
         hora_salida=$1, minutos_trabajados=$2,
         notas=COALESCE(NULLIF($3,''), notas), actualizado_en=NOW()
       WHERE id=$4`,
      [horaAhora, minTrab, notas||'', reg.rows[0].id]
    );

    res.json({
      ok: true, empleado: emp.rows[0].nombre, hora: horaAhora,
      minutos_trabajados: minTrab
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

module.exports = router;
