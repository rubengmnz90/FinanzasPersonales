import './db/env';
import { createDb } from './db/client';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { registerMcp } from './mcp/register';
import { AutoBackup, autoBackupFromEnv, buildConfig } from './modules/backup/auto';
import { loadStoredFields } from './modules/backup/settings';

const db = createDb(process.env.DATABASE_URL!);
await migrate(db);

const autoBackup = new AutoBackup(null);
try {
  const stored = await loadStoredFields(db); // lo guardado desde la pantalla manda sobre el .env
  const fromApp = stored ? buildConfig(stored) : null;
  if (fromApp) autoBackup.setConfig(fromApp, 'app');
} catch (e) {
  console.error('[respaldo-auto] no se pudo leer la configuración guardada:', (e as Error).message);
}
if (!autoBackup.cfg) {
  const env = autoBackupFromEnv();
  if (env) autoBackup.setConfig(env, 'env');
}
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
if (!autoBackup.cfg) console.log('[respaldo-auto] apagado: configúralo en la pantalla Respaldo (o con BACKUP_S3_* en el .env)');
console.log(`Finanzas escuchando en ${publicUrl} (puerto ${port})`);
