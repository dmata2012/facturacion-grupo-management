const router = require('express').Router();
const { query } = require('../config/db');
const { verificarToken, requireRol } = require('../middleware/auth');
const { NIVEL, permisosDeUsuario, invalidarCache } = require('../middleware/permiso');

router.use(verificarToken);

// ═══ CATÁLOGO DE MÓDULOS ════════════════════════════
// La clave es la misma que usa nav() en el frontend, para que el menú se pueda
// dibujar directamente a partir de los permisos sin tablas de equivalencia.
const MODULOS_SEED = [
  { clave:'dashboard',    nombre:'Dashboard',           icono:'📊', grupo:'Principal',            orden:1  },
  { clave:'facturas',     nombre:'Facturas',            icono:'🧾', grupo:'Ingresos (CxC)',       orden:10 },
  { clave:'cobranza',     nombre:'Cobranza',            icono:'💰', grupo:'Ingresos (CxC)',       orden:11 },
  { clave:'estadoCuenta', nombre:'Estado de Cuenta',    icono:'📑', grupo:'Dirección',            orden:6  },
  { clave:'clientes',     nombre:'Clientes',            icono:'🏢', grupo:'Ingresos (CxC)',       orden:13 },
  { clave:'gastos',       nombre:'Gastos (CxP)',        icono:'📤', grupo:'Gastos (CxP)',         orden:20 },
  { clave:'misVacaciones',nombre:'Mis Vacaciones',      icono:'🏖', grupo:'Mi espacio',           orden:5  },
  { clave:'nomina',       nombre:'Nómina',              icono:'👥', grupo:'Recursos Humanos',     orden:30 },
  { clave:'empleados',    nombre:'Empleados',           icono:'👤', grupo:'Recursos Humanos',     orden:31 },
  { clave:'vacaciones',   nombre:'Vacaciones',          icono:'🌴', grupo:'Recursos Humanos',     orden:32,
    nota:'En Ver solo aparece su propia tarjeta. De Capturar en adelante ve a toda la plantilla.' },
  { clave:'checador',     nombre:'Reloj Checador',      icono:'🕐', grupo:'Recursos Humanos',     orden:33 },
  { clave:'asistencia',   nombre:'Lista de Asistencia', icono:'📋', grupo:'Recursos Humanos',     orden:34,
    nota:'Se puede dar sin dar el Reloj Checador. En Editar además permite capturar notas de justificación.' },
  { clave:'cajaChica',    nombre:'Caja Chica',          icono:'💵', grupo:'Tesorería',            orden:40 },
  { clave:'bancos',       nombre:'Cuentas Bancarias',   icono:'🏦', grupo:'Bancos',               orden:50 },
  { clave:'reportes',     nombre:'Reportes',            icono:'📋', grupo:'Dirección',            orden:7  },
  { clave:'estadisticas', nombre:'Estadísticas',        icono:'📈', grupo:'Dirección',            orden:8  },
  { clave:'receptoras',   nombre:'Empresas Emisoras',   icono:'🏛', grupo:'Configuración',        orden:70 },
  { clave:'catalogo',     nombre:'Conceptos de Desglose',icono:'📂',grupo:'Configuración',        orden:71 },
  { clave:'usuarios',     nombre:'Usuarios y Permisos', icono:'🔒', grupo:'Administración',       orden:80 }
];

// ═══ PERFILES INICIALES ═════════════════════════════
// Reproducen exactamente lo que hoy puede cada rol, para que al encender el motor
// nadie gane ni pierda accesos. A partir de aquí ya se editan desde la pantalla.
const T = NIVEL.TODO, E = NIVEL.EDITAR, C = NIVEL.CAPTURAR, V = NIVEL.VER, N = NIVEL.NINGUNO;
const TODOS = MODULOS_SEED.map(m => m.clave);

const PERFILES_SEED = [
  { clave:'admin', nombre:'Administrador', color:'#be123c', es_sistema:true,
    descripcion:'Acceso total al sistema, incluida la gestión de usuarios y permisos.',
    permisos: Object.fromEntries(TODOS.map(k => [k, T])) },

  { clave:'gerente', nombre:'Gerente', color:'#7c3aed', es_sistema:true,
    descripcion:'Ve toda la operación y captura; no administra usuarios.',
    permisos: { ...Object.fromEntries(TODOS.map(k => [k, E])),
      gastos: T, usuarios: N } },

  { clave:'capturista', nombre:'Capturista', color:'#0891b2', es_sistema:true,
    descripcion:'Captura facturas y apoya en Recursos Humanos.',
    permisos: { facturas: E, empleados: E, vacaciones: C, gastos: C, dashboard: V, asistencia: V } },

  { clave:'tesoreria', nombre:'Tesorería', color:'#059669', es_sistema:true,
    descripcion:'Maneja caja chica y bancos.',
    permisos: { cajaChica: E, bancos: E, vacaciones: C, gastos: E, dashboard: V } },

  { clave:'tesoreria_consulta', nombre:'Tesorería (consulta)', color:'#0284c7', es_sistema:true,
    descripcion:'Consulta caja chica y bancos, sin poder modificar.',
    permisos: { cajaChica: V, bancos: V, vacaciones: C, dashboard: V } },

  { clave:'checador', nombre:'Reloj Checador', color:'#a16207', es_sistema:true,
    descripcion:'Perfil de la tablet del kiosco. Solo marca entradas y salidas.',
    permisos: { checador: C } },

  { clave:'lectura', nombre:'Solo lectura', color:'#64748b', es_sistema:true,
    descripcion:'Consulta la operación sin poder capturar ni modificar nada.',
    permisos: { dashboard: V, facturas: V, cobranza: V, estadoCuenta: V,
                clientes: V, gastos: V, reportes: V, estadisticas: V } },

  // Perfil para toda la plantilla: entra solo a pedir sus propias vacaciones.
  // Deliberadamente NO lleva el módulo 'vacaciones', que muestra los saldos y
  // solicitudes de todos; 'misVacaciones' está acotado a su propio expediente.
  { clave:'colaborador', nombre:'Colaborador', color:'#0d9488', es_sistema:true,
    descripcion:'Solo puede solicitar sus vacaciones y ver sus propios días. No ve información de nadie más.',
    permisos: { misVacaciones: C } }
];

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS fac_modulos (
        clave TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        icono TEXT,
        grupo TEXT,
        orden INT DEFAULT 99,
        nota TEXT,
        activo BOOLEAN DEFAULT TRUE
      )`);
    await query(`ALTER TABLE fac_modulos ADD COLUMN IF NOT EXISTS nota TEXT`);

    await query(`
      CREATE TABLE IF NOT EXISTS fac_perfiles (
        id SERIAL PRIMARY KEY,
        clave TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        color TEXT DEFAULT '#64748b',
        es_sistema BOOLEAN DEFAULT FALSE,
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);

    await query(`
      CREATE TABLE IF NOT EXISTS fac_perfil_permisos (
        perfil_id INT REFERENCES fac_perfiles(id) ON DELETE CASCADE,
        modulo TEXT REFERENCES fac_modulos(clave) ON DELETE CASCADE,
        nivel INT NOT NULL DEFAULT 0,
        PRIMARY KEY (perfil_id, modulo)
      )`);

    // Excepciones por persona: pisan el nivel del perfil solo en ese módulo
    await query(`
      CREATE TABLE IF NOT EXISTS fac_usuario_permisos (
        usuario_id INT REFERENCES fac_usuarios(id) ON DELETE CASCADE,
        modulo TEXT REFERENCES fac_modulos(clave) ON DELETE CASCADE,
        nivel INT NOT NULL,
        motivo TEXT,
        creado_por INT,
        creado_en TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (usuario_id, modulo)
      )`);

    // Bitácora: sirve para explicar después por qué alguien tenía cierto acceso
    await query(`
      CREATE TABLE IF NOT EXISTS fac_permisos_bitacora (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        objetivo TEXT NOT NULL,
        modulo TEXT,
        nivel_antes INT,
        nivel_despues INT,
        hecho_por INT,
        hecho_por_nombre TEXT,
        creado_en TIMESTAMP DEFAULT NOW()
      )`);

    for (const m of MODULOS_SEED) {
      await query(
        `INSERT INTO fac_modulos(clave, nombre, icono, grupo, orden, nota) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (clave) DO UPDATE
           SET nombre=EXCLUDED.nombre, icono=EXCLUDED.icono,
               grupo=EXCLUDED.grupo, orden=EXCLUDED.orden, nota=EXCLUDED.nota`,
        [m.clave, m.nombre, m.icono, m.grupo, m.orden, m.nota || null]);
    }

    for (const p of PERFILES_SEED) {
      const r = await query(
        `INSERT INTO fac_perfiles(clave, nombre, descripcion, color, es_sistema)
         VALUES($1,$2,$3,$4,TRUE)
         ON CONFLICT (clave) DO UPDATE SET es_sistema = TRUE
         RETURNING id`,
        [p.clave, p.nombre, p.descripcion, p.color]);
      const perfilId = r.rows[0].id;

      // Solo se siembra la matriz la primera vez: si ya la ajustaron desde la
      // pantalla, un reinicio del servidor no debe revertir esos cambios.
      const ya = await query(`SELECT COUNT(*)::int AS n FROM fac_perfil_permisos WHERE perfil_id=$1`, [perfilId]);
      if (ya.rows[0].n > 0) continue;
      for (const clave of TODOS) {
        await query(
          `INSERT INTO fac_perfil_permisos(perfil_id, modulo, nivel) VALUES($1,$2,$3)
           ON CONFLICT (perfil_id, modulo) DO NOTHING`,
          [perfilId, clave, p.permisos[clave] || 0]);
      }
    }
    console.log('✔ Permisos: módulos y perfiles listos');
  } catch (e) { console.warn('Migración permisos:', e.message); }
})();

// ═══ CONSULTA ═══════════════════════════════════════
// Lo que puede el usuario de la sesión. La pantalla lo pide al entrar.
router.get('/mis-permisos', async (req, res) => {
  try {
    res.json(await permisosDeUsuario(req.usuario.id, req.usuario.rol));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/modulos', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM fac_modulos WHERE activo ORDER BY orden, nombre`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ PERFILES ═══════════════════════════════════════
router.get('/perfiles', requireRol('admin'), async (req, res) => {
  try {
    const perfiles = await query(`
      SELECT p.*,
        (SELECT COUNT(*)::int FROM fac_usuarios u WHERE u.rol = p.clave AND u.activo) AS n_usuarios
      FROM fac_perfiles p WHERE p.activo ORDER BY p.es_sistema DESC, p.nombre`);
    const permisos = await query(`SELECT perfil_id, modulo, nivel FROM fac_perfil_permisos`);
    const matriz = {};
    permisos.rows.forEach(x => {
      (matriz[x.perfil_id] = matriz[x.perfil_id] || {})[x.modulo] = x.nivel;
    });
    res.json(perfiles.rows.map(p => ({ ...p, permisos: matriz[p.id] || {} })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/perfiles', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, color, copiar_de } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre del perfil requerido.' });
    // La clave se deriva del nombre: es lo que se guarda en fac_usuarios.rol
    const clave = nombre.trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    if (!clave) return res.status(400).json({ error: 'El nombre debe tener al menos una letra o número.' });

    const r = await query(
      `INSERT INTO fac_perfiles(clave, nombre, descripcion, color, es_sistema)
       VALUES($1,$2,$3,$4,FALSE) RETURNING *`,
      [clave, nombre.trim(), descripcion || null, color || '#64748b']);
    const perfilId = r.rows[0].id;

    // Arrancar copiando otro perfil ahorra llenar 17 celdas a mano
    const base = copiar_de
      ? (await query(`SELECT modulo, nivel FROM fac_perfil_permisos WHERE perfil_id=$1`, [copiar_de])).rows
      : [];
    const mods = await query(`SELECT clave FROM fac_modulos`);
    for (const m of mods.rows) {
      const b = base.find(x => x.modulo === m.clave);
      await query(`INSERT INTO fac_perfil_permisos(perfil_id, modulo, nivel) VALUES($1,$2,$3)`,
        [perfilId, m.clave, b ? b.nivel : 0]);
    }
    await bitacora('perfil_creado', r.rows[0].nombre, null, null, null, req.usuario);
    invalidarCache();
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Ya existe un perfil con ese nombre.' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/perfiles/:id', requireRol('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, color } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido.' });
    await query(`UPDATE fac_perfiles SET nombre=$1, descripcion=$2, color=$3 WHERE id=$4`,
      [nombre.trim(), descripcion || null, color || '#64748b', req.params.id]);
    invalidarCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cambiar el nivel de un módulo dentro de un perfil
router.put('/perfiles/:id/permiso', requireRol('admin'), async (req, res) => {
  try {
    const { modulo, nivel } = req.body;
    const n = parseInt(nivel);
    if (!modulo || isNaN(n) || n < 0 || n > 4)
      return res.status(400).json({ error: 'Módulo o nivel inválido.' });

    const p = await query(`SELECT nombre, clave, es_sistema FROM fac_perfiles WHERE id=$1`, [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Perfil no encontrado.' });
    // Sin esto, un descuido en la propia pantalla de permisos deja el sistema
    // sin nadie que pueda volver a entrar a arreglarlo.
    if (p.rows[0].clave === 'admin' && modulo === 'usuarios' && n < NIVEL.TODO)
      return res.status(400).json({ error: 'El perfil Administrador no puede perder el acceso a Usuarios y Permisos: nadie podría volver a configurarlos.' });

    const antes = await query(`SELECT nivel FROM fac_perfil_permisos WHERE perfil_id=$1 AND modulo=$2`,
      [req.params.id, modulo]);
    await query(
      `INSERT INTO fac_perfil_permisos(perfil_id, modulo, nivel) VALUES($1,$2,$3)
       ON CONFLICT (perfil_id, modulo) DO UPDATE SET nivel=EXCLUDED.nivel`,
      [req.params.id, modulo, n]);
    await bitacora('perfil_permiso', p.rows[0].nombre, modulo,
      antes.rows[0]?.nivel ?? null, n, req.usuario);
    invalidarCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/perfiles/:id', requireRol('admin'), async (req, res) => {
  try {
    const p = await query(`SELECT clave, nombre, es_sistema FROM fac_perfiles WHERE id=$1`, [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Perfil no encontrado.' });
    if (p.rows[0].es_sistema)
      return res.status(400).json({ error: `"${p.rows[0].nombre}" es un perfil del sistema y no se puede eliminar. Puedes ajustar sus permisos.` });

    const uso = await query(`SELECT COUNT(*)::int AS n FROM fac_usuarios WHERE rol=$1`, [p.rows[0].clave]);
    if (uso.rows[0].n > 0)
      return res.status(400).json({ error: `${uso.rows[0].n} usuario(s) tienen este perfil. Cámbialos de perfil antes de eliminarlo.` });

    await query(`DELETE FROM fac_perfiles WHERE id=$1`, [req.params.id]);
    await bitacora('perfil_eliminado', p.rows[0].nombre, null, null, null, req.usuario);
    invalidarCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ EXCEPCIONES POR USUARIO ════════════════════════
router.get('/usuarios', requireRol('admin'), async (req, res) => {
  try {
    const us = await query(`
      SELECT u.id, u.nombre, u.email, u.rol, u.activo,
             p.nombre AS perfil, p.color AS perfil_color
      FROM fac_usuarios u
      LEFT JOIN fac_perfiles p ON p.clave = u.rol
      WHERE u.activo ORDER BY u.nombre`);
    const ex = await query(`SELECT usuario_id, modulo, nivel, motivo FROM fac_usuario_permisos`);
    const porUsuario = {};
    ex.rows.forEach(x => { (porUsuario[x.usuario_id] = porUsuario[x.usuario_id] || {})[x.modulo] = x; });
    res.json(us.rows.map(u => ({ ...u, excepciones: porUsuario[u.id] || {} })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poner o quitar una excepción. nivel null borra la excepción y devuelve al perfil.
router.put('/usuarios/:id/permiso', requireRol('admin'), async (req, res) => {
  try {
    const { modulo, nivel, motivo } = req.body;
    if (!modulo) return res.status(400).json({ error: 'Módulo requerido.' });

    const u = await query(`SELECT nombre, rol FROM fac_usuarios WHERE id=$1`, [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // Nadie puede quitarse a sí mismo la llave de esta pantalla: sería la única
    // acción del sistema que no se puede deshacer desde el propio sistema.
    if (modulo === 'usuarios' && String(req.params.id) === String(req.usuario.id)
        && nivel !== null && nivel !== undefined && nivel !== '' && parseInt(nivel) < NIVEL.TODO)
      return res.status(400).json({ error: 'No puedes quitarte tu propio acceso a Usuarios y Permisos. Pídeselo a otro administrador.' });

    const antes = await query(`SELECT nivel FROM fac_usuario_permisos WHERE usuario_id=$1 AND modulo=$2`,
      [req.params.id, modulo]);

    if (nivel === null || nivel === undefined || nivel === '') {
      await query(`DELETE FROM fac_usuario_permisos WHERE usuario_id=$1 AND modulo=$2`,
        [req.params.id, modulo]);
      await bitacora('excepcion_quitada', u.rows[0].nombre, modulo,
        antes.rows[0]?.nivel ?? null, null, req.usuario);
      invalidarCache();
      return res.json({ ok: true, quitada: true });
    }

    const n = parseInt(nivel);
    if (isNaN(n) || n < 0 || n > 4) return res.status(400).json({ error: 'Nivel inválido.' });
    await query(
      `INSERT INTO fac_usuario_permisos(usuario_id, modulo, nivel, motivo, creado_por)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (usuario_id, modulo) DO UPDATE
         SET nivel=EXCLUDED.nivel, motivo=EXCLUDED.motivo, creado_en=NOW()`,
      [req.params.id, modulo, n, motivo || null, req.usuario.id]);
    await bitacora('excepcion_puesta', u.rows[0].nombre, modulo,
      antes.rows[0]?.nivel ?? null, n, req.usuario);
    invalidarCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Permisos efectivos de un usuario, con el desglose de de dónde sale cada uno
router.get('/usuarios/:id/efectivos', requireRol('admin'), async (req, res) => {
  try {
    const u = await query(`SELECT id, nombre, rol FROM fac_usuarios WHERE id=$1`, [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const perfil = await query(
      `SELECT pp.modulo, pp.nivel FROM fac_perfil_permisos pp
       JOIN fac_perfiles p ON p.id = pp.perfil_id WHERE p.clave=$1`, [u.rows[0].rol]);
    const ex = await query(`SELECT modulo, nivel, motivo FROM fac_usuario_permisos WHERE usuario_id=$1`,
      [req.params.id]);
    const dePerfil = Object.fromEntries(perfil.rows.map(x => [x.modulo, x.nivel]));
    const excep    = Object.fromEntries(ex.rows.map(x => [x.modulo, x]));
    const mods = await query(`SELECT clave FROM fac_modulos WHERE activo`);
    res.json({
      usuario: u.rows[0],
      modulos: mods.rows.map(m => ({
        modulo: m.clave,
        nivel_perfil: dePerfil[m.clave] ?? 0,
        excepcion: excep[m.clave] ? excep[m.clave].nivel : null,
        motivo: excep[m.clave]?.motivo || null,
        efectivo: excep[m.clave] ? excep[m.clave].nivel : (dePerfil[m.clave] ?? 0)
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bitacora', requireRol('admin'), async (req, res) => {
  try {
    const r = await query(`
      SELECT b.*, m.nombre AS modulo_nombre
      FROM fac_permisos_bitacora b
      LEFT JOIN fac_modulos m ON m.clave = b.modulo
      ORDER BY b.creado_en DESC LIMIT 200`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function bitacora(tipo, objetivo, modulo, antes, despues, usuario) {
  try {
    await query(
      `INSERT INTO fac_permisos_bitacora(tipo, objetivo, modulo, nivel_antes, nivel_despues, hecho_por, hecho_por_nombre)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [tipo, objetivo, modulo || null, antes, despues, usuario.id, usuario.nombre]);
  } catch (e) { /* la bitácora nunca debe tumbar la operación */ }
}

module.exports = router;
