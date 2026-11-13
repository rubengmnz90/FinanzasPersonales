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

## Docker

```
cp .env.example .env        # SEED_USER_PASSWORD, POSTGRES_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

La app queda en `PUBLIC_URL` (por defecto http://localhost:3000). Al arrancar migra y siembra el usuario `SEED_EMAIL`; el primer ingreso obliga a cambiar la contraseña (mínimo 8 caracteres). El registro está cerrado (`ALLOW_SIGNUP=false`).

Importar el Excel dentro del contenedor:

```
docker compose cp "Administracion 2026.xlsx" app:/tmp/admin.xlsx
docker compose exec app pnpm import-excel --file /tmp/admin.xlsx
```

Backup: `docker compose exec db pg_dump -U postgres finanzas > backup.sql`

Si publicas con HTTPS, pon `PUBLIC_URL=https://...` (activa cookies `secure`).

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
