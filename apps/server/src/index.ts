import './db/env';
import { createDb } from './db/client';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { registerMcp } from './mcp/register';
import { AutoBackup, autoBackupFromEnv } from './modules/backup/auto';

const db = createDb(process.env.DATABASE_URL!);
await migrate(db);

const autoBackup = new AutoBackup(autoBackupFromEnv());
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
const app = await buildApp(db, {
  allowSignup: process.env.ALLOW_SIGNUP === 'true',
  secureCookies: publicUrl.startsWith('https://'),
  publicUrl,
  databaseUrl: process.env.DATABASE_URL!,
  autoBackup,
  extend: (a, d) => registerMcp(a, d, publicUrl),
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
autoBackup.start();
if (!autoBackup.cfg) console.log('[respaldo-auto] apagado: falta configurar BACKUP_S3_* (ver docs/respaldo-automatico.md)');
console.log(`Finanzas escuchando en ${publicUrl} (puerto ${port})`);
