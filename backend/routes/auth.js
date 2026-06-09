const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../config/db');

const SECRET = () => process.env.FAC_JWT_SECRET || process.env.JWT_SECRET || 'fac_secret_dev';

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

    const token = jwt.sign(
      { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
      SECRET(),
      { expiresIn: '12h' }
    );

    res.json({ token, usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol } });
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
