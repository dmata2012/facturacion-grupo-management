/**
 * Servidor de desarrollo del sitio público — sin dependencias.
 *
 * Sirve todo lo que está en sitio/public y recarga el navegador solo cuando
 * un archivo cambia. No hay build ni node_modules: lo que se ve aquí es
 * exactamente lo que se publica.
 *
 *   node sitio/dev-server.js          → http://localhost:5173
 *   PORT=8080 node sitio/dev-server.js
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const RAIZ   = path.join(__dirname, 'public');
const PUERTO = Number(process.env.PORT || process.env.SITIO_PORT || 5173);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg' : 'image/svg+xml',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif' : 'image/gif',
  '.webp': 'image/webp',
  '.ico' : 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf' : 'application/pdf',
  '.txt' : 'text/plain; charset=utf-8'
};

// ── Recarga en vivo ───────────────────────────
// Cada pestaña abierta deja aquí su conexión SSE; al cambiar un archivo se les
// avisa a todas y se recargan solas.
const clientes = new Set();

const SCRIPT_RECARGA = `
<script>
(function(){
  var es = new EventSource('/__recarga');
  es.onmessage = function(){ location.reload(); };
  es.onerror = function(){ /* el servidor se reinició: el navegador reintenta solo */ };
})();
</script>
`;

function avisarCambio(archivo) {
  console.log(`↻ ${archivo} — recargando ${clientes.size} pestaña(s)`);
  for (const res of clientes) res.write('data: cambio\n\n');
}

let ultimoAviso = 0;
fs.watch(RAIZ, { recursive: true }, (_evento, archivo) => {
  if (!archivo) return;
  // fs.watch dispara varias veces por un solo guardado; con 100 ms basta.
  const ahora = Date.now();
  if (ahora - ultimoAviso < 100) return;
  ultimoAviso = ahora;
  avisarCambio(archivo);
});

// ── Resolución de rutas ───────────────────────
// "/servicios" y "/servicios.html" llevan al mismo archivo: así las URLs del
// sitio se ven limpias en desarrollo igual que en producción.
function resolverArchivo(urlPath) {
  const limpio = decodeURIComponent(urlPath.split('?')[0]);
  const destino = path.normalize(path.join(RAIZ, limpio));

  // Nunca servir fuera de public/, aunque la URL traiga "../".
  if (!destino.startsWith(RAIZ)) return null;

  const candidatos = [];
  if (limpio.endsWith('/')) {
    candidatos.push(path.join(destino, 'index.html'));
  } else {
    candidatos.push(destino);
    candidatos.push(destino + '.html');
    candidatos.push(path.join(destino, 'index.html'));
  }

  for (const c of candidatos) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// ── Servidor ──────────────────────────────────
const servidor = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/__recarga') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('retry: 1000\n\n');
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
    return;
  }

  const archivo = resolverArchivo(req.url);

  if (!archivo) {
    const pagina404 = path.join(RAIZ, '404.html');
    const existe404 = fs.existsSync(pagina404);
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      existe404
        ? fs.readFileSync(pagina404, 'utf8').replace('</body>', SCRIPT_RECARGA + '</body>')
        : '<h1>404 — página no encontrada</h1>'
    );
  }

  const ext  = path.extname(archivo).toLowerCase();
  const tipo = TIPOS[ext] || 'application/octet-stream';

  // En desarrollo nada se cachea: al recargar siempre se ve el último cambio.
  const cabeceras = { 'Content-Type': tipo, 'Cache-Control': 'no-store' };

  if (ext === '.html') {
    const html = fs.readFileSync(archivo, 'utf8');
    const conRecarga = html.includes('</body>')
      ? html.replace('</body>', SCRIPT_RECARGA + '</body>')
      : html + SCRIPT_RECARGA;
    res.writeHead(200, cabeceras);
    return res.end(conRecarga);
  }

  res.writeHead(200, cabeceras);
  fs.createReadStream(archivo).pipe(res);
});

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✖ El puerto ${PUERTO} ya está ocupado.`);
    console.error(`  Prueba: PORT=${PUERTO + 1} node sitio/dev-server.js\n`);
    process.exit(1);
  }
  throw e;
});

servidor.listen(PUERTO, () => {
  console.log(`\n✅ Sitio Grupo Management — desarrollo`);
  console.log(`   http://localhost:${PUERTO}`);
  console.log(`   Carpeta: ${RAIZ}`);
  console.log(`   Guarda un archivo y el navegador se recarga solo.\n`);
});
