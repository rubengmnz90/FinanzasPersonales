import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';
import { NotFoundError } from '../db/client';
import { addEntry, createAccount, getLedger, listBalances, pendingTempWithdrawals, savingsOverview } from './ledgers/service';
import { addAllocation, getRecovery, setCobro } from './recovery/service';
import { addSplitItem, createSplit, getSplit } from './splits/service';
import { createTransaction } from './transactions/service';
import { ensureCategory } from './categories/service';
import { annualSummary, monthlySummary, projectedBalance, rangeSummary } from './summary/service';
import { addItem, createPlan, getPlanView, setCell } from './plans/service';

let ctx: TestCtx;
let a: string;
let b: string;
beforeAll(async () => {
  ctx = await makeTestDb();
  a = await makeUser(ctx.db);
  b = await makeUser(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

describe('ledgers', () => {
  it('tarjeta: saldo disponible y deuda respecto de la línea', async () => {
    const card = await createAccount(ctx.db, a, { type: 'card', name: 'Coomecipar', creditLimit: 3000000, openingBalance: 0 });
    for (const [c, v] of [['Inicial', 3000000], ['Teclado', -3000000], ['Pago', 200000], ['Arete', -186928]] as const) {
      await addEntry(ctx.db, a, card.id, { date: '2026-04-02', concept: c, rawAmount: v });
    }
    const l = await getLedger(ctx.db, a, card.id);
    expect(l.balance).toBe(13072);
    expect(l.owed).toBe(2986928);
    expect(l.entries.map((e) => e.balance)).toEqual([3000000, 0, 200000, 13072]);
  });

  it('deuda con la esposa: saldo negativo = lo que debo', async () => {
    const d = await createAccount(ctx.db, a, { type: 'debt', name: 'Deuda Casa', counterparty: 'Esposa' });
    await addEntry(ctx.db, a, d.id, { date: '2024-01-15', concept: 'Prestamo', rawAmount: -1000000 });
    await addEntry(ctx.db, a, d.id, { date: '2024-02-15', concept: 'Pago', rawAmount: 250000 });
    const l = await getLedger(ctx.db, a, d.id);
    expect(l.balance).toBe(-750000);
    expect(l.owed).toBe(750000);
  });

  it('ahorro: retiros temporales y devoluciones', async () => {
    const s = await createAccount(ctx.db, a, { type: 'savings', name: 'Ahorro Coomecipar' });
    await addEntry(ctx.db, a, s.id, { date: '2026-04-11', concept: 'Ahorro', rawAmount: 100000, tag: null });
    await addEntry(ctx.db, a, s.id, { date: '2026-09-05', concept: 'Reponer Osky', rawAmount: -250000, tag: 'temp_withdrawal' });
    await addEntry(ctx.db, a, s.id, { date: '2026-09-20', concept: 'Devolución', rawAmount: 100000, tag: 'return' });
    expect(await pendingTempWithdrawals(ctx.db, a, s.id)).toBe(150000);
    const w = await savingsOverview(ctx.db, a, s.id);
    expect(w.totals.pending).toBe(150000);
    expect(w.people).toEqual([{ person: null, lent: 250000, returned: 100000, pending: 150000 }]);
  });

  it('ahorro: separa depósitos, extracciones, préstamos y devoluciones por persona', async () => {
    const u = await makeUser(ctx.db);
    const s = await createAccount(ctx.db, u, { type: 'savings', name: 'Ahorro 2' });
    await addEntry(ctx.db, u, s.id, { date: '2026-01-01', concept: 'Ahorro', rawAmount: 500000, bucket: 'Ahorro' });
    await addEntry(ctx.db, u, s.id, { date: '2026-02-01', concept: 'Compré moto', rawAmount: -100000, bucket: 'Ahorro' });
    await addEntry(ctx.db, u, s.id, { date: '2026-03-01', concept: 'Reponer Charlie', rawAmount: -35000, tag: 'temp_withdrawal', person: 'Charlie' });
    await addEntry(ctx.db, u, s.id, { date: '2026-03-02', concept: 'Super', rawAmount: -312233, tag: 'temp_withdrawal', person: 'Devolver en cobro' });
    await addEntry(ctx.db, u, s.id, { date: '2026-03-03', concept: 'Traje', rawAmount: -2274, tag: 'temp_withdrawal' });
    await addEntry(ctx.db, u, s.id, { date: '2026-03-04', concept: 'Pagó Charlie', rawAmount: 15000, tag: 'return', person: 'Charlie' });
    const o = await savingsOverview(ctx.db, u, s.id);
    expect(o.moves.map((m) => m.kind)).toEqual(['deposit', 'withdrawal', 'loan', 'loan', 'loan', 'return']);
    expect(o.totals).toMatchObject({ deposits: 500000, withdrawals: 100000, lent: 349507, returned: 15000, pending: 334507 });
    expect(o.people.map((p) => [p.person, p.pending])).toEqual([['Devolver en cobro', 312233], ['Charlie', 20000], [null, 2274]]);
    expect(o.moves.at(-1)!.balance).toBe(500000 - 100000 - 35000 - 312233 - 2274 + 15000);
  });

  it('aísla usuarios', async () => {
    expect(await listBalances(ctx.db, b)).toHaveLength(0);
    const [acc] = await listBalances(ctx.db, a);
    await expect(getLedger(ctx.db, b, acc.accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addEntry(ctx.db, b, acc.accountId, { date: '2026-01-01', concept: 'x', rawAmount: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('recovery', () => {
  it('calcula pendiente por deuda y saldo libre por cobro', async () => {
    await setCobro(ctx.db, a, 3, 'Quincena Noviembre', 5500000);
    await addAllocation(ctx.db, a, { cobroIndex: 3, concept: 'Fijos', rawAmount: 2682953 });
    await addAllocation(ctx.db, a, { cobroIndex: 3, concept: 'Vacaciones', rawAmount: 1650000, tag: 'V' });
    await addAllocation(ctx.db, a, { cobroIndex: 3, concept: 'Reponer Ahorro', rawAmount: 150000, tag: 'A' });
    const r = await getRecovery(ctx.db, a);
    const cobro = r.cobros[0];
    expect(cobro.spent).toBe(4482953);
    expect(cobro.left).toBe(1017047);
    expect(r.debts.find((d) => d.key === 'savings')!.paid).toBe(150000);
    expect(r.debts.find((d) => d.key === 'savings')!.pending).toBe(150000 - 150000);
    expect(r.byTag.V).toBe(1650000);
  });
});

describe('splits', () => {
  it('replica la plantilla de distribución y detecta % que no suman 100', async () => {
    const id = await createSplit(ctx.db, a, { name: 'Super', participants: ['Emma', 'Ali', 'Yo'] });
    await addSplitItem(ctx.db, a, id, { total: 51726, discountPct: 0.2, shares: { Emma: 0.2, Ali: 0.4, Yo: 0.4 } });
    const bad = await addSplitItem(ctx.db, a, id, { total: 1000, discountPct: 0, shares: { Emma: 0.5 } });
    const v = await getSplit(ctx.db, a, id);
    expect(v.items[0].shares.Yo).toBe(0.4);
    expect(v.result.items[0].byPerson).toEqual({ Emma: 8276, Ali: 16552, Yo: 16552 });
    expect(v.shareErrors).toEqual([{ itemId: bad, sum: 0.5 }]);
    await expect(getSplit(ctx.db, b, id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('summary', () => {
  it('resume por rango, mensual y anual; meses vacíos en cero', async () => {
    const hon = await ensureCategory(ctx.db, b, 'Honorarios', 'Ingresos');
    const com = await ensureCategory(ctx.db, b, 'Comida', 'Gasto');
    await createTransaction(ctx.db, b, { date: '2026-01-05', item: 'h', kind: 'income', rawAmount: 5000000, categoryId: hon });
    await createTransaction(ctx.db, b, { date: '2026-01-10', item: 'pizza', kind: 'expense', rawAmount: 42500, categoryId: com });
    await createTransaction(ctx.db, b, { date: '2026-03-10', item: 'cena', kind: 'expense', rawAmount: 58000, categoryId: com });
    const jan = await monthlySummary(ctx.db, b, 2026, 1);
    expect(jan.net).toBe(4957500);
    expect(jan.groups.find((g) => g.group === 'Gasto')!.total).toBe(42500);
    const rng = await rangeSummary(ctx.db, b, '2026-01-08', '2026-03-31');
    expect(rng.expense).toBe(100500);
    const annual = await annualSummary(ctx.db, b, 2026);
    const comida = annual.find((x) => x.category === 'Comida')!;
    expect(comida.months[0]).toBe(42500);
    expect(comida.months[1]).toBe(0);
    expect(comida.total).toBe(100500);
    const feb = await monthlySummary(ctx.db, b, 2026, 2);
    expect(feb.net).toBe(0);
  });

  it('saldo proyectado cobro a cobro desde el saldo real', async () => {
    const plan = await createPlan(ctx.db, b, {
      year: 2026,
      name: 'P',
      periods: [{ label: 'Quincena', dayOfMonth: 15 }, { label: 'Fin de mes', dayOfMonth: 30 }],
    });
    const v = await getPlanView(ctx.db, b, plan.id);
    const inc = await addItem(ctx.db, b, plan.id, { periodId: v.periods[0].id, kind: 'income', concept: 'Honorarios' });
    const exp = await addItem(ctx.db, b, plan.id, { periodId: v.periods[1].id, kind: 'expense', concept: 'Alquiler' });
    await setCell(ctx.db, b, inc, 4, 5000000);
    await setCell(ctx.db, b, exp, 4, 1050000);
    const proj = await projectedBalance(ctx.db, b, plan.id, '2026-03-31');
    const start = 5000000 - 42500 - 58000;
    const apr15 = proj.find((e) => e.date === '2026-04-15')!;
    const apr30 = proj.find((e) => e.date === '2026-04-30')!;
    expect(apr15.balance).toBe(start + 5000000);
    expect(apr30.balance).toBe(start + 5000000 - 1050000);
    expect(proj.every((e) => e.date > '2026-03-31')).toBe(true);
  });
});
