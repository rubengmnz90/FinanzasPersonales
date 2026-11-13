import type { Queryable } from '../../db/client';
import { listBalances } from '../ledgers/service';
import { getPlanView, listPlans } from '../plans/service';

export type Status = 'ok' | 'warn' | 'bad' | 'info';

export interface HealthCheck {
  key: string;
  label: string;
  /** Valor numérico base (guaraníes, meses o porcentaje 0-100 según `unit`). */
  value: number;
  unit: 'pyg' | 'months' | 'pct' | 'count';
  status: Status;
  hint: string;
}

export interface HealthReport {
  asOf: string;
  scorePct: number;
  summary: { liquid: number; savings: number; cardDebt: number; externalDebt: number; loansFromSavings: number; netWorth: number };
  avgMonthlyIncome: number;
  avgMonthlyExpense: number;
  checks: HealthCheck[];
}

const addMonths = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** Reporte de sanidad financiera a una fecha: liquidez, colchón, tarjetas, deudas, ritmo de ahorro y orden de los datos. */
export async function healthReport(db: Queryable, userId: string, asOf?: string): Promise<HealthReport> {
  const at = asOf ?? new Date().toISOString().slice(0, 10);
  const balances = await listBalances(db, userId, { asOf: at });
  const sum = (f: (b: (typeof balances)[number]) => number, t: string[]) =>
    balances.filter((b) => t.includes(b.type) && !b.archived).reduce((s, b) => s + f(b), 0);

  const flow = balances.filter((b) => b.inFlow);
  const liquid = flow.filter((b) => !b.archived).reduce((s, b) => s + b.balance, 0);
  const savings = sum((b) => b.balance, ['savings']);
  const loansFromSavings = sum((b) => b.loansPending, ['savings']);
  const cardDebt = sum((b) => b.owed, ['card']);
  const cardLimit = sum((b) => b.creditLimit ?? 0, ['card']);
  const externalDebt = -sum((b) => b.balance, ['debt']);
  const negativeBanks = flow.filter((b) => b.balance < 0);
  const colchon = balances.filter((b) => b.type === 'savings').flatMap((b) => b.buckets).filter((k) => /colch|emergen/i.test(k.bucket)).reduce((s, k) => s + k.balance, 0);

  // Promedios de los 3 meses completos anteriores al mes de la fecha.
  const monthStart = `${at.slice(0, 7)}-01`;
  const from = addMonths(monthStart, -3);
  const rows = (await db.query(
    `SELECT kind, SUM(amount) AS s FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id
     WHERE t.user_id=$1 AND t.date >= $2 AND t.date < $3 GROUP BY kind`,
    [userId, from, monthStart],
  )).rows;
  const inc = (rows.find((r: any) => r.kind === 'income')?.s ?? 0) / 3;
  const exp = (rows.find((r: any) => r.kind === 'expense')?.s ?? 0) / 3;

  const unc = (await db.query(
    `SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND date >= $2 AND date <= $3) AS total
     FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.user_id=$1 AND t.date >= $2 AND t.date <= $3 AND (t.category_id IS NULL OR c.name='Sin categoría')`,
    [userId, addMonths(at, -3), at],
  )).rows[0];

  // Meses del año con neto negativo en el plan vigente (de hoy en adelante).
  let negMonths = 0;
  let planChecked = false;
  const plan = (await listPlans(db, userId, Number(at.slice(0, 4))))[0];
  if (plan) {
    const v = await getPlanView(db, userId, plan.id);
    planChecked = true;
    const cur = Number(at.slice(5, 7));
    negMonths = v.grandByMonth.net.filter((n: number, i: number) => i + 1 >= cur && n < 0).length;
  }

  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);

  const liqMonths = exp > 0 ? liquid / exp : 0;
  add({
    key: 'liquidity', label: 'Liquidez (bancos + efectivo)', value: liqMonths, unit: 'months',
    status: exp === 0 ? 'info' : liqMonths >= 1 ? 'ok' : liqMonths >= 0.5 ? 'warn' : 'bad',
    hint: 'Meses de gasto promedio que cubre el dinero disponible. Lo sano es 1 mes o más.',
  });
  add({
    key: 'negative_accounts', label: 'Cuentas en negativo', value: negativeBanks.length, unit: 'count',
    status: negativeBanks.length === 0 ? 'ok' : 'bad',
    hint: negativeBanks.length ? `En negativo: ${negativeBanks.map((b) => b.name).join(', ')}. Revisa si falta registrar una transferencia o un ingreso.` : 'Ninguna cuenta bancaria o de efectivo está en negativo.',
  });
  const efMonths = exp > 0 ? (colchon || savings) / exp : 0;
  add({
    key: 'emergency', label: colchon ? 'Colchón de emergencia' : 'Ahorro disponible', value: efMonths, unit: 'months',
    status: exp === 0 ? 'info' : efMonths >= 3 ? 'ok' : efMonths >= 1 ? 'warn' : 'bad',
    hint: 'Meses de gasto cubiertos por el ahorro. La meta habitual es 3 meses.',
  });
  add({
    key: 'loans_from_savings', label: 'Prestado del ahorro sin reponer', value: loansFromSavings, unit: 'pyg',
    status: loansFromSavings === 0 ? 'ok' : savings > 0 && loansFromSavings > savings ? 'bad' : 'warn',
    hint: 'Lo que sacaste del ahorro para flujo o tarjetas y falta devolver.',
  });
  const util = cardLimit > 0 ? (cardDebt / cardLimit) * 100 : 0;
  add({
    key: 'card_use', label: 'Uso de tarjetas', value: util, unit: 'pct',
    status: cardLimit === 0 ? 'info' : util <= 30 ? 'ok' : util <= 60 ? 'warn' : 'bad',
    hint: 'Deuda de tarjetas sobre el límite total. Por debajo de 30% es sano.',
  });
  const rate = inc > 0 ? ((inc - exp) / inc) * 100 : 0;
  add({
    key: 'saving_rate', label: 'Ahorro mensual (promedio 3 meses)', value: rate, unit: 'pct',
    status: inc === 0 ? 'info' : rate >= 10 ? 'ok' : rate >= 0 ? 'warn' : 'bad',
    hint: 'Porcentaje del ingreso que sobra después de gastar. Apunta a 10% o más.',
  });
  const dti = inc > 0 ? (externalDebt / (inc * 12)) * 100 : 0;
  add({
    key: 'external_debt', label: 'Deudas externas vs. ingreso anual', value: dti, unit: 'pct',
    status: inc === 0 ? 'info' : externalDebt <= 0 ? 'ok' : dti <= 50 ? 'ok' : dti <= 100 ? 'warn' : 'bad',
    hint: `Debes ${externalDebt.toLocaleString('es-PY')} Gs. entre casa, casamiento, normal y préstamo de boda.`,
  });
  if (planChecked) {
    add({
      key: 'plan_negative_months', label: 'Meses del plan con neto negativo', value: negMonths, unit: 'count',
      status: negMonths === 0 ? 'ok' : negMonths <= 2 ? 'warn' : 'bad',
      hint: 'Meses restantes del año cuyo plan gasta más de lo que ingresa.',
    });
  }
  const total = Number(unc.total);
  const uncPct = total > 0 ? (Number(unc.n) / total) * 100 : 0;
  add({
    key: 'uncategorized', label: 'Movimientos sin categoría (3 meses)', value: Number(unc.n), unit: 'count',
    status: uncPct === 0 ? 'ok' : uncPct <= 5 ? 'warn' : 'bad',
    hint: 'Sin categoría los resúmenes pierden precisión.',
  });

  const pts = { ok: 1, warn: 0.5, bad: 0, info: null as number | null };
  const scored = checks.filter((c) => pts[c.status] !== null);
  const scorePct = scored.length ? Math.round((scored.reduce((s, c) => s + (pts[c.status] as number), 0) / scored.length) * 100) : 0;

  return {
    asOf: at,
    scorePct,
    summary: { liquid, savings, cardDebt, externalDebt, loansFromSavings, netWorth: liquid + savings + sum((b) => b.balance, ['cash_box', 'fund']) - cardDebt - externalDebt },
    avgMonthlyIncome: inc,
    avgMonthlyExpense: exp,
    checks,
  };
}
