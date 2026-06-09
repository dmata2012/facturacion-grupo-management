const jwt = require('jsonwebtoken');

function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acceso denegado. Inicia sesión.' });

  try {
    const decoded = jwt.verify(token, process.env.FAC_JWT_SECRET || process.env.JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch {
    return res.status(403).json({ error: 'Sesión expirada o token inválido.' });
  }
}

function requireRol(...roles) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'No autenticado.' });
    if (!roles.includes(req.usuario.rol))
      return res.status(403).json({ error: `Acceso denegado. Requiere: ${roles.join(' o ')}.` });
    next();
  };
}

module.exports = { verificarToken, requireRol };
