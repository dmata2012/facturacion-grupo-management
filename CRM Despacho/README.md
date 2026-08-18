# CRM Despacho — sitio web público de Grupo Management

Sitio institucional de Grupo Management. Es un **proyecto aparte** del sistema
de facturación: vive en esta misma carpeta del repositorio, pero no comparte
código, servidor ni base de datos con `backend/` ni con `frontend/`.

- **Sin dependencias**: no hay `npm install`, no hay `node_modules`, no hay build.
- **Sin base de datos**: son páginas estáticas; nada consulta PostgreSQL.
- **Lo que ves es lo que se publica**: los archivos de `public/` se suben tal cual.

## Arrancar en local

Con Node 18 o superior instalado:

```bash
node "CRM Despacho/dev-server.js"
```

o, desde la raíz del repositorio:

```bash
npm run crm
```

Después abre **http://localhost:5173**.

Si el puerto está ocupado:

```bash
PORT=5174 node "CRM Despacho/dev-server.js"
```

El servidor de desarrollo recarga el navegador solo cada vez que guardas un
archivo dentro de `public/`. No hace falta reiniciarlo.

## Estructura

```
CRM Despacho/
├── dev-server.js        servidor de desarrollo (Node puro, con recarga en vivo)
├── package.json
├── README.md
└── public/              ← todo lo que se publica
    ├── index.html       inicio
    ├── servicios.html
    ├── nosotros.html
    ├── contacto.html
    ├── 404.html
    ├── css/estilos.css  hoja de estilos única
    ├── js/sitio.js      menú móvil, enlace activo y validación del formulario
    └── img/logo.png
```

La barra de navegación y el pie están escritos igual en las cuatro páginas.
Si cambias un enlace, cámbialo en las cuatro (son archivos estáticos, no hay
plantillas). El enlace de la página actual se resalta solo, por JavaScript.

## Editar el contenido

El texto es una primera versión con datos de ejemplo. Antes de publicar hay que
reemplazar:

| Dónde | Qué reemplazar |
|---|---|
| Pie de todas las páginas y `contacto.html` | correo `contacto@grupomanagement.mx`, teléfono `+52 (00) 0000 0000`, dirección |
| `index.html` (portada) | los cuatro números: años, clientes, tiempo de respuesta |
| `nosotros.html` | la historia y los números de la empresa |
| `servicios.html` | descripciones y alcance real de cada servicio |

Los colores, tipografías y radios están todos en las variables del inicio de
`public/css/estilos.css`, tomados del sistema de facturación para que ambos se
vean como la misma empresa (rojo `#9B1528`, tipografía Inter).

## Formulario de contacto

Hoy el formulario **valida en el navegador y muestra un acuse, pero no envía
nada a ningún lado**. Para que llegue el mensaje hay dos caminos:

1. **Servicio externo** (lo más rápido): apuntar el `<form>` a un servicio de
   formularios y quitar el `e.preventDefault()` de `public/js/sitio.js`.
2. **Endpoint propio**: agregar una ruta en el backend existente
   (por ejemplo `POST /api/contacto`) y enviar los datos con `fetch` desde
   `sitio.js`. Ahí sí entraría PostgreSQL, si se quiere guardar cada solicitud.

Mientras no exista ninguno de los dos, el aviso de "recibimos tus datos" es solo
visual: conviene dejar visible el correo y el teléfono, como está ahora.

## Publicar

Al no haber build, se sube la carpeta `public/` completa a cualquier hosting
estático (Netlify, Vercel, Cloudflare Pages, GitHub Pages, o un bucket detrás de
un CDN). En Render funciona como *Static Site* con:

- **Publish directory**: `CRM Despacho/public`
- **Build command**: *(vacío)*

`dev-server.js` es solo para desarrollo; no se usa en producción.
