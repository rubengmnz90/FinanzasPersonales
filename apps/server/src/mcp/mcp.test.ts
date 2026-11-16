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

const prevLoginLimit = process.env.LOGIN_RATE_LIMIT;
beforeAll(async () => {
  // Este archivo inicia sesión muchas veces con el mismo usuario; el límite de 10/min se prueba en api.test.ts.
  process.env.LOGIN_RATE_LIMIT = '1000';
  ctx = await makeTestDb();
  app = await buildApp(ctx.db, { extend: (a, d) => registerMcp(a, d, 'http://localhost') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  // el publicUrl de los metadatos no afecta a las llamadas de este test
  await mkUser('a@test.io', 'clave-a-12345');
  await mkUser('b@test.io', 'clave-b-12345');
});
afterAll(async () => {
  if (prevLoginLimit === undefined) delete process.env.LOGIN_RATE_LIMIT;
  else process.env.LOGIN_RATE_LIMIT = prevLoginLimit;
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
    const w = await call(c, 'savings_overview', { account: savings });
    expect(w.json.totals.pending).toBe(0);
    await ctx.db.query(
      `INSERT INTO accounts(user_id,type,name,credit_limit) SELECT id,'card','Tarjeta Test',1000000 FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`,
    );
    const use = await call(c, 'add_transaction', { account: 'Tarjeta Test', kind: 'expense', item: 'Cerveza', amount: 40000, date: '2026-11-14' });
    expect(use.isError).toBe(false);
    const st = await call(c, 'account_statement', { account: 'Tarjeta Test' });
    expect(st.json.rows.at(-1).delta).toBe(-40000);
    await c.close();
  });

  it('add_transaction en un fondo (Ahorro Emma) descuenta y devuelve el saldo sin pasar por el flujo', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(
      `INSERT INTO accounts(user_id,type,name) SELECT id,'fund','Fondo Test' FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`,
    );
    const dep = await call(c, 'add_transaction', { account: 'Fondo Test', kind: 'income', item: 'Aporte', amount: 130000, date: '2026-11-10' });
    expect(dep.isError).toBe(false);
    const out = await call(c, 'add_transaction', { account: 'Fondo Test', kind: 'expense', item: 'Salud Emma', amount: 70000, date: '2026-11-16' });
    expect(out.isError).toBe(false);
    const accs = await call(c, 'list_accounts', {});
    const fund = (accs.json as any[]).find((a) => a.name === 'Fondo Test');
    expect(fund.balance).toBe(60000);
    // no toca el flujo de caja
    const sum = await call(c, 'monthly_summary', { year: 2026, month: 11 });
    expect(sum.json.expense).toBe(0);
    await c.close();
  });

  it('tarjeta: la compra con rubro cuenta en el resumen, el pago es una transferencia y se puede editar y borrar', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name,in_flow,is_default) SELECT id,'bank','GNB',true,true FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name,credit_limit,opening_balance) SELECT id,'card','Tarjeta Prueba',1000000,1000000 FROM users WHERE email='a@test.io'`);
    await ctx.db.query(`INSERT INTO categories(user_id,name,group_name) SELECT id,'Juegos','Gasto' FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`);
    const gnb = async () => ((await call(c, 'list_accounts', {})).json as any[]).find((x) => x.name === 'GNB');
    const card = async () => ((await call(c, 'list_accounts', {})).json as any[]).find((x) => x.name === 'Tarjeta Prueba');
    const gnb0 = (await gnb()).balance;

    // Compra + IVA en la tarjeta, con rubro, cuenta de pago y grupo.
    const buy = await call(c, 'add_transaction', { account: 'Tarjeta Prueba', kind: 'expense', item: 'Juego', amount: 347168, category: 'Juegos', payFrom: 'GNB', group: 'Juegos sep', date: '2026-09-10' });
    expect(buy.isError).toBe(false);
    expect(buy.json.warning).toBeUndefined();
    const iva = await call(c, 'add_transaction', { account: 'Tarjeta Prueba', kind: 'expense', item: 'IVA juego', amount: 34717, category: 'Juegos', payFrom: 'GNB', group: 'Juegos sep', date: '2026-09-10' });
    // Sin rubro: avisa y no cuenta.
    const nocat = await call(c, 'add_transaction', { account: 'Tarjeta Prueba', kind: 'expense', item: 'Sin rubro', amount: 1000, date: '2026-09-10' });
    expect(nocat.json.warning).toContain('category');

    let sum = await call(c, 'monthly_summary', { year: 2026, month: 9 });
    expect(sum.json.expense).toBe(381885);
    expect(sum.json.groups.find((g: any) => g.group === 'Gasto').categories).toEqual([{ name: 'Juegos', total: 381885 }]);
    expect((await gnb()).balance).toBe(gnb0); // comprar con la tarjeta no baja el banco todavía

    // Pago de la tarjeta: una sola operación, baja GNB, sube la tarjeta y no cuenta como ingreso ni egreso.
    const before = (await card()).balance;
    const pay = await call(c, 'add_transaction', { account: 'Tarjeta Prueba', kind: 'income', item: 'Pago tarjeta', amount: 161013, payFrom: 'GNB', date: '2026-09-20' });
    expect(pay.isError).toBe(false);
    expect(pay.json.type).toBe('transfer');
    expect((await gnb()).balance).toBe(gnb0 - 161013);
    expect((await card()).balance).toBe(before + 161013);
    sum = await call(c, 'monthly_summary', { year: 2026, month: 9 });
    expect(sum.json.expense).toBe(381885);
    expect(sum.json.income).toBe(0);
    const annual = await call(c, 'annual_summary', { year: 2026 });
    expect(annual.json.find((r: any) => r.category === 'Juegos').total).toBe(381885);
    const range = await call(c, 'range_summary', { from: '2026-09-01', to: '2026-09-30' });
    expect(range.json.expense).toBe(381885);

    // Grupo: subtotal compra + IVA; ids visibles en list_transactions.
    const st = await call(c, 'account_statement', { account: 'Tarjeta Prueba' });
    expect(st.json.groups).toEqual([{ group: 'Juegos sep', count: 2, total: -381885 }]);
    const list = await call(c, 'list_transactions', { account: 'Tarjeta Prueba' });
    const row = list.json.rows.find((r: any) => r.item === 'IVA juego');
    expect(row.rowType).toBe('entry');

    // Editar y borrar con las mismas herramientas que el resto.
    const upd = await call(c, 'update_transaction', { id: row.id, amount: 30000 });
    expect(upd.isError).toBe(false);
    sum = await call(c, 'monthly_summary', { year: 2026, month: 9 });
    expect(sum.json.expense).toBe(347168 + 30000);
    expect((await call(c, 'delete_transaction', { id: row.id })).isError).toBe(false);
    sum = await call(c, 'monthly_summary', { year: 2026, month: 9 });
    expect(sum.json.expense).toBe(347168);
    await c.close();
  });

  it('préstamo del ahorro y su devolución no inflan los ingresos ni los egresos', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name,in_flow,is_default) SELECT id,'bank','GNB',true,true FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name) SELECT id,'savings','Ahorro Prestamo' FROM users WHERE email='a@test.io'`);
    await call(c, 'add_transfer', { from: 'Ahorro Prestamo', to: 'GNB', amount: 850000, kind: 'loan', date: '2026-10-05' });
    await call(c, 'add_transaction', { item: 'Honorario', kind: 'income', amount: 5000000, account: 'GNB', date: '2026-10-10' });
    await call(c, 'add_transfer', { from: 'GNB', to: 'Ahorro Prestamo', amount: 850000, kind: 'repayment', date: '2026-10-10' });
    for (const r of [
      (await call(c, 'monthly_summary', { year: 2026, month: 10 })).json,
      (await call(c, 'range_summary', { from: '2026-10-01', to: '2026-10-31' })).json,
    ]) {
      expect(r.income).toBe(5000000);
      expect(r.expense).toBe(0);
    }
    const accs = (await call(c, 'list_accounts', {})).json as any[];
    expect(accs.find((a) => a.name === 'Ahorro Prestamo').loansPending).toBe(0);
    await c.close();
  });

  it('tarjeta: compras por regularizar, cuánto falta, regularizar por monto (parcial) y deshacer', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name,in_flow,is_default) SELECT id,'bank','GNB',true,true FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`);
    await ctx.db.query(`INSERT INTO accounts(user_id,type,name,credit_limit,opening_balance) SELECT id,'card','Tarjeta Reg',1000000,1000000 FROM users WHERE email='a@test.io'`);
    await ctx.db.query(`INSERT INTO categories(user_id,name,group_name) SELECT id,'Comida','Gasto' FROM users WHERE email='a@test.io' ON CONFLICT DO NOTHING`);
    const acc = async (n: string) => ((await call(c, 'list_accounts', {})).json as any[]).find((x) => x.name === n);
    const gnb0 = (await acc('GNB')).balance;
    const card0 = (await acc('Tarjeta Reg')).balance;

    // Una noche de salida: 60.000 de cerveza y 30.000 de hamburguesas por regularizar, y una compra normal.
    const a1 = await call(c, 'add_transaction', { account: 'Tarjeta Reg', kind: 'expense', item: 'Cerveza', amount: 60000, category: 'Comida', payFrom: 'GNB', regularize: true, date: '2026-12-02' });
    expect(a1.isError).toBe(false);
    expect(a1.json.regularize).toBe('pending');
    await call(c, 'add_transaction', { account: 'Tarjeta Reg', kind: 'expense', item: 'Hamburguesas', amount: 30000, category: 'Comida', payFrom: 'GNB', regularize: true, date: '2026-12-02' });
    await call(c, 'add_transaction', { account: 'Tarjeta Reg', kind: 'expense', item: 'Normal', amount: 9000, category: 'Comida', date: '2026-12-03' });

    // ¿Cuánto debo regularizar?
    let pend = (await call(c, 'pending_regularization', {})).json;
    expect(pend.total).toBe(90000);
    expect(pend.count).toBe(2);
    expect((await acc('Tarjeta Reg')).pendingRegularize).toBe(90000);
    expect((await call(c, 'monthly_summary', { year: 2026, month: 12 })).json.expense).toBe(99000); // ya cuentan como gasto
    expect((await acc('GNB')).balance).toBe(gnb0); // el banco no se movió todavía

    // Regulariza 80.000: cubre los 60.000 y 20.000 de los 30.000; quedan 10.000.
    const reg = await call(c, 'regularize', { account: 'GNB', amount: 80000, date: '2026-12-05' });
    expect(reg.isError).toBe(false);
    expect(reg.json.total).toBe(80000);
    expect(reg.json.stillPending).toBe(10000);
    expect(reg.json.applied).toEqual([
      expect.objectContaining({ concept: 'Cerveza', applied: 60000, remaining: 0 }),
      expect.objectContaining({ concept: 'Hamburguesas', applied: 20000, remaining: 10000 }),
    ]);
    expect(reg.json.transfers).toHaveLength(1); // una sola transferencia
    expect((await acc('GNB')).balance).toBe(gnb0 - 80000);
    expect((await acc('Tarjeta Reg')).balance).toBe(card0 - 99000 + 80000);
    expect((await call(c, 'monthly_summary', { year: 2026, month: 12 })).json.expense).toBe(99000); // pagar no es gastar otra vez
    pend = (await call(c, 'pending_regularization', {})).json;
    expect(pend.total).toBe(10000);
    expect(pend.entries).toEqual([expect.objectContaining({ concept: 'Hamburguesas', amount: 30000, regularized: 20000, pending: 10000 })]);

    // No se puede regularizar más de lo pendiente.
    expect((await call(c, 'regularize', { account: 'GNB', amount: 10001 })).isError).toBe(true);

    // Sin monto ni cuenta: paga lo que falta con la cuenta anotada (GNB).
    const rest = await call(c, 'regularize', {});
    expect(rest.isError).toBe(false);
    expect(rest.json.total).toBe(10000);
    expect((await call(c, 'pending_regularization', {})).json.total).toBe(0);
    expect((await call(c, 'regularize', {})).isError).toBe(true);

    // Borrar la transferencia de 80.000 devuelve esos abonos a pendiente.
    await call(c, 'delete_transfer', { id: reg.json.transfers[0].id });
    pend = (await call(c, 'pending_regularization', {})).json;
    expect(pend.total).toBe(80000);
    expect((await acc('GNB')).balance).toBe(gnb0 - 10000);
    await c.close();
  });

  it('rubros: lista por tipo con uso y sugiere el rubro según el historial', async () => {
    const cookie = await webLogin('a@test.io', 'clave-a-12345');
    const { tokens } = await fullFlow(cookie);
    const c = await connect(tokens.access_token);
    await ctx.db.query(`INSERT INTO categories(user_id,name,group_name) SELECT id,v.n,v.g FROM users u CROSS JOIN (VALUES ('Bebidas','Gasto'),('Comida','Gasto'),('Honorarios','Ingresos')) AS v(n,g) WHERE u.email='a@test.io' ON CONFLICT DO NOTHING`);
    await call(c, 'add_transaction', { item: 'Cerveza salida', kind: 'expense', amount: 40000, category: 'Bebidas', date: '2026-12-10' });
    await call(c, 'add_transaction', { item: 'Cerveza viernes', kind: 'expense', amount: 20000, category: 'Bebidas', date: '2026-12-11' });
    await call(c, 'add_transaction', { item: 'Almuerzo', kind: 'expense', amount: 30000, category: 'Comida', date: '2026-12-11' });

    const all = (await call(c, 'list_categories', {})).json as any[];
    const beb = all.find((x) => x.name === 'Bebidas');
    expect(beb.uses).toBe(2);
    expect(beb.examples).toContain('Cerveza salida');
    expect(beb.groupName).toBe('Gasto');
    const gasto = (await call(c, 'list_categories', { group: 'Gasto' })).json as any[];
    expect(gasto.every((x) => x.groupName === 'Gasto')).toBe(true);
    const usos = gasto.map((x) => x.uses);
    expect(usos).toEqual([...usos].sort((p, q) => q - p)); // los más usados primero

    const sug = (await call(c, 'suggest_category', { text: 'Cerveza con amigos' })).json as any[];
    expect(sug[0].category).toBe('Bebidas');
    const inc = (await call(c, 'suggest_category', { text: 'Honorarios evento', kind: 'income' })).json as any[];
    expect(inc[0].category).toBe('Honorarios');
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
