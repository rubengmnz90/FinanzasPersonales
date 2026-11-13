import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestDb, type TestCtx } from '../test/helpers';
import { hashPassword } from '../auth/sessions';
import { buildApp } from './app';

let ctx: TestCtx;
let app: FastifyInstance;

async function user(email: string, pw: string, mustChange = false) {
  const r = await ctx.db.query(
    'INSERT INTO users(email,password_hash,must_change_password) VALUES ($1,$2,$3) RETURNING id',
    [email, await hashPassword(pw), mustChange],
  );
  return r.rows[0].id as string;
}

function sidOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const sid = list.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return sid && sid !== 'sid=' ? sid : '';
}

async function login(email: string, password: string, ip = '10.0.0.1') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: ip });
  return { res, cookie: sidOf(res) };
}

beforeAll(async () => {
  ctx = await makeTestDb();
  app = await buildApp(ctx.db, { allowSignup: false });
  await user('ruben@test.io', 'clave-inicial', true);
  await user('otro@test.io', 'otra-clave-1', false);
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('auth', () => {
  it('rechaza credenciales malas sin distinguir si el email existe', async () => {
    const a = await login('ruben@test.io', 'mala', '10.0.0.2');
    const b = await login('noexiste@test.io', 'mala', '10.0.0.3');
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json()).toEqual(b.res.json());
  });

  it('limita a 10 intentos por minuto por IP+email', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login('ruben@test.io', 'mala', '10.0.0.9')).res.statusCode;
    expect(last).toBe(429);
  });

  it('signup cerrado por defecto', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'n@t.io', password: '12345678' } });
    expect(r.statusCode).toBe(404);
  });

  it('el usuario inicial debe cambiar la contraseña antes de usar la API', async () => {
    const { res, cookie } = await login('ruben@test.io', 'clave-inicial', '10.0.0.4');
    expect(res.json().mustChangePassword).toBe(true);
    const blocked = await app.inject({ method: 'GET', url: '/api/transactions', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('PASSWORD_CHANGE_REQUIRED');

    const weak = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie }, payload: { currentPassword: 'clave-inicial', newPassword: '123' } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie }, payload: { currentPassword: 'clave-inicial', newPassword: 'nueva-clave-segura' } });
    expect(ok.statusCode).toBe(200);
    const newCookie = sidOf(ok);
    const allowed = await app.inject({ method: 'GET', url: '/api/transactions', headers: { cookie: newCookie } });
    expect(allowed.statusCode).toBe(200);
    // la sesión anterior quedó cerrada y la contraseña vieja ya no sirve
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await login('ruben@test.io', 'clave-inicial', '10.0.0.5')).res.statusCode).toBe(401);
  });

  it('sin sesión todo da 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/plans' })).statusCode).toBe(401);
  });
});

describe('API de datos', () => {
  it('crea un gasto con fórmula, filtra por rango y aísla usuarios', async () => {
    const a = (await login('ruben@test.io', 'nueva-clave-segura', '10.0.1.1')).cookie;
    const b = (await login('otro@test.io', 'otra-clave-1', '10.0.1.2')).cookie;
    const created = await app.inject({
      method: 'POST', url: '/api/transactions', headers: { cookie: a },
      payload: { date: '2026-08-02', item: 'Google Vibra Lejana', kind: 'expense', rawAmount: '=45814+4581' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().amount).toBe(50395);
    const id = created.json().id;

    const inRange = await app.inject({ method: 'GET', url: '/api/transactions?from=2026-08-01&to=2026-08-31', headers: { cookie: a } });
    expect(inRange.json()).toHaveLength(1);
    const outRange = await app.inject({ method: 'GET', url: '/api/transactions?from=2026-09-01&to=2026-09-30', headers: { cookie: a } });
    expect(outRange.json()).toHaveLength(0);

    expect((await app.inject({ method: 'GET', url: `/api/transactions/${id}`, headers: { cookie: b } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, headers: { cookie: b }, payload: { item: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${id}`, headers: { cookie: b } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/transactions', headers: { cookie: b } })).json()).toHaveLength(0);
  });

  it('valida entradas: monto con código y fecha inválida dan 400', async () => {
    const a = (await login('ruben@test.io', 'nueva-clave-segura', '10.0.1.3')).cookie;
    const bad1 = await app.inject({ method: 'POST', url: '/api/transactions', headers: { cookie: a }, payload: { date: '2026-01-01', item: 'x', kind: 'expense', rawAmount: '=process.exit()' } });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json().error).toBe('INVALID_AMOUNT');
    const bad2 = await app.inject({ method: 'POST', url: '/api/transactions', headers: { cookie: a }, payload: { date: '01/01/2026', item: 'x', kind: 'expense', rawAmount: 1 } });
    expect(bad2.statusCode).toBe(400);
  });

  it('planes: crear mensual, editar celda con expresión y clonar a otro año', async () => {
    const a = (await login('ruben@test.io', 'nueva-clave-segura', '10.0.1.4')).cookie;
    const plan = (await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie: a }, payload: { year: 2027, name: 'Mensual', periods: [{ label: 'Mensual', dayOfMonth: 30 }] } })).json();
    const view = (await app.inject({ method: 'GET', url: `/api/plans/${plan.id}`, headers: { cookie: a } })).json();
    const item = (await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/items`, headers: { cookie: a }, payload: { periodId: view.periods[0].id, kind: 'expense', concept: 'Alquiler' } })).json();
    const put = await app.inject({ method: 'PUT', url: `/api/plan-items/${item.id}/cells/1`, headers: { cookie: a }, payload: { rawAmount: '=1.050.000' } });
    expect(put.json().amount).toBe(1050000);
    const clone = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/rollover`, headers: { cookie: a }, payload: { toYear: 2028 } });
    expect(clone.statusCode).toBe(200);
    expect(clone.json().plan.year).toBe(2028);
    const again = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/rollover`, headers: { cookie: a }, payload: { toYear: 2028 } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('YEAR_EXISTS');
  });
});

describe('importar Excel desde la app', () => {
  const xlsx = process.env.EXCEL_FILE ?? 'C:/Users/Ruben/Downloads/Administracion 2026.xlsx';
  const up = (cookie: string, body: Buffer | string, dry: boolean) =>
    app.inject({ method: 'POST', url: `/api/import?dryRun=${dry ? 1 : 0}`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: body });
  const tmpDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('import-'));

  it('exige sesión y rechaza lo que no es un .xlsx, sin dejar temporales', async () => {
    const before = tmpDirs().length;
    expect((await app.inject({ method: 'POST', url: '/api/import', headers: { 'content-type': 'application/octet-stream' }, payload: 'x' })).statusCode).toBe(401);
    const { cookie } = await login('otro@test.io', 'otra-clave-1', '10.0.1.1');
    const bad = await up(cookie, 'esto no es un excel', true);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('ARCHIVO_INVALIDO');
    // un ZIP válido pero que no es el libro esperado tampoco deja rastro
    const fake = await up(cookie, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('basura')]), true);
    expect(fake.statusCode).toBe(400);
    expect(tmpDirs().length).toBe(before);
  });

  it.skipIf(!existsSync(xlsx))('simula sin guardar, importa, y repetir no duplica; el temporal se borra', async () => {
    const before = tmpDirs().length;
    const { cookie } = await login('otro@test.io', 'otra-clave-1', '10.0.1.2');
    const file = readFileSync(xlsx);
    const count = async () => (await ctx.db.query('SELECT count(*)::int AS n FROM transactions t JOIN users u ON u.id=t.user_id WHERE u.email=$1', ['otro@test.io'])).rows[0].n as number;

    const dry = await up(cookie, file, true);
    expect(dry.statusCode).toBe(200);
    expect(dry.json().reconciliation.every((r: any) => r.ok)).toBe(true);
    expect(await count()).toBe(0);

    const real = await up(cookie, file, false);
    expect(real.statusCode).toBe(200);
    const n = await count();
    expect(n).toBeGreaterThan(100);

    const again = await up(cookie, file, false);
    expect(again.statusCode).toBe(200);
    expect(await count()).toBe(n);
    expect(tmpDirs().length).toBe(before);

    // quedó en el historial como "importación" y se puede deshacer entera
    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=5', headers: { cookie } });
    const act = audit.json().actions.find((a: any) => a.actor === 'importación' && a.total > 100);
    expect(act).toBeTruthy();
    expect(act.entries.length).toBeLessThanOrEqual(30);
  }, 120_000);
});
