# Finanzas personales

Reemplaza la planilla "Administracion 2026": flujo de caja, planes (mensual / quincenal / varios por mes), ahorro, tarjetas, deudas con la esposa, caja de Vibra Lejana y distribución de compras. Moneda: guaraníes. Multiusuario con login; incluye un servidor MCP para conectar una IA.

Stack: Fastify + PostgreSQL (`pg`), React + Vite, pnpm workspaces (`apps/server`, `apps/web`, `packages/shared`).

## Desarrollo local

```
pnpm install
cp .env.example .env        # completar DATABASE_URL y SEED_USER_PASSWORD
pnpm -F server seed         # migra y crea el usuario inicial (debe cambiar la clave al primer ingreso)
pnpm -F server import-excel --file "C:\ruta\Administracion 2026.xlsx" [--user email] [--dry-run]
pnpm build                  # compila el frontend (apps/web/dist)
pnpm -F server start        # http://localhost:3000
```

Tests: `pnpm test` (necesita `TEST_DATABASE_URL`); E2E: `cd apps/web && npx playwright test` (usa la base `finanzas_test`, instala Chrome del sistema).

## Despliegue en tu servidor (Docker)

Requisitos: un servidor con Docker y el plugin Compose.

```
git clone https://github.com/rubengmnz90/FinanzasPersonales.git
cd FinanzasPersonales
cp .env.example .env     # edítalo: POSTGRES_PASSWORD, SEED_USER_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

- La app escucha en el puerto `PORT` (3000) y la base Postgres queda dentro de la red de Docker, sin publicarse.
- Al arrancar **migra** la base y **siembra** el usuario `SEED_EMAIL` con la clave `SEED_USER_PASSWORD` (solo si aún no existe; nunca pisa la contraseña de un usuario existente). El primer ingreso obliga a cambiarla (mínimo 8 caracteres). El registro está cerrado (`ALLOW_SIGNUP=false`).
- `GET /healthz` responde `{"ok":true}` cuando la app y la base funcionan; Docker lo usa como healthcheck (`docker compose ps` muestra `healthy`).
- Datos persistentes en el volumen `pgdata`. No lo borres con `docker compose down -v`.

### HTTPS y dominio

Publica la app detrás de un proxy con HTTPS y pon `PUBLIC_URL=https://tu-dominio` en `.env` (activa cookies `secure` y es la URL que usa la IA por MCP). Ejemplo con Caddy (certificado automático):

```
tu-dominio.com {
    reverse_proxy localhost:3000
}
```

### Base de datos externa (p. ej. Supabase)

Define `DATABASE_URL` en `.env` y levanta solo la app: `docker compose -f docker-compose.external.yml up -d --build`. Con Supabase usa la cadena del *Session pooler* (puerto 5432) y activa RLS en las tablas de `public` (la app se conecta con el rol `postgres`, que no la sufre).

### Actualizar, respaldar, importar

```
git pull && docker compose up -d --build          # actualizar (las migraciones corren solas)
docker compose exec db pg_dump -U postgres finanzas > backup.sql      # respaldo
docker compose cp "Administracion 2026.xlsx" app:/tmp/admin.xlsx
docker compose exec app ./node_modules/.bin/tsx src/import/cli.ts --file /tmp/admin.xlsx   # importar el Excel
```

### Antes de abrirlo a internet

- Cambia `POSTGRES_PASSWORD` y `SEED_USER_PASSWORD` (no dejes `12345`) y no subas `.env`.
- Mantén `ALLOW_SIGNUP=false`.
- Programa el respaldo de `pg_dump` (cron) y guárdalo fuera del servidor.
- Todo cambio queda en **Historial** (con deshacer), incluidos los de la IA.

## Conectar una IA (MCP)

En la app: **Conectar IA**. O por consola:

```
claude mcp add --transport http finanzas http://localhost:3000/mcp
```

Claude abre el navegador, inicias sesión y apruebas los permisos (`finanzas:read`, `finanzas:write`). Puedes revocar la conexión desde la misma pantalla.

## Cuentas, transferencias, ahorro y préstamos

- **Flujo de caja** (pantalla Flujo): solo usa cuentas propias *marcadas para el flujo* (por defecto GNB, predeterminada, y Familiar). Se marca o desmarca al editar la cuenta ("Usar en el flujo de caja"). Efectivo viene desmarcado. Las tarjetas y el ahorro nunca entran al flujo; pagar una tarjeta es una transferencia banco → tarjeta.
- **Cuentas**: bancos, efectivo y cajas. La caja **Vibra Lejana** (alias rubengmnz90@gmail.com, Banco Familiar) tiene su pestaña *Movimientos* editable.
- **Tarjetas y ahorro**: tarjetas con su deuda y el ahorro **Coomecipar** (alias 2946999-6) dividido por objetivo (Ahorro, Aguinaldo, Vacaciones, Emma…). Cada objetivo se marca *intocable* o *tocable*; se muestran el total, el monto intocable y el "saldo que puedo tocar" (igual que el Excel). Prestar desde un objetivo intocable pide confirmación.
- **Transferir**: entre cuentas, pasar a ahorro eligiendo el objetivo, préstamo del ahorro (queda pendiente hasta devolver) y devolución.
- **Saldo inicial**: el saldo de cada cuenta es *saldo inicial + movimientos*; edita la cuenta para que coincida con el banco.
- **Préstamos**: pestaña *Deudas con mi esposa* (casa, casamiento, normal, boda) y pestaña *Préstamos con cuotas* (Coomecipar, equipos de Vibra Lejana y los nuevos). Cada cuota se marca pagada (registra el egreso en el flujo, o en la caja de Vibra Lejana). Un préstamo nuevo puede quedar *en la proyección*: sus cuotas pendientes se suman a los gastos planeados. El de Coomecipar amortiza distinto: se agregan las cuotas a mano.
- **Ejecutar plan** (Planes): registra el honorario y los pagos de un cobro/mes eligiendo cuenta por línea. El cobro de **Fin de mes** entra el **día 1** del mes (aunque se cobre el 30 del anterior); la quincena, el día 15. No se duplica si lo vuelves a ejecutar.
- **Flujo**: además del saldo, muestra el *disponible a inicio de mes* y el *disponible en la quincena*.
- **Resúmenes → Sanidad**: semáforo de liquidez, colchón, tarjetas, deudas, ahorro mensual y orden de datos.

## Notas de importación

- Se ignoran las hojas desde "MejoraFinanciera" en adelante, "Proyeccion Mensual" antigua, "Ahorro e Inversion" y "Honorarios".
- Fechas asumidas: Quincena → día 15, Fin de mes → último día, año 2026; Vibra Lejana → 2026-01-01; Deuda Casamiento → 2024-01-01.
- "Otros gastos" del plan se calcula desde los gastos con fecha; un valor escrito a mano lo pisa (celda naranja, `Supr` vuelve al cálculo).
- "Ahorro pendiente" se calcula en vivo; el Excel tenía una cifra fija desactualizada.
