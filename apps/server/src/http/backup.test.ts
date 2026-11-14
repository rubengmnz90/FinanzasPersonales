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
});
