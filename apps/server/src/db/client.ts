import pg from 'pg';
import { auditCtx, type AuditCtx } from './context';

// DATE como 'YYYY-MM-DD'; BIGINT y NUMERIC como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Db | Tx;

/** Deja en la transacción actual quién hace el cambio (lo leen los triggers del historial). */
async function applyAuditCtx(c: pg.PoolClient, ctx: AuditCtx): Promise<void> {
  await c.query("SELECT set_config('app.actor', $1, true), set_config('app.user_id', $2, true)", [ctx.actor, ctx.userId ?? '']);
}

const WRITES = /^\s*(INSERT|UPDATE|DELETE|WITH)\b/i;

export function createDb(connectionString: string, schema?: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  // Las escrituras sueltas (sin transacción propia) se envuelven en una para poder anotar el autor del cambio.
  const plain = pool.query.bind(pool) as (text: any, params?: any) => Promise<any>;
  (pool as any).query = (text: any, params?: any) => {
    const ctx = auditCtx.getStore();
    if (!ctx || typeof text !== 'string' || !WRITES.test(text)) return plain(text, params);
    return (async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await applyAuditCtx(c, ctx);
        const r = await c.query(text, params);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    })();
  };
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const ctx = auditCtx.getStore();
    if (ctx) await applyAuditCtx(c, ctx);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export class NotFoundError extends Error {
  constructor(what = 'recurso') {
    super(`${what} no encontrado`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(public code: string, public detail?: string) {
    super(code);
    this.name = 'ValidationError';
  }
}
