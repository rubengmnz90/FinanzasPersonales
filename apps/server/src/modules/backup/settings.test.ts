import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, type TestCtx } from '../../test/helpers';
import { hashPassword } from '../../auth/sessions';
import { buildApp } from '../../http/app';
import { AutoBackup } from './auto';
import { decryptJson, encryptJson, mergeInput, publicView, SettingsError } from './settings';

const ENV = { SETTINGS_KEY: 'una-llave-larga-del-servidor-123' } as NodeJS.ProcessEnv;
const input = { endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'mi-bucket', keyId: '004abcdef123456', secret: 'K004-secreto-muy-secreto' };

describe('configuración guardada desde la app (cifrada)', () => {
  it('cifra y descifra; el texto guardado no contiene el secreto', () => {
    const blob = encryptJson(input, ENV);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('secreto');
    expect(blob).not.toContain('004abcdef');
    expect(decryptJson(blob, ENV)).toEqual(input);
    expect(encryptJson(input, ENV)).not.toBe(blob); // iv distinto cada vez
  });

  it('con otra llave o un blob alterado no descifra; sin llave no cifra', () => {
    const blob = encryptJson(input, ENV);
    expect(() => decryptJson(blob, { SETTINGS_KEY: 'otra-llave-larga-del-servidor-999' } as NodeJS.ProcessEnv)).toThrow('cambió');
    const parts = blob.split('.');
    parts[3] = parts[3].slice(0, -2) + 'AA';
    expect(() => decryptJson(parts.join('.'), ENV)).toThrow(SettingsError);
    expect(() => encryptJson(input, {} as NodeJS.ProcessEnv)).toThrow('llave');
    expect(() => encryptJson(input, { BACKUP_TOKEN: 'corto' } as NodeJS.ProcessEnv)).toThrow('llave');
    const tok = { BACKUP_TOKEN: 'token-de-respaldo-largo-1234' } as NodeJS.ProcessEnv; // sin SETTINGS_KEY usa BACKUP_TOKEN
    expect(decryptJson(encryptJson(input, tok), tok)).toEqual(input);
  });

  it('mergeInput valida y, al editar, conserva el secreto si va vacío', () => {
    const { fields, config } = mergeInput(input, null);
    expect(fields.endpoint).toBe(input.endpoint);
    expect(config.info.bucket).toBe('mi-bucket');
    const again = mergeInput({ ...input, keyId: '', secret: '', hours: '3,9', keepWeekly: '8' }, fields);
    expect(again.fields.secret).toBe(input.secret);
    expect(again.fields.keyId).toBe(input.keyId);
    expect(again.config.hours).toEqual([3, 9]);
    expect(again.config.policy.weekly).toBe(8);
    expect(() => mergeInput({ ...input, endpoint: 'http://inseguro.com' }, null)).toThrow('https');
    expect(() => mergeInput({ ...input, endpoint: 'http://127.0.0.1:9000' }, null)).not.toThrow();
    expect(() => mergeInput({ ...input, bucket: '??' }, null)).toThrow('bucket');
    expect(() => mergeInput({ ...input, secret: '' }, null)).toThrow('applicationKey');
    expect(() => mergeInput({ ...input, hours: '25' }, null)).toThrow('horas');
    expect(() => mergeInput({ ...input, keepDaily: '-1' }, null)).toThrow('enteros');
    expect(() => mergeInput({ ...input, tz: 'Marte/Olimpo' }, null)).toThrow('Zona');
  });

  it('publicView nunca devuelve el secreto ni la clave de acceso completa', () => {
    const v = publicView(mergeInput(input, null).fields)!;
    expect(JSON.stringify(v)).not.toContain('secreto');
    expect(JSON.stringify(v)).not.toContain('004abcdef123456');
    expect(v.hasSecret).toBe(true);
  });
});

describe('rutas /api/backup/auto/config', () => {
  let ctx: TestCtx;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: Server;
  let endpoint = '';
  const auto = new AutoBackup(null, { log: () => undefined });
  const OLD = { k: process.env.SETTINGS_KEY, a: process.env.ADMIN_EMAIL };

  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@test.io';
    process.env.SETTINGS_KEY = ENV.SETTINGS_KEY;
    // Un "S3" local que acepta subir, listar y borrar; así se prueba el guardado sin salir a internet.
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/xml');
          res.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
          return;
        }
        res.statusCode = req.method === 'DELETE' ? 204 : 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ctx = await makeTestDb();
    app = await buildApp(ctx.db, { autoBackup: auto });
    await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2)', ['admin@test.io', await hashPassword('clave-12345')]);
  });
  afterAll(async () => {
    await app.close();
    await ctx.close();
    await new Promise<void>((r) => server.close(() => r()));
    if (OLD.k === undefined) delete process.env.SETTINGS_KEY; else process.env.SETTINGS_KEY = OLD.k;
    if (OLD.a === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = OLD.a;
  });

  async function cookie() {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.io', password: 'clave-12345' } });
    const raw = r.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
  }
  const body = (over: object = {}) => ({ ...input, ...over });

  it('exige administrador y rechaza datos inválidos', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/backup/auto/config', payload: body() })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'PUT', url: '/api/backup/auto/config', headers: { cookie: await cookie() }, payload: body({ endpoint: 'ftp://x' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('INVALID_SETTINGS');
  });

  it('si no se puede conectar, no guarda nada y no activa nada', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/backup/auto/config', headers: { cookie: await cookie() }, payload: body({ endpoint: 'https://127.0.0.1:1' }) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('CONNECTION_FAILED');
    expect((await ctx.db.query('SELECT 1 FROM backup_settings')).rowCount).toBe(0);
    expect(auto.cfg).toBeNull();
  }, 60_000);

  it('GET informa que hay llave y que no hay nada guardado', async () => {
    const j = (await app.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie: await cookie() } })).json();
    expect(j.keyAvailable).toBe(true);
    expect(j.settings).toBeNull();
    expect(j.status.configured).toBe(false);
  });

  it('PUT sobre el bucket que responde: prueba, guarda cifrado, activa y no devuelve el secreto', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/backup/auto/config', headers: { cookie: await cookie() }, payload: body({ endpoint }) });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toContain(input.secret);
    const raw = (await ctx.db.query('SELECT config_enc FROM backup_settings')).rows[0].config_enc as string;
    expect(raw).not.toContain('secreto');
    expect(raw).not.toContain(input.keyId);
    expect(auto.cfg?.info.bucket).toBe('mi-bucket');
    expect(auto.source).toBe('app');

    const j = (await app.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie: await cookie() } })).json();
    expect(j.settings.hasSecret).toBe(true);
    expect(j.status.configured).toBe(true);
    expect(JSON.stringify(j)).not.toContain(input.secret);
    expect(JSON.stringify(j)).not.toContain(input.keyId);

    // al editar sin escribir el secreto, se conserva el anterior
    const again = await app.inject({ method: 'PUT', url: '/api/backup/auto/config', headers: { cookie: await cookie() }, payload: body({ endpoint, keyId: '', secret: '', hours: '6,18' }) });
    expect(again.statusCode).toBe(200);
    expect(auto.cfg?.hours).toEqual([6, 18]);
  });

  it('DELETE borra lo guardado y apaga el respaldo si no hay .env', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/backup/auto/config', headers: { cookie: await cookie() } });
    expect(r.statusCode).toBe(200);
    expect((await ctx.db.query('SELECT 1 FROM backup_settings')).rowCount).toBe(0);
    expect(auto.cfg).toBeNull();
  });
});
