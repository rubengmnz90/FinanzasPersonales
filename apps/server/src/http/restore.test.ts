import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { makeTestDb, type TestCtx } from '../test/helpers';
import { hashPassword } from '../auth/sessions';
import { buildApp } from './app';
import { extractSql, RestoreError, validateDump } from '../modules/backup/restore';

const DUMP = `--
-- PostgreSQL database dump
--
DROP TABLE IF EXISTS public.users CASCADE;
CREATE TABLE public.users (id uuid, email text);
CREATE TABLE public.schema_migrations (name text);
COPY public.users (id, email) FROM stdin;
\\N\ta@test.io
\\.
`;
const zip = (sql: string, name = 'finanzas.sql') => Buffer.from(zipSync({ [name]: new TextEncoder().encode(sql) }));

describe('validación del dump', () => {
  it('acepta un dump normal, incluido \\N dentro de COPY', () => {
    expect(() => validateDump(Buffer.from(DUMP))).not.toThrow();
  });
  it('rechaza comandos de psql fuera de COPY', () => {
    expect(() => validateDump(Buffer.from(DUMP + '\\! rm -rf /\n'))).toThrow(RestoreError);
  });
  it('rechaza archivos que no son de la app', () => {
    expect(() => validateDump(Buffer.from('SELECT 1;'))).toThrow(RestoreError);
    expect(() => validateDump(Buffer.from('-- PostgreSQL database dump\nCREATE TABLE x (a int);'))).toThrow(RestoreError);
  });
  it('extrae el único .sql y rechaza zips raros', () => {
    expect(extractSql(zip(DUMP)).toString()).toBe(DUMP);
    expect(() => extractSql(Buffer.from('no soy zip'))).toThrow(RestoreError);
    expect(() => extractSql(zip(DUMP, 'nota.txt'))).toThrow(RestoreError);
  });
});

describe('POST /api/backup/restore', () => {
  let ctx: TestCtx;
  let app: FastifyInstance;
  let restored: Buffer | null = null;
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@test.io';
    ctx = await makeTestDb();
    app = await buildApp(ctx.db, { allowSignup: false, restore: async (sql) => { restored = sql; } });
    const pw = await hashPassword('clave-12345');
    await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2),($3,$2)', ['admin@test.io', pw, 'otro@test.io']);
  });
  afterAll(async () => { await app.close(); await ctx.close(); delete process.env.ADMIN_EMAIL; });

  async function login(email: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'clave-12345' } });
    const raw = r.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
  }
  const post = (cookie: string | undefined, body: Buffer, url = '/api/backup/restore?confirm=RESTAURAR') =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/zip', ...(cookie ? { cookie } : {}) }, payload: body });

  it('sin sesión 401, usuario normal 403, sin confirmación 400', async () => {
    expect((await post(undefined, zip(DUMP))).statusCode).toBe(401);
    expect((await post(await login('otro@test.io'), zip(DUMP))).statusCode).toBe(403);
    expect((await post(await login('admin@test.io'), zip(DUMP), '/api/backup/restore')).statusCode).toBe(400);
    expect(restored).toBeNull();
  });

  it('el administrador restaura un zip válido; uno inválido no toca nada', async () => {
    const cookie = await login('admin@test.io');
    const bad = await post(cookie, zip('SELECT 1;'));
    expect(bad.statusCode).toBe(400);
    expect(restored).toBeNull();
    const ok = await post(cookie, zip(DUMP));
    expect(ok.statusCode).toBe(200);
    expect(restored?.toString()).toBe(DUMP);
  });
});
