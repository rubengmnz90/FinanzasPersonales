import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { registerOAuth, verifyAccessToken } from './oauth';
import { createMcpServer } from './tools';

/** Registra OAuth (metadatos, registro, authorize, token) y el endpoint /mcp (Streamable HTTP sin estado). */
export function registerMcp(app: FastifyInstance, db: Db, publicUrl: string): void {
  registerOAuth(app, db, publicUrl);

  const unauthorized = (reply: FastifyReply, description?: string) =>
    reply
      .code(401)
      .header(
        'WWW-Authenticate',
        `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"${description ? `, error="invalid_token", error_description="${description}"` : ''}`,
      )
      .send({ error: 'unauthorized' });

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return unauthorized(reply);
    const info = await verifyAccessToken(db, m[1]);
    if (!info) return unauthorized(reply, 'token inválido o vencido');

    // Sin estado: un servidor y transporte por petición, ligados al usuario del token.
    const client = (await db.query("SELECT metadata->>'client_name' AS name FROM oauth_clients WHERE client_id=$1", [info.clientId])).rows[0];
    const server = createMcpServer({ db, userId: info.userId, scopes: info.scopes, actor: `ia: ${client?.name ?? info.clientId}`.slice(0, 60) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post('/mcp', handle);
  app.get('/mcp', async (req, reply) => {
    // Sin sesiones/SSE de servidor a cliente: se informa claramente.
    const auth = req.headers.authorization;
    if (!auth) return unauthorized(reply);
    return reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
  });
  app.delete('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'method_not_allowed' }));
}
