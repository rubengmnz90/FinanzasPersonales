import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestDb, type TestCtx } from '../test/helpers';
import { hashPassword } from '../auth/sessions';
import { buildApp } from '../http/app';
import { registerMcp } from './register';

let ctx: TestCtx;
let app: FastifyInstance;
let base = '';
const REDIRECT = 'http://localhost:9999/callback';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function mkUser(email: string, pw: string) {
  await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2)', [email, await hashPassword(pw)]);
}

async function webLogin(email: string, pw: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0];
}

async function register(redirect = REDIRECT) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude Code (test)' }) });
  return { status: r.status, body: (await r.json()) as any };
}

async function getCode(cookie: string, clientId: string, challenge: string, scopes?: string[]) {
  const r = await fetch(`${base}/api/oauth/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', approve: true, ...(scopes ? { scopes } : {}) }),
  });
  expect(r.status).toBe(200);
  const url = new URL(((await r.json()) as any).redirectTo);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

const tokenReq = (params: Record<string, string>) =>
  fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

async function fullFlow(cookie: string, scopes?: string[]) {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const code = await getCode(cookie, client.client_id, challenge, scopes);
  const r = await tokenReq({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  expect(r.status).toBe(200);
  return { client, tokens: (await r.json()) as any };
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
};

beforeAll(async () => {
  ctx = await makeTestDb();
  app = await buildApp(ctx.db, { extend: (a, d) => registerMcp(a, d, 'http://localhost') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  // el publicUrl de los metadatos no afecta a las llamadas de este test
  await mkUser('a@test.io', 'clave-a-12345');
  await mkUser('b@test.io', 'clave-b-12345');
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('OAuth', () => {
  it('sin token /mcp responde 401 con WWW-Authenticate apuntando a los metadatos', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('publica metadatos con PKCE S256 y registro dinámico', async () => {
    const m: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.registration_endpoint).toContain('/oauth/register');
  });

  it('rechaza redirect_uri peligrosos y no redirige con redirect_uri no registrado', async () => {
    expect((await register('javascript:alert(1)')).status).toBe(400);
    expect((await register('http://evil.example.com/cb')).status).toBe(400);
    const { body: client } = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:1/otro', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
    const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(r.status).toBe(400);
  });

  it('authorize sin sesión redirige al login de la web conservando la solicitud', async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
    const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/login?next=');
  });

  it('PKCE: verifier incorrecto falla y el código no se puede reutilizar', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const code = await getCode(cookie, client.client_id, challenge);
    const bad = await tokenReq({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: REDIRECT });
    expect(bad.status).toBe(400);
    const reuse = await tokenReq({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(reuse.status).toBe(400);
  });

  it('refresh rota el token y revoca el anterior', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { client, tokens } = await fullFlow(cookie);
    const r = await tokenReq({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
    expect(r.status).toBe(200);
    const next: any = await r.json();
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await tokenReq({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});

describe('herramientas MCP', () => {
  it('con permiso de escritura carga un gasto con expresión y lo lee de vuelta', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['add_transaction', 'list_transactions', 'monthly_summary', 'list_accounts']));
    const add = await call(c, 'add_transaction', { date: '2026-08-02', item: 'Google Vibra Lejana', kind: 'expense', amount: '=45814+4581' });
    expect(add.isError).toBe(false);
    expect(add.json.amount).toBe(50395);
    const list = await call(c, 'list_transactions', { from: '2026-08-01', to: '2026-08-31' });
    expect(list.json.rows).toHaveLength(1);
    const sum = await call(c, 'monthly_summary', { year: 2026, month: 8 });
    expect(sum.json.expense).toBe(50395);
    const bad = await call(c, 'add_transaction', { item: 'x', kind: 'expense', amount: '=process.exit()' });
    expect(bad.isError).toBe(true);
    await c.close();
  });

  it('add_transaction en un ahorro registra la devolución de un retiro temporal', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(
      `INSERT INTO accounts(user_id,type,name) SELECT id,'savings','Ahorro Test' FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`,
    );
    const savings = 'Ahorro Test';
    await call(c, 'add_transaction', { account: savings, kind: 'expense', item: 'Reponer amor', amount: 91000, date: '2026-11-13' });
    const back = await call(c, 'add_transaction', { account: savings, kind: 'income', item: 'Devolución Amor', amount: 91000, date: '2026-11-13' });
    expect(back.isError).toBe(false);
    expect(back.json.tag).toBe('return');
    const w = await call(c, 'savings_withdrawals', { account: savings });
    expect(w.json.pending).toBe(0);
    await ctx.db.query(
      `INSERT INTO accounts(user_id,type,name,credit_limit) SELECT id,'card','Tarjeta Test',1000000 FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`,
    );
    const use = await call(c, 'add_transaction', { account: 'Tarjeta Test', kind: 'expense', item: 'Cerveza', amount: 40000, date: '2026-11-14' });
    expect(use.isError).toBe(false);
    const st = await call(c, 'account_statement', { account: 'Tarjeta Test' });
    expect(st.json.rows.at(-1).delta).toBe(-40000);
    await c.close();
  });

  it('un token solo de lectura no puede escribir', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie, ['finanzas:read']);
    const c = await connect(tokens.access_token);
    const r = await call(c, 'add_transaction', { item: 'x', kind: 'expense', amount: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('finanzas:write');
    expect((await call(c, 'list_transactions')).isError).toBe(false);
    await c.close();
  });

  it('el token del usuario B no ve ni toca datos de A', async () => {
    const ca = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens: ta } = await fullFlow(ca);
    const a = await connect(ta.access_token);
    const pe = await call(a, 'add_planned_expense', { concept: 'Celular', amount: 250000, period: 'Quincena', dueDate: '2026-03-15' });
    const cb = await webLogin('b@test.io', 'clave-b-12345');
    const { tokens: tb } = await fullFlow(cb);
    const b = await connect(tb.access_token);
    expect((await call(b, 'list_transactions')).json.rows).toHaveLength(0);
    expect((await call(b, 'list_planned_expenses')).json).toHaveLength(0);
    const steal = await call(b, 'mark_planned_expense_done', { id: pe.json.id });
    expect(steal.isError).toBe(true);
    expect(steal.text).toContain('No encontrado');
    await a.close();
    await b.close();
  });

  it('revocar la conexión corta el acceso al instante', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { client, tokens } = await fullFlow(cookie);
    const list = await fetch(`${base}/api/connections`, { headers: { cookie } });
    expect(((await list.json()) as any[]).some((x) => x.client_id === client.client_id)).toBe(true);
    await fetch(`${base}/api/connections/${client.client_id}`, { method: 'DELETE', headers: { cookie } });
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });
});
