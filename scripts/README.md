# Scripts de mantenimiento

Utilidades de un solo uso para operar directamente sobre la base de datos de Render.
**No forman parte de la aplicación** — el servidor no los ejecuta ni los importa.

Las migraciones normales del sistema son idempotentes y viven dentro de cada archivo de
`backend/routes/` (como IIFE al inicio, con `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Se aplican solas al arrancar el servidor.
Estos scripts son para casos puntuales que no encajan en ese flujo.

## Cómo ejecutarlos

Ninguno lleva la contraseña dentro. La cadena de conexión se pasa por variable de entorno:

```bash
DATABASE_URL="postgresql://usuario:password@host/basedatos" node scripts/<script>.js
```

La cadena se obtiene en Render → base de datos `facturacion_db_tbm9` → *Connection String*
(usar la **External Database URL**).

## Qué hace cada uno

| Script | Propósito |
|---|---|
| `init_full_render.js` | Crea el esquema completo desde cero y siembra el usuario admin. Solo para una instalación nueva. |
| `fix_schema_render.js` | Repara columnas faltantes en tablas ya existentes. |
| `fix_desglose_render.js` | Corrige la tabla de desglose de facturas. |
| `fix_pass_render.js` | Regenera el hash de contraseña de un usuario cuando se pierde el acceso. |
| `add_campos_clientes.js` | Agregó los campos de contacto y crédito a `fac_clientes` (junio 2026). Ya aplicado. |

## Advertencia

Escriben directo en producción y varios no son idempotentes: **respaldar antes de correrlos**.
`init_full_render.js` en particular está pensado para una base vacía.
