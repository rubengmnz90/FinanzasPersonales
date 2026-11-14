import { auditCtx } from '../db/context';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { InvalidAmountError } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Db } from '../db/client';
import {
  createSession,
  destroySession,
  getSessionUser,
  hashPassword,
  RateLimiter,
  SESSION_DAYS,
  verifyPassword,
  type SessionUser,
} from '../auth/sessions';
import { seedCategories } from '../modules/categories/service';
import { registerApiRoutes } from './routes';
import { DumpError, runPgDump, safeEqual, stamp, zipDump } from '../modules/backup/dump';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export interface AppOptions {
  allowSignup?: boolean;
  secureCookies?: boolean;
  publicUrl?: string;
  /** Conexión a la base, para el dump completo (pg_dump). */
  databaseUrl?: string;
  /** Reemplaza pg_dump (pruebas). */
  dump?: () => Promise<Buffer>;
  /** Hook para registrar rutas extra (OAuth + MCP). */
  extend?: (app: FastifyInstance, db: Db) => Promise<void> | void;
}

export const COOKIE = 'sid';

export async function buildApp(db: Db, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'NOT_FOUND', detail: err.message });
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.code, detail: err.detail ?? err.code });
    if (err instanceof InvalidAmountError) return reply.code(400).send({ error: 'INVALID_AMOUNT', detail: 'Monto inválido' });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'BAD_REQUEST', detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err?.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: 'Ya existe un registro igual' });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'ERROR', detail: err.message });
    console.error(err);
    // Quien usa la API ya inició sesión (es su propia base): se devuelve el motivo para poder diagnosticar sin entrar al servidor.
    return reply.code(500).send({ error: 'INTERNAL', detail: String(err?.message ?? err).slice(0, 300) });
  });

  const limiter = new RateLimiter(Number(process.env.LOGIN_RATE_LIMIT) || 10, 60_000);
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!opts.secureCookies,
      path: '/',
      maxAge: SESSION_DAYS * 24 * 3600,
    });

  // ── auth ──
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const key = `${req.ip}|${String(email ?? '').toLowerCase()}`;
    if (!limiter.check(key)) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
    const u = (await db.query('SELECT * FROM users WHERE email=$1', [String(email ?? '').trim().toLowerCase()])).rows[0];
    const ok = await verifyPassword(u?.password_hash ?? null, String(password ?? ''));
    if (!u || !ok) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    setCookie(reply, await createSession(db, u.id));
    return { id: u.id, email: u.email, mustChangePassword: u.must_change_password };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/signup', async (req, reply) => {
    if (!opts.allowSignup) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: 'Email válido y contraseña de 8+ caracteres' });
    }
    const r = await db.query(
      'INSERT INTO users(email,password_hash) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING RETURNING id',
      [email.trim().toLowerCase(), await hashPassword(password)],
    );
    if (!r.rowCount) return reply.code(409).send({ error: 'EMAIL_TAKEN' });
    await seedCategories(db, r.rows[0].id);
    setCookie(reply, await createSession(db, r.rows[0].id));
    return { id: r.rows[0].id, email: email.trim().toLowerCase(), mustChangePassword: false };
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const u = await getSessionUser(db, req.cookies[COOKIE]);
    if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    req.user = u;
  };

  // Salud para Docker y balanceadores: sin sesión, confirma que la base responde.
  app.get('/healthz', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  app.get('/api/me', { preHandler: authenticate }, async (req) => req.user);

  // ── respaldo completo (pg_dump en .zip) ──
  // Acceso: el token BACKUP_TOKEN (Authorization: Bearer ...) para servicios externos, o la sesión del administrador
  // (ADMIN_EMAIL, por defecto SEED_EMAIL). Es una copia de TODA la base, por eso no se abre a cualquier usuario.
  const backupLimiter = new RateLimiter(10, 60_000);
  app.get('/api/backup/full', async (req, reply) => {
    const adminEmail = (process.env.ADMIN_EMAIL || process.env.SEED_EMAIL || '').trim().toLowerCase();
    const token = process.env.BACKUP_TOKEN?.trim() ?? '';
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    let allowed = false;
    if (bearer) {
      if (!backupLimiter.check(req.ip)) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
      allowed = token.length >= 20 && safeEqual(bearer, token);
      if (!allowed) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    } else {
      const u = await getSessionUser(db, req.cookies[COOKIE]);
      if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
      if (!adminEmail || u.email.toLowerCase() !== adminEmail) {
        return reply.code(403).send({ error: 'FORBIDDEN', detail: 'El respaldo completo es solo para el administrador' });
      }
    }
    try {
      const sql = await (opts.dump ? opts.dump() : runPgDump(opts.databaseUrl ?? process.env.DATABASE_URL ?? ''));
      const base = `finanzas-${stamp()}`;
      const zip = zipDump(sql, `${base}.sql`);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${base}.zip"`)
        .header('cache-control', 'no-store')
        .send(zip);
    } catch (e) {
      if (e instanceof DumpError) {
        console.error('[backup]', e.message);
        return reply.code(e.code === 'PG_DUMP_MISSING' ? 501 : 500).send({ error: e.code, detail: e.message });
      }
      throw e;
    }
  });

  // Estado de la base: qué migraciones corrieron y si existen las columnas nuevas (para diagnosticar tras actualizar).
  app.get('/api/diagnostico', { preHandler: authenticate }, async () => {
    const mig = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    const cols = await db.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
       WHERE table_schema = current_schema() AND ((table_name='ledger_entries' AND column_name='person') OR (table_name='transactions' AND column_name='payer'))`,
    );
    return { migraciones: mig.rows.map((r: any) => r.name), columnas: cols.rows.map((r: any) => r.c) };
  });

  app.post('/api/auth/change-password', { preHandler: authenticate }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'WEAK_PASSWORD', detail: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    const u = (await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id])).rows[0];
    if (!(await verifyPassword(u.password_hash, String(currentPassword ?? '')))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }
    if (newPassword === currentPassword) return reply.code(400).send({ error: 'SAME_PASSWORD', detail: 'Elige una contraseña distinta' });
    await db.query('UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1', [
      req.user!.id,
      await hashPassword(newPassword),
    ]);
    // Cierra las demás sesiones.
    const current = req.cookies[COOKIE];
    await db.query('DELETE FROM sessions WHERE user_id=$1', [req.user!.id]);
    setCookie(reply, await createSession(db, req.user!.id));
    void current;
    return { ok: true };
  });

  // ── API de datos: exige sesión y que no esté pendiente el cambio de contraseña ──
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req, reply) => {
      await authenticate(req, reply);
      if (reply.sent) return reply;
      if (req.user!.mustChangePassword) return reply.code(403).send({ error: 'PASSWORD_CHANGE_REQUIRED' });
    });
    // El resto de la petición (handler incluido) corre con el autor anotado, para que el historial sepa quién hizo el cambio.
    scope.addHook('preHandler', (req, _reply, done) => {
      if (!req.user) return done();
      auditCtx.run({ actor: 'web', userId: req.user.id }, done);
    });
    registerApiRoutes(scope, db);
  });

  if (opts.extend) await opts.extend(app, db);

  // ── frontend compilado (si existe) ──
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
