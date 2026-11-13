import type { Queryable } from '../../db/client';
import { getPlanView } from '../plans/service';
import { balanceAt } from '../transactions/service';

export interface RangeSummary {
  from: string;
  to: string;
  groups: { group: string; total: number; categories: { name: string; total: number }[] }[];
  income: number;
  expense: number;
  net: number;
}

/** Resumen por grupo → categoría para un rango de fechas cualquiera (incluye ambos extremos). */
export async function rangeSummary(db: Queryable, userId: string, from: string, to: string): Promise<RangeSummary> {
  const rows = (await db.query(
    `SELECT COALESCE(c.group_name,'Sin grupo') AS g, COALESCE(c.name,'Sin categoría') AS c, t.kind,
            SUM(t.amount)::bigint AS total
     FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=$1 AND t.date BETWEEN $2 AND $3
     GROUP BY 1,2,3 ORDER BY 1,2`,
    [userId, from, to],
  )).rows;
  const groups = new Map<string, Map<string, number>>();
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    // En un grupo de egresos, un ingreso (reintegro) resta; en Ingresos, un egreso resta.
    const signed = r.kind === 'income' ? r.total : -r.total;
    if (r.kind === 'income') income += r.total;
    else expense += r.total;
    const gm = groups.get(r.g) ?? new Map();
    const natural = r.g === 'Ingresos' ? signed : -signed;
    gm.set(r.c, (gm.get(r.c) ?? 0) + natural);
    groups.set(r.g, gm);
  }
  return {
    from,
    to,
    groups: [...groups.entries()].map(([group, cats]) => ({
      group,
      total: [...cats.values()].reduce((a, b) => a + b, 0),
      categories: [...cats.entries()].map(([name, total]) => ({ name, total })),
    })),
    income,
    expense,
    net: income - expense,
  };
}

export async function monthlySummary(db: Queryable, userId: string, year: number, month: number): Promise<RangeSummary> {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return rangeSummary(db, userId, `${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, '0')}`);
}

export async function annualSummary(
  db: Queryable,
  userId: string,
  year: number,
): Promise<{ group: string; category: string; months: number[]; total: number }[]> {
  const rows = (await db.query(
    `SELECT COALESCE(c.group_name,'Sin grupo') AS g, COALESCE(c.name,'Sin categoría') AS c,
            EXTRACT(MONTH FROM t.date)::int AS m,
            SUM(CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END)::bigint AS total
     FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=$1 AND EXTRACT(YEAR FROM t.date)=$2
     GROUP BY 1,2,3`,
    [userId, year],
  )).rows;
  const map = new Map<string, { group: string; category: string; months: number[]; total: number }>();
  for (const r of rows) {
    const k = `${r.g}|${r.c}`;
    const e = map.get(k) ?? { group: r.g, category: r.c, months: Array(12).fill(0), total: 0 };
    const v = r.g === 'Ingresos' ? r.total : -r.total;
    e.months[r.m - 1] += v;
    e.total += v;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => a.group.localeCompare(b.group) || a.category.localeCompare(b.category));
}

/** Plan vs real por mes (ingresos y egresos reales del flujo contra los del plan). */
export async function planVsActual(
  db: Queryable,
  userId: string,
  planId: string,
): Promise<{ month: number; plannedIncome: number; actualIncome: number; plannedExpense: number; actualExpense: number; diffNet: number }[]> {
  const v = await getPlanView(db, userId, planId);
  const rows = (await db.query(
    `SELECT EXTRACT(MONTH FROM date)::int AS m, kind, SUM(amount)::bigint AS s
     FROM transactions WHERE user_id=$1 AND EXTRACT(YEAR FROM date)=$2 GROUP BY 1,2`,
    [userId, v.plan.year],
  )).rows;
  return Array.from({ length: 12 }, (_, i) => {
    const aI = rows.find((r) => r.m === i + 1 && r.kind === 'income')?.s ?? 0;
    const aE = rows.find((r) => r.m === i + 1 && r.kind === 'expense')?.s ?? 0;
    const pI = v.grandByMonth.income[i];
    const pE = v.grandByMonth.expense[i];
    return { month: i + 1, plannedIncome: pI, actualIncome: aI, plannedExpense: pE, actualExpense: aE, diffNet: aI - aE - (pI - pE) };
  });
}

function cobroDate(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Saldo proyectado cobro a cobro desde `fromDate`, partiendo del saldo real del flujo. */
export async function projectedBalance(
  db: Queryable,
  userId: string,
  planId: string,
  fromDate: string,
): Promise<{ date: string; period: string; income: number; expense: number; net: number; balance: number }[]> {
  const v = await getPlanView(db, userId, planId);
  let balance = await balanceAt(db, userId, fromDate);
  const events: { date: string; period: string; income: number; expense: number }[] = [];
  for (const p of v.periods) {
    for (let m = 1; m <= 12; m++) {
      const date = cobroDate(v.plan.year, m, p.dayOfMonth);
      if (date > fromDate) events.push({ date, period: p.label, income: p.totals.income[m - 1], expense: p.totals.expense[m - 1] });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  return events.map((e) => {
    balance += e.income - e.expense;
    return { ...e, net: e.income - e.expense, balance };
  });
}
