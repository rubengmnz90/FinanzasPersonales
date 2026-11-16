import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, type TestCtx } from '../../test/helpers';
import { hashPassword } from '../../auth/sessions';
import { buildApp } from '../../http/app';
import { AutoBackup, autoBackupFromEnv, listAutoCopies, runBackup, type AutoBackupConfig } from './auto';
import { classify, copyName, DEFAULT_POLICY, latestSlot, parseCopyDate, selectToDelete, type Copy, type Policy } from './gfs';
import { MemoryStore, S3Store } from './store';

const DUMP = Buffer.from(`--
-- PostgreSQL database dump
--
CREATE TABLE public.users (id uuid, email text);
CREATE TABLE public.schema_migrations (name text);
`);
const POLICY: Policy = { recentDays: 2, daily: 7, weekly: 4, monthly: 12, tz: 'UTC' };
const at = (iso: string) => new Date(iso);
const copy = (iso: string): Copy => ({ key: `finanzas/${copyName(at(iso))}`, at: at(iso) });

/** 4 copias por día (00, 06, 12, 18 UTC) desde `from` hasta `to` (incluidos). */
function fourPerDay(from: string, to: string): Copy[] {
  const out: Copy[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    for (const h of [0, 6, 12, 18]) out.push(copy(`${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:00:05Z`));
  }
  return out;
}

describe('nombres de las copias', () => {
  it('se arman y se leen de vuelta; lo ajeno no se reconoce', () => {
    const d = at('2026-11-16T15:30:45Z');
    expect(copyName(d)).toBe('finanzas-20261116-153045.zip');
    expect(parseCopyDate(`finanzas/${copyName(d)}`)?.toISOString()).toBe(d.toISOString());
    expect(parseCopyDate('finanzas/notas.txt')).toBeNull();
    expect(parseCopyDate('finanzas/finanzas-2026-11-16.zip')).toBeNull();
  });
});

describe('retención GFS', () => {
  it('con 4 copias por día durante 100 días deja reciente + 7 diarias + 4 semanales + 12 mensuales', () => {
    const copies = fourPerDay('2026-08-08', '2026-11-16'); // 101 días
    const now = at('2026-11-16T19:00:00Z'); // lunes
    const keep = classify(copies, now, POLICY);
    // recientes: todas las de los últimos 2 días
    const recent = copies.filter((c) => now.getTime() - c.at.getTime() < 2 * 86_400_000);
    for (const c of recent) expect(keep.get(c.key)).toContain('reciente');
    // diarias: la última de cada uno de los últimos 7 días (18:00)
    for (const d of ['16', '15', '14', '13', '12', '11', '10']) {
      expect(keep.has(`finanzas/finanzas-202611${d}-180005.zip`)).toBe(true);
    }
    // las de las 00, 06 y 12 de hace 5 días ya no se guardan
    expect(keep.has('finanzas/finanzas-20261111-000005.zip')).toBe(false);
    expect(keep.has('finanzas/finanzas-20261111-120005.zip')).toBe(false);
    // una por semana: la última de cada semana (el domingo 18:00): 15/11, 8/11 y 1/11
    for (const k of ['20261115', '20261108', '20261101']) expect(keep.get(`finanzas/finanzas-${k}-180005.zip`)).toContain('semanal');
    // las de mitad de semana de hace más de 7 días no se guardan (el lunes 9/11 no es la última de su semana)
    expect(keep.has('finanzas/finanzas-20261109-180005.zip')).toBe(false);
    expect(keep.has('finanzas/finanzas-20261103-120005.zip')).toBe(false);
    // una por mes: la última de agosto, septiembre y octubre
    for (const k of ['20260831', '20260930', '20261031']) expect(keep.get(`finanzas/finanzas-${k}-180005.zip`)).toContain('mensual');
    // total acotado: ~8 recientes + ~5 diarias + ~3 semanales + ~3 mensuales
    expect(keep.size).toBeLessThanOrEqual(8 + 7 + 4 + 12);
    expect(keep.size).toBeGreaterThanOrEqual(16);
    // una copia puede cumplir varios roles: la del domingo 15 es reciente, diaria y semanal
    expect(keep.get('finanzas/finanzas-20261115-180005.zip')).toEqual(expect.arrayContaining(['reciente', 'diaria', 'semanal']));
  });

  it('en un año de copias quedan pocas (no crece sin fin) y siempre está la más nueva', () => {
    const copies = fourPerDay('2025-11-17', '2026-11-16'); // 365 días ≈ 1460 copias
    const now = at('2026-11-16T19:00:00Z');
    const del = selectToDelete(copies, now, POLICY);
    const left = copies.length - del.length;
    expect(copies.length).toBeGreaterThan(1400);
    expect(left).toBeLessThanOrEqual(35);
    expect(del.some((c) => c.key === copies[copies.length - 1].key)).toBe(false);
  });

  it('nunca deja el bucket sin copias, aunque todas sean viejas', () => {
    const copies = [copy('2020-01-01T00:00:00Z'), copy('2020-01-02T00:00:00Z')];
    const del = selectToDelete(copies, at('2026-11-16T00:00:00Z'), POLICY);
    expect(del.map((c) => c.key)).toEqual([copies[0].key]); // se queda la más nueva
  });

  it('los días se cuentan en la zona horaria elegida', () => {
    // 02:00 UTC del 16 son las 23:00 del 15 en Asunción (UTC-3): es el mismo día local que las 20:00 UTC del 15
    const a = copy('2026-11-16T02:00:00Z');
    const b = copy('2026-11-15T20:00:00Z');
    const c = copy('2026-11-14T00:00:00Z');
    const now = at('2026-11-16T12:00:00Z');
    const keep = classify([a, b, c], now, { ...POLICY, recentDays: 0, tz: 'America/Asuncion' });
    expect(keep.get(a.key)).toContain('diaria'); // la más nueva del día local 15
    expect(keep.get(b.key)).toBeUndefined(); // no es la última de su día local
  });
});

describe('horarios', () => {
  it('devuelve la última hora programada que ya pasó', () => {
    const hours = [0, 6, 12, 18];
    expect(latestSlot(at('2026-11-16T14:20:00Z'), hours, 'UTC').toISOString()).toBe('2026-11-16T12:00:00.000Z');
    expect(latestSlot(at('2026-11-16T05:59:00Z'), hours, 'UTC').toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(latestSlot(at('2026-11-16T00:00:00Z'), hours, 'UTC').toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });
  it('respeta la zona horaria (Asunción es UTC-3)', () => {
    // 14:20 UTC = 11:20 en Asunción → la última hora fue 06:00 local = 09:00 UTC
    expect(latestSlot(at('2026-11-16T14:20:00Z'), [0, 6, 12, 18], 'America/Asuncion').toISOString()).toBe('2026-11-16T09:00:00.000Z');
    // 01:00 UTC del 16 = 22:00 del 15 local → la última fue las 18:00 locales del 15 = 21:00 UTC
    expect(latestSlot(at('2026-11-16T01:00:00Z'), [0, 6, 12, 18], 'America/Asuncion').toISOString()).toBe('2026-11-15T21:00:00.000Z');
  });
});

describe('configuración desde el entorno', () => {
  const base = { BACKUP_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com', BACKUP_S3_KEY_ID: 'id', BACKUP_S3_SECRET: 'sec', BACKUP_S3_BUCKET: 'mi-bucket' };
  it('sin las 4 variables obligatorias queda apagado', () => {
    expect(autoBackupFromEnv({})).toBeNull();
    expect(autoBackupFromEnv({ ...base, BACKUP_S3_SECRET: '' })).toBeNull();
    expect(autoBackupFromEnv({ ...base, BACKUP_AUTO: 'false' })).toBeNull();
  });
  it('con ellas usa los valores por defecto: 4 al día, GFS 2/7/4/12, carpeta finanzas/', () => {
    const c = autoBackupFromEnv(base)!;
    expect(c.hours).toEqual([0, 6, 12, 18]);
    expect(c.prefix).toBe('finanzas/');
    expect(c.policy).toEqual(DEFAULT_POLICY);
    expect(c.info.bucket).toBe('mi-bucket');
    expect(JSON.stringify(c.info)).not.toContain('sec');
  });
  it('las variables opcionales vacías (así las pasa Docker) usan los valores por defecto', () => {
    const c = autoBackupFromEnv({ ...base, BACKUP_HOURS: '', BACKUP_S3_PREFIX: '', BACKUP_TZ: '', BACKUP_KEEP_DAILY: '', BACKUP_S3_REGION: '', BACKUP_S3_SSE: '', BACKUP_AUTO: '' })!;
    expect(c.hours).toEqual([0, 6, 12, 18]);
    expect(c.prefix).toBe('finanzas/');
    expect(c.policy).toEqual(DEFAULT_POLICY);
  });
  it('se puede ajustar', () => {
    const c = autoBackupFromEnv({ ...base, BACKUP_HOURS: '3, 9', BACKUP_KEEP_WEEKLY: '8', BACKUP_S3_PREFIX: '/copias', BACKUP_TZ: 'UTC' })!;
    expect(c.hours).toEqual([3, 9]);
    expect(c.policy.weekly).toBe(8);
    expect(c.prefix).toBe('copias/');
    expect(c.policy.tz).toBe('UTC');
  });
});

describe('hacer una copia', () => {
  const mk = (store = new MemoryStore()): AutoBackupConfig => ({ store, prefix: 'finanzas/', hours: [0, 6, 12, 18], policy: POLICY, info: { bucket: 'b', endpoint: 'e' } });

  it('sube un .zip restaurable, lo verifica y aplica GFS sin tocar archivos ajenos', async () => {
    const store = new MemoryStore();
    const cfg = mk(store);
    for (const c of fourPerDay('2026-09-01', '2026-11-15')) await store.put(c.key, Buffer.from('viejo'));
    await store.put('finanzas/LEEME.txt', Buffer.from('no tocar'));
    const before = store.objects.size;
    const r = await runBackup(cfg, { now: at('2026-11-16T00:00:05Z'), dump: async () => DUMP });
    expect(r.key).toBe('finanzas/finanzas-20261116-000005.zip');
    expect(store.objects.has(r.key)).toBe(true);
    expect(store.objects.get(r.key)!.body.subarray(0, 2).toString()).toBe('PK'); // es un zip
    expect(r.deleted.length).toBeGreaterThan(40);
    expect(store.objects.size).toBe(before + 1 - r.deleted.length);
    expect(store.objects.has('finanzas/LEEME.txt')).toBe(true);
    expect(r.deleted).not.toContain(r.key);
  });

  it('si la subida falla no borra nada y lo dice', async () => {
    const store = new MemoryStore();
    for (const c of fourPerDay('2026-09-01', '2026-09-30')) await store.put(c.key, Buffer.from('x'));
    const n = store.objects.size;
    store.failPut = true;
    await expect(runBackup(mk(store), { now: at('2026-11-16T00:00:05Z'), dump: async () => DUMP })).rejects.toThrow('no disponible');
    expect(store.objects.size).toBe(n);
  });

  it('un dump inválido no se sube', async () => {
    const store = new MemoryStore();
    await expect(runBackup(mk(store), { dump: async () => Buffer.from('SELECT 1;') })).rejects.toThrow();
    expect(store.objects.size).toBe(0);
  });

  it('listAutoCopies explica por qué se conserva cada copia', async () => {
    const store = new MemoryStore();
    const cfg = mk(store);
    await runBackup(cfg, { now: at('2026-11-16T00:00:05Z'), dump: async () => DUMP });
    const list = await listAutoCopies(cfg, at('2026-11-16T01:00:00Z'));
    expect(list).toHaveLength(1);
    expect(list[0].tiers).toContain('reciente');
    expect(list[0].name).toBe('finanzas-20261116-000005.zip');
  });
});

describe('planificador', () => {
  it('hace una copia cuando pasó una hora programada sin copia y luego espera la siguiente', async () => {
    const store = new MemoryStore();
    const cfg: AutoBackupConfig = { store, prefix: 'finanzas/', hours: [0, 6, 12, 18], policy: POLICY, info: { bucket: 'b', endpoint: 'e' } };
    let now = at('2026-11-16T06:10:00Z');
    const auto = new AutoBackup(cfg, { dump: async () => DUMP, log: () => undefined, clock: () => now });
    expect(await auto.tick()).toBe(true); // pasó la de las 06:00
    expect(store.objects.size).toBe(1);
    expect(await auto.tick()).toBe(false); // sigue en el mismo horario
    now = at('2026-11-16T11:59:00Z');
    expect(await auto.tick()).toBe(false);
    now = at('2026-11-16T12:01:00Z');
    expect(await auto.tick()).toBe(true); // llegó la de las 12:00
    expect(store.objects.size).toBe(2);
    expect(auto.status().lastSuccess?.key).toContain('20261116-120100');
    expect(auto.status().lastError).toBeNull();
  });

  it('tras un reinicio no duplica: mira las copias que ya hay en el almacenamiento', async () => {
    const store = new MemoryStore();
    const cfg: AutoBackupConfig = { store, prefix: 'finanzas/', hours: [0, 6, 12, 18], policy: POLICY, info: { bucket: 'b', endpoint: 'e' } };
    await store.put(`finanzas/${copyName(at('2026-11-16T06:05:00Z'))}`, Buffer.from('x'));
    const auto = new AutoBackup(cfg, { dump: async () => DUMP, log: () => undefined, clock: () => at('2026-11-16T07:00:00Z') });
    expect(await auto.tick()).toBe(false);
    expect(store.objects.size).toBe(1);
  });

  it('si falla lo registra y reintenta a los 30 minutos', async () => {
    const store = new MemoryStore();
    store.failPut = true;
    const cfg: AutoBackupConfig = { store, prefix: 'finanzas/', hours: [0, 6, 12, 18], policy: POLICY, info: { bucket: 'b', endpoint: 'e' } };
    let now = at('2026-11-16T06:10:00Z');
    const auto = new AutoBackup(cfg, { dump: async () => DUMP, log: () => undefined, clock: () => now });
    const err = console.error;
    console.error = () => undefined;
    try {
      expect(await auto.tick()).toBe(false);
      expect(auto.status().lastError?.message).toContain('no disponible');
      store.failPut = false;
      now = at('2026-11-16T06:20:00Z');
      expect(await auto.tick()).toBe(false); // todavía no pasan los 30 min
      now = at('2026-11-16T06:45:00Z');
      expect(await auto.tick()).toBe(true);
      expect(auto.status().lastError).toBeNull();
    } finally { console.error = err; }
  });

  it('sin configuración no hace nada', async () => {
    const auto = new AutoBackup(null);
    expect(await auto.tick()).toBe(false);
    expect(auto.status().configured).toBe(false);
    await expect(auto.runNow()).rejects.toThrow('no está configurado');
  });
});

describe('S3Store contra un servidor S3 de mentira', () => {
  let server: Server;
  let endpoint = '';
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; bytes: number }[] = [];
  const keys = ['finanzas/finanzas-20261115-000005.zip', 'finanzas/finanzas-20261116-000005.zip', 'finanzas/finanzas-20261116-060005.zip'];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, bytes: Buffer.concat(chunks).length });
        if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
          const token = url.searchParams.get('continuation-token');
          const page = token ? keys.slice(2) : keys.slice(0, 2);
          const more = !token;
          res.setHeader('content-type', 'application/xml');
          res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><IsTruncated>${more}</IsTruncated>${more ? '<NextContinuationToken>t2</NextContinuationToken>' : ''}${page.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-11-16T00:00:05.000Z</LastModified><Size>1234</Size></Contents>`).join('')}</ListBucketResult>`);
          return;
        }
        res.statusCode = req.method === 'DELETE' ? 204 : 200;
        res.setHeader('etag', '"abc"');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sube con cifrado, recorre las páginas del listado y borra', async () => {
    const s = new S3Store({ endpoint, region: 'us-west-004', keyId: 'k', secret: 's', bucket: 'b' });
    await s.put('finanzas/prueba.zip', Buffer.from('PKcontenido'));
    const put = seen.find((x) => x.method === 'PUT')!;
    expect(put.url.split('?')[0]).toBe('/b/finanzas/prueba.zip'); // path-style
    expect(put.bytes).toBe(11);
    expect(put.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(put.headers.authorization).toContain('AWS4-HMAC-SHA256');
    expect(put.headers['x-amz-checksum-crc32']).toBeUndefined(); // B2 no acepta el checksum automático nuevo

    const all = await s.list('finanzas/');
    expect(all.map((o) => o.key)).toEqual(keys); // juntó las 2 páginas
    expect(all[0].size).toBe(1234);

    await s.delete('finanzas/prueba.zip');
    expect(seen.some((x) => x.method === 'DELETE' && x.url.split('?')[0] === '/b/finanzas/prueba.zip')).toBe(true);
  });

  it('sse "none" no pide cifrado', async () => {
    const s = new S3Store({ endpoint, region: 'r', keyId: 'k', secret: 's', bucket: 'b', sse: 'none' });
    seen.length = 0;
    await s.put('finanzas/x.zip', Buffer.from('PK'));
    expect(seen[0].headers['x-amz-server-side-encryption']).toBeUndefined();
  });
});

describe('rutas del administrador', () => {
  let ctx: TestCtx;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auto: AutoBackup;
  const store = new MemoryStore();
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@test.io';
    ctx = await makeTestDb();
    auto = new AutoBackup(
      { store, prefix: 'finanzas/', hours: [0, 6, 12, 18], policy: POLICY, info: { bucket: 'mi-bucket', endpoint: 'https://s3.example.com' } },
      { dump: async () => DUMP, log: () => undefined },
    );
    app = await buildApp(ctx.db, { autoBackup: auto });
    const pw = await hashPassword('clave-12345');
    await ctx.db.query('INSERT INTO users(email,password_hash) VALUES ($1,$2),($3,$2)', ['admin@test.io', pw, 'otro@test.io']);
  });
  afterAll(async () => { await app.close(); await ctx.close(); delete process.env.ADMIN_EMAIL; });
  async function login(email: string) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'clave-12345' } });
    const raw = r.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
  }

  it('exige ser administrador', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/backup/auto' })).statusCode).toBe(401);
    const otro = await login('otro@test.io');
    expect((await app.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie: otro } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/backup/auto/run', headers: { cookie: otro } })).statusCode).toBe(403);
  });

  it('el administrador ve el estado (sin claves), respalda ahora y ve la copia', async () => {
    const cookie = await login('admin@test.io');
    const st = (await app.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie } })).json();
    expect(st.status.configured).toBe(true);
    expect(st.status.bucket).toBe('mi-bucket');
    expect(JSON.stringify(st)).not.toMatch(/secret|SECRET/);
    expect(st.copies).toEqual([]);

    const run = await app.inject({ method: 'POST', url: '/api/backup/auto/run', headers: { cookie } });
    expect(run.statusCode).toBe(200);
    expect(run.json().key).toMatch(/^finanzas\/finanzas-\d{8}-\d{6}\.zip$/);

    const after = (await app.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie } })).json();
    expect(after.copies).toHaveLength(1);
    expect(after.copies[0].tiers).toContain('reciente');
    expect(after.status.lastSuccess.key).toBe(run.json().key);
  });

  it('sin configurar: estado apagado y respaldar ahora da 400', async () => {
    const app2 = await buildApp(ctx.db, {});
    const r = await app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.io', password: 'clave-12345' } });
    const raw = r.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
    expect((await app2.inject({ method: 'GET', url: '/api/backup/auto', headers: { cookie } })).json().status.configured).toBe(false);
    expect((await app2.inject({ method: 'POST', url: '/api/backup/auto/run', headers: { cookie } })).statusCode).toBe(400);
    await app2.close();
  });
});
