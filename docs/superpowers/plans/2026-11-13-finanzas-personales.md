# Finanzas Personales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App web multiusuario (Vite + backend propio) que reemplaza `Administracion 2026.xlsx`: flujo de caja, proyección por cobro con varios planes, ahorro/tarjetas/deudas, migración completa del Excel, listo para 2027 y con un servidor MCP autenticado por navegador.

**Architecture:** Monorepo pnpm. `apps/server` (Fastify + SQLite vía Drizzle) expone API REST y `/mcp` (MCP Streamable HTTP con OAuth 2.1 + PKCE). `apps/web` (Vite + React + TS) usa grillas editables estilo hoja de cálculo. `packages/shared` tiene el parser de expresiones, el dinero y los esquemas zod que comparten server, web y MCP. Una sola capa de servicios (`modules/*`) la usan REST y MCP, siempre con `userId` explícito.

**Tech Stack:** Node 22, TypeScript, pnpm workspaces, Fastify, Drizzle ORM + better-sqlite3, argon2, zod, `@modelcontextprotocol/sdk`, Vite, React, TanStack Query, TanStack Table, Vitest, Playwright, `exceljs` (solo importador).

**Spec:** No hay documento de diseño separado. La fuente es `C:\Users\Ruben\Downloads\Administracion 2026.xlsx` más la sección "Hallazgos del Excel" de este plan (derivada de leer las 16 hojas, fórmulas y valores cacheados).

## Hallazgos del Excel (lo que hay que migrar y replicar)

| Hoja | Qué es | Modelo destino |
|---|---|---|
| `Flujo` | Libro de movimientos: Fecha, Item, Ingreso, Egreso, Saldo acumulado, Subgrupo, Observación. 1.400 filas reales (ene–nov 2026; el resto son filas vacías con fórmulas). El Grupo sale de `VLOOKUP(Subgrupo, Grupos)`. Hay montos como fórmula (`=45814+4581`). Fila 2 es el "Saldo inicial" (Honorarios 1.500.000). | `transactions` |
| `Grupos` | 5 grupos (Ingresos, Egresos, Gasto, Inversion, Otros) y 32 subgrupos, cada uno con su grupo. | `categories` |
| `Proyeccion Mensual 2026` / `2027` | Dos bloques idénticos: **Fin de mes** (cols D:O) y **QUINCENA** (cols T:AE). Cada bloque: filas de GASTOS, filas de INGRESOS, Total, Neto por mes. La fila "Otros gastos" se calcula con `SUMIFS` desde `Otros gastos` por mes y cobro. | `plans`, `plan_periods`, `plan_items`, `plan_cells` |
| `Otros gastos` (B:F) | Gastos puntuales: Concepto, Monto, Grupo (`Fin`/`Quincena` = en qué cobro se paga), Mes (texto), Realizado (`Ok`). Sin año: es 2026. | `planned_expenses` |
| `Otros gastos` (I:M) | "Ahorro emma": fondo con depósitos de 100.000/mes y retiros negativos con fecha. Suma = 132.137. | cuenta `fund` |
| `Ahorro` (A:D) | Aportes a ahorro (cuenta Coomecipar; concepto Ahorro/Aguinaldo). | cuenta `savings` |
| `Ahorro` (K:N) | "Reponer X": retiros temporales del ahorro que se devuelven (el lío). | movimientos de `savings` con etiqueta `temp_withdrawal` |
| `Ahorro` (F:G) | Caja de Vibra Lejana: entradas/gastos del grupo, saldo 1.189.912, total gastado 12.121.539. | cuenta `cash_box` |
| `Ahorro` (P:T) y `Tarjetas` (B:F) | **Mismo dato duplicado**: tarjeta Coomecipar, línea 3.000.000, Saldo = disponible, Deuda = Saldo − línea. | cuenta `card` (importar una sola vez) |
| `Tarjetas` (J:N) | Tarjeta GNB, línea 7.000.000. | cuenta `card` |
| `Como` | Auxiliar de recuperación: deuda de tarjeta (2.045.068) y de ahorro (2.188.387) menos lo ya pagado por etiqueta (T/A/V/F) → pendiente; plan por cobro (Quincena/Inicio de cada mes) con ingreso 5.500.000, asignaciones y saldo libre. | `recovery_allocations` + deudas leídas de ledgers |
| `Plantilla distribucion` | Compras compartidas: Total, Descuento %, % por persona (Emma/Ali/Yo), `ROUND` por persona, totales por persona. | `splits` |
| `Prestamos` | 4 libros debe/haber con saldo acumulado (préstamo "normal", Boda, Casa) + resumen: Deuda Casa −3.994.472, Prestamo −4.945.572, normal −1.889.745, Casamiento −11.000.000 (fijo), Devolución 41.000, total −21.788.789. | cuentas `debt` |
| `Resumen Mensual` / `Resumen Anual` | Tablas dinámicas vacías sobre Flujo. | Pantallas de resumen |
| `MejoraFinanciera`, `Proyeccion Mensual` (vieja), `Ahorro e Inversion`, `Honorarios` | Fuera de alcance (indicado por el usuario: "de mejora financiera en adelante no hace falta"). | No se migran |

Supuestos que se asumen y se documentan en la UI de importación (corregibles sin tocar código):
- Moneda: guaraníes (PYG), enteros, sin decimales. Los porcentajes de `Plantilla` son la única fracción.
- `Otros gastos` no trae año: se importa como 2026.
- `Prestamos` son deudas que el usuario debe (saldo negativo); el modelo de ledger sirve igual si fueran a favor.
- Las celdas stray `K430:M434` de `Flujo` (columnas fuera de tabla) no se migran y salen en el reporte.

## Global Constraints

- Idioma de la UI: español; código e identificadores en inglés.
- Dinero: entero PYG en `INTEGER`; nunca `float` en almacenamiento. Formato de UI `es-PY` (`1.050.000`).
- Todo acceso a datos recibe `userId` y filtra por él; no existe consulta sin `user_id`.
- Usuario inicial: `rubengmnz90@gmail.com`, creado por el script de seed con la contraseña de la variable de entorno `SEED_USER_PASSWORD`; la contraseña **nunca** va en el repo, el código ni los logs; `must_change_password = 1` obliga a cambiarla en el primer login.
- Registro abierto controlado por `ALLOW_SIGNUP=true|false` (por defecto `false`).
- Contraseñas con argon2id; sesión web en cookie `httpOnly`, `sameSite=lax`, `secure` en producción; límite de 10 intentos de login por minuto por IP+email.
- MCP: transporte Streamable HTTP en `/mcp`, OAuth 2.1 con PKCE `S256`, registro dinámico de clientes, scopes `finanzas:read` y `finanzas:write`, tokens guardados como hash. Al conectar, el navegador abre login + pantalla de autorización.
- Nunca `eval`/`Function` para fórmulas; solo el parser propio de expresiones aritméticas.
- Respuesta de grilla ≤ 100 ms para editar una celda (actualización optimista) con 1.400+ filas.

## Review Focus

Entradas que el spec insinúa y ninguna tarea cubre por defecto; cada una tiene su test en la tarea indicada:

1. Montos escritos como fórmula o con formato local: `=45814+4581` → 50.395; `1.050.000` → 1050000; `=1;DROP` o `process.exit()` se rechazan sin ejecutarse (Task 1, `expr.test.ts`).
2. Filas del Excel con subgrupo vacío o `#N/A`, filas basura con año 1899 e ingreso y egreso en 0: el importador no las pierde ni inventa; los movimientos sin subgrupo van a "Sin categoría" y el saldo final de `Flujo` sigue cuadrando con el Excel (Task 5).
3. Aislamiento entre usuarios: el usuario B pidiendo ids del usuario A por REST o por un token MCP recibe 404, y un token `finanzas:read` no puede escribir (Task 2 y Task 9).
4. Importar el mismo Excel dos veces no duplica nada (clave de importación por fila) (Task 5).
5. Cambio de año y de modo de cobro: clonar el plan 2026 → 2027 no copia banderas de "realizado", un plan con 1 período (mensual) y otro con 2 (quincenal) conviven, y quitar un período con montos exige moverlos o confirmarlo (Task 3 y Task 10).

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .env.example, .gitignore
packages/shared/src/
  expr.ts            parseAmount(input) -> number   (parser aritmético seguro)
  money.ts           formatPyg(n), roundPyg(n)
  split.ts           computeSplit(input) -> SplitResult
  schemas.ts         zod: inputs/outputs compartidos
apps/server/src/
  db/schema.ts, db/client.ts, db/migrate.ts, db/seed.ts
  auth/{password.ts, sessions.ts, routes.ts, oauth-provider.ts}
  modules/{categories,transactions,plans,planned-expenses,ledgers,recovery,splits,summary}/service.ts
  http/{app.ts, routes/*.ts}
  mcp/{server.ts, tools.ts}
  import/{excel-reader.ts, importer.ts, cli.ts}
apps/web/src/
  app/{router.tsx, layout.tsx, theme.css}
  features/{auth,flow,plans,accounts,recovery,splits,summary,connect}/
  components/DataGrid.tsx   grilla editable reutilizable
```

---

### Task 1: Scaffold, shared core y base de datos

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/shared/src/{expr.ts,money.ts,schemas.ts}`, `apps/server/src/db/{schema.ts,client.ts,migrate.ts}`
- Test: `packages/shared/src/expr.test.ts`, `apps/server/src/db/schema.test.ts`

**Interfaces:**
- Produces: `parseAmount(input: string | number): number` (lanza `Error("INVALID_AMOUNT")`); `roundPyg(n: number): number`; `formatPyg(n: number): string`; `getDb(path?: string): Db`; tablas Drizzle listadas abajo.

Tablas (todas con `id` TEXT uuid, excepto donde se indica; toda tabla de datos con `user_id` NOT NULL e índice):
`users(email unique, password_hash, must_change_password, created_at)`, `categories(user_id, name, group_name CHECK IN ('Ingresos','Egresos','Gasto','Inversion','Otros'), archived)`, `transactions(user_id, date, seq, item, kind CHECK IN ('income','expense'), amount INTEGER >= 0, amount_expr, category_id NULL, note, import_key NULL)` con índice único `(user_id, import_key)`, `plans(user_id, year, name, archived)`, `plan_periods(plan_id, label, day_of_month, sort)`, `plan_items(plan_id, period_id, kind, concept, sort, auto_source NULL)`, `plan_cells(item_id, month 1..12, amount, amount_expr)` PK `(item_id, month)`, `planned_expenses(user_id, concept, amount, period_label, year, month, due_date NULL, done, transaction_id NULL)`, `accounts(user_id, type CHECK IN ('savings','card','cash_box','fund','debt'), name, credit_limit NULL)`, `ledger_entries(account_id, date, seq, concept, amount, tag NULL, import_key NULL)`, `recovery_allocations(user_id, cobro_label, cobro_index, concept, amount, tag CHECK IN ('T','A','V','F') OR NULL)`, `splits(user_id, name, date, participants JSON)`, `split_items(split_id, label, total, discount_pct, shares JSON)`, `oauth_clients`, `oauth_codes`, `oauth_tokens` (hashes), `sessions`.

- [ ] **Step 1: Escribir tests de `parseAmount`** en `expr.test.ts`: `"=45814+4581"→50395`, `"1.050.000"→1050000`, `"=(883114-223313)"→659801`, `"=1500000/2"→750000`, `750000→750000`, `"-87400"→-87400`, y rechazos: `"=process.exit()"`, `"1;2"`, `"=2**9999"` lanzan `INVALID_AMOUNT`; vacío → `0`.
- [ ] **Step 2: Ejecutar** `pnpm -F shared test` → FAIL ("parseAmount not defined").
- [ ] **Step 3: Implementar `parseAmount`** en `packages/shared/src/expr.ts`: tokenizador + descenso recursivo para `+ - * / ( )` y números; interpreta `.` como separador de miles solo si el texto no tiene `,`; `,` es decimal. Redondea con `roundPyg` al final.
- [ ] **Step 4: Ejecutar** el mismo test → PASS.
- [ ] **Step 5: Escribir `schema.test.ts`**: crea DB en memoria, aplica `migrate`, inserta dos usuarios y verifica que `transactions.kind` rechaza `'x'`, que `(user_id, import_key)` duplicado falla y que `amount < 0` falla.
- [ ] **Step 6: Implementar** `schema.ts`, `client.ts` (SQLite WAL, `foreign_keys=ON`) y `migrate.ts` (migraciones drizzle-kit).
- [ ] **Step 7: Ejecutar** `pnpm test` → PASS.
- [ ] **Step 8: Commit** (`git init` primero si no hay repo): `git add -A && git commit -m "feat: scaffold monorepo, parseAmount y esquema de datos"`

---

### Task 2: Autenticación, seed y servicios base (categorías y movimientos)

**Files:**
- Create: `apps/server/src/auth/{password.ts,sessions.ts,routes.ts}`, `apps/server/src/db/seed.ts`, `apps/server/src/http/app.ts`
- Create: `apps/server/src/modules/categories/service.ts`, `apps/server/src/modules/transactions/service.ts`, `apps/server/src/http/routes/{categories,transactions}.ts`
- Test: `apps/server/src/auth/auth.test.ts`, `apps/server/src/modules/transactions/transactions.test.ts`

**Interfaces:**
- Consumes: `getDb`, tablas, `parseAmount` (Task 1).
- Produces:
  - `buildApp(db: Db): FastifyInstance`; decorador `req.userId: string` (preHandler `requireUser`).
  - `listTransactions(db, userId, q: {from?: string; to?: string; categoryId?: string; text?: string; limit?: number}): TransactionRow[]` con `TransactionRow = {id, date, item, kind, amount, categoryId|null, categoryName|null, groupName|null, note, balance: number}`; `balance` = acumulado ordenado por `(date, seq)` con `SUM() OVER`.
  - `createTransaction(db, userId, {date, item, kind, rawAmount: string|number, categoryId?, note?}): TransactionRow`, `updateTransaction(db, userId, id, patch)`, `deleteTransaction(db, userId, id)` → lanzan `NotFoundError` si el id no es del usuario.
  - `listCategories(db, userId)`, `upsertCategory(db, userId, {id?, name, groupName})`.
  - Rutas: `POST /api/auth/login|logout|change-password`, `POST /api/auth/signup` (404 si `ALLOW_SIGNUP!=true`), `GET /api/me`, `GET|POST|PATCH|DELETE /api/transactions`, `/api/categories`.

- [ ] **Step 1: Tests de auth** (`auth.test.ts`): login correcto devuelve cookie; contraseña mala → 401 sin distinguir si el email existe; 11 intentos/min → 429; `signup` → 404 con `ALLOW_SIGNUP=false`; usuario seed con `must_change_password` recibe `mustChangePassword:true` en `/api/me` y toda otra ruta responde 403 hasta cambiar la contraseña.
- [ ] **Step 2: Tests de movimientos** (`transactions.test.ts`): crear `"=45814+4581"` guarda `amount=50395` y `amount_expr`; el saldo acumulado de 3 movimientos del mismo día respeta `seq`; usuario B hace `getTransaction/update/delete` sobre un id de A → `NotFoundError` (Review Focus 3); `kind='expense'` con monto negativo se rechaza.
- [ ] **Step 3: Ejecutar** → FAIL.
- [ ] **Step 4: Implementar** auth (argon2id, sesiones con token aleatorio hasheado, rate limit en memoria), `seed.ts` (`pnpm -F server seed`: crea `rubengmnz90@gmail.com` con `process.env.SEED_USER_PASSWORD`, aborta con mensaje claro si falta la variable, y siembra los 5 grupos + 32 subgrupos de `Grupos`), y los servicios de categorías y movimientos.
- [ ] **Step 5: Ejecutar** `pnpm -F server test` → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat: auth multiusuario, seed y servicio de movimientos"`

---

### Task 3: Motor de planes (proyección por cobro) y gastos puntuales

**Files:**
- Create: `apps/server/src/modules/plans/service.ts`, `apps/server/src/modules/planned-expenses/service.ts`, `apps/server/src/http/routes/{plans,planned-expenses}.ts`
- Test: `apps/server/src/modules/plans/plans.test.ts`

**Interfaces:**
- Consumes: tablas de plan, `parseAmount`.
- Produces:
  - `createPlan(db, userId, {year, name, periods: {label: string; dayOfMonth: number}[]}): Plan` (1 período = mensual; 2 = quincenal; N permitido).
  - `getPlanView(db, userId, planId): PlanView` con `PlanView = {plan, periods: {id,label,items: {id,kind,concept,auto,cells:number[12]}[], totals: {expense:number[12], income:number[12], net:number[12]}}[], grand: {expense:number, income:number, net:number}}`. Las filas con `auto_source='planned_expenses'` toman su monto de `SUM(planned_expenses)` por `(period_label, year, month)` (réplica del `SUMIFS` de Excel).
  - `setCell(db, userId, itemId, month, rawInput): number`; `addItem`, `renameItem`, `removeItem`; `fillRight(db, userId, itemId, fromMonth)`; `applyAdjust(db, userId, planId, {itemIds, months, pct?: number, delta?: number}): PlanView`.
  - `clonePlan(db, userId, planId, {name, year}): Plan` (copia períodos, filas y celdas; no copia `planned_expenses` ni `done`).
  - `comparePlans(db, userId, aId, bId): {month, netA, netB, diff}[]`.
  - `removePeriod(db, userId, periodId, {moveToPeriodId?: string; confirmDiscard?: boolean})` → error `PERIOD_HAS_DATA` si hay montos y no se indicó destino ni confirmación.
  - `planned-expenses`: `createPlannedExpense`, `updatePlannedExpense`, `markDone(db, userId, id, {createTransaction: boolean})`, `listPlannedExpenses(db, userId, {year, month?})`.

- [ ] **Step 1: Test de regresión contra el Excel** (`plans.test.ts`) con datos fixture del 2026 (bloque Fin de mes): totales por mes `Total Gastos` ene=4.989.391, feb=4.382.551, mar=4.807.336; `P25=57.124.862`, `P33=72.350.000`, `P35 Neto=15.225.138`. Bloque Quincena: `AF25=56.365.765`, `AF33=77.026.283`, `AF35=20.660.518`.
- [ ] **Step 2: Test de "Otros gastos"**: con 4 gastos puntuales `Fin`/`Enero` (360.568 + 450.000 + 431.372 + 0 … valor cacheado 1.241.940) la fila automática de enero vale 1.241.940; `markDone` con `createTransaction:true` crea el movimiento y enlaza `transaction_id`.
- [ ] **Step 3: Tests de escenarios**: `clonePlan` conserva totales y deja `done=false`; `applyAdjust({pct:10})` sube solo las filas y meses indicados; `removePeriod` con montos y sin destino lanza `PERIOD_HAS_DATA`; un plan de 1 período y otro de 2 del mismo año coexisten; usuario B no ve ni clona planes de A (404).
- [ ] **Step 4: Ejecutar** → FAIL.
- [ ] **Step 5: Implementar** los servicios; los totales se calculan en memoria sobre las celdas del plan (sin guardar derivados).
- [ ] **Step 6: Ejecutar** → PASS.
- [ ] **Step 7: Commit** `git commit -m "feat: planes por cobro, escenarios y gastos puntuales"`

---

### Task 4: Cuentas (ahorro, tarjetas, caja, fondos, deudas), recuperación y distribución

**Files:**
- Create: `apps/server/src/modules/{ledgers,recovery,splits}/service.ts`, `packages/shared/src/split.ts`, `apps/server/src/http/routes/{accounts,recovery,splits}.ts`
- Test: `apps/server/src/modules/ledgers/ledgers.test.ts`, `packages/shared/src/split.test.ts`, `apps/server/src/modules/recovery/recovery.test.ts`

**Interfaces:**
- Produces:
  - `createAccount(db, userId, {type, name, creditLimit?})`; `addEntry(db, userId, accountId, {date, concept, rawAmount, tag?})`; `getLedger(db, userId, accountId): {account, entries: (Entry & {balance:number})[], balance:number, owed:number}` donde `owed` = `creditLimit − balance` para `card`, `−balance` para `debt` y `0` en el resto.
  - `listBalances(db, userId): {accountId, type, name, balance, owed}[]`.
  - `computeSplit({items: {total:number; discountPct:number; shares: Record<string,number>}[], people: string[]}): {items: {net:number; byPerson: Record<string,number>}[]; totals: Record<string,number>; roundingDiff: number}`: `net = total − total*discountPct`; cada persona `ROUND(net*share, 0)`; `roundingDiff = Σnet − Σtotals` (como en el Excel, no se reparte el residuo).
  - `getRecovery(db, userId): {debts: {key:'card'|'savings'; owed:number; paid:number; pending:number}[]; cobros: {label:string; income:number; allocations: Allocation[]; spent:number; left:number}[]}`. `paid` = suma de asignaciones con etiqueta `T` (tarjeta) o `A` (ahorro); `owed` sale del ledger (tarjeta: deuda de la tarjeta elegida; ahorro: suma de retiros `temp_withdrawal` pendientes), no se escribe a mano. `setAllocation`, `removeAllocation`.
  - `savings` acepta etiqueta `temp_withdrawal` y `returnEntry` que la compensa.

- [ ] **Step 1: Tests de ledger**: tarjeta Coomecipar con línea 3.000.000 y movimientos del Excel (Inicial 3.000.000, Teclado −3.000.000, Pago 200.000, Arete −186.928) deja `balance=13.072`, `owed=2.986.928`; GNB línea 7.000.000 con sus 10 movimientos da `balance=6.952.460` y `owed=47.540`; cuenta `debt` Casa termina en `−3.994.472`; `listBalances` de otro usuario no incluye estas cuentas.
- [ ] **Step 2: Tests de split** con las filas reales de `Plantilla`: `51726`, desc `0.2`, shares `0.2/0.4/0.4` → net `41380.8`, Emma `8276`, Ali `16552`, Yo `16552`, suma `41380`, `roundingDiff = 0.8`; `7100*4` con share Yo=1 → `22720`; totales del Excel: Emma `92652`, Yo `312233`, Ali `299701`, total Emma+Yo `404885`.
- [ ] **Step 3: Test de recuperación** con los valores de `Como`: tarjeta owed `2.045.068` paid `550.000` pending `1.495.068`; ahorro owed `2.188.387` paid `1.470.000` pending `718.387`; cobro "Quincena Noviembre" ingreso `5.500.000`, gasto `4.482.953`, saldo `1.017.047`.
- [ ] **Step 4: Ejecutar** → FAIL.
- [ ] **Step 5: Implementar** servicios y `computeSplit`.
- [ ] **Step 6: Ejecutar** → PASS.
- [ ] **Step 7: Commit** `git commit -m "feat: cuentas, recuperacion y distribucion de compras"`

---

### Task 5: Importador del Excel con reporte y cuadre

**Files:**
- Create: `apps/server/src/import/{excel-reader.ts,importer.ts,cli.ts}`
- Test: `apps/server/src/import/import.test.ts`, fixture generado en `apps/server/src/import/fixtures/mini.xlsx` (armado por el test con `exceljs`)

**Interfaces:**
- Consumes: servicios de Tasks 2–4.
- Produces: `importWorkbook(db, userId, filePath: string, opts?: {dryRun?: boolean}): ImportReport` con `ImportReport = {created: Record<string, number>, skipped: {sheet:string; row:number; reason:string}[], warnings: string[], reconciliation: {name:string; excel:number; app:number; ok:boolean}[]}`. CLI: `pnpm -F server import --file "<ruta>" --user rubengmnz90@gmail.com [--dry-run]`.

Reglas por hoja:
- `Flujo`: usa **valores cacheados** (`data_only`) y guarda la fórmula en `amount_expr` cuando la celda era fórmula; ignora filas sin fecha o con año 1899 y las celdas fuera de `A:J`; `kind` según columna Ingreso/Egreso; subgrupo vacío o `#N/A` → categoría "Sin categoría" + warning; `import_key = "flujo:<fila>"`; `seq` = orden de fila.
- `Grupos` → `categories`; `Proyeccion Mensual 2026/2027` → un `plan` por año con 2 períodos (`Fin de mes` día 30, `Quincena` día 15), filas por concepto; la fila `Otros gastos` queda `auto_source='planned_expenses'`; `Otros gastos B:F` → `planned_expenses` (`done` si `Realizado='Ok'`, año 2026, `Mes` en minúscula/mayúscula indistinto); `Otros gastos I:M` → cuenta `fund` "Ahorro Emma".
- `Ahorro A:D`+`K:N` → cuenta `savings` (K:N con etiqueta `temp_withdrawal`); `Ahorro F:G` → cuenta `cash_box` "Vibra Lejana"; `Tarjetas B:F` → card Coomecipar (línea 3.000.000) y `J:N` → card GNB (7.000.000); `Ahorro P:T` se **omite** por duplicado y se verifica igualdad con `Tarjetas B:F` (warning si difiere); `Como` → `recovery_allocations` (etiquetas `V/A/T/F`, cobro por columna `E`); `Plantilla distribucion` → un `split` "Plantilla 2026"; `Prestamos` → cuentas `debt` (Casa, Boda/Prestamo, Normal) más la fija "Casamiento −11.000.000".

- [ ] **Step 1: Test de reconciliación contra el archivo real** (se salta con `it.skipIf` si el archivo no existe): tras importar, `Flujo` da 1.400 movimientos y el saldo acumulado en la fila de "Google Vibra Lejana" (2026-08-02) es `870.903`; plan 2026 neto `15.225.138`; Ahorro Emma `132.137`; Vibra Lejana `1.189.912`; deuda de tarjeta Coomecipar `2.045.067`; `Prestamos` total `−21.788.789`; split totales `92.652 / 312.233 / 299.701`.
- [ ] **Step 2: Test con fixture mínimo**: una fila con `#N/A` en subgrupo va a "Sin categoría" y aparece en `warnings`; fila 1899 en `skipped`; fórmula `=45814+4581` guarda `50395` y `amount_expr="=45814+4581"` (Review Focus 2).
- [ ] **Step 3: Test de idempotencia**: importar dos veces deja los mismos conteos y mismos saldos (Review Focus 4); `dryRun` no escribe nada.
- [ ] **Step 4: Ejecutar** → FAIL.
- [ ] **Step 5: Implementar** lector (exceljs con lectura de valor y fórmula por celda) e importador por hoja dentro de **una transacción SQLite** (todo o nada); el reporte imprime la tabla de reconciliación y sale con código 1 si algún `ok=false`.
- [ ] **Step 6: Ejecutar** `pnpm -F server test` → PASS; luego `pnpm -F server import --file "C:\Users\Ruben\Downloads\Administracion 2026.xlsx" --user rubengmnz90@gmail.com --dry-run` y revisar el reporte.
- [ ] **Step 7: Commit** `git commit -m "feat: importador del Excel con reconciliacion"`

---

### Task 6: Resúmenes y proyección vs real

**Files:**
- Create: `apps/server/src/modules/summary/service.ts`, `apps/server/src/http/routes/summary.ts`
- Test: `apps/server/src/modules/summary/summary.test.ts`

**Interfaces:**
- Produces: `monthlySummary(db, userId, year, month): {groups: {group:string; total:number; categories: {name:string; total:number}[]}[]; income:number; expense:number; net:number}`; `annualSummary(db, userId, year): {group:string; category:string; months:number[12]; total:number}[]`; `planVsActual(db, userId, planId): {month:number; planned:number; actual:number; diff:number}[]` (ingresos y egresos reales desde `transactions`, plan desde `getPlanView`); `projectedBalance(db, userId, planId, fromDate): {date:string; balance:number}[]` (saldo actual de `Flujo` + neto del plan por cobro posterior a la fecha, respondiendo "cómo iré y qué tengo que pagar en cada cobro").

- [ ] **Step 1: Tests** con 6 movimientos de 2 meses: totales por grupo y categoría; `annualSummary` suma 12 meses; `planVsActual` marca `diff` negativo cuando se gastó más de lo planeado; `projectedBalance` parte del último saldo real y resta/suma el neto por cobro; un mes sin movimientos devuelve ceros (no `NaN`, no omite el mes).
- [ ] **Step 2: Ejecutar** → FAIL. **Step 3: Implementar** con consultas agregadas SQL. **Step 4: Ejecutar** → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: resumenes mensual/anual y proyeccion vs real"`

---

### Task 7: Frontend base, diseño y pantalla de Flujo

**Files:**
- Create: `apps/web/` (Vite React TS), `apps/web/src/app/{router.tsx,layout.tsx,theme.css}`, `apps/web/src/components/DataGrid.tsx`, `apps/web/src/features/auth/*`, `apps/web/src/features/flow/FlowPage.tsx`
- Test: `apps/web/src/components/DataGrid.test.tsx`, `apps/web/e2e/flow.spec.ts` (Playwright)

**Interfaces:**
- Consumes: API REST de Task 2; `parseAmount`, `formatPyg` de `shared`.
- Produces: `<DataGrid<T> columns rows onCommit={(rowId, colKey, raw) => Promise<void>} />` con: navegación con flechas/Enter/Tab, edición al teclear, pegado desde Excel (TSV), `Ctrl+D` rellenar hacia abajo, actualización optimista y vuelta atrás si el servidor falla; `FlowPage`: filtro por mes/categoría/texto, fila de alta rápida al final (fecha = hoy, Enter guarda y mantiene el foco), saldo acumulado y total de ingresos/egresos del mes en el pie, selector de año.

- [ ] **Step 1: Test de DataGrid**: teclear `=45814+4581` y Enter llama `onCommit` con ese texto crudo; pegar 3 filas TSV genera 3 commits; error del servidor revierte la celda y muestra aviso.
- [ ] **Step 2: Test E2E** (`flow.spec.ts`): login → pantalla de cambio de contraseña obligatoria → alta de un gasto con `=1000+500` → aparece `1.500` y el saldo se recalcula; recargar mantiene el dato.
- [ ] **Step 3: Ejecutar** → FAIL.
- [ ] **Step 4: Implementar** layout con barra lateral (Flujo, Planes, Cuentas, Recuperación, Distribución, Resúmenes, Conectar IA), tema claro/oscuro, tipografía con cifras tabulares, colores semánticos (ingreso verde, egreso rojo) y `DataGrid` virtualizado (TanStack Table + virtual) para 1.400+ filas.
- [ ] **Step 5: Ejecutar** `pnpm -F web test` y `pnpm -F web e2e` → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat: web base, grilla editable y pantalla de flujo"`

---

### Task 8: Pantalla de Planes (jugar con los números)

**Files:**
- Create: `apps/web/src/features/plans/{PlansPage.tsx,PlanGrid.tsx,ComparePanel.tsx,PlannedExpensesPanel.tsx}`
- Test: `apps/web/src/features/plans/PlanGrid.test.tsx`, `apps/web/e2e/plans.spec.ts`

**Interfaces:**
- Consumes: `getPlanView`, `setCell`, `fillRight`, `applyAdjust`, `clonePlan`, `comparePlans`, `removePeriod`, planned-expenses (Task 3).
- Produces: `PlanGrid` con una sección por cobro (pestañas o lado a lado), filas Gastos/Ingresos, totales y **Neto** por mes recalculados al instante al editar; menú por fila: "rellenar hacia la derecha", "+/− %", renombrar, borrar; botón "Clonar plan" y "Comparar con…" (diferencia de neto por mes); crear plan con selector mensual/quincenal/personalizado; panel lateral de "Otros gastos" con marcar realizado y crear el movimiento.

- [ ] **Step 1: Tests**: editar una celda actualiza Total y Neto de ese mes sin recargar; "+10% filas seleccionadas" ajusta solo los meses elegidos; quitar un cobro con montos abre diálogo de mover/descartar (Review Focus 5).
- [ ] **Step 2: E2E**: clonar "2026" como "Escenario sin Tupi", poner Tupi en 0, ver la diferencia de neto en el comparador.
- [ ] **Step 3: Ejecutar** → FAIL. **Step 4: Implementar** reutilizando `DataGrid`. **Step 5: Ejecutar** → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat: pantalla de planes con clonado y comparador"`

---

### Task 9: Pantallas de Cuentas, Recuperación, Distribución y Resúmenes

**Files:**
- Create: `apps/web/src/features/accounts/*`, `apps/web/src/features/recovery/*`, `apps/web/src/features/splits/*`, `apps/web/src/features/summary/*`
- Test: `apps/web/e2e/accounts.spec.ts`, `apps/web/e2e/splits.spec.ts`

**Interfaces:**
- Consumes: servicios de Tasks 4 y 6.
- Produces:
  - Cuentas: tarjetas (línea, disponible, deuda), ahorro con retiros temporales y botón "devolver", caja Vibra Lejana, fondo Emma, deudas con resumen total.
  - Recuperación: dos barras de progreso (tarjeta, ahorro) y la grilla por cobro con saldo libre.
  - Distribución: tabla de ítems con descuento y reparto %, totales por persona en vivo, alerta si los % de una fila no suman 100.
  - Resúmenes: mensual (por grupo → categoría), anual (12 meses), gráfico plan vs real y saldo proyectado.

- [ ] **Step 1: E2E de Distribución**: cargar la fila `51726` / 20% / `0.2-0.4-0.4` muestra Emma `8.276`, Ali `16.552`, Yo `16.552` y una nota de redondeo `0,8`.
- [ ] **Step 2: E2E de Cuentas**: agregar un retiro temporal de 250.000 a Ahorro sube "pendiente de reponer" y registrar la devolución lo baja; abrir con otro usuario no muestra esos datos.
- [ ] **Step 3: Ejecutar** → FAIL. **Step 4: Implementar** las cuatro pantallas. **Step 5: Ejecutar** → PASS.
- [ ] **Step 6: Commit** `git commit -m "feat: cuentas, recuperacion, distribucion y resumenes"`

---

### Task 10: Servidor MCP con OAuth por navegador

**Files:**
- Create: `apps/server/src/mcp/{server.ts,tools.ts}`, `apps/server/src/auth/oauth-provider.ts`, `apps/web/src/features/connect/{AuthorizePage.tsx,ConnectPage.tsx}`
- Test: `apps/server/src/mcp/mcp.test.ts`

**Interfaces:**
- Consumes: servicios de Tasks 2–6 (siempre con el `userId` del token).
- Produces: `class FinanzasOAuthProvider implements OAuthServerProvider` (clientes dinámicos, `authorize` redirige a `/authorize?...` de la web, que exige sesión y muestra "¿Autorizar a {cliente} con permisos {scopes}?", códigos de un solo uso con PKCE S256, tokens y refresh guardados con hash, revocación); endpoints `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/authorize`, `/token`, `/revoke`; ruta `POST|GET|DELETE /mcp`.
- Herramientas (nombre → scope): `list_categories` (read), `list_transactions` (read), `add_transaction` (write; acepta `amount` como número o expresión), `list_planned_expenses` (read), `add_planned_expense` (write), `mark_planned_expense_done` (write), `get_plan` (read), `compare_plans` (read), `monthly_summary` (read), `annual_summary` (read), `balances` (read: ahorro, tarjetas, caja, deudas), `recovery_status` (read), `projected_balance` (read). Toda salida incluye números como enteros PYG.
- La pantalla `ConnectPage` muestra el comando `claude mcp add --transport http finanzas <URL>/mcp` y la lista de conexiones activas con botón "Revocar".

- [ ] **Step 1: Tests** (`mcp.test.ts`): sin token `/mcp` → 401 con `WWW-Authenticate` que apunta al recurso protegido; flujo completo registro → authorize (con sesión) → token con PKCE correcto da acceso, con `code_verifier` incorrecto falla; un token `finanzas:read` llamando `add_transaction` → error de scope; el token del usuario A con id de un movimiento de B → "no encontrado" (Review Focus 3); `add_transaction` con `"=45814+4581"` crea 50.395; revocar el token corta el acceso inmediatamente.
- [ ] **Step 2: Ejecutar** → FAIL.
- [ ] **Step 3: Implementar** provider, rutas y herramientas (cada herramienta valida entrada con zod y delega en los servicios; sin lógica propia).
- [ ] **Step 4: Ejecutar** → PASS.
- [ ] **Step 5: Verificación manual**: levantar el server, ejecutar `claude mcp add --transport http finanzas http://localhost:3000/mcp`, autenticar desde `/mcp` en Claude Code (debe abrirse el navegador, pedir login y autorización) y pedir "resumen de octubre" y "carga un gasto de 45.000 en Comida".
- [ ] **Step 6: Commit** `git commit -m "feat: servidor MCP con OAuth por navegador"`

---

### Task 11: Año nuevo (2027), importación real y puesta en marcha

**Files:**
- Create: `apps/server/src/modules/plans/rollover.ts`, `apps/web/src/features/plans/RolloverDialog.tsx`, `README.md` (arranque, variables de entorno, backup, despliegue)
- Test: `apps/server/src/modules/plans/rollover.test.ts`

**Interfaces:**
- Produces: `rolloverYear(db, userId, {fromPlanId: string; toYear: number; name?: string}): {plan: Plan; openingBalance: number}`: clona el plan, no copia banderas ni gastos puntuales y devuelve el saldo de cierre de `Flujo` del año anterior para el movimiento "Saldo inicial" del año nuevo (que el usuario confirma antes de crearse).

- [ ] **Step 1: Test**: con datos 2026, `rolloverYear(... toYear: 2027)` produce un plan con los mismos totales, `planned_expenses` vacío, `openingBalance` = último saldo del flujo 2026; ejecutarlo dos veces para el mismo año falla con `YEAR_EXISTS` (Review Focus 5).
- [ ] **Step 2: Ejecutar** → FAIL. **Step 3: Implementar** servicio y diálogo ("Preparar 2027": elegir plan base, revisar saldo inicial, crear). **Step 4: Ejecutar** → PASS.
- [ ] **Step 5: Puesta en marcha**: `pnpm -F server migrate`, `SEED_USER_PASSWORD=<la elige el usuario> pnpm -F server seed`, importar el Excel real sin `--dry-run`, revisar la tabla de reconciliación (todo `ok`) y entrar con el usuario inicial para cambiar la contraseña.
- [ ] **Step 6: Respaldo**: documentar en `README.md` el backup diario del archivo SQLite (`sqlite3 finanzas.db ".backup ..."`).
- [ ] **Step 7: Commit** `git commit -m "feat: cambio de año y puesta en marcha"`

---

## Self-Review

- **Cobertura del pedido:** user/pass y multiusuario (T2), usuario inicial con contraseña por defecto sin exponerla (T2, T11), UX rica tipo Excel (T7–T9), cobro mensual/quincenal/varios planes (T3, T8), migración completa de Flujo, Proyección 2026/2027, Otros gastos, Ahorro, Vibra Lejana, lío, Tarjetas, Como, Plantilla, Grupos, Resúmenes y Préstamos (T5), lo posterior a MejoraFinanciera excluido, 2027 (T3, T11), MCP con navegador para autenticar y autorizar (T10).
- **Consistencia de nombres:** `parseAmount`, `getPlanView`, `computeSplit`, `getLedger`, `getRecovery`, `rolloverYear` aparecen igual donde se consumen.
- **Valores de verificación** salen de los valores cacheados del Excel leídos; el importador los revalida en cada corrida.
- **Pendiente de decisión del usuario (no bloquea):** dónde se despliega (por defecto local/VPS con un solo proceso Node + archivo SQLite); si `Prestamos` son deudas propias o préstamos otorgados (el modelo soporta ambos).
