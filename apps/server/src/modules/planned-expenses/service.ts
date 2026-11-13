import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Queryable } from '../../db/client';
import { createTransaction } from '../transactions/service';

export interface PlannedExpense {
  id: string;
  concept: string;
  amount: number;
  periodLabel: string;
  dueDate: string;
  done: boolean;
  transactionId: string | null;
}

const map = (r: any): PlannedExpense => ({
  id: r.id,
  concept: r.concept,
  amount: r.amount,
  periodLabel: r.period_label,
  dueDate: r.due_date,
  done: r.done,
  transactionId: r.transaction_id,
});

export async function listPlannedExpenses(
  db: Queryable,
  userId: string,
  q: { from?: string; to?: string; done?: boolean } = {},
): Promise<PlannedExpense[]> {
  const r = await db.query(
    `SELECT * FROM planned_expenses WHERE user_id=$1
       AND ($2::date IS NULL OR due_date >= $2) AND ($3::date IS NULL OR due_date <= $3)
       AND ($4::boolean IS NULL OR done = $4)
     ORDER BY due_date, concept`,
    [userId, q.from ?? null, q.to ?? null, q.done ?? null],
  );
  return r.rows.map(map);
}

export async function createPlannedExpense(
  db: Queryable,
  userId: string,
  input: { concept: string; rawAmount: string | number; periodLabel: string; dueDate: string; done?: boolean },
): Promise<PlannedExpense> {
  const r = await db.query(
    `INSERT INTO planned_expenses(user_id,concept,amount,period_label,due_date,done)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, input.concept, parseAmount(input.rawAmount), input.periodLabel, input.dueDate, input.done ?? false],
  );
  return map(r.rows[0]);
}

export async function updatePlannedExpense(
  db: Queryable,
  userId: string,
  id: string,
  patch: Partial<{ concept: string; rawAmount: string | number; periodLabel: string; dueDate: string }>,
): Promise<PlannedExpense> {
  const cur = (await db.query('SELECT * FROM planned_expenses WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!cur) throw new NotFoundError('gasto puntual');
  const r = await db.query(
    `UPDATE planned_expenses SET concept=$3, amount=$4, period_label=$5, due_date=$6 WHERE id=$1 AND user_id=$2 RETURNING *`,
    [
      id,
      userId,
      patch.concept ?? cur.concept,
      patch.rawAmount === undefined ? cur.amount : parseAmount(patch.rawAmount),
      patch.periodLabel ?? cur.period_label,
      patch.dueDate ?? cur.due_date,
    ],
  );
  return map(r.rows[0]);
}

export async function deletePlannedExpense(db: Queryable, userId: string, id: string): Promise<void> {
  const r = await db.query('DELETE FROM planned_expenses WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('gasto puntual');
}

/** Marca como realizado; opcionalmente crea el movimiento en el flujo en la fecha de pago. */
export async function markDone(
  db: Queryable,
  userId: string,
  id: string,
  opts: { createTransaction: boolean; categoryId?: string | null; date?: string },
): Promise<PlannedExpense> {
  const cur = (await db.query('SELECT * FROM planned_expenses WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!cur) throw new NotFoundError('gasto puntual');
  if (cur.done) throw new ValidationError('ALREADY_DONE');
  let txId: string | null = null;
  if (opts.createTransaction) {
    const t = await createTransaction(db, userId, {
      date: opts.date ?? cur.due_date,
      item: cur.concept,
      kind: 'expense',
      rawAmount: cur.amount,
      categoryId: opts.categoryId ?? null,
    });
    txId = t.id;
  }
  const r = await db.query('UPDATE planned_expenses SET done=true, transaction_id=$3 WHERE id=$1 AND user_id=$2 RETURNING *', [
    id,
    userId,
    txId,
  ]);
  return map(r.rows[0]);
}
