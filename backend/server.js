require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();

const FRONTEND_DIR = fs.existsSync(path.join(__dirname, '..', 'frontend', 'index.html'))
  ? path.join(__dirname, '..', 'frontend')
  : path.join(__dirname, 'frontend');

// ── Middlewares ───────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, cb) => {
    // En producción Render el frontend y backend son el mismo origen
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true); // sin restricción si no se configura
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin no permitido: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Sin caché para index.html — DEBE ir ANTES de express.static, de lo contrario
// express.static responde primero y estos headers nunca se aplican.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(FRONTEND_DIR, { etag: false, lastModified: false }));

// Archivos subidos protegidos
const { verificarToken } = require('./middleware/auth');
app.use('/uploads', verificarToken, express.static(path.join(__dirname, 'uploads')));

// ── Rutas API ─────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/usuarios',  require('./routes/usuarios'));
app.use('/api/clientes',  require('./routes/clientes'));
app.use('/api/facturas',  require('./routes/facturas'));
app.use('/api/pagos',     require('./routes/pagos'));
app.use('/api/nomina',    require('./routes/nomina'));
app.use('/api/vacaciones', require('./routes/vacaciones'));
app.use('/api/tesoreria',  require('./routes/tesoreria'));
app.use('/api/checador',   require('./routes/checador'));
app.use('/api/conceptos',  require('./routes/conceptos'));
app.use('/api/receptoras', require('./routes/receptoras'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/reportes',  require('./routes/reportes'));
app.use('/api/bancos',    require('./routes/bancos'));
app.use('/api/gastos',    require('./routes/gastos'));
app.use('/api/permisos',  require('./routes/permisos'));
app.use('/api/ingresos-sf', require('./routes/ingresos-sf'));

// ── Health check ──────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await require('./config/db').query('SELECT 1');
    res.json({ status: 'ok', sistema: 'facturación', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ── Version desplegada ───────────────────────
// Existe para responder de un vistazo "¿ya me llegó el cambio?". Sin esto, la
// unica forma de saberlo era probar la funcion nueva y deducirlo del resultado.
//
// arrancado_en es el momento en que este proceso levanto, o sea cuando termino
// el deploy: es el dato que de verdad importa. El commit lo pone Render solo.
const ARRANCADO_EN = new Date().toISOString();
app.get('/api/version', (req, res) => {
  const sha = process.env.RENDER_GIT_COMMIT || '';
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    commit: sha ? sha.slice(0, 7) : null,
    rama: process.env.RENDER_GIT_BRANCH || null,
    arrancado_en: ARRANCADO_EN
  });
});

// ── SPA fallback ──────────────────────────────
app.get('*', (req, res) => {
  // Cualquier ruta SPA devuelve index.html — nunca debe cachearse
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ── Error handler ─────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: 'El archivo excede 10 MB.' });
  res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
});

// ── Auto-vencer facturas ──────────────────────
async function autoVencer() {
  try {
    const { query } = require('./config/db');
    const r = await query(`
      UPDATE fac_facturas SET estatus='vencida', actualizado_en=NOW()
      WHERE estatus IN ('pendiente','parcial')
        AND fecha_vencimiento IS NOT NULL
        AND fecha_vencimiento < CURRENT_DATE
      RETURNING id
    `);
    if (r.rows.length) console.log(`⚠️  ${r.rows.length} facturas marcadas como vencidas.`);
  } catch (e) { console.warn('Auto-vencer:', e.message); }
}

// ── Iniciar ───────────────────────────────────
const PORT = process.env.FAC_PORT || process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n✅ Sistema de Facturación corriendo en http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api\n`);
  await autoVencer();

  // Importador automático de facturas por correo (IMAP)
  try {
    const { iniciarImportadorCorreo } = require('./config/imap-facturas');
    iniciarImportadorCorreo();
  } catch (e) {
    console.warn('No se pudo iniciar el importador de correo:', e.message);
  }
});
