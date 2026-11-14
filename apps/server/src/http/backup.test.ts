import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestDb, type TestCtx } from '../test/helpers';
import { hashPassword } from '../auth/sessions';
import { buildApp } from './app';
import { createAccount, addEntry } from '../modules/ledgers/service';
import { createTransaction } from '../modules/transactions/service';

let ctx: TestCtx;
let app: FastifyInstance;
beforeAll(async () => {
  ctx = await makeTestDb();
  app = await buildApp(ctx.db, { allowSignup: false });
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'clave-12345' } });
  const raw = r.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
}

describe('respaldo descargable', () => {
  it('descarga solo los datos del usuario, sin claves ni sesiones', async () => {
    const pw = await hashPassword('clave-12345');
    const a = (await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id', ['a@test.io', pw])).rows[0].id;
    const b = (await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2) RETURNING id', ['b@test.io', pw])).rows[0].id;
    const sa = await createAccount(ctx.db, a, { type: 'savings', name: 'Ahorro A' });
    await addEntry(ctx.db, a, sa.id, { date: '2026-01-01', concept: 'Ahorro', rawAmount: 1000, bucket: 'Ahorro' });
    await createTransaction(ctx.db, a, { date: '2026-01-02', item: 'Honorarios', kind: 'income', rawAmount: 500, payer: 'CBG' });
    await createAccount(ctx.db, b, { type: 'savings', name: 'Ahorro B' });

    const res = await app.inject({ method: 'GET', url: '/api/backup', headers: { cookie: await login('a@test.io') } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('finanzas-respaldo-');
    const data = res.json();
    expect(data.user.email).toBe('a@test.io');
    expect(data.counts.ledger_entries).toBe(1);
    expect(data.counts.transactions).toBe(1);
    expect(data.tables.transactions[0].payer).toBe('CBG');
    expect(data.tables.accounts.map((x: any) => x.name)).toContain('Ahorro A');
    expect(data.tables.accounts.map((x: any) => x.name)).not.toContain('Ahorro B');
    expect(JSON.stringify(data)).not.toContain('argon2');
    expect(data.tables.sessions).toBeUndefined();

    const anon = await app.inject({ method: 'GET', url: '/api/backup' });
    expect(anon.statusCode).toBe(401);
  });

  it('el diagnóstico confirma migraciones y columnas nuevas', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostico', headers: { cookie: await login('a@test.io') } });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.migraciones).toEqual(expect.arrayContaining(['007_entry_person.sql', '008_transaction_payer.sql']));
    expect(d.columnas.sort()).toEqual(['ledger_entries.person', 'transactions.payer']);
  });
});

describe('respaldo completo (zip del dump)', () => {
  const OLD = { t: process.env.BACKUP_TOKEN, a: process.env.ADMIN_EMAIL };
  const TOKEN = 'token-de-prueba-0123456789abcdef';
  async function full(dump: () => Promise<Buffer>) {
    const a = await buildApp(ctx.db, { allowSignup: false, dump });
    return a;
  }
  afterAll(() => {
    process.env.BACKUP_TOKEN = OLD.t; process.env.ADMIN_EMAIL = OLD.a;
    if (OLD.t === undefined) delete process.env.BACKUP_TOKEN;
    if (OLD.a === undefined) delete process.env.ADMIN_EMAIL;
  });

  it('con el token devuelve un zip con el SQL; sin token o con uno malo, 401', async () => {
    process.env.BACKUP_TOKEN = TOKEN;
    const a = await full(async () => Buffer.from('-- dump falso\nSELECT 1;\n'));
    const ok = await a.inject({ method: 'GET', url: '/api/backup/full', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/zip');
    expect(ok.headers['content-disposition']).toMatch(/finanzas-\d{8}-\d{6}\.zip/);
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(new Uint8Array(ok.rawPayload));
    const names = Object.keys(files);
    expect(names).toHaveLength(1);
    expect(strFromU8(files[names[0]])).toContain('SELECT 1;');
    expect((await a.inject({ method: 'GET', url: '/api/backup/full', headers: { authorization: 'Bearer otro' } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/backup/full' })).statusCode).toBe(401);
    await a.close();
  });

  it('sin BACKUP_TOKEN configurado, ningún Bearer sirve', async () => {
    delete process.env.BACKUP_TOKEN;
    const a = await full(async () => Buffer.from('x'));
    expect((await a.inject({ method: 'GET', url: '/api/backup/full', headers: { authorization: 'Bearer ' } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/backup/full', headers: { authorization: 'Bearer undefined' } })).statusCode).toBe(401);
    await a.close();
  });

  it('por sesión: solo el administrador; otro usuario recibe 403', async () => {
    delete process.env.BACKUP_TOKEN;
    process.env.ADMIN_EMAIL = 'a@test.io';
    const a = await full(async () => Buffer.from('-- ok'));
    const login2 = async (email: string) => {
      const r = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'clave-12345' } });
      const raw = r.headers['set-cookie'];
      return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
    };
    expect((await a.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: await login2('a@test.io') } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/backup/full', headers: { cookie: await login2('b@test.io') } })).statusCode).toBe(403);
    await a.close();
  });
});
