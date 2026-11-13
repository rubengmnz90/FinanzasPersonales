import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../../test/helpers';
import { NotFoundError } from '../../db/client';
import {
  addItem,
  applyAdjust,
  clearOverride,
  clonePlan,
  comparePlans,
  createPlan,
  fillRight,
  getPlanView,
  removePeriod,
  setCell,
} from './service';
import { createPlannedExpense, markDone } from '../planned-expenses/service';
import { listTransactions } from '../transactions/service';

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

async function twoPeriodPlan() {
  const plan = await createPlan(ctx.db, a, {
    year: 2026,
    name: 'Base',
    periods: [
      { label: 'Fin de mes', dayOfMonth: 30 },
      { label: 'Quincena', dayOfMonth: 15 },
    ],
  });
  const v = await getPlanView(ctx.db, a, plan.id);
  return { plan, fin: v.periods[0].id, qui: v.periods[1].id };
}

describe('plans', () => {
  it('calcula totales y neto por mes y por cobro', async () => {
    const { plan, fin, qui } = await twoPeriodPlan();
    const alq = await addItem(ctx.db, a, plan.id, { periodId: fin, kind: 'expense', concept: 'Alquiler' });
    const hon = await addItem(ctx.db, a, plan.id, { periodId: fin, kind: 'income', concept: 'Honorarios Tellma' });
    const spo = await addItem(ctx.db, a, plan.id, { periodId: qui, kind: 'expense', concept: 'Spotify' });
    await setCell(ctx.db, a, alq, 1, 1050000);
    await setCell(ctx.db, a, alq, 2, '=1.050.000');
    await setCell(ctx.db, a, hon, 1, 5000000);
    await setCell(ctx.db, a, spo, 1, 50000);
    const v = await getPlanView(ctx.db, a, plan.id);
    expect(v.periods[0].totals.expense[0]).toBe(1050000);
    expect(v.periods[0].totals.net[0]).toBe(3950000);
    expect(v.periods[0].totals.net[1]).toBe(-1050000);
    expect(v.periods[1].totals.net[0]).toBe(-50000);
    expect(v.grand.net).toBe(5000000 - 2100000 - 50000);
  });

  it('fila automática "Otros gastos" suma gastos puntuales por cobro, mes y año (por fecha)', async () => {
    const { plan, fin } = await twoPeriodPlan();
    const otros = await addItem(ctx.db, a, plan.id, {
      periodId: fin, kind: 'expense', concept: 'Otros gastos', autoSource: 'planned_expenses',
    });
    await createPlannedExpense(ctx.db, a, { concept: 'Tarjeta', rawAmount: 431372, periodLabel: 'Fin de mes', dueDate: '2026-01-31' });
    await createPlannedExpense(ctx.db, a, { concept: 'Devolución', rawAmount: '=342568+18000', periodLabel: 'Fin de mes', dueDate: '2026-01-31' });
    await createPlannedExpense(ctx.db, a, { concept: 'Otro año', rawAmount: 999, periodLabel: 'Fin de mes', dueDate: '2027-01-31' });
    await createPlannedExpense(ctx.db, a, { concept: 'Otro cobro', rawAmount: 111, periodLabel: 'Quincena', dueDate: '2026-01-15' });
    const v = await getPlanView(ctx.db, a, plan.id);
    const row = v.periods[0].items.find((i) => i.id === otros)!;
    expect(row.cells[0]).toBe(431372 + 360568);
    // Escribir en una fila automática crea un valor manual que pisa al calculado; se puede deshacer.
    await setCell(ctx.db, a, otros, 1, 5);
    let v2 = await getPlanView(ctx.db, a, plan.id);
    let r2 = v2.periods[0].items.find((i) => i.id === otros)!;
    expect(r2.cells[0]).toBe(5);
    expect(r2.overrides[0]).toBe(true);
    expect(r2.computed[0]).toBe(431372 + 360568);
    await clearOverride(ctx.db, a, otros, 1);
    v2 = await getPlanView(ctx.db, a, plan.id);
    r2 = v2.periods[0].items.find((i) => i.id === otros)!;
    expect(r2.cells[0]).toBe(431372 + 360568);
    expect(r2.overrides[0]).toBe(false);
  });

  it('markDone crea el movimiento en la fecha de pago y no se repite', async () => {
    const pe = await createPlannedExpense(ctx.db, a, { concept: 'Celular', rawAmount: 250000, periodLabel: 'Quincena', dueDate: '2026-03-15' });
    const done = await markDone(ctx.db, a, pe.id, { createTransaction: true });
    expect(done.done).toBe(true);
    const tx = await listTransactions(ctx.db, a, { text: 'Celular' });
    expect(tx[0].date).toBe('2026-03-15');
    expect(tx[0].amount).toBe(250000);
    await expect(markDone(ctx.db, a, pe.id, { createTransaction: true })).rejects.toThrow('ALREADY_DONE');
  });

  it('clona sin gastos puntuales, ajusta por % solo lo elegido y compara', async () => {
    const { plan, fin } = await twoPeriodPlan();
    const x = await addItem(ctx.db, a, plan.id, { periodId: fin, kind: 'expense', concept: 'Tupi' });
    const y = await addItem(ctx.db, a, plan.id, { periodId: fin, kind: 'expense', concept: 'Super' });
    await setCell(ctx.db, a, x, 1, 100000);
    await fillRight(ctx.db, a, x, 1);
    await setCell(ctx.db, a, y, 1, 400000);
    const clone = await clonePlan(ctx.db, a, plan.id, { name: 'Escenario', year: 2027 });
    const adj = await applyAdjust(ctx.db, a, clone.id, {
      itemIds: [(await getPlanView(ctx.db, a, clone.id)).periods[0].items.find((i) => i.concept === 'Tupi')!.id],
      months: [1, 2],
      pct: 10,
    });
    const tupi = adj.periods[0].items.find((i) => i.concept === 'Tupi')!;
    expect(tupi.cells.slice(0, 3)).toEqual([110000, 110000, 100000]);
    expect(adj.periods[0].items.find((i) => i.concept === 'Super')!.cells[0]).toBe(400000);
    const cmp = await comparePlans(ctx.db, a, plan.id, clone.id);
    expect(cmp[0].diff).toBe(-10000);
    expect(cmp[2].diff).toBe(0);
  });

  it('quitar un cobro con montos exige destino o confirmación; mensual y quincenal conviven', async () => {
    const { plan, fin, qui } = await twoPeriodPlan();
    const it = await addItem(ctx.db, a, plan.id, { periodId: qui, kind: 'expense', concept: 'X' });
    await setCell(ctx.db, a, it, 1, 10);
    await expect(removePeriod(ctx.db, a, qui)).rejects.toThrow('PERIOD_HAS_DATA');
    await removePeriod(ctx.db, a, qui, { moveToPeriodId: fin });
    const v = await getPlanView(ctx.db, a, plan.id);
    expect(v.periods).toHaveLength(1);
    expect(v.periods[0].items[0].cells[0]).toBe(10);
    await expect(removePeriod(ctx.db, a, fin, { confirmDiscard: true })).rejects.toThrow('LAST_PERIOD');
    const monthly = await createPlan(ctx.db, a, { year: 2026, name: 'Mensual', periods: [{ label: 'Mensual', dayOfMonth: 30 }] });
    expect((await getPlanView(ctx.db, a, monthly.id)).periods).toHaveLength(1);
  });

  it('aísla usuarios', async () => {
    const { plan } = await twoPeriodPlan();
    await expect(getPlanView(ctx.db, b, plan.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(clonePlan(ctx.db, b, plan.id, { name: 'robo' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
