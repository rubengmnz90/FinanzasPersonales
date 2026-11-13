import { parseAmount } from '@finanzas/shared';
import type { Queryable } from '../../db/client';
import { NotFoundError, ValidationError } from '../../db/client';
import { defaultAccountId } from '../ledgers/service';

export interface TransactionRow {
  id: string;
  /** 'tx' = ingreso/egreso del flujo; 'transfer' = movimiento entre cuentas propias. */
  rowType: 'tx' | 'transfer';
  date: string;
  item: string;
  kind: 'income' | 'expense' | 'transfer';
  amount: number;
  amountExpr: string | null;
  categoryId: string | null;
  categoryName: string | null;
  groupName: string | null;
  note: string | null;
  accountId: string | null;
  accountName: string | null;
  /** Solo transferencias. */
  toAccountId: string | null;
  toAccountName: string | null;
  bucket: string | null;
  transferKind: 'transfer' | 'loan' | 'repayment' | null;
  /** Saldo acumulado: de la cuenta filtrada, o del dinero disponible (bancos + efectivo) si no hay filtro. */
  balance: number;
}

export interface TxQuery {
  from?: string; // YYYY-MM-DD (incluido)
  to?: string; // YYYY-MM-DD (incluido)
  categoryId?: string;
  groupName?: string;
  text?: string;
  accountId?: string;
  includeTransfers?: boolean;
  order?: 'asc' | 'desc';
  limit?: number;
}

interface Raw extends Omit<TransactionRow, 'balance'> {
  at: number;
  seq: number;
}

export async function listTransactions(db: Queryable, userId: string, q: TxQuery = {}): Promise<TransactionRow[]> {
  const accs = (await db.query('SELECT id, type, in_flow, opening_balance FROM accounts WHERE user_id=$1', [userId])).rows;
  const flowIds = new Set<string>(accs.filter((a: any) => a.in_flow).map((a: any) => a.id));
  const isLiquid = (id: string | null) => id === null || flowIds.has(id);

  const tx = await db.query(
    `SELECT t.*, c.name AS category_name, c.group_name, a.name AS account_name
     FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN accounts a ON a.id=t.account_id
     WHERE t.user_id=$1`,
    [userId],
  );
  const tr = await db.query(
    `SELECT x.*, f.name AS from_name, o.name AS to_name FROM transfers x
     JOIN accounts f ON f.id=x.from_account_id JOIN accounts o ON o.id=x.to_account_id WHERE x.user_id=$1`,
    [userId],
  );

  const all: Raw[] = [
    ...tx.rows.map((r: any): Raw => ({
      id: r.id, rowType: 'tx', date: r.date, item: r.item, kind: r.kind, amount: r.amount, amountExpr: r.amount_expr,
      categoryId: r.category_id, categoryName: r.category_name, groupName: r.group_name, note: r.note,
      accountId: r.account_id, accountName: r.account_name, toAccountId: null, toAccountName: null, bucket: null,
      transferKind: null, at: new Date(r.created_at).getTime(), seq: Number(r.seq),
    })),
    ...tr.rows.map((r: any): Raw => ({
      id: r.id, rowType: 'transfer', date: r.date, item: r.note ?? '', kind: 'transfer', amount: r.amount, amountExpr: null,
      categoryId: null, categoryName: null, groupName: null, note: r.note, accountId: r.from_account_id, accountName: r.from_name,
      toAccountId: r.to_account_id, toAccountName: r.to_name, bucket: r.bucket, transferKind: r.kind,
      at: new Date(r.created_at).getTime(), seq: Number(r.seq),
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at - b.at || a.seq - b.seq));

  const scope = q.accountId ?? null;
  let bal = scope
    ? Number(accs.find((a: any) => a.id === scope)?.opening_balance ?? 0)
    : accs.filter((a: any) => a.in_flow).reduce((s: number, a: any) => s + Number(a.opening_balance), 0);
  const delta = (r: Raw): number => {
    if (r.rowType === 'tx') {
      const sign = r.kind === 'income' ? 1 : -1;
      return scope ? (r.accountId === scope ? sign * r.amount : 0) : isLiquid(r.accountId) ? sign * r.amount : 0;
    }
    if (scope) return (r.toAccountId === scope ? r.amount : 0) - (r.accountId === scope ? r.amount : 0);
    return (isLiquid(r.toAccountId) ? r.amount : 0) - (isLiquid(r.accountId) ? r.amount : 0);
  };

  const text = q.text?.toLowerCase();
  const out: TransactionRow[] = [];
  for (const r of all) {
    bal += delta(r);
    if (q.from && r.date < q.from) continue;
    if (q.to && r.date > q.to) continue;
    if (r.rowType === 'transfer') {
      if (q.includeTransfers === false || q.categoryId || q.groupName) continue;
      if (!scope && !isLiquid(r.accountId) && !isLiquid(r.toAccountId)) continue; // no toca ninguna cuenta del flujo
      if (scope && r.accountId !== scope && r.toAccountId !== scope) continue;
    } else {
      if (q.categoryId && r.categoryId !== q.categoryId) continue;
      if (q.groupName && r.groupName !== q.groupName) continue;
      if (scope && r.accountId !== scope) continue;
    }
    if (text && !`${r.item} ${r.note ?? ''} ${r.accountName ?? ''} ${r.toAccountName ?? ''} ${r.categoryName ?? ''}`.toLowerCase().includes(text)) continue;
    const { at: _a, seq: _s, ...row } = r;
    out.push({ ...row, balance: bal });
  }
  const limit = Math.min(q.limit ?? 5000, 20000);
  return q.order === 'desc' ? out.reverse().slice(0, limit) : out.slice(0, limit);
}

export async function getTransaction(db: Queryable, userId: string, id: string): Promise<TransactionRow> {
  const found = (await listTransactions(db, userId, { limit: 20000 })).find((r) => r.id === id && r.rowType === 'tx');
  if (!found) throw new NotFoundError('movimiento');
  return found;
}

export interface TxInput {
  date: string;
  item: string;
  kind: 'income' | 'expense';
  rawAmount: string | number;
  categoryId?: string | null;
  note?: string | null;
  /** Cuenta del movimiento; por defecto la cuenta predeterminada (GNB). */
  accountId?: string | null;
  importKey?: string;
}

function normalizeAmount(raw: string | number): { amount: number; expr: string | null } {
  const amount = parseAmount(raw);
  if (amount < 0) throw new ValidationError('NEGATIVE_AMOUNT', 'El monto no puede ser negativo; usa el tipo ingreso/egreso');
  const expr = typeof raw === 'string' && /[=+\-*/()]/.test(raw.trim().replace(/^-/, '')) ? raw.trim() : null;
  return { amount, expr };
}

async function assertCategory(db: Queryable, userId: string, id?: string | null) {
  if (!id) return;
  const r = await db.query('SELECT 1 FROM categories WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('categoría');
}

async function assertFlowAccount(db: Queryable, userId: string, id?: string | null) {
  if (!id) return;
  const r = await db.query('SELECT in_flow FROM accounts WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('cuenta');
  if (!r.rows[0].in_flow) {
    throw new ValidationError('ACCOUNT_NOT_ALLOWED', 'El flujo se registra solo en cuentas propias marcadas para el flujo; para ahorros o tarjetas usa una transferencia');
  }
}

export async function createTransaction(db: Queryable, userId: string, input: TxInput): Promise<TransactionRow> {
  const { amount, expr } = normalizeAmount(input.rawAmount);
  await assertCategory(db, userId, input.categoryId);
  await assertFlowAccount(db, userId, input.accountId);
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  const r = await db.query(
    `INSERT INTO transactions(user_id,date,item,kind,amount,amount_expr,category_id,note,account_id,import_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [userId, input.date, input.item, input.kind, amount, expr, input.categoryId ?? null, input.note ?? null, accountId, input.importKey ?? null],
  );
  return getTransaction(db, userId, r.rows[0].id);
}

export async function updateTransaction(
  db: Queryable,
  userId: string,
  id: string,
  patch: Partial<TxInput>,
): Promise<TransactionRow> {
  const cur = await getTransaction(db, userId, id); // 404 si no es del usuario
  let amount = cur.amount;
  let expr = cur.amountExpr;
  if (patch.rawAmount !== undefined) ({ amount, expr } = normalizeAmount(patch.rawAmount));
  if (patch.categoryId !== undefined) await assertCategory(db, userId, patch.categoryId);
  if (patch.accountId !== undefined) await assertFlowAccount(db, userId, patch.accountId);
  await db.query(
    `UPDATE transactions SET date=$3, item=$4, kind=$5, amount=$6, amount_expr=$7, category_id=$8, note=$9, account_id=$10
     WHERE id=$1 AND user_id=$2`,
    [
      id,
      userId,
      patch.date ?? cur.date,
      patch.item ?? cur.item,
      patch.kind ?? cur.kind,
      amount,
      expr,
      patch.categoryId === undefined ? cur.categoryId : patch.categoryId,
      patch.note === undefined ? cur.note : patch.note,
      patch.accountId === undefined ? cur.accountId : patch.accountId,
    ],
  );
  return getTransaction(db, userId, id);
}

export async function deleteTransaction(db: Queryable, userId: string, id: string): Promise<void> {
  const r = await db.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('movimiento');
}

/** Dinero disponible (bancos + efectivo) hasta una fecha incluida. Las compras con tarjeta no lo reducen hasta que se paga la tarjeta. */
export async function balanceAt(db: Queryable, userId: string, date: string): Promise<number> {
  const r = await db.query(
    `SELECT
       COALESCE((SELECT SUM(opening_balance) FROM accounts WHERE user_id=$1 AND in_flow),0)
     + COALESCE((SELECT SUM(CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END) FROM transactions t
                 LEFT JOIN accounts a ON a.id=t.account_id
                 WHERE t.user_id=$1 AND t.date <= $2 AND (a.id IS NULL OR a.in_flow)),0)
     + COALESCE((SELECT SUM((CASE WHEN o.in_flow THEN x.amount ELSE 0 END)
                          - (CASE WHEN f.in_flow THEN x.amount ELSE 0 END))
                 FROM transfers x JOIN accounts f ON f.id=x.from_account_id JOIN accounts o ON o.id=x.to_account_id
                 WHERE x.user_id=$1 AND x.date <= $2),0) AS b`,
    [userId, date],
  );
  return r.rows[0].b;
}
