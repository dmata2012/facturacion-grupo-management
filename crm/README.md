# CRM Migratorio — despacho de abogados

Sistema para llevar al cliente desde el primer contacto hasta el cierre del caso
migratorio: la venta, el trámite por etapas, la cobranza, las comisiones y los
reportes de dirección.

Es un proyecto **independiente** del sistema de facturación y del sitio web que
viven en este mismo repositorio: base de datos propia, usuarios propios.

---

## 1. Qué necesitas antes de empezar

1. **Node.js 18 o superior** — compruébalo con `node --version`.
2. **Una base de datos PostgreSQL.** Lo más rápido es una gratuita en la nube
   ([Neon](https://neon.tech) o [Supabase](https://supabase.com)): te dan una
   cadena de conexión y no instalas nada en tu computadora.

## 2. Arrancar en tu computadora

**Windows** (CMD o PowerShell) — parado *dentro* de la carpeta `crm`:

```
npm install
copy .env.example .env
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

**Mac o Linux:**

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

El paso más común que falla es el primero: si `npm install` responde
`EPERM ... mkdir 'C:\'`, quiere decir que la terminal **no está dentro de la
carpeta del proyecto**. Compruébalo con `dir` (Windows) o `ls`: tienes que ver
ahí un archivo `package.json`. Truco: abre la carpeta en el Explorador, escribe
`cmd` en la barra de dirección y presiona Enter — la terminal abre ya ubicada.

Abre **http://localhost:3000**.

En `.env` hay que llenar dos cosas:

- `DATABASE_URL` — la cadena que te dio Neon o Supabase.
- `AUTH_SECRET` — genérala con:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

### Usuarios de prueba

Los crea el `seed`. **Todos usan la contraseña `demo1234`** — sirven para
probar, y hay que borrarlos o cambiarles la contraseña antes de usar el sistema
de verdad.

| Correo | Rol |
|---|---|
| `director@despacho.mx` | Director / dueño — acceso completo |
| `vendedor@despacho.mx` | Vendedor |
| `abogado@despacho.mx` | Abogado / operador |
| `contador@despacho.mx` | Contador |
| `asistente@despacho.mx` | Asistente |

---

## 3. Cómo está organizado

```
crm/
├── prisma/schema.prisma     el modelo de datos completo (21 tablas)
├── prisma/seed.ts           catálogos, plantillas y usuarios iniciales
├── auth.ts / auth.config.ts autenticación (la config ligera va aparte porque
│                            el middleware corre en Edge y no carga Prisma)
├── middleware.ts            sin sesión, todo redirige a /ingresar
├── lib/
│   ├── negocio.ts           ← las reglas del despacho viven aquí
│   ├── permisos.ts          ← qué ve cada rol, y qué registros ve
│   ├── cuotas.ts            estatus de las cuotas, calculado contra hoy
│   ├── archivos.ts          almacenamiento de documentos
│   └── prisma.ts, formato.ts, sesion.ts, mexico.ts
├── app/(panel)/             las pantallas del sistema
└── componentes/             piezas visuales compartidas
```

Si vas a modificar comportamiento, casi siempre el archivo correcto es
`lib/negocio.ts` o `lib/permisos.ts`, no la pantalla.

---

## 4. Las cuatro reglas que gobiernan el sistema

Están escritas así a propósito y no deben "simplificarse":

1. **El contacto inicial no es un prospecto.** Se captura como contacto, y solo
   pasa a prospecto calificado cuando la entrevista de valoración resulta
   viable. Si resulta no viable, se archiva y **no** cuenta como prospecto
   perdido. → `registrarEntrevista()`.

2. **Las comisiones son multi-participante con porcentaje directo.** Cada
   participante cobra su % sobre el **total de la venta**; no es una bolsa que
   se reparta entre todos, y los porcentajes no tienen por qué sumar 100. Cada
   quien tiene su propio estatus de pago. El monto se congela al calcularse,
   junto con la versión de la plantilla: cambiarla mañana no mueve lo ya
   calculado. → `aplicarPlantillaComision()`.

3. **La ubicación del cliente y la dependencia del trámite son independientes.**
   Un cliente puede vivir en CDMX y su expediente presentarse en Veracruz. El
   sistema nunca autocompleta uno con el otro.

4. **El estatus de una cuota se calcula, no se guarda.** Depende de la fecha de
   hoy, así que un valor almacenado sería mentira al día siguiente. Se deriva de
   la fecha pactada y de si hay pago registrado. → `lib/cuotas.ts`.

Además, dos automatismos: al cerrar una venta como ganada se abre solo el
expediente con su checklist, su plan de pagos y sus comisiones; y cada cambio de
etapa (de venta y de caso) queda registrado con fecha y usuario sin que nadie lo
capture. De ahí sale la fecha de presentación ante la autoridad.

---

## 5. Permisos por rol

Se resuelven en dos niveles, porque uno solo no alcanza:

- **Acceso al módulo** (`puede()`): decide el menú y corta la petición en la puerta.
- **Alcance de los datos** (`filtroVentas`, `filtroCasos`, `filtroComisiones`,
  `filtroClientes`): recorta *qué registros* ve dentro del módulo, pegado a la
  consulta de la base — el único lugar donde no se puede evadir.

| Rol | Ve |
|---|---|
| Director / dueño | Todo, incluidos reportes y todas las comisiones |
| Vendedor | Sus prospectos, sus ventas y los casos de sus ventas. Solo su propia comisión |
| Abogado / operador | Los casos que tiene asignados. No ve comisiones ajenas |
| Asistente | Captura, documentos y agenda |
| Contador | Cobros, pagos, comisiones y reportes. No entra al detalle legal del caso |

---

## 6. Qué está construido y qué no

**Listo y probado (fase 1):**

- Captura de cliente y contacto inicial, con los campos exactos pedidos
- Entrevista de valoración y conversión a prospecto calificado
- Pipeline comercial completo, con motivo de pérdida obligatorio
- Cierre ganado: abre expediente + checklist + plan de pagos + comisiones
- Pipeline legal con historial automático de etapas y fecha de presentación
- Ficha de cliente con sus cinco pestañas
- Cobros y comisiones, con pago individual por participante
- Reportes con selector de periodo (semana / mes / año)
- Autenticación y permisos por rol, aplicados también a las consultas
- Auditoría de ventas, pagos y comisiones

**Falta (fases 2 y 3):**

- **Envío real de alertas por WhatsApp y correo.** La configuración ya se
  guarda y se consulta; falta conectar el proveedor y el proceso que las dispara.
- **Agenda en vistas día / semana / mes.** Hoy es una lista cronológica que ya se
  alimenta sola de los seguimientos.
- **Pantallas para editar catálogos y plantillas.** Hoy se consultan en
  Configuración y se editan en la base de datos.
- **Rango de fechas personalizado** en reportes (están semana, mes y año).
- **Almacenamiento tipo S3.** Hoy los documentos se guardan en la carpeta
  `archivos/`, fuera de `public/`, y se sirven por una ruta que exige sesión.
  Para producción hay que cambiar `lib/archivos.ts`.

---

## 7. Antes de usarlo con datos reales

1. Cambia o borra los usuarios de prueba (todos traen `demo1234`).
2. Genera un `AUTH_SECRET` propio y distinto al de desarrollo.
3. Sustituye los catálogos de ejemplo por los tipos de trámite reales del
   despacho y sus documentos.
4. Configura respaldos de la base de datos.
5. Mueve los documentos a almacenamiento dedicado (punto anterior).
