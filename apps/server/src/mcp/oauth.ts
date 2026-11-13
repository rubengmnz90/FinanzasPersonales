import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { getSessionUser, randomToken, sha256 } from '../auth/sessions';

export const SCOPES = ['finanzas:read', 'finanzas:write'] as const;
export type Scope = (typeof SCOPES)[number];

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 30;
const CODE_TTL_MIN = 10;

const isLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

/** Redirect URI aceptable: https, http solo a loopback, o esquema propio (apps nativas). Nunca javascript:/data:. */
export function validRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return isLoopback(url.hostname);
    return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function pkceOk(verifier: string, challenge: string): boolean {
  const calc = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(calc);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AccessInfo {
  userId: string;
  clientId: string;
  scopes: string[];
}

export async function verifyAccessToken(db: Db, token: string): Promise<AccessInfo | null> {
  const r = await db.query(
    `SELECT user_id, client_id, scopes FROM oauth_tokens WHERE token_hash=$1 AND kind='access' AND expires_at > now()`,
    [sha256(token)],
  );
  const t = r.rows[0];
  return t ? { userId: t.user_id, clientId: t.client_id, scopes: t.scopes } : null;
}

async function issueTokens(db: Db, p: { userId: string; clientId: string; scopes: string[]; resource: string | null }) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await db.query(
    `INSERT INTO oauth_tokens(token_hash,kind,client_id,user_id,scopes,resource,expires_at)
     VALUES ($1,'access',$2,$3,$4,$5, now() + ($6 || ' seconds')::interval),
            ($7,'refresh',$2,$3,$4,$5, now() + ($8 || ' days')::interval)`,
    [sha256(access), p.clientId, p.userId, p.scopes, p.resource, String(ACCESS_TTL_S), sha256(refresh), String(REFRESH_TTL_DAYS)],
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: p.scopes.join(' '),
  };
}

function oauthError(reply: FastifyReply, code: string, description: string, status = 400) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: code, error_description: description });
}

export function registerOAuth(app: FastifyInstance, db: Db, publicUrl: string): void {
  // application/x-www-form-urlencoded para /oauth/token y /oauth/revoke
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error);
    }
  });

  const resourceUrl = `${publicUrl}/mcp`;

  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: resourceUrl,
    authorization_servers: [publicUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Finanzas Personales',
  }));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: resourceUrl,
    authorization_servers: [publicUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Finanzas Personales',
  }));

  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    revocation_endpoint: `${publicUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: SCOPES,
  }));

  // ── registro dinámico de clientes (RFC 7591) ──
  app.post('/oauth/register', async (req, reply) => {
    const b = z.object({
      redirect_uris: z.array(z.string()).min(1).max(10),
      client_name: z.string().max(100).optional(),
      token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional(),
    }).passthrough().safeParse(req.body);
    if (!b.success) return oauthError(reply, 'invalid_client_metadata', 'Metadatos inválidos');
    if (!b.data.redirect_uris.every(validRedirectUri)) return oauthError(reply, 'invalid_redirect_uri', 'redirect_uri no permitido');
    const clientId = 'fin_' + randomToken(16);
    const method = b.data.token_endpoint_auth_method ?? 'none';
    const secret = method === 'none' ? null : randomToken(32);
    const meta = { redirect_uris: b.data.redirect_uris, client_name: b.data.client_name ?? 'Cliente MCP', token_endpoint_auth_method: method };
    await db.query('INSERT INTO oauth_clients(client_id,client_secret_hash,metadata) VALUES ($1,$2,$3)', [
      clientId,
      secret ? sha256(secret) : null,
      JSON.stringify(meta),
    ]);
    return reply.code(201).send({
      client_id: clientId,
      ...(secret ? { client_secret: secret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...meta,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  const authParams = z.object({
    client_id: z.string(),
    redirect_uri: z.string(),
    response_type: z.literal('code'),
    code_challenge: z.string().min(43).max(128),
    code_challenge_method: z.literal('S256'),
    scope: z.string().optional(),
    state: z.string().optional(),
    resource: z.string().optional(),
  });

  async function loadClient(clientId: string) {
    const r = await db.query('SELECT * FROM oauth_clients WHERE client_id=$1', [clientId]);
    return r.rows[0] as { client_id: string; client_secret_hash: string | null; metadata: any } | undefined;
  }

  const sessionUser = (req: FastifyRequest) => getSessionUser(db, (req.cookies as any)?.sid);

  // ── /oauth/authorize: redirige al login o a la pantalla de consentimiento de la web ──
  app.get('/oauth/authorize', async (req, reply) => {
    const parsed = authParams.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', error_description: 'Parámetros OAuth inválidos (PKCE S256 obligatorio)' });
    const q = parsed.data;
    const client = await loadClient(q.client_id);
    // Con client o redirect_uri inválidos NO se redirige (evita open redirect).
    if (!client || !client.metadata.redirect_uris.includes(q.redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'Cliente o redirect_uri no registrado' });
    }
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const u = await sessionUser(req);
    if (!u) return reply.redirect(`${publicUrl}/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
    return reply.redirect(`${publicUrl}/authorize?${qs}`);
  });

  // ── API de la pantalla de consentimiento (requiere sesión web) ──
  app.get('/api/oauth/authorize-info', async (req, reply) => {
    const u = await sessionUser(req);
    if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const q = z.object({ client_id: z.string(), redirect_uri: z.string() }).parse(req.query);
    const client = await loadClient(q.client_id);
    if (!client || !client.metadata.redirect_uris.includes(q.redirect_uri)) return reply.code(400).send({ error: 'INVALID_CLIENT' });
    return { clientName: client.metadata.client_name, redirectHost: new URL(q.redirect_uri).host || new URL(q.redirect_uri).protocol, scopes: SCOPES, email: u.email };
  });

  app.post('/api/oauth/decision', async (req, reply) => {
    const u = await sessionUser(req);
    if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    if (u.mustChangePassword) return reply.code(403).send({ error: 'PASSWORD_CHANGE_REQUIRED' });
    const b = authParams.extend({ approve: z.boolean(), scopes: z.array(z.enum(SCOPES)).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid_request' });
    const client = await loadClient(b.data.client_id);
    if (!client || !client.metadata.redirect_uris.includes(b.data.redirect_uri)) return reply.code(400).send({ error: 'INVALID_CLIENT' });
    const target = new URL(b.data.redirect_uri);
    if (b.data.state) target.searchParams.set('state', b.data.state);
    if (!b.data.approve) {
      target.searchParams.set('error', 'access_denied');
      return { redirectTo: target.toString() };
    }
    const requested = (b.data.scope ?? '').split(' ').filter((s) => (SCOPES as readonly string[]).includes(s));
    const granted = (b.data.scopes ?? (requested.length ? requested : [...SCOPES])).filter((s) => (SCOPES as readonly string[]).includes(s));
    if (!granted.length) return reply.code(400).send({ error: 'NO_SCOPES' });
    const code = randomToken(32);
    await db.query(
      `INSERT INTO oauth_codes(code_hash,client_id,user_id,code_challenge,redirect_uri,scopes,resource,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval)`,
      [sha256(code), client.client_id, u.id, b.data.code_challenge, b.data.redirect_uri, granted, b.data.resource ?? null, String(CODE_TTL_MIN)],
    );
    target.searchParams.set('code', code);
    return { redirectTo: target.toString() };
  });

  // Conexiones activas (para la pantalla "Conectar IA")
  app.get('/api/connections', async (req, reply) => {
    const u = await sessionUser(req);
    if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    const r = await db.query(
      `SELECT c.client_id, c.metadata->>'client_name' AS name, MIN(t.created_at) AS since, MAX(t.expires_at) AS expires,
              (array_agg(t.scopes ORDER BY t.created_at DESC))[1] AS scopes
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id
       WHERE t.user_id=$1 AND t.kind='refresh' AND t.expires_at > now() GROUP BY c.client_id, name ORDER BY since DESC`,
      [u.id],
    );
    return r.rows;
  });
  app.delete('/api/connections/:clientId', async (req, reply) => {
    const u = await sessionUser(req);
    if (!u) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    await db.query('DELETE FROM oauth_tokens WHERE user_id=$1 AND client_id=$2', [u.id, (req.params as any).clientId]);
    return { ok: true };
  });

  // ── /oauth/token ──
  app.post('/oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = b.client_id ? await loadClient(b.client_id) : undefined;
    if (!client) return oauthError(reply, 'invalid_client', 'Cliente desconocido', 401);
    if (client.client_secret_hash) {
      if (!b.client_secret || sha256(b.client_secret) !== client.client_secret_hash) return oauthError(reply, 'invalid_client', 'Secreto inválido', 401);
    }

    if (b.grant_type === 'authorization_code') {
      if (!b.code || !b.code_verifier || !b.redirect_uri) return oauthError(reply, 'invalid_request', 'Faltan code, code_verifier o redirect_uri');
      // El código se consume siempre (un solo uso), incluso si luego falla la verificación.
      const r = await db.query('DELETE FROM oauth_codes WHERE code_hash=$1 RETURNING *', [sha256(b.code)]);
      const c = r.rows[0];
      if (!c || c.client_id !== client.client_id || new Date(c.expires_at) < new Date()) return oauthError(reply, 'invalid_grant', 'Código inválido o vencido');
      if (c.redirect_uri !== b.redirect_uri) return oauthError(reply, 'invalid_grant', 'redirect_uri no coincide');
      if (!pkceOk(b.code_verifier, c.code_challenge)) return oauthError(reply, 'invalid_grant', 'PKCE inválido');
      return reply.header('Cache-Control', 'no-store').send(await issueTokens(db, { userId: c.user_id, clientId: client.client_id, scopes: c.scopes, resource: c.resource }));
    }

    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token) return oauthError(reply, 'invalid_request', 'Falta refresh_token');
      const r = await db.query(
        `DELETE FROM oauth_tokens WHERE token_hash=$1 AND kind='refresh' AND client_id=$2 AND expires_at > now() RETURNING *`,
        [sha256(b.refresh_token), client.client_id],
      );
      const t = r.rows[0];
      if (!t) return oauthError(reply, 'invalid_grant', 'refresh_token inválido');
      // Rotación: el refresh viejo ya se borró; también se invalidan los access previos de ese cliente/usuario.
      await db.query(`DELETE FROM oauth_tokens WHERE user_id=$1 AND client_id=$2 AND kind='access'`, [t.user_id, t.client_id]);
      return reply.header('Cache-Control', 'no-store').send(await issueTokens(db, { userId: t.user_id, clientId: t.client_id, scopes: t.scopes, resource: t.resource }));
    }
    return oauthError(reply, 'unsupported_grant_type', 'grant_type no soportado');
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.token) await db.query('DELETE FROM oauth_tokens WHERE token_hash=$1', [sha256(b.token)]);
    return reply.code(200).send({});
  });
}
