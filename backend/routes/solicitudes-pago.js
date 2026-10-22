const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken } = require('../middleware/auth');
const { NIVEL, permiso, nivelEn } = require('../middleware/permiso');
const { enviar, plantilla } = require('../config/mailer');

router.use(verificarToken);

// ═══ SOLICITUDES DE PAGO ════════════════════════════
// Cualquier usuario pide un pago; un rol autorizador lo aprueba; la solicitud
// cae en una cola que Tesorería ve en vivo, alguien la toma para trabajarla y
// al liquidarla se avisa por correo a quien la pidió.
//
// LÍNEA DE VIDA
//   pendiente   recién capturada, esperando autorización
//   autorizada  aprobada; ya está en la cola de Tesorería
//   en_proceso  alguien de Tesorería la tomó y la está trabajando
//   pagada      liquidada; se avisó por correo al solicitante
//   rechazada   el autorizador la negó (queda el motivo)
//   cancelada   el solicitante se arrepintió antes de que la autorizaran
//
// Son dos permisos distintos y no dos niveles del mismo, porque autorizar y
// pagar las hace gente distinta: 'solicitudesPago' (pedir y autorizar) y
// 'colaPagos' (tomar y liquidar en Tesorería).
const TIPOS_PAGO = ['efectivo', 'cheque', 'dispersion', 'transferencia'];

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_solicitudes_pago (
        id SERIAL PRIMARY KEY,
        folio TEXT UNIQUE,
        solicitante_id INT,
        beneficiario TEXT NOT NULL,
        concepto TEXT NOT NULL,
        monto NUMERIC(14,2) NOT NULL,
        moneda TEXT NOT NULL DEFAULT 'MXN',
        tipo_pago TEXT NOT NULL,
        fecha_requerida DATE,
        urgente BOOLEAN NOT NULL DEFAULT FALSE,
        -- Datos de destino. Cuáles aplican depende del tipo de pago; se guardan
        -- todos en la misma fila porque una solicitud solo tiene un destino.
        banco TEXT,
        clabe TEXT,
        cuenta TEXT,
        titular TEXT,
        cheque_a_nombre_de TEXT,
        referencia TEXT,
        notas TEXT,
        estatus TEXT NOT NULL DEFAULT 'pendiente',
        autorizada_por INT, autorizada_en TIMESTAMP, autorizacion_nota TEXT,
        rechazo_motivo TEXT,
        tomada_por INT, tomada_en TIMESTAMP,
        pagada_por INT, pagada_en TIMESTAMP,
        pago_referencia TEXT, pago_notas TEXT, cuenta_id INT,
        -- Enlace con la agenda de Tesorería. Sin FK por la misma razón que allá:
        -- no atar esta migración al orden en que se cargan los módulos.
        pago_programado_id INT,
        correo_enviado_en TIMESTAMP, correo_error TEXT,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW(),
        CHECK (monto > 0),
        CHECK (estatus IN ('pendiente','autorizada','en_proceso','pagada','rechazada','cancelada')),
        CHECK (tipo_pago IN ('efectivo','cheque','dispersion','transferencia'))
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_solpago_estatus ON fac_solicitudes_pago(estatus)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_solpago_solic   ON fac_solicitudes_pago(solicitante_id)`);

    // Marca en la agenda de qué solicitud vino el pago. Sirve para dos cosas:
    // mostrarlo en pantalla y, sobre todo, impedir que se liquide desde allá
    // (ver el candado en pagos-programados.js).
    await query(`ALTER TABLE fac_pagos_programados ADD COLUMN IF NOT EXISTS solicitud_id INT`);
    console.log('✔ Solicitudes de Pago: tablas listas');
  } catch (e) { console.warn('Migración solicitudes de pago:', e.message); }
})();

// ── Quién ve qué ────────────────────────────
// Un usuario común solo ve sus propias solicitudes. Quien puede autorizar
// (Editar en el módulo) las ve todas, porque para eso autoriza. Tesorería ve
// las que ya están en la cola, que es otra consulta.
async function veTodas(u) {
  return (await nivelEn(u, 'solicitudesPago')) >= NIVEL.EDITAR;
}

const ETIQUETA_TIPO = {
  efectivo:'Efectivo', cheque:'Cheque',
  dispersion:'Dispersión', transferencia:'Transferencia / SPEI'
};

function datosDelCuerpo(b) {
  const beneficiario = (b.beneficiario || '').trim();
  const concepto     = (b.concepto || '').trim();
  if (!beneficiario) return { error: 'El beneficiario es obligatorio.' };
  if (!concepto)     return { error: 'El concepto es obligatorio.' };

  const monto = parseFloat(b.monto);
  if (!Number.isFinite(monto) || monto <= 0)
    return { error: 'El monto debe ser mayor a cero.' };

  const tipo_pago = TIPOS_PAGO.includes(b.tipo_pago) ? b.tipo_pago : null;
  if (!tipo_pago) return { error: 'Elige una forma de pago válida.' };

  // Un pago que sale por el banco sin a dónde mandarlo no se puede trabajar:
  // mejor detenerlo aquí que descubrirlo en la cola de Tesorería.
  if ((tipo_pago === 'transferencia' || tipo_pago === 'dispersion')
      && !(b.clabe || '').trim() && !(b.cuenta || '').trim())
    return { error: 'Para transferencia o dispersión hace falta la CLABE o el número de cuenta.' };

  return {
    beneficiario, concepto, monto, tipo_pago,
    moneda            : (b.moneda || 'MXN').trim().toUpperCase().slice(0,3),
    fecha_requerida   : b.fecha_requerida || null,
    urgente           : b.urgente === true || b.urgente === 'true',
    banco             : (b.banco   || '').trim() || null,
    clabe             : (b.clabe   || '').trim() || null,
    cuenta            : (b.cuenta  || '').trim() || null,
    titular           : (b.titular || '').trim() || null,
    cheque_a_nombre_de: (b.cheque_a_nombre_de || '').trim() || null,
    referencia        : (b.referencia || '').trim() || null,
    notas             : (b.notas      || '').trim() || null
  };
}

const SELECT_BASE = `
  SELECT s.*,
         TO_CHAR(s.fecha_requerida,'YYYY-MM-DD') AS fecha_requerida,
         TO_CHAR(s.pagada_en,'YYYY-MM-DD HH24:MI')  AS pagada_en_txt,
         TO_CHAR(s.creado_en,'YYYY-MM-DD')          AS solicitado_el,
         us.nombre AS solicitante, us.email AS solicitante_email,
         ua.nombre AS autorizador,
         ut.nombre AS tomada_por_nombre,
         up.nombre AS pagada_por_nombre,
         (s.estatus IN ('pendiente','autorizada','en_proceso')
          AND s.fecha_requerida IS NOT NULL
          AND s.fecha_requerida < CURRENT_DATE) AS atrasada
    FROM fac_solicitudes_pago s
    LEFT JOIN fac_usuarios us ON us.id = s.solicitante_id
    LEFT JOIN fac_usuarios ua ON ua.id = s.autorizada_por
    LEFT JOIN fac_usuarios ut ON ut.id = s.tomada_por
    LEFT JOIN fac_usuarios up ON up.id = s.pagada_por`;

// ═══ LISTADO ════════════════════════════════════════
router.get('/', permiso('solicitudesPago', NIVEL.VER), async (req, res) => {
  try {
    const { estatus, tipo_pago, desde, hasta, buscar, mias } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    // El filtro de visibilidad va primero y no se puede saltar desde la query
    if (!(await veTodas(req.usuario)) || mias === 'true') {
      params.push(req.usuario.id); where += ` AND s.solicitante_id = $${params.length}`;
    }
    if (estatus === 'abiertas') {
      where += ` AND s.estatus IN ('pendiente','autorizada','en_proceso')`;
    } else if (estatus) {
      params.push(estatus); where += ` AND s.estatus = $${params.length}`;
    }
    if (tipo_pago) { params.push(tipo_pago); where += ` AND s.tipo_pago = $${params.length}`; }
    if (desde)     { params.push(desde);     where += ` AND s.creado_en >= $${params.length}::date`; }
    if (hasta)     { params.push(hasta);     where += ` AND s.creado_en < ($${params.length}::date + 1)`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (s.folio ILIKE $${params.length} OR s.beneficiario ILIKE $${params.length}
                      OR s.concepto ILIKE $${params.length} OR s.referencia ILIKE $${params.length})`;
    }

    const r = await query(`${SELECT_BASE} ${where}
      ORDER BY CASE s.estatus WHEN 'pendiente' THEN 0 WHEN 'autorizada' THEN 1
                              WHEN 'en_proceso' THEN 2 ELSE 3 END,
               s.urgente DESC, s.creado_en DESC
      LIMIT 500`, params);

    const tot = await query(`
      SELECT COUNT(*) FILTER (WHERE s.estatus='pendiente')::int  AS n_pendientes,
             COUNT(*) FILTER (WHERE s.estatus='autorizada')::int AS n_autorizadas,
             COUNT(*) FILTER (WHERE s.estatus='en_proceso')::int AS n_proceso,
             COUNT(*) FILTER (WHERE s.estatus='pagada')::int     AS n_pagadas,
             COALESCE(SUM(s.monto) FILTER (WHERE s.estatus IN ('pendiente','autorizada','en_proceso')),0) AS abierto,
             COALESCE(SUM(s.monto) FILTER (WHERE s.estatus='pendiente'),0)  AS por_autorizar,
             COALESCE(SUM(s.monto) FILTER (WHERE s.estatus='pagada'),0)     AS pagado
        FROM fac_solicitudes_pago s ${where}`, params);

    res.json({ data: r.rows, totales: tot.rows[0], ve_todas: await veTodas(req.usuario) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ COLA EN VIVO DE TESORERÍA ══════════════════════
// La pantalla la consulta cada pocos segundos. Devuelve solo lo que está en la
// cola y un sello de tiempo del servidor, para que la pantalla pueda decir
// cuándo se actualizó sin depender del reloj de cada máquina.
router.get('/cola', permiso('colaPagos', NIVEL.VER), async (req, res) => {
  try {
    const r = await query(`${SELECT_BASE}
      WHERE s.estatus IN ('autorizada','en_proceso')
      ORDER BY s.urgente DESC,
               s.fecha_requerida ASC NULLS LAST,
               s.autorizada_en ASC`);

    const tot = await query(`
      SELECT COUNT(*) FILTER (WHERE estatus='autorizada')::int AS en_espera,
             COUNT(*) FILTER (WHERE estatus='en_proceso')::int AS en_proceso,
             COUNT(*) FILTER (WHERE estatus IN ('autorizada','en_proceso') AND urgente)::int AS urgentes,
             COALESCE(SUM(monto) FILTER (WHERE estatus='autorizada'),0)  AS monto_espera,
             COALESCE(SUM(monto) FILTER (WHERE estatus='en_proceso'),0)  AS monto_proceso,
             COALESCE(SUM(monto) FILTER (WHERE estatus='pagada' AND pagada_en::date = CURRENT_DATE),0) AS pagado_hoy,
             COUNT(*) FILTER (WHERE estatus='pagada' AND pagada_en::date = CURRENT_DATE)::int AS n_pagado_hoy
        FROM fac_solicitudes_pago`);

    res.json({ data: r.rows, totales: tot.rows[0], al: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', permiso('solicitudesPago', NIVEL.VER), async (req, res) => {
  try {
    const r = await query(`${SELECT_BASE} WHERE s.id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const s = r.rows[0];
    // Ver una ajena por su id directo también está vedado a quien no autoriza
    if (s.solicitante_id !== req.usuario.id && !(await veTodas(req.usuario)))
      return res.status(403).json({ error: 'Esta solicitud no es tuya.' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CREAR ══════════════════════════════════════════
router.post('/', permiso('solicitudesPago', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const d = datosDelCuerpo(req.body);
    if (d.error) return res.status(400).json({ error: d.error });

    const r = await query(
      `INSERT INTO fac_solicitudes_pago(
         solicitante_id, beneficiario, concepto, monto, moneda, tipo_pago,
         fecha_requerida, urgente, banco, clabe, cuenta, titular,
         cheque_a_nombre_de, referencia, notas)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [req.usuario.id, d.beneficiario, d.concepto, d.monto, d.moneda, d.tipo_pago,
       d.fecha_requerida, d.urgente, d.banco, d.clabe, d.cuenta, d.titular,
       d.cheque_a_nombre_de, d.referencia, d.notas]);

    // El folio se arma con el id ya asignado: así no hay contador aparte que se
    // pueda encimar cuando dos personas capturan al mismo tiempo.
    const id = r.rows[0].id;
    const f = await query(
      `UPDATE fac_solicitudes_pago
          SET folio = 'SP-' || TO_CHAR(creado_en,'YYYY') || '-' || LPAD(id::text,5,'0')
        WHERE id=$1 RETURNING *`, [id]);
    res.status(201).json(f.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ EDITAR (solo mientras no la autorizan) ═════════
router.put('/:id', permiso('solicitudesPago', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const a = await query(`SELECT solicitante_id, estatus FROM fac_solicitudes_pago WHERE id=$1`,
      [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const s = a.rows[0];

    if (s.solicitante_id !== req.usuario.id && !(await veTodas(req.usuario)))
      return res.status(403).json({ error: 'Esta solicitud no es tuya.' });
    if (s.estatus !== 'pendiente')
      return res.status(400).json({ error: `Ya no se puede editar: la solicitud está ${s.estatus}.` });

    const d = datosDelCuerpo(req.body);
    if (d.error) return res.status(400).json({ error: d.error });

    await query(
      `UPDATE fac_solicitudes_pago SET
         beneficiario=$1, concepto=$2, monto=$3, moneda=$4, tipo_pago=$5,
         fecha_requerida=$6, urgente=$7, banco=$8, clabe=$9, cuenta=$10, titular=$11,
         cheque_a_nombre_de=$12, referencia=$13, notas=$14, actualizado_en=NOW()
       WHERE id=$15`,
      [d.beneficiario, d.concepto, d.monto, d.moneda, d.tipo_pago, d.fecha_requerida,
       d.urgente, d.banco, d.clabe, d.cuenta, d.titular, d.cheque_a_nombre_de,
       d.referencia, d.notas, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ AUTORIZAR / RECHAZAR ═══════════════════════════
// Al autorizar nace el renglón en la agenda de Tesorería. Es el único momento
// en que se crea, y queda enlazado en los dos sentidos.
router.patch('/:id/autorizar', permiso('solicitudesPago', NIVEL.EDITAR), async (req, res) => {
  try {
    const { rechazar, motivo, nota } = req.body;

    const a = await query(`SELECT * FROM fac_solicitudes_pago WHERE id=$1`, [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const s = a.rows[0];
    if (s.estatus !== 'pendiente')
      return res.status(400).json({ error: `Solo se autorizan las pendientes; esta está ${s.estatus}.` });

    if (rechazar) {
      if (!(motivo || '').trim())
        return res.status(400).json({ error: 'Para rechazar hay que escribir el motivo.' });
      await query(
        `UPDATE fac_solicitudes_pago
            SET estatus='rechazada', autorizada_por=$1, autorizada_en=NOW(),
                rechazo_motivo=$2, actualizado_en=NOW()
          WHERE id=$3`, [req.usuario.id, motivo.trim(), req.params.id]);
      return res.json({ ok: true, estatus: 'rechazada' });
    }

    let programadoId = null;
    try {
      const p = await query(
        `INSERT INTO fac_pagos_programados(
           beneficiario, concepto, monto, fecha_programada, forma_pago,
           prioridad, referencia, notas, solicitud_id, creado_por)
         VALUES($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9,$10) RETURNING id`,
        [s.beneficiario, s.concepto, s.monto, s.fecha_requerida, s.tipo_pago,
         s.urgente ? 'alta' : 'normal', s.referencia,
         `Viene de la solicitud ${s.folio}`, s.id, req.usuario.id]);
      programadoId = p.rows[0].id;
    } catch (e) {
      // Que la agenda falle no debe impedir autorizar: la solicitud sigue su
      // curso y la cola de Tesorería la muestra igual. Queda el aviso en log.
      console.warn(`No se pudo crear el pago programado de ${s.folio}:`, e.message);
    }

    await query(
      `UPDATE fac_solicitudes_pago
          SET estatus='autorizada', autorizada_por=$1, autorizada_en=NOW(),
              autorizacion_nota=$2, pago_programado_id=$3, actualizado_en=NOW()
        WHERE id=$4`,
      [req.usuario.id, (nota || '').trim() || null, programadoId, req.params.id]);

    res.json({ ok: true, estatus: 'autorizada', pago_programado_id: programadoId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ CANCELAR (el propio solicitante) ═══════════════
router.patch('/:id/cancelar', permiso('solicitudesPago', NIVEL.CAPTURAR), async (req, res) => {
  try {
    const a = await query(`SELECT solicitante_id, estatus FROM fac_solicitudes_pago WHERE id=$1`,
      [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const s = a.rows[0];
    if (s.solicitante_id !== req.usuario.id && !(await veTodas(req.usuario)))
      return res.status(403).json({ error: 'Esta solicitud no es tuya.' });
    if (s.estatus !== 'pendiente')
      return res.status(400).json({ error: `Solo se cancelan las pendientes; esta está ${s.estatus}.` });

    await query(`UPDATE fac_solicitudes_pago SET estatus='cancelada', actualizado_en=NOW() WHERE id=$1`,
      [req.params.id]);
    res.json({ ok: true, estatus: 'cancelada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ TOMAR / SOLTAR (Tesorería) ═════════════════════
// El UPDATE lleva el estatus esperado en el WHERE: si dos personas de Tesorería
// pican "Tomar" a la vez, la segunda no actualiza ninguna fila y se le avisa,
// en vez de que las dos crean que la tienen.
router.patch('/:id/tomar', permiso('colaPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const r = await query(
      `UPDATE fac_solicitudes_pago
          SET estatus='en_proceso', tomada_por=$1, tomada_en=NOW(), actualizado_en=NOW()
        WHERE id=$2 AND estatus='autorizada' RETURNING id`,
      [req.usuario.id, req.params.id]);

    if (!r.rows.length) {
      const a = await query(
        `SELECT s.estatus, u.nombre FROM fac_solicitudes_pago s
           LEFT JOIN fac_usuarios u ON u.id = s.tomada_por WHERE s.id=$1`, [req.params.id]);
      if (!a.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      const { estatus, nombre } = a.rows[0];
      return res.status(409).json({
        error: estatus === 'en_proceso'
          ? `Esta solicitud ya la tomó ${nombre || 'alguien más'}.`
          : `Ya no está en la cola: quedó ${estatus}.`
      });
    }
    res.json({ ok: true, estatus: 'en_proceso' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/soltar', permiso('colaPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const r = await query(
      `UPDATE fac_solicitudes_pago
          SET estatus='autorizada', tomada_por=NULL, tomada_en=NULL, actualizado_en=NOW()
        WHERE id=$1 AND estatus='en_proceso' RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(400).json({ error: 'Esta solicitud no está en proceso.' });
    res.json({ ok: true, estatus: 'autorizada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ MARCAR PAGADA + AVISO POR CORREO ═══════════════
router.patch('/:id/pagar', permiso('colaPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const { pago_referencia, pago_notas, cuenta_id } = req.body;

    const r = await query(
      `UPDATE fac_solicitudes_pago
          SET estatus='pagada', pagada_por=$1, pagada_en=NOW(),
              pago_referencia=$2, pago_notas=$3, cuenta_id=$4, actualizado_en=NOW()
        WHERE id=$5 AND estatus='en_proceso' RETURNING *`,
      [req.usuario.id, (pago_referencia || '').trim() || null,
       (pago_notas || '').trim() || null, cuenta_id ? parseInt(cuenta_id) : null,
       req.params.id]);

    if (!r.rows.length) {
      const a = await query(`SELECT estatus FROM fac_solicitudes_pago WHERE id=$1`, [req.params.id]);
      if (!a.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      return res.status(400).json({
        error: `Primero hay que tomarla. Ahora está ${a.rows[0].estatus}.` });
    }
    const s = r.rows[0];

    // La agenda se cierra junto con la solicitud, para que no queden las dos
    // contando el mismo dinero como pendiente.
    if (s.pago_programado_id) {
      try {
        await query(
          `UPDATE fac_pagos_programados
              SET estatus='pagado', pagado_en=CURRENT_DATE, pago_referencia=$1,
                  cuenta_id=COALESCE($2, cuenta_id), actualizado_en=NOW()
            WHERE id=$3`, [s.pago_referencia, s.cuenta_id, s.pago_programado_id]);
      } catch (e) { console.warn(`No se pudo cerrar el pago programado de ${s.folio}:`, e.message); }
    }

    // El correo va después de que el pago ya quedó asentado: si el envío falla,
    // el pago no se deshace. Se guarda el resultado para poder reintentar.
    const sol = await query(`SELECT nombre, email FROM fac_usuarios WHERE id=$1`, [s.solicitante_id]);
    const destinatario = sol.rows[0]?.email;
    const aviso = await enviar({
      para  : destinatario,
      asunto: `Pago realizado · ${s.folio} · ${s.beneficiario}`,
      texto : `Tu solicitud ${s.folio} por ${s.monto} ${s.moneda} a favor de ${s.beneficiario} ya fue pagada.`,
      html  : plantilla({
        titulo: 'Tu pago ya fue realizado',
        saludo: `Hola ${sol.rows[0]?.nombre || ''},`,
        cuerpo: `La solicitud <strong>${s.folio}</strong> que registraste ya fue procesada por Tesorería y el pago está <strong>concluido</strong>.`,
        datos : [
          ['Folio', s.folio],
          ['Beneficiario', s.beneficiario],
          ['Concepto', s.concepto],
          ['Importe', `$${Number(s.monto).toLocaleString('es-MX',{minimumFractionDigits:2})} ${s.moneda}`],
          ['Forma de pago', ETIQUETA_TIPO[s.tipo_pago] || s.tipo_pago],
          ['Referencia del pago', s.pago_referencia],
          ['Pagado el', new Date(s.pagada_en).toLocaleString('es-MX')]
        ],
        pie: 'Si algo no coincide, avisa a Tesorería citando el folio.'
      })
    });

    await query(
      `UPDATE fac_solicitudes_pago
          SET correo_enviado_en = CASE WHEN $1 THEN NOW() ELSE NULL END, correo_error = $2
        WHERE id=$3`,
      [aviso.ok, aviso.ok ? null : (aviso.motivo || 'desconocido'), s.id]);

    res.json({ ok: true, estatus: 'pagada', correo: aviso });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reintento manual del aviso, para cuando el correo falló por algo temporal
router.post('/:id/reenviar-aviso', permiso('colaPagos', NIVEL.EDITAR), async (req, res) => {
  try {
    const r = await query(`${SELECT_BASE} WHERE s.id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const s = r.rows[0];
    if (s.estatus !== 'pagada')
      return res.status(400).json({ error: 'Solo se avisa de las que ya están pagadas.' });

    const aviso = await enviar({
      para  : s.solicitante_email,
      asunto: `Pago realizado · ${s.folio} · ${s.beneficiario}`,
      texto : `Tu solicitud ${s.folio} ya fue pagada.`,
      html  : plantilla({
        titulo: 'Tu pago ya fue realizado',
        saludo: `Hola ${s.solicitante || ''},`,
        cuerpo: `La solicitud <strong>${s.folio}</strong> ya fue procesada por Tesorería y el pago está <strong>concluido</strong>.`,
        datos : [['Folio', s.folio], ['Beneficiario', s.beneficiario],
                 ['Importe', `$${Number(s.monto).toLocaleString('es-MX',{minimumFractionDigits:2})} ${s.moneda}`],
                 ['Referencia del pago', s.pago_referencia]]
      })
    });
    await query(
      `UPDATE fac_solicitudes_pago
          SET correo_enviado_en = CASE WHEN $1 THEN NOW() ELSE correo_enviado_en END, correo_error = $2
        WHERE id=$3`, [aviso.ok, aviso.ok ? null : (aviso.motivo || 'desconocido'), s.id]);
    res.json(aviso.ok ? { ok: true } : { ok: false, error: aviso.motivo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', permiso('solicitudesPago', NIVEL.TODO), async (req, res) => {
  try {
    const r = await query(`DELETE FROM fac_solicitudes_pago WHERE id=$1 RETURNING pago_programado_id`,
      [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    // El renglón de la agenda se va con ella: existía solo por esta solicitud
    if (r.rows[0].pago_programado_id) {
      try { await query(`DELETE FROM fac_pagos_programados WHERE id=$1`, [r.rows[0].pago_programado_id]); }
      catch (e) { console.warn('No se pudo borrar el pago programado enlazado:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
