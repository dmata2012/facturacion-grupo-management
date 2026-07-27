const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../config/db');

const SECRET = () => process.env.FAC_JWT_SECRET || process.env.JWT_SECRET || 'fac_secret_dev';

// El rol se guarda en la BD sin validación, así que puede llegar con variantes
// ('Gerencia', 'GERENTE', 'tesorería'…). Se normaliza al valor canónico que
// entienden requireRol() y los PAGES_* del frontend.
const ALIAS_ROL = {
  gerencia: 'gerente', gerentes: 'gerente', gerencial: 'gerente',
  administrador: 'admin', administradora: 'admin',
  capturistas: 'capturista', captura: 'capturista',
  tesoreria: 'tesoreria', tesorera: 'tesoreria', tesorero: 'tesoreria',
  'tesoreria consulta': 'tesoreria_consulta', 'tesoreria-consulta': 'tesoreria_consulta',
  consulta: 'lectura', lector: 'lectura', lectora: 'lectura',
  reloj: 'checador', checadora: 'checador'
};
function normalizarRol(rol) {
  const base = String(rol || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // quita acentos
  return ALIAS_ROL[base] || base;
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos.' });

    const r = await query('SELECT * FROM fac_usuarios WHERE email=$1 AND activo=TRUE', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenciales inválidas.' });

    const user = r.rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas.' });

    const rol = normalizarRol(user.rol);
    const token = jwt.sign(
      { id: user.id, nombre: user.nombre, email: user.email, rol },
      SECRET(),
      { expiresIn: '12h' }
    );

    res.json({ token, usuario: { id: user.id, nombre: user.nombre, email: user.email, rol } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').verificarToken, (req, res) => {
  res.json(req.usuario);
});

module.exports = router;
module.exports.normalizarRol = normalizarRol;
