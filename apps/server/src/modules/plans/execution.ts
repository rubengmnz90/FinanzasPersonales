import { NotFoundError, ValidationError, withTx, type Db, type Queryable } from '../../db/client';
import { categoryIdByName } from '../categories/service';
import { createTransaction } from '../transactions/service';
import { createTransfer, type TransferInput } from '../transfers/service';

export interface ExecLine {
  key: string;
  source: 'item' | 'planned';
  refId: string;
  kind: 'income' | 'expense';
  concept: string;
  amount: number;
  date: string;
  executed: boolean;
  categoryId: string | null;
}

export interface ExecPreview {
  planId: string;
  planName: string;
  year: number;
  month: number;
  periodId: string;
  periodLabel: string;
  date: string;
  lines: ExecLine[];
}

const pad = (n: number) => String(n).padStart(2, '0');

function clampDate(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

/** Qué se ejecutaría al "ejecutar el plan" de un cobro en un mes: ingresos/gastos planificados y gastos puntuales con fecha. */
export async function previewExecution(
  db: Queryable,
  userId: string,
  input: { planId: string; periodId: string; month: number },
): Promise<ExecPreview> {
  const p = (await db.query(
    `SELECT p.id, p.name, p.year, pp.id AS period_id, pp.label, pp.day_of_month
     FROM plans p JOIN plan_periods pp ON pp.plan_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND pp.id=$3`,
    [input.planId, userId, input.periodId],
  )).rows[0];
  if (!p) throw new NotFoundError('plan o cobro');
  // El cobro de "Fin de mes" es en realidad el inicio del mes siguiente: entra el día 1 de ese mes, aunque se cobre el 30 del anterior.
  const date = /fin de mes/i.test(p.label) ? `${p.year}-${pad(input.month)}-01` : clampDate(p.year, input.month, p.day_of_month);

  const items = (await db.query(
    `SELECT i.id, i.kind, i.concept, c.amount FROM plan_items i
     JOIN plan_cells c ON c.item_id=i.id AND c.month=$2
     WHERE i.period_id=$1 AND i.auto_source IS NULL AND c.amount > 0
     ORDER BY CASE i.kind WHEN 'income' THEN 0 ELSE 1 END, i.sort, i.concept`,
    [input.periodId, input.month],
  )).rows;
  const planned = (await db.query(
    `SELECT id, concept, amount, due_date, done FROM planned_expenses
     WHERE user_id=$1 AND period_label=$2 AND due_date >= $3 AND due_date <= $4
     ORDER BY due_date, concept`,
    [userId, p.label, `${p.year}-${pad(input.month)}-01`, clampDate(p.year, input.month, 31)],
  )).rows;

  const lines: ExecLine[] = [];
  for (const it of items) {
    const key = `item:${it.id}:${p.year}-${pad(input.month)}`;
    const done = (await db.query('SELECT 1 FROM transactions WHERE user_id=$1 AND import_key=$2', [userId, `exec:${key}`])).rowCount! > 0;
    lines.push({
      key, source: 'item', refId: it.id, kind: it.kind, concept: it.concept, amount: it.amount, date,
      executed: done, categoryId: await categoryIdByName(db, userId, it.concept),
    });
  }
  for (const pe of planned) {
    lines.push({
      key: `planned:${pe.id}`, source: 'planned', refId: pe.id, kind: 'expense', concept: pe.concept, amount: pe.amount,
      date: pe.due_date, executed: pe.done, categoryId: null,
    });
  }
  return { planId: p.id, planName: p.name, year: p.year, month: input.month, periodId: p.period_id, periodLabel: p.label, date, lines };
}

export interface ExecInput {
  planId: string;
  periodId: string;
  month: number;
  lines: { key: string; accountId: string; amount?: string | number; categoryId?: string | null }[];
  /** Movimientos entre cuentas a registrar junto con el plan (p. ej. pasar el honorario de Familiar a GNB). */
  transfers?: TransferInput[];
}

/** Registra en el flujo las líneas elegidas. Idempotente: lo ya ejecutado se omite. */
export async function executePlan(
  db: Db,
  userId: string,
  input: ExecInput,
): Promise<{ created: number; skipped: number; transfers: number }> {
  return withTx(db, async (tx) => {
    const preview = await previewExecution(tx, userId, input);
    const byKey = new Map(preview.lines.map((l) => [l.key, l]));
    let created = 0;
    let skipped = 0;
    for (const req of input.lines) {
      const line = byKey.get(req.key);
      if (!line) throw new ValidationError('UNKNOWN_LINE', `La línea ${req.key} no pertenece a este cobro`);
      if (line.executed) {
        skipped++;
        continue;
      }
      const t = await createTransaction(tx, userId, {
        date: line.date,
        item: line.concept,
        kind: line.kind,
        rawAmount: req.amount ?? line.amount,
        categoryId: req.categoryId === undefined ? line.categoryId : req.categoryId,
        accountId: req.accountId,
        importKey: line.source === 'item' ? `exec:${line.key}` : undefined,
      });
      if (line.source === 'planned') {
        await tx.query('UPDATE planned_expenses SET done=true, transaction_id=$3 WHERE id=$1 AND user_id=$2', [line.refId, userId, t.id]);
      }
      created++;
    }
    for (const tr of input.transfers ?? []) await createTransfer(tx, userId, tr);
    return { created, skipped, transfers: input.transfers?.length ?? 0 };
  });
}
