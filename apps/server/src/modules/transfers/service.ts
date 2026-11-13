import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Queryable } from '../../db/client';
import { getAccount } from '../ledgers/service';

export type TransferKind = 'transfer' | 'loan' | 'repayment';

export interface Transfer {
  id: string;
  date: string;
  fromAccountId: string;
  toAccountId: string;
  fromName: string;
  toName: string;
  amount: number;
  kind: TransferKind;
  bucket: string | null;
  note: string | null;
}

export interface TransferInput {
  date: string;
  fromAccountId: string;
  toAccountId: string;
  rawAmount: string | number;
  kind?: TransferKind;
  /** Objetivo del ahorro (colchón, vacaciones, aguinaldo…) cuando el origen o el destino es un ahorro. */
  bucket?: string | null;
  note?: string | null;
  /** Confirma que se usa plata de un objetivo intocable (Aguinaldo, Vacaciones…). */
  useUntouchable?: boolean;
  importKey?: string;
}

export const mapTransfer = (r: any): Transfer => ({
  id: r.id,
  date: r.date,
  fromAccountId: r.from_account_id,
  toAccountId: r.to_account_id,
  fromName: r.from_name,
  toName: r.to_name,
  amount: r.amount,
  kind: r.kind,
  bucket: r.bucket,
  note: r.note,
});

const SELECT = `SELECT x.*, f.name AS from_name, o.name AS to_name FROM transfers x
  JOIN accounts f ON f.id=x.from_account_id JOIN accounts o ON o.id=x.to_account_id`;

async function validate(
  db: Queryable,
  userId: string,
  i: Required<Pick<TransferInput, 'fromAccountId' | 'toAccountId'>> & { kind: TransferKind; bucket?: string | null; useUntouchable?: boolean },
) {
  if (i.fromAccountId === i.toAccountId) throw new ValidationError('SAME_ACCOUNT', 'El origen y el destino deben ser distintos');
  const from = await getAccount(db, userId, i.fromAccountId);
  const to = await getAccount(db, userId, i.toAccountId);
  if (i.kind === 'loan' && from.type !== 'savings') throw new ValidationError('LOAN_FROM_SAVINGS', 'Un préstamo sale de una cuenta de ahorro');
  if (i.kind === 'loan' && i.bucket && !i.useUntouchable) {
    const lock = await db.query('SELECT 1 FROM savings_buckets WHERE user_id=$1 AND name=$2 AND untouchable', [userId, i.bucket.trim()]);
    if (lock.rowCount) throw new ValidationError('BUCKET_UNTOUCHABLE', `"${i.bucket}" es intocable: confirma que quieres usarlo`);
  }
  if (i.kind === 'repayment' && to.type !== 'savings') throw new ValidationError('REPAYMENT_TO_SAVINGS', 'La devolución entra a una cuenta de ahorro');
}

export async function getTransfer(db: Queryable, userId: string, id: string): Promise<Transfer> {
  const r = await db.query(`${SELECT} WHERE x.id=$1 AND x.user_id=$2`, [id, userId]);
  if (!r.rowCount) throw new NotFoundError('transferencia');
  return mapTransfer(r.rows[0]);
}

export async function createTransfer(db: Queryable, userId: string, input: TransferInput): Promise<Transfer> {
  const amount = parseAmount(input.rawAmount);
  if (!(amount > 0)) throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', 'El monto debe ser mayor a cero');
  const kind = input.kind ?? 'transfer';
  await validate(db, userId, { fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, kind, bucket: input.bucket, useUntouchable: input.useUntouchable });
  const r = await db.query(
    `INSERT INTO transfers(user_id,date,from_account_id,to_account_id,amount,kind,bucket,note,import_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [userId, input.date, input.fromAccountId, input.toAccountId, amount, kind, input.bucket?.trim() || null, input.note ?? null, input.importKey ?? null],
  );
  return getTransfer(db, userId, r.rows[0].id);
}

export async function updateTransfer(db: Queryable, userId: string, id: string, patch: Partial<TransferInput>): Promise<Transfer> {
  const cur = await getTransfer(db, userId, id);
  const amount = patch.rawAmount === undefined ? cur.amount : parseAmount(patch.rawAmount);
  if (!(amount > 0)) throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', 'El monto debe ser mayor a cero');
  const next = {
    fromAccountId: patch.fromAccountId ?? cur.fromAccountId,
    toAccountId: patch.toAccountId ?? cur.toAccountId,
    kind: patch.kind ?? cur.kind,
  };
  await validate(db, userId, { ...next, bucket: patch.bucket === undefined ? cur.bucket : patch.bucket, useUntouchable: patch.useUntouchable });
  await db.query(
    `UPDATE transfers SET date=$3, from_account_id=$4, to_account_id=$5, amount=$6, kind=$7, bucket=$8, note=$9
     WHERE id=$1 AND user_id=$2`,
    [
      id, userId, patch.date ?? cur.date, next.fromAccountId, next.toAccountId, amount, next.kind,
      patch.bucket === undefined ? cur.bucket : patch.bucket?.trim() || null,
      patch.note === undefined ? cur.note : patch.note,
    ],
  );
  return getTransfer(db, userId, id);
}

export async function deleteTransfer(db: Queryable, userId: string, id: string): Promise<void> {
  const r = await db.query('DELETE FROM transfers WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('transferencia');
}

export interface SavingsBucket { name: string; untouchable: boolean }

/** Objetivos de ahorro: los definidos (con su marca de intocable) más los que ya aparecen en movimientos. */
export async function listBuckets(db: Queryable, userId: string): Promise<SavingsBucket[]> {
  const defined = (await db.query('SELECT name, untouchable FROM savings_buckets WHERE user_id=$1 ORDER BY sort, name', [userId])).rows;
  const used = (await db.query(
    `SELECT DISTINCT b FROM (
       SELECT e.bucket AS b FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE a.user_id=$1
       UNION SELECT bucket FROM transfers WHERE user_id=$1) u WHERE b IS NOT NULL`,
    [userId],
  )).rows.map((x: any) => x.b as string);
  const out: SavingsBucket[] = defined.map((d: any) => ({ name: d.name, untouchable: d.untouchable }));
  for (const n of used) if (!out.some((o) => o.name === n)) out.push({ name: n, untouchable: false });
  return out;
}

/** Crea el objetivo o actualiza si es intocable. */
export async function saveBucket(db: Queryable, userId: string, name: string, untouchable: boolean): Promise<SavingsBucket> {
  const n = name.trim();
  if (!n) throw new ValidationError('NAME_REQUIRED', 'El objetivo necesita un nombre');
  await db.query(
    `INSERT INTO savings_buckets(user_id,name,untouchable,sort) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(sort),0)+1 FROM savings_buckets WHERE user_id=$1))
     ON CONFLICT (user_id,name) DO UPDATE SET untouchable=EXCLUDED.untouchable`,
    [userId, n, untouchable],
  );
  return { name: n, untouchable };
}
