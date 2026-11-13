import { parseAmount } from '@finanzas/shared';
import { NotFoundError, type Queryable } from '../../db/client';
import { listAccounts, pendingTempWithdrawals, getLedger } from '../ledgers/service';

export type RecoveryTag = 'T' | 'A' | 'V' | 'F';

export interface Allocation {
  id: string;
  cobroIndex: number;
  cobroLabel: string;
  concept: string;
  amount: number;
  tag: RecoveryTag | null;
}

export interface RecoveryView {
  debts: { key: 'card' | 'savings'; accountName: string | null; owed: number; paid: number; pending: number }[];
  byTag: Record<'V' | 'F', number>;
  cobros: { index: number; label: string; income: number; allocations: Allocation[]; spent: number; left: number }[];
}

export async function setCobro(db: Queryable, userId: string, index: number, label: string, rawIncome: string | number) {
  await db.query(
    `INSERT INTO recovery_cobros(user_id,cobro_index,label,income) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id,cobro_index) DO UPDATE SET label=EXCLUDED.label, income=EXCLUDED.income`,
    [userId, index, label, parseAmount(rawIncome)],
  );
}

export async function addAllocation(
  db: Queryable,
  userId: string,
  input: { cobroIndex: number; concept: string; rawAmount: string | number; tag?: RecoveryTag | null; importKey?: string },
): Promise<string> {
  const cobro = (await db.query('SELECT label FROM recovery_cobros WHERE user_id=$1 AND cobro_index=$2', [userId, input.cobroIndex])).rows[0];
  if (!cobro) throw new NotFoundError('cobro');
  const r = await db.query(
    `INSERT INTO recovery_allocations(user_id,cobro_label,cobro_index,concept,amount,tag,import_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, cobro.label, input.cobroIndex, input.concept, parseAmount(input.rawAmount), input.tag ?? null, input.importKey ?? null],
  );
  return r.rows[0].id;
}

export async function updateAllocation(
  db: Queryable,
  userId: string,
  id: string,
  patch: Partial<{ concept: string; rawAmount: string | number; tag: RecoveryTag | null }>,
): Promise<void> {
  const cur = (await db.query('SELECT * FROM recovery_allocations WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!cur) throw new NotFoundError('asignación');
  await db.query('UPDATE recovery_allocations SET concept=$2, amount=$3, tag=$4 WHERE id=$1', [
    id,
    patch.concept ?? cur.concept,
    patch.rawAmount === undefined ? cur.amount : parseAmount(patch.rawAmount),
    patch.tag === undefined ? cur.tag : patch.tag,
  ]);
}

export async function removeAllocation(db: Queryable, userId: string, id: string): Promise<void> {
  const r = await db.query('DELETE FROM recovery_allocations WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('asignación');
}

/**
 * Réplica de la hoja `Como`. La deuda de tarjeta sale de la tarjeta indicada (o la primera);
 * la de ahorro, de los retiros temporales pendientes de la cuenta de ahorro.
 */
export async function getRecovery(
  db: Queryable,
  userId: string,
  opts: { cardAccountId?: string; savingsAccountId?: string } = {},
): Promise<RecoveryView> {
  const accounts = await listAccounts(db, userId);
  const card = accounts.find((a) => a.id === opts.cardAccountId) ?? accounts.find((a) => a.type === 'card');
  const savings = accounts.find((a) => a.id === opts.savingsAccountId) ?? accounts.find((a) => a.type === 'savings');

  const sumTag = async (tag: string) =>
    (await db.query('SELECT COALESCE(SUM(amount),0) AS s FROM recovery_allocations WHERE user_id=$1 AND tag=$2', [userId, tag])).rows[0].s as number;

  const cardOwed = card ? (await getLedger(db, userId, card.id)).owed : 0;
  const savingsOwed = savings ? await pendingTempWithdrawals(db, userId, savings.id) : 0;
  const paidT = await sumTag('T');
  const paidA = await sumTag('A');

  const cobros = (await db.query('SELECT * FROM recovery_cobros WHERE user_id=$1 ORDER BY cobro_index', [userId])).rows;
  const allocs = (await db.query('SELECT * FROM recovery_allocations WHERE user_id=$1 ORDER BY cobro_index, id', [userId])).rows;

  return {
    debts: [
      { key: 'card', accountName: card?.name ?? null, owed: cardOwed, paid: paidT, pending: cardOwed - paidT },
      { key: 'savings', accountName: savings?.name ?? null, owed: savingsOwed, paid: paidA, pending: savingsOwed - paidA },
    ],
    byTag: { V: await sumTag('V'), F: await sumTag('F') },
    cobros: cobros.map((c) => {
      const mine: Allocation[] = allocs
        .filter((a) => a.cobro_index === c.cobro_index)
        .map((a) => ({
          id: a.id,
          cobroIndex: a.cobro_index,
          cobroLabel: a.cobro_label,
          concept: a.concept,
          amount: a.amount,
          tag: a.tag,
        }));
      const spent = mine.reduce((s, a) => s + a.amount, 0);
      return { index: c.cobro_index, label: c.label, income: c.income, allocations: mine, spent, left: c.income - spent };
    }),
  };
}
