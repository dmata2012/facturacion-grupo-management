const { query } = require('../config/db');

// Cinco niveles, iguales para todos los módulos. Son acumulativos: quien puede
// editar también puede capturar y ver, así que basta comparar con >=.
const NIVEL = {
  NINGUNO : 0,   // ni aparece en el menú
  VER     : 1,   // consultar y exportar
  CAPTURAR: 2,   // crear registros
  EDITAR  : 3,   // crear y modificar
  TODO    : 4    // además borrar y configurar
};

const NOMBRE_NIVEL = {
  0: 'Sin acceso', 1: 'Ver', 2: 'Capturar', 3: 'Editar', 4: 'Administrar'
};

// Un usuario activo consulta muchas pantallas seguidas; sin caché serían dos
// consultas extra por petición. 30 s es suficiente para que un cambio de
// permisos se sienta inmediato sin castigar la base.
const _cache = new Map();
const TTL_MS = 30 * 1000;

function invalidarCache(usuarioId) {
  if (usuarioId) _cache.delete(usuarioId);
  else _cache.clear();
}

// Permiso efectivo = excepción del usuario, si existe; si no, el nivel de su perfil.
async function permisosDeUsuario(usuarioId, rol) {
  const cacheado = _cache.get(usuarioId);
  if (cacheado && cacheado.expira > Date.now()) return cacheado.datos;

  const niveles = {};
  try {
    const perfil = await query(
      `SELECT pp.modulo, pp.nivel
         FROM fac_perfil_permisos pp
         JOIN fac_perfiles p ON p.id = pp.perfil_id
        WHERE p.clave = $1 AND p.activo`, [rol]);
    perfil.rows.forEach(x => { niveles[x.modulo] = x.nivel; });

    const ex = await query(
      `SELECT modulo, nivel FROM fac_usuario_permisos WHERE usuario_id = $1`, [usuarioId]);
    ex.rows.forEach(x => { niveles[x.modulo] = x.nivel; });
  } catch (e) {
    // Si las tablas aún no existen (primer arranque tras el deploy), se devuelve
    // vacío y el llamador decide: el frontend cae a su lógica anterior.
    return { niveles: {}, listo: false, motivo: 'sin_tablas' };
  }

  // Válvula de seguridad: si el rol del usuario no corresponde a ningún perfil,
  // su matriz saldría vacía y quedaría encerrado fuera del sistema. En ese caso
  // se declara "no listo" para que se aplique la lógica anterior de roles.
  if (!Object.keys(niveles).length)
    return { niveles: {}, listo: false, motivo: 'perfil_no_encontrado', rol };

  const datos = { niveles, listo: true };
  _cache.set(usuarioId, { datos, expira: Date.now() + TTL_MS });
  return datos;
}

async function nivelEn(usuario, modulo) {
  const p = await permisosDeUsuario(usuario.id, usuario.rol);
  return p.niveles[modulo] ?? 0;
}

// Middleware. Sustituye a requireRol(): en vez de enumerar roles en cada ruta,
// se declara qué módulo y qué nivel hace falta.
//
//   router.delete('/:id', permiso('gastos', NIVEL.TODO), handler)
//
// Los módulos se migran de uno en uno; mientras tanto requireRol sigue vigente
// en los que aún no se han pasado.
function permiso(modulo, nivelMinimo = NIVEL.VER) {
  return async (req, res, next) => {
    try {
      if (!req.usuario) return res.status(401).json({ error: 'Sesión no válida.' });
      const p = await permisosDeUsuario(req.usuario.id, req.usuario.rol);
      // Sin tablas de permisos todavía: no se bloquea a nadie, para que un deploy
      // a medias no deje el sistema inservible.
      if (!p.listo) return next();
      const nivel = p.niveles[modulo] ?? 0;
      if (nivel >= nivelMinimo) return next();
      return res.status(403).json({
        error: nivel === 0
          ? 'No tienes acceso a este módulo.'
          : `Tu permiso aquí es "${NOMBRE_NIVEL[nivel]}" y esta acción requiere "${NOMBRE_NIVEL[nivelMinimo]}".`
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

module.exports = { NIVEL, NOMBRE_NIVEL, permiso, permisosDeUsuario, nivelEn, invalidarCache };
