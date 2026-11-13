import { NotFoundError, ValidationError, withTx, type Db, type Queryable } from '../../db/client';
import { auditCtx } from '../../db/context';

export type AuditOp = 'INSERT' | 'UPDATE' | 'DELETE';

/** Tablas con historial (las mismas que tienen el trigger `audit`). Es la lista blanca para deshacer. */
const TABLE_LABELS: Record<string, string> = {
  categories: 'Categoría',
  transactions: 'Movimiento del flujo',
  plans: 'Plan',
  plan_periods: 'Período del plan',
  plan_items: 'Fila del plan',
  plan_cells: 'Celda del plan',
  planned_expenses: 'Gasto planeado',
  accounts: 'Cuenta',
  ledger_entries: 'Movimiento de cuenta',
  recovery_allocations: 'Recuperación',
  recovery_cobros: 'Cobro de recuperación',
  splits: 'Reparto',
  split_items: 'Ítem de reparto',
  transfers: 'Transferencia',
  savings_buckets: 'Objetivo de ahorro',
  loans: 'Préstamo',
  loan_installments: 'Cuota de préstamo',
};

const OP_LABEL: Record<AuditOp, string> = { INSERT: 'Creó', UPDATE: 'Editó', DELETE: 'Eliminó' };
/** Columnas que cambian solas y no aportan al detalle. */
const NOISE = new Set(['seq', 'created_at', 'updated_at']);

export interface AuditChange { column: string; before: unknown; after: unknown }
export interface AuditEntry {
  id: string;
  table: string;
  tableLabel: string;
  op: AuditOp;
  label: string;
  changes: AuditChange[];
}
export interface AuditAction {
  txId: number;
  at: string;
  actor: string;
  reverted: boolean;
  summary: string;
  entries: AuditEntry[];
}

function describeRow(data: any): string {
  if (!data) return '';
  const name = data.concept ?? data.name ?? data.label ?? data.note ?? data.title ?? '';
  const parts = [name, data.amount !== undefined && data.amount !== null ? new Intl.NumberFormat('es-PY').format(Number(data.amount)) : '', data.date ?? data.due_date ?? ''];
  return parts.filter((p) => p !== '' && p !== null && p !== undefined).join(' · ');
}

function diff(o: any, n: any): AuditChange[] {
  const out: AuditChange[] = [];
  for (const k of Object.keys(n ?? {})) {
    if (NOISE.has(k)) continue;
    if (JSON.stringify(o?.[k]) !== JSON.stringify(n[k])) out.push({ column: k, before: o?.[k] ?? null, after: n[k] });
  }
  return out;
}

function toEntry(r: any): AuditEntry {
  const op = r.op as AuditOp;
  return {
    id: r.id,
    table: r.table_name,
    tableLabel: TABLE_LABELS[r.table_name] ?? r.table_name,
    op,
    label: describeRow(op === 'DELETE' ? r.old_data : r.new_data),
    changes: op === 'UPDATE' ? diff(r.old_data, r.new_data) : [],
  };
}

/** Historial agrupado por acción (todo lo que cambió en la misma transacción), lo más reciente primero. */
export async function listAudit(
  db: Queryable,
  userId: string,
  opts: { limit?: number; beforeSeq?: number; actor?: 'ia' | 'web' | 'otros' } = {},
): Promise<{ actions: AuditAction[]; nextBefore: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  // Se piden filas de sobra y se agrupan por acción; la última acción puede quedar cortada, por eso se descarta.
  const filter = opts.actor === 'ia' ? "AND actor LIKE 'ia%'" : opts.actor === 'web' ? "AND actor = 'web'" : opts.actor === 'otros' ? "AND actor NOT LIKE 'ia%' AND actor <> 'web'" : '';
  const rows = (await db.query(
    `SELECT * FROM audit_log WHERE user_id=$1 AND ($2::bigint IS NULL OR seq < $2) ${filter} ORDER BY seq DESC LIMIT $3`,
    [userId, opts.beforeSeq ?? null, limit * 6],
  )).rows;
  const hasMore = rows.length === limit * 6;
  const groups = new Map<number, any[]>();
  for (const r of rows) groups.set(r.tx_id, [...(groups.get(r.tx_id) ?? []), r]);
  let list = [...groups.values()];
  if (hasMore && list.length > 1) list = list.slice(0, -1); // la última puede estar incompleta
  list = list.slice(0, limit);
  const actions = list.map((g): AuditAction => {
    const entries = g.map(toEntry);
    const first = entries[0];
    const more = entries.length > 1 ? ` (+${entries.length - 1} más)` : '';
    return {
      txId: g[0].tx_id,
      at: g[0].at instanceof Date ? g[0].at.toISOString() : g[0].at,
      actor: g[0].actor,
      reverted: g.every((r) => r.reverted_at),
      summary: `${OP_LABEL[first.op]} ${first.tableLabel.toLowerCase()}${first.label ? `: ${first.label}` : ''}${more}`,
      entries,
    };
  });
  const lastSeq = list.length ? Math.min(...list[list.length - 1].map((r) => Number(r.seq))) : null;
  return { actions, nextBefore: hasMore && lastSeq !== null ? lastSeq : null };
}

async function primaryKey(db: Queryable, table: string): Promise<string[]> {
  const r = await db.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    [`"${table}"`],
  );
  return r.rows.map((x: any) => x.attname as string);
}

async function columns(db: Queryable, table: string): Promise<{ name: string; identity: boolean }[]> {
  const r = await db.query(
    `SELECT attname, attidentity, attgenerated FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [`"${table}"`],
  );
  // Las columnas generadas (calculadas) no se escriben; las de identidad (seq) solo al reinsertar, con OVERRIDING SYSTEM VALUE.
  return r.rows.filter((x: any) => !x.attgenerated).map((x: any) => ({ name: x.attname as string, identity: x.attidentity === 'a' }));
}

const conflict = () => new ValidationError('ROLLBACK_CONFLICT', 'No se puede deshacer porque los datos cambiaron después. Deshaz primero los cambios más recientes.');

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function applyInverse(tx: Queryable, r: any): Promise<void> {
  if (!(r.table_name in TABLE_LABELS)) throw new ValidationError('ROLLBACK_TABLE', `No se puede deshacer en ${r.table_name}`);
  const t = ident(r.table_name);
  const pk = await primaryKey(tx, r.table_name);
  try {
    if (r.op === 'INSERT') {
      const where = pk.map((c, i) => `${ident(c)} = (SELECT ${ident(c)} FROM jsonb_populate_record(NULL::${t}, $1::jsonb))`).join(' AND ');
      await tx.query(`DELETE FROM ${t} WHERE ${where}`, [JSON.stringify(r.new_data)]);
    } else if (r.op === 'DELETE') {
      const cols = (await columns(tx, r.table_name)).map((c) => ident(c.name)).join(', ');
      await tx.query(`INSERT INTO ${t} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM jsonb_populate_record(NULL::${t}, $1::jsonb)`, [JSON.stringify(r.old_data)]);
    } else {
      const writable = new Set((await columns(tx, r.table_name)).filter((c) => !c.identity).map((c) => c.name));
      const cols = Object.keys(r.old_data).filter((c) => !pk.includes(c) && writable.has(c));
      const set = cols.map((c) => `${ident(c)} = s.${ident(c)}`).join(', ');
      const where = pk.map((c) => `${t}.${ident(c)} = s.${ident(c)}`).join(' AND ');
      const res = await tx.query(`UPDATE ${t} SET ${set} FROM jsonb_populate_record(NULL::${t}, $1::jsonb) s WHERE ${where}`, [JSON.stringify(r.old_data)]);
      if (!res.rowCount) throw new ValidationError('ROLLBACK_CONFLICT', 'El registro ya no existe');
    }
  } catch (e: any) {
    if (e instanceof ValidationError) throw e;
    throw e;
  }
}

/**
 * Deshace una acción completa (todo lo que cambió en esa transacción), en orden inverso.
 * Deshacer también queda en el historial, así que se puede "rehacer" deshaciendo el deshacer.
 */
export async function revertAction(db: Db, userId: string, txId: number, actor = 'deshacer'): Promise<{ reverted: number }> {
  return auditCtx.run({ actor, userId }, () =>
    withTx(db, async (tx) => {
      const rows = (await tx.query(
        `SELECT * FROM audit_log WHERE user_id=$1 AND tx_id=$2 AND reverted_at IS NULL ORDER BY seq DESC FOR UPDATE`,
        [userId, txId],
      )).rows;
      if (!rows.length) {
        const any = await tx.query('SELECT 1 FROM audit_log WHERE user_id=$1 AND tx_id=$2', [userId, txId]);
        if (!any.rowCount) throw new NotFoundError('acción del historial');
        throw new ValidationError('ALREADY_REVERTED', 'Esa acción ya fue deshecha');
      }
      // Una fila puede depender de otra que se restaura después (p. ej. la cuenta y sus movimientos): se reintenta al final.
      let queue = rows;
      while (queue.length) {
        const retry: any[] = [];
        for (const r of queue) {
          await tx.query('SAVEPOINT undo_row');
          try {
            await applyInverse(tx, r);
            await tx.query('RELEASE SAVEPOINT undo_row');
          } catch (e: any) {
            await tx.query('ROLLBACK TO SAVEPOINT undo_row');
            if (e?.code === '23503') retry.push(r);
            else if (e instanceof ValidationError) throw e;
            else if (typeof e?.code === 'string' && /^(23|22)/.test(e.code)) throw conflict();
            else throw e;
          }
        }
        if (retry.length === queue.length) throw conflict();
        queue = retry;
      }
      await tx.query('UPDATE audit_log SET reverted_at=now() WHERE user_id=$1 AND tx_id=$2 AND reverted_at IS NULL', [userId, txId]);
      return { reverted: rows.length };
    }),
  );
}
