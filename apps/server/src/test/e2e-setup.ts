/**
 * Deja la base E2E lista: esquema nuevo, usuario e2e con cambio de contraseña obligatorio y,
 * si existe, el Excel real importado. Se ejecuta con tsx desde el global-setup de Playwright.
 */
import '../db/env';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { createDb } from '../db/client';
import { migrate } from '../db/migrate';
import { hashPassword } from '../auth/sessions';
import { seedCategories } from '../modules/categories/service';
import { seedDefaultAccounts } from '../modules/ledgers/service';
import { importWorkbook } from '../import/importer';

const url = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:12345@localhost:5432/finanzas_test';

const admin = new pg.Pool({ connectionString: url, max: 1 });
await admin.query('DROP SCHEMA public CASCADE');
await admin.query('CREATE SCHEMA public');
await admin.end();

const db = createDb(url);
await migrate(db);
const r = await db.query(
  "INSERT INTO users(email,password_hash,must_change_password) VALUES ('e2e@test.io',$1,true) RETURNING id",
  [await hashPassword('clave-inicial-e2e')],
);
await seedCategories(db, r.rows[0].id);
await seedDefaultAccounts(db, r.rows[0].id);
const xlsx = process.env.EXCEL_FILE ?? 'C:\\Users\\Ruben\\Downloads\\Administracion 2026.xlsx';
if (existsSync(xlsx)) {
  const rep = await importWorkbook(db, r.rows[0].id, xlsx);
  console.log(`[e2e-setup] Excel importado: ${rep.reconciliation.filter((x) => x.ok).length}/${rep.reconciliation.length} controles OK`);
}
await db.end();
