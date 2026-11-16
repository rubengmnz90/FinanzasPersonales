import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, type TestCtx } from '../../test/helpers';
import { adviceReport, buildAdvice, type AdviceInput } from './advice';

const check = (key: string, value: number, status: 'ok' | 'warn' | 'bad' | 'info' = 'warn') => ({ key, label: key, value, unit: 'pct' as const, status, hint: '' });

function base(over: Partial<AdviceInput> = {}): AdviceInput {
  return {
    asOf: '2026-11-16',
    health: {
      scorePct: 80, avgMonthlyIncome: 10_000_000, avgMonthlyExpense: 7_000_000,
      summary: { liquid: 8_000_000, savings: 25_000_000, cardDebt: 0, externalDebt: 0, loansFromSavings: 0, netWorth: 33_000_000 },
      checks: [check('liquidity', 1.1, 'ok'), check('emergency', 3.5, 'ok'), check('saving_rate', 30, 'ok'), check('uncategorized', 0, 'ok')],
    },
    accounts: [{ name: 'GNB', type: 'savings', balance: 8_000_000, owed: 0, creditLimit: null, inFlow: true, archived: false, buckets: [] }],
    pendingRegularize: { total: 0, count: 0, byCard: [] },
    categories: [], monthToDateExpense: 0, projection: [], planNegativeMonths: [], plannedDue: [], loans: [],
    ...over,
  };
}
const keys = (a: ReturnType<typeof buildAdvice>) => a.recommendations.map((r) => r.key);

describe('buildAdvice', () => {
  it('finanzas sanas: solo propone poner el sobrante a trabajar', () => {
    const a = buildAdvice(base());
    expect(keys(a)).toEqual(['put_surplus_to_work']);
    expect(a.headline).toContain('Vas bien');
  });

  it('cuenta en negativo es urgente y va primero, con el monto a cubrir', () => {
    const a = buildAdvice(base({
      accounts: [
        { name: 'GNB', type: 'savings', balance: -300_000, owed: 0, creditLimit: null, inFlow: true, archived: false, buckets: [] },
        { name: 'Ahorro', type: 'savings', balance: 5_000_000, owed: 0, creditLimit: null, inFlow: false, archived: false, buckets: [] },
      ],
      health: { ...base().health, checks: [check('liquidity', 0.2, 'bad')] },
    }));
    expect(a.recommendations[0]).toMatchObject({ key: 'negative_accounts', priority: 'urgent', amount: 300_000 });
    expect(a.recommendations[0].steps.join(' ')).toContain('300.000');
    expect(keys(a)).not.toContain('liquidity'); // no duplica: primero se cubre el negativo
    expect(a.headline).toContain('urgente');
  });

  it('saldo proyectado negativo dentro de 30 días es urgente y trae el punto más bajo', () => {
    const a = buildAdvice(base({
      projection: [
        { date: '2026-11-20', period: 'Cobro 1', balance: 1_000_000 },
        { date: '2026-12-05', period: 'Cobro 2', balance: -500_000 },
        { date: '2026-12-20', period: 'Cobro 3', balance: -900_000 },
      ],
    }));
    const r = a.recommendations.find((x) => x.key === 'projected_shortfall')!;
    expect(r.priority).toBe('urgent');
    expect(r.amount).toBe(900_000);
    expect(r.why).toContain('5 de diciembre');
  });

  it('cuotas vencidas, tarjetas altas y gasto que se disparó', () => {
    const a = buildAdvice(base({
      loans: [{ name: 'Préstamo auto', amount: 1_200_000, dueDate: '2026-11-10' }],
      accounts: [{ name: 'Visa', type: 'card', balance: 0, owed: 7_000_000, creditLimit: 10_000_000, inFlow: false, archived: false, buckets: [] }],
      categories: [{ name: 'Comida', group: 'Gasto', last: 2_000_000, avg: 1_000_000 }, { name: 'Fijos', group: 'Egresos', last: 1_000_000, avg: 1_000_000 }],
    }));
    expect(a.recommendations[0]).toMatchObject({ key: 'loans_overdue', priority: 'urgent' });
    const card = a.recommendations.find((x) => x.key === 'card_use')!;
    expect(card.priority).toBe('important'); // 70% > 60%
    expect(card.amount).toBe(4_000_000); // 7M - 30% de 10M
    const sp = a.recommendations.find((x) => x.key === 'category_spikes')!;
    expect(sp.why).toContain('Comida');
    expect(sp.why).not.toContain('Fijos');
  });

  it('ahorro bajo: calcula cuánto liberar y señala rubros discrecionales', () => {
    const a = buildAdvice(base({
      health: { ...base().health, avgMonthlyExpense: 10_500_000, checks: [check('saving_rate', -5, 'bad')] },
      categories: [{ name: 'Salidas', group: 'Gasto', last: 2_000_000, avg: 2_000_000 }, { name: 'Alquiler', group: 'Egresos', last: 4_000_000, avg: 4_000_000 }],
    }));
    const r = a.recommendations.find((x) => x.key === 'saving_rate')!;
    expect(r.priority).toBe('important');
    expect(r.amount).toBe(1_500_000); // 10% de 10M + 500k de déficit
    expect(r.steps.join(' ')).toContain('Salidas');
    expect(keys(a)).not.toContain('put_surplus_to_work');
  });

  it('colchón: calcula meses para llegar a la meta con 10% de los ingresos', () => {
    const a = buildAdvice(base({
      health: { ...base().health, summary: { ...base().health.summary, savings: 7_000_000 }, checks: [check('emergency', 1, 'warn')] },
    }));
    const r = a.recommendations.find((x) => x.key === 'emergency')!;
    expect(r.amount).toBe(14_000_000); // 3 × 7M − 7M
    expect(r.steps[0]).toContain('14 meses'); // 14M / 1M al mes
  });

  it('ritmo del mes: avisa solo si proyecta 15% sobre el promedio y desde el día 7', () => {
    const slow = buildAdvice(base({ monthToDateExpense: 4_000_000 })); // día 16 → ~7.5M (7%)
    expect(keys(slow)).not.toContain('month_pace');
    const fast = buildAdvice(base({ monthToDateExpense: 6_000_000 })); // → ~11.25M
    expect(keys(fast)).toContain('month_pace');
    const early = buildAdvice(base({ asOf: '2026-11-03', monthToDateExpense: 6_000_000 }));
    expect(keys(early)).not.toContain('month_pace');
  });

  it('ordena por prioridad', () => {
    const a = buildAdvice(base({
      loans: [{ name: 'X', amount: 1, dueDate: '2026-11-01' }],
      health: { ...base().health, checks: [check('uncategorized', 4, 'warn')] },
    }));
    expect(a.recommendations.map((r) => r.priority)).toEqual(['urgent', 'improve']);
  });
});

describe('adviceReport (base real)', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await makeTestDb(); });
  afterAll(async () => { await ctx.close(); });

  it('funciona con una cuenta vacía y con datos', async () => {
    const u = (await ctx.db.query(`INSERT INTO users(email,password_hash) VALUES ('adv@test.io','x') RETURNING id`)).rows[0].id;
    const empty = await adviceReport(ctx.db, u, '2026-11-16');
    expect(empty.recommendations).toEqual([]);
    expect(empty.headline).toContain('Todo en orden');

    const acc = (await ctx.db.query(`INSERT INTO accounts(user_id,type,name,in_flow) VALUES ($1,'savings','GNB',true) RETURNING id`, [u])).rows[0].id;
    const cat = (await ctx.db.query(`INSERT INTO categories(user_id,name,group_name) VALUES ($1,'Comida','Gasto') RETURNING id`, [u])).rows[0].id;
    const ins = (date: string, item: string, kind: string, amount: number, category: string | null) =>
      ctx.db.query('INSERT INTO transactions(user_id,date,item,kind,amount,account_id,category_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [u, date, item, kind, amount, acc, category]);
    for (const m of ['2026-08', '2026-09', '2026-10']) {
      await ins(`${m}-05`, 'Sueldo', 'income', 3000000, null);
      await ins(`${m}-10`, 'Super', 'expense', 2900000, cat);
    }
    await ins('2026-11-02', 'Fiesta', 'expense', 900000, null);
    const a = await adviceReport(ctx.db, u, '2026-11-16');
    expect(a.recommendations.length).toBeGreaterThan(0);
    expect(a.recommendations.find((r) => r.key === 'saving_rate')).toBeTruthy(); // ahorra ~3%
    expect(a.recommendations.find((r) => r.key === 'uncategorized')).toBeTruthy();
  });
});
