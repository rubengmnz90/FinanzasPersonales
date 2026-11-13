import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Queryable } from '../../db/client';
import { addEntry, getAccount } from '../ledgers/service';
import { createTransaction } from '../transactions/service';

export interface Installment {
  id: string;
  number: number;
  dueDate: string;
  amount: number;
  paid: boolean;
  paidDate: string | null;
}

export interface Loan {
  id: string;
  name: string;
  lender: string | null;
  principal: number;
  installmentAmount: number;
  inProjection: boolean;
  payAccountId: string | null;
  ledgerAccountId: string | null;
  note: string | null;
  installments: Installment[];
  paidCount: number;
  paidTotal: number;
  pendingCount: number;
  pendingTotal: number;
  nextDue: string | null;
}

export interface LoanInput {
  name: string;
  lender?: string | null;
  principal?: number;
  installmentAmount?: number;
  /** Cantidad de cuotas iguales (si no se da `schedule`). */
  installments?: number;
  firstDue?: string;
  /** Cuotas explícitas (ya pagadas o con montos distintos, p. ej. amortización francesa). */
  schedule?: { number?: number; dueDate: string; amount: number; paid?: boolean; paidDate?: string | null }[];
  inProjection?: boolean;
  payAccountId?: string | null;
  ledgerAccountId?: string | null;
  note?: string | null;
}

const addMonths = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

const periodOf = (iso: string) => (Number(iso.slice(8, 10)) <= 15 ? 'Quincena' : 'Fin de mes');

async function loadLoan(db: Queryable, userId: string, id: string): Promise<Loan> {
  const l = await db.query('SELECT * FROM loans WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!l.rowCount) throw new NotFoundError('préstamo');
  return (await hydrate(db, l.rows))[0];
}

async function hydrate(db: Queryable, rows: any[]): Promise<Loan[]> {
  if (!rows.length) return [];
  const ins = await db.query('SELECT * FROM loan_installments WHERE loan_id = ANY($1) ORDER BY number', [rows.map((r) => r.id)]);
  return rows.map((r): Loan => {
    const installments: Installment[] = ins.rows
      .filter((i: any) => i.loan_id === r.id)
      .map((i: any) => ({ id: i.id, number: i.number, dueDate: i.due_date, amount: i.amount, paid: i.paid, paidDate: i.paid_date }));
    const paid = installments.filter((i) => i.paid);
    const pending = installments.filter((i) => !i.paid);
    return {
      id: r.id, name: r.name, lender: r.lender, principal: r.principal, installmentAmount: r.installment_amount,
      inProjection: r.in_projection, payAccountId: r.pay_account_id, ledgerAccountId: r.ledger_account_id, note: r.note,
      installments,
      paidCount: paid.length, paidTotal: paid.reduce((s, i) => s + i.amount, 0),
      pendingCount: pending.length, pendingTotal: pending.reduce((s, i) => s + i.amount, 0),
      nextDue: pending.length ? pending[0].dueDate : null,
    };
  });
}

export async function listLoans(db: Queryable, userId: string): Promise<Loan[]> {
  return hydrate(db, (await db.query('SELECT * FROM loans WHERE user_id=$1 ORDER BY name', [userId])).rows);
}

export async function getLoan(db: Queryable, userId: string, id: string): Promise<Loan> {
  return loadLoan(db, userId, id);
}

/** Crea / quita el gasto planeado de una cuota pendiente según el préstamo esté o no en la proyección. */
async function syncPlanned(db: Queryable, userId: string, loan: { name: string; inProjection: boolean }, inst: { id: string; number: number; dueDate: string; amount: number; paid: boolean }) {
  const cur = (await db.query('SELECT planned_expense_id FROM loan_installments WHERE id=$1', [inst.id])).rows[0]?.planned_expense_id as string | null;
  if (loan.inProjection && !inst.paid) {
    const concept = `${loan.name} · cuota ${inst.number}`;
    if (cur) {
      await db.query('UPDATE planned_expenses SET concept=$3, amount=$4, period_label=$5, due_date=$6 WHERE id=$1 AND user_id=$2', [cur, userId, concept, inst.amount, periodOf(inst.dueDate), inst.dueDate]);
    } else {
      const r = await db.query(
        'INSERT INTO planned_expenses(user_id,concept,amount,period_label,due_date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [userId, concept, inst.amount, periodOf(inst.dueDate), inst.dueDate],
      );
      await db.query('UPDATE loan_installments SET planned_expense_id=$2 WHERE id=$1', [inst.id, r.rows[0].id]);
    }
  } else if (cur && !inst.paid) {
    await db.query('DELETE FROM planned_expenses WHERE id=$1 AND user_id=$2 AND NOT done', [cur, userId]);
  }
}

export async function createLoan(db: Queryable, userId: string, input: LoanInput): Promise<Loan> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('NAME_REQUIRED', 'El préstamo necesita un nombre');
  if (input.ledgerAccountId) await getAccount(db, userId, input.ledgerAccountId);
  if (input.payAccountId) await getAccount(db, userId, input.payAccountId);
  const schedule = input.schedule ?? [];
  if (!schedule.length && input.installments) {
    if (!input.firstDue || !input.installmentAmount) throw new ValidationError('SCHEDULE_INCOMPLETE', 'Indica monto de cuota y primer vencimiento');
    for (let n = 1; n <= input.installments; n++) schedule.push({ number: n, dueDate: addMonths(input.firstDue, n - 1), amount: input.installmentAmount });
  }
  const installmentAmount = input.installmentAmount ?? schedule[schedule.length - 1]?.amount ?? 0;
  const r = await db.query(
    `INSERT INTO loans(user_id,name,lender,principal,installment_amount,in_projection,pay_account_id,ledger_account_id,note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, name, input.lender ?? null, input.principal ?? 0, installmentAmount, input.inProjection ?? false, input.payAccountId ?? null, input.ledgerAccountId ?? null, input.note ?? null],
  );
  const loanId = r.rows[0].id as string;
  let n = 0;
  for (const s of schedule) {
    n = s.number ?? n + 1;
    const ins = await db.query(
      'INSERT INTO loan_installments(loan_id,number,due_date,amount,paid,paid_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [loanId, n, s.dueDate, s.amount, s.paid ?? false, s.paid ? s.paidDate ?? s.dueDate : null],
    );
    await syncPlanned(db, userId, { name, inProjection: input.inProjection ?? false }, { id: ins.rows[0].id, number: n, dueDate: s.dueDate, amount: s.amount, paid: s.paid ?? false });
  }
  return loadLoan(db, userId, loanId);
}

export async function updateLoan(
  db: Queryable,
  userId: string,
  id: string,
  patch: Partial<Pick<LoanInput, 'name' | 'lender' | 'principal' | 'installmentAmount' | 'inProjection' | 'payAccountId' | 'note'>>,
): Promise<Loan> {
  const cur = await loadLoan(db, userId, id);
  if (patch.payAccountId) await getAccount(db, userId, patch.payAccountId);
  const next = {
    name: patch.name?.trim() || cur.name,
    inProjection: patch.inProjection ?? cur.inProjection,
  };
  await db.query(
    `UPDATE loans SET name=$3, lender=$4, principal=$5, installment_amount=$6, in_projection=$7, pay_account_id=$8, note=$9 WHERE id=$1 AND user_id=$2`,
    [
      id, userId, next.name,
      patch.lender === undefined ? cur.lender : patch.lender,
      patch.principal ?? cur.principal,
      patch.installmentAmount ?? cur.installmentAmount,
      next.inProjection,
      patch.payAccountId === undefined ? cur.payAccountId : patch.payAccountId,
      patch.note === undefined ? cur.note : patch.note,
    ],
  );
  if (patch.inProjection !== undefined || patch.name !== undefined) {
    for (const i of cur.installments) await syncPlanned(db, userId, next, i);
  }
  return loadLoan(db, userId, id);
}

export async function deleteLoan(db: Queryable, userId: string, id: string): Promise<void> {
  const loan = await loadLoan(db, userId, id);
  await db.query(
    `DELETE FROM planned_expenses WHERE user_id=$1 AND NOT done AND id IN (SELECT planned_expense_id FROM loan_installments WHERE loan_id=$2)`,
    [userId, id],
  );
  await db.query('DELETE FROM loans WHERE id=$1 AND user_id=$2', [loan.id, userId]);
}

async function installmentRow(db: Queryable, userId: string, installmentId: string) {
  const r = await db.query(
    `SELECT i.*, l.name AS loan_name, l.in_projection, l.pay_account_id, l.ledger_account_id
     FROM loan_installments i JOIN loans l ON l.id=i.loan_id WHERE i.id=$1 AND l.user_id=$2`,
    [installmentId, userId],
  );
  if (!r.rowCount) throw new NotFoundError('cuota');
  return r.rows[0];
}

/** Agrega una cuota (p. ej. al préstamo de Coomecipar, que no amortiza en cuotas iguales). */
export async function addInstallment(db: Queryable, userId: string, loanId: string, input: { dueDate: string; rawAmount: string | number }): Promise<Loan> {
  const loan = await loadLoan(db, userId, loanId);
  const amount = parseAmount(input.rawAmount);
  const number = (loan.installments[loan.installments.length - 1]?.number ?? 0) + 1;
  const ins = await db.query('INSERT INTO loan_installments(loan_id,number,due_date,amount) VALUES ($1,$2,$3,$4) RETURNING id', [loanId, number, input.dueDate, amount]);
  await syncPlanned(db, userId, loan, { id: ins.rows[0].id, number, dueDate: input.dueDate, amount, paid: false });
  return loadLoan(db, userId, loanId);
}

export async function updateInstallment(
  db: Queryable,
  userId: string,
  installmentId: string,
  patch: { dueDate?: string; rawAmount?: string | number },
): Promise<Loan> {
  const i = await installmentRow(db, userId, installmentId);
  const dueDate = patch.dueDate ?? i.due_date;
  const amount = patch.rawAmount === undefined ? i.amount : parseAmount(patch.rawAmount);
  await db.query('UPDATE loan_installments SET due_date=$2, amount=$3 WHERE id=$1', [installmentId, dueDate, amount]);
  await syncPlanned(db, userId, { name: i.loan_name, inProjection: i.in_projection }, { id: installmentId, number: i.number, dueDate, amount, paid: i.paid });
  return loadLoan(db, userId, i.loan_id);
}

export async function deleteInstallment(db: Queryable, userId: string, installmentId: string): Promise<Loan> {
  const i = await installmentRow(db, userId, installmentId);
  if (i.planned_expense_id) await db.query('DELETE FROM planned_expenses WHERE id=$1 AND user_id=$2 AND NOT done', [i.planned_expense_id, userId]);
  await db.query('DELETE FROM loan_installments WHERE id=$1', [installmentId]);
  return loadLoan(db, userId, i.loan_id);
}

/**
 * Marca una cuota pagada. Por defecto registra el pago: un egreso del flujo (categoría Prestamos) o, si el préstamo
 * se paga desde una caja (Vibra Lejana), un movimiento negativo de esa caja. `record:false` solo la marca (histórica).
 */
export async function payInstallment(
  db: Queryable,
  userId: string,
  installmentId: string,
  opts: { date?: string; accountId?: string | null; record?: boolean } = {},
): Promise<Loan> {
  const i = await installmentRow(db, userId, installmentId);
  if (i.paid) throw new ValidationError('ALREADY_PAID', 'La cuota ya está pagada');
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const concept = `${i.loan_name} · cuota ${i.number}`;
  let transactionId: string | null = null;
  let entryId: string | null = null;
  if (opts.record !== false) {
    if (i.ledger_account_id) {
      entryId = await addEntry(db, userId, i.ledger_account_id, { date, concept, rawAmount: -i.amount });
    } else {
      const cat = (await db.query(`SELECT id FROM categories WHERE user_id=$1 AND name='Prestamos'`, [userId])).rows[0]?.id ?? null;
      const t = await createTransaction(db, userId, {
        date, item: concept, kind: 'expense', rawAmount: i.amount, categoryId: cat, accountId: opts.accountId ?? i.pay_account_id ?? null,
      });
      transactionId = t.id;
    }
  }
  await db.query('UPDATE loan_installments SET paid=true, paid_date=$2, transaction_id=$3, ledger_entry_id=$4 WHERE id=$1', [installmentId, date, transactionId, entryId]);
  if (i.planned_expense_id) await db.query('UPDATE planned_expenses SET done=true, transaction_id=$3 WHERE id=$1 AND user_id=$2', [i.planned_expense_id, userId, transactionId]);
  return loadLoan(db, userId, i.loan_id);
}

/** Deshace el pago de una cuota (borra el movimiento que se creó, si lo hubo). */
export async function unpayInstallment(db: Queryable, userId: string, installmentId: string): Promise<Loan> {
  const i = await installmentRow(db, userId, installmentId);
  if (!i.paid) throw new ValidationError('NOT_PAID', 'La cuota no está pagada');
  if (i.transaction_id) await db.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2', [i.transaction_id, userId]);
  if (i.ledger_entry_id) await db.query('DELETE FROM ledger_entries WHERE id=$1', [i.ledger_entry_id]);
  await db.query('UPDATE loan_installments SET paid=false, paid_date=NULL, transaction_id=NULL, ledger_entry_id=NULL WHERE id=$1', [installmentId]);
  if (i.planned_expense_id) await db.query('UPDATE planned_expenses SET done=false, transaction_id=NULL WHERE id=$1 AND user_id=$2', [i.planned_expense_id, userId]);
  return loadLoan(db, userId, i.loan_id);
}

/**
 * Préstamos conocidos del usuario (idempotente). Supuestos a revisar en pantalla:
 * - Coomecipar: 10.000.000, cuota 883.114 con 3 pagadas (la 1ª fue de 828.867; las otras dos se asumen de 883.114).
 *   No se proyecta: amortiza distinto; las cuotas siguientes se agregan a mano.
 * - Equipo de Vibra Lejana: 12 cuotas de 1.059.737 (la 1ª fue de 1.074.202), 3 pagadas y ya anotadas en la caja.
 */
export async function seedDefaultLoans(db: Queryable, userId: string): Promise<void> {
  const exists = async (name: string) => (await db.query('SELECT 1 FROM loans WHERE user_id=$1 AND name=$2', [userId, name])).rowCount;
  if (!(await exists('Préstamo Coomecipar'))) {
    await createLoan(db, userId, {
      name: 'Préstamo Coomecipar', lender: 'Coomecipar', principal: 10_000_000, installmentAmount: 883_114, inProjection: false,
      note: 'Cuotas 2 y 3 asumidas en 883.114; amortiza distinto: agrega las siguientes a mano.',
      schedule: [
        { number: 1, dueDate: '2026-09-15', amount: 828_867, paid: true },
        { number: 2, dueDate: '2026-10-15', amount: 883_114, paid: true },
        { number: 3, dueDate: '2026-11-15', amount: 883_114, paid: true },
      ],
    });
  }
  if (!(await exists('Préstamo equipos Vibra Lejana'))) {
    const caja = (await db.query(`SELECT id FROM accounts WHERE user_id=$1 AND type='cash_box' AND name='Vibra Lejana'`, [userId])).rows[0]?.id ?? null;
    const schedule = Array.from({ length: 12 }, (_, k) => ({
      number: k + 1, dueDate: addMonths('2026-09-01', k), amount: k === 0 ? 1_074_202 : 1_059_737, paid: k < 3,
    }));
    await createLoan(db, userId, {
      name: 'Préstamo equipos Vibra Lejana', lender: 'Banco', principal: 0, installmentAmount: 1_059_737, inProjection: false,
      ledgerAccountId: caja, note: 'Fechas de vencimiento asumidas (mensual); ajústalas.', schedule,
    });
  }
}
