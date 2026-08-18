# CRM Despacho — sitio web

Sitio web nuevo, **independiente**. No comparte código, servidor ni base de
datos con el sistema de facturación de este repositorio: puedes copiar esta
carpeta a donde quieras y funciona sola.

- **Sin instalaciones**: no hay `npm install`, no hay `node_modules`, no hay build.
- **Sin base de datos**: son páginas estáticas.
- **Lo que ves es lo que se publica**: los archivos de `public/` se suben tal cual.

Lo único que necesitas es **Node 18 o superior** instalado.
Para comprobar que lo tienes, abre una terminal y escribe `node --version`.

---

## 1. Trabajar en tu computadora

Copia esta carpeta a donde quieras (por ejemplo `C:\Proyectos\CRM Despacho` en
Windows, o `~/Proyectos/CRM Despacho` en Mac). Después, desde la terminal:

```bash
cd "CRM Despacho"
node dev-server.js
```

Abre **http://localhost:5173** en el navegador.

Edita cualquier archivo de `public/`, guarda, y el navegador se recarga solo.
No hace falta reiniciar el servidor. Para detenerlo: `Ctrl + C`.

Si el puerto 5173 está ocupado:

```bash
PORT=5174 node dev-server.js
```

(En Windows con PowerShell: `$env:PORT=5174; node dev-server.js`)

---

## 2. Qué hay en cada archivo

```
CRM Despacho/
├── dev-server.js        servidor para trabajar en local (no se publica)
├── package.json
├── README.md            este archivo
└── public/              ← TODO lo que se publica está aquí
    ├── index.html       inicio
    ├── servicios.html
    ├── nosotros.html
    ├── contacto.html
    ├── 404.html         página de error
    ├── css/estilos.css  todos los colores y estilos, en un solo archivo
    ├── js/sitio.js      menú del celular, enlace activo, validación del formulario
    └── img/logo.png
```

La barra de navegación y el pie de página están escritos igual en las cinco
páginas. Si cambias un enlace, cámbialo en las cinco (son archivos estáticos,
no hay plantillas). El enlace de la página en que estás se resalta solo.

Los colores y tipografías están juntos al inicio de `public/css/estilos.css`,
en la sección de variables. Cambiando ahí el rojo, cambia en todo el sitio.

---

## 3. Antes de publicar: qué hay que reemplazar

El texto actual es una primera versión con **datos de ejemplo inventados**:

| Dónde | Qué reemplazar |
|---|---|
| Pie de las 5 páginas y `contacto.html` | correo `contacto@grupomanagement.mx`, teléfono `+52 (00) 0000 0000`, dirección |
| `index.html` (portada) | los cuatro números: años, clientes, tiempo de respuesta |
| `nosotros.html` | la historia y los números reales de la empresa |
| `servicios.html` | descripciones y alcance real de cada servicio |

## 4. El formulario de contacto

Hoy **valida los datos y muestra un acuse, pero no envía nada a ningún lado**.
Mientras no se conecte, deja visibles el correo y el teléfono, como están ahora.

Para que los mensajes lleguen, cuando el sitio ya esté publicado, hay dos caminos:

1. **Servicio externo** (lo más rápido, sin programar): apuntar el `<form>` a un
   servicio de formularios y quitar el `e.preventDefault()` de `public/js/sitio.js`.
2. **Endpoint propio**: una ruta en un backend que reciba los datos y los envíe
   por correo o los guarde.

---

## 5. Publicar el sitio

No hay que compilar nada: se sube la carpeta `public/` completa a cualquier
hosting estático (Netlify, Vercel, Cloudflare Pages, GitHub Pages, o el hosting
donde ya tengas el dominio).

En Render se publica como **Static Site**:

- **Publish directory**: `public`
- **Build command**: *(vacío)*

`dev-server.js` es solo para trabajar en local; en producción no se usa.
