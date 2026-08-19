# CRM Migratorio — despacho de abogados

Sistema para llevar al cliente desde el primer contacto hasta el cierre del caso
migratorio: la venta, el trámite por etapas, la cobranza, las comisiones y los
reportes de dirección.

Es un proyecto **independiente** del sistema de facturación y del sitio web que
viven en este mismo repositorio: base de datos propia, usuarios propios.

---

## 1. Qué necesitas antes de empezar

1. **Node.js 20.9 o superior** — compruébalo con `node --version`. Si te falta
   o tienes una versión anterior, descárgalo de [nodejs.org](https://nodejs.org)
   (la opción **LTS**) y reinicia la terminal después de instalarlo.
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
- Configuración editable desde el sistema: tipos de trámite con sus etapas y
  checklist, catálogos, plantillas de comisión, motor de alertas y usuarios

**Falta (fases 2 y 3):**

- **Envío real de alertas por WhatsApp y correo.** La configuración ya se
  guarda y se consulta; falta conectar el proveedor y el proceso que las dispara.
- **Agenda en vistas día / semana / mes.** Hoy es una lista cronológica que ya se
  alimenta sola de los seguimientos.
- **Rango de fechas personalizado** en reportes (están semana, mes y año).
- **Almacenamiento tipo S3.** Los documentos se guardan en disco (en local, la
  carpeta `archivos/`; en Render, el disco persistente montado), fuera de
  `public/` y servidos por una ruta que exige sesión. Funciona bien, pero atado
  a una sola máquina: el día que el sistema corra en varias, hay que mover esto
  a S3 o equivalente. Solo implica cambiar `lib/archivos.ts`.

---

## 7. Antes de usarlo con datos reales

1. Cambia o borra los usuarios de prueba (todos traen `demo1234`).
2. Genera un `AUTH_SECRET` propio y distinto al de desarrollo.
3. Sustituye los catálogos de ejemplo por los tipos de trámite reales del
   despacho y sus documentos.
4. Configura respaldos de la base de datos.
5. Mueve los documentos a almacenamiento dedicado (punto anterior).

---

## 8. Publicar en Render

Render **no acepta un ZIP**: solo despliega desde un repositorio de GitHub, así
que primero hay que subir el proyecto (sección 9).

El repositorio trae un `render.yaml` que declara todo: el servicio web, la base
de datos PostgreSQL y el disco donde viven los documentos. En el panel de
Render: **New → Blueprint**, eliges el repositorio, **Apply**. No hay variables
que capturar a mano — la cadena de conexión se inyecta sola desde la base
declarada, y `AUTH_SECRET` la genera Render.

El primer despliegue tarda entre 3 y 6 minutos. Las migraciones corren dentro
del build, así que las tablas quedan creadas sin ejecutar nada aparte, y cada
despliegue futuro deja la base al día igual.

### Lo que crea el blueprint

| Recurso | Plan | Para qué |
|---|---|---|
| Servicio web `crm-migratorio` | starter | La aplicación |
| Base `crm-migratorio-db` | basic-256mb | Los datos |
| Disco `documentos`, 5 GB en `/var/data` | — | Los archivos de los expedientes |

Los tres son de pago a propósito. En el plan gratuito el servicio se duerme
tras unos minutos sin uso, las bases caducan y Render las elimina, y no existen
los discos persistentes: los documentos se borrarían en cada despliegue.

Si Render no reconoce alguno de los nombres de plan (los cambia de vez en
cuando), elige el equivalente en el panel al aplicar el blueprint.

### Crear el primer usuario

Al terminar el despliegue la aplicación responde, pero **no hay usuarios**: en
producción el seed no crea los de prueba, porque comparten una contraseña
conocida. Para dar de alta el primer acceso, desde tu computadora con el `.env`
apuntando a la base de producción:

```
npm run crear-usuario
```

La cadena de conexión de la base la copias del panel de Render, en la sección
**Connect** de `crm-migratorio-db` (usa la *External Connection String*).

### Después del primer despliegue

1. **Activa los respaldos** de la base en el panel de Render. La base es el
   sistema: si se pierde, se perdieron los expedientes, la cobranza y las
   comisiones. Comprueba una vez que sabes restaurarlos.
2. **Dominio propio**, si lo quieres: se configura en Settings → Custom Domains.
3. El disco puede crecer cuando haga falta, pero **no se puede reducir**.

## 9. Subir el proyecto a un repositorio nuevo de GitHub

Render necesita el código en GitHub. Desde la carpeta del proyecto:

```
git init
git add .
git commit -m "CRM migratorio: version inicial"
git branch -M main
git remote add origin https://github.com/USUARIO/crm-migratorio.git
git push -u origin main
```

Antes hay que crear el repositorio **vacío** en https://github.com/new — sin
README, sin `.gitignore` y sin licencia, o el `push` choca. Márcalo **privado**:
el código no contiene datos de clientes, pero sí la lógica del despacho.

El `.gitignore` ya excluye lo que nunca debe subir: `node_modules`, la carpeta
`archivos/` con los documentos y, sobre todo, el `.env` con tus contraseñas.
