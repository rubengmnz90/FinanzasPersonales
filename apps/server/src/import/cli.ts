import '../db/env';
import { createDb } from '../db/client';
import { importWorkbook } from './importer';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg('file');
const email = arg('user') ?? process.env.SEED_EMAIL;
const dryRun = process.argv.includes('--dry-run');
if (!file || !email) {
  console.error('Uso: pnpm -F server import --file "<ruta.xlsx>" --user <email> [--dry-run]');
  process.exit(2);
}

const db = createDb(process.env.DATABASE_URL!);
const u = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
if (!u.rowCount) {
  console.error(`No existe el usuario ${email}. Ejecuta primero: pnpm -F server seed`);
  process.exit(2);
}
const report = await importWorkbook(db, u.rows[0].id, file, { dryRun });
console.log(dryRun ? '== SIMULACIÓN (no se guardó nada) ==' : '== IMPORTACIÓN GUARDADA ==');
console.log('Creado:', report.created);
if (report.skipped.length) {
  console.log(`Omitidos (${report.skipped.length}):`);
  for (const s of report.skipped.slice(0, 40)) console.log(`  ${s.sheet} fila ${s.row}: ${s.reason}`);
}
if (report.warnings.length) {
  console.log(`Avisos (${report.warnings.length}):`);
  for (const w of report.warnings.slice(0, 40)) console.log(`  - ${w}`);
}
console.log('Reconciliación contra el Excel:');
for (const r of report.reconciliation) {
  console.log(`  ${r.ok ? (r.note ? 'INF' : 'OK ') : 'ERR'} ${r.name}: excel=${r.excel} app=${r.app}${r.note ? '  (' + r.note + ')' : ''}`);
}
await db.end();
process.exit(report.reconciliation.every((r) => r.ok) ? 0 : 1);
