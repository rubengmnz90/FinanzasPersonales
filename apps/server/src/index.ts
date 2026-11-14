import './db/env';
import { createDb } from './db/client';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { registerMcp } from './mcp/register';

const db = createDb(process.env.DATABASE_URL!);
await migrate(db);

const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
const app = await buildApp(db, {
  allowSignup: process.env.ALLOW_SIGNUP === 'true',
  secureCookies: publicUrl.startsWith('https://'),
  publicUrl,
  databaseUrl: process.env.DATABASE_URL!,
  extend: (a, d) => registerMcp(a, d, publicUrl),
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Finanzas escuchando en ${publicUrl} (puerto ${port})`);
