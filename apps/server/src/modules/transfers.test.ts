import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';
import { NotFoundError, ValidationError } from '../db/client';
import {
  accountIdByName, accountStatement, addEntry, assignBucket, createAccount, defaultAccountId, listBalances, seedDefaultAccounts, updateAccount,
} from './ledgers/service';
import { createTransfer, deleteTransfer, listBuckets } from './transfers/service';
import { createTransaction, listTransactions } from './transactions/service';
import { createPlan, addItem, setCell, getPlanView } from './plans/service';
import { createPlannedExpense } from './planned-expenses/service';
import { executePlan, previewExecution } from './plans/execution';
import { healthReport } from './summary/health';

let ctx: TestCtx;
let u: string;
let other: string;
let gnb: string;
let fam: string;
let efectivo: string;
let ahorro: string;
let tarjeta: string;

const bal = async (id: string, asOf?: string) => (await listBalances(ctx.db, u, { asOf })).find((b) => b.accountId === id)!;

beforeAll(async () => {
  ctx = await makeTestDb();
  u = await makeUser(ctx.db);
  other = await makeUser(ctx.db);
  await seedDefaultAccounts(ctx.db, u);
  await seedDefaultAccounts(ctx.db, u); // idempotente
  gnb = (await accountIdByName(ctx.db, u, 'GNB'))!;
  fam = (await accountIdByName(ctx.db, u, 'Familiar'))!;
  efectivo = (await accountIdByName(ctx.db, u, 'Efectivo'))!;
  ahorro = (await createAccount(ctx.db, u, { type: 'savings', name: 'Ahorro Coomecipar', institution: 'Coomecipar' })).id;
  // La tarjeta parte debiendo 200.000 (límite 7.000.000 − saldo disponible 6.800.000).
  tarjeta = (await createAccount(ctx.db, u, { type: 'card', name: 'Tarjeta GNB', creditLimit: 7000000, openingBalance: 6800000 })).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('cuentas por defecto', () => {
  it('crea GNB (predeterminada) y Familiar en el flujo, y Efectivo fuera, una sola vez', async () => {
    const accs = (await listBalances(ctx.db, u)).filter((a) => ['bank', 'cash'].includes(a.type));
    expect(accs.map((a) => a.name).sort()).toEqual(['Efectivo', 'Familiar', 'GNB']);
    expect(accs.find((a) => a.name === 'GNB')).toMatchObject({ alias: '0971185507', isDefault: true, inFlow: true });
    expect(accs.find((a) => a.name === 'Familiar')).toMatchObject({ alias: '2946999', inFlow: true });
    expect(accs.find((a) => a.name === 'Efectivo')!.inFlow).toBe(false);
    expect(await defaultAccountId(ctx.db, u)).toBe(gnb);
  });
});

describe('flujo por cuenta', () => {
  it('un movimiento sin cuenta va a GNB; con cuenta va a esa', async () => {
    await createTransaction(ctx.db, u, { date: '2026-11-01', item: 'Honorario', kind: 'income', rawAmount: 5000000 });
    await createTransaction(ctx.db, u, { date: '2026-11-02', item: 'Alquiler', kind: 'expense', rawAmount: 30000, accountId: fam });
    expect((await bal(gnb)).balance).toBe(5000000);
    expect((await bal(fam)).balance).toBe(-30000);
    await createTransaction(ctx.db, u, { date: '2026-11-02', item: 'Pago Familiar', kind: 'income', rawAmount: 30000, accountId: fam });
  });

  it('el flujo solo admite cuentas marcadas: Efectivo no lo está hasta que se marque', async () => {
    await expect(createTransaction(ctx.db, u, { date: '2026-11-02', item: 'Almuerzo', kind: 'expense', rawAmount: 30000, accountId: efectivo })).rejects.toBeInstanceOf(ValidationError);
    await updateAccount(ctx.db, u, efectivo, { inFlow: true });
    await createTransaction(ctx.db, u, { date: '2026-11-02', item: 'Almuerzo', kind: 'expense', rawAmount: 30000, accountId: efectivo });
    expect((await bal(efectivo)).balance).toBe(-30000);
    await createTransaction(ctx.db, u, { date: '2026-11-02', item: 'Reintegro', kind: 'income', rawAmount: 30000, accountId: efectivo });
    await updateAccount(ctx.db, u, efectivo, { inFlow: false });
  });

  it('una cuenta de ahorro o tarjeta no puede marcarse para el flujo', async () => {
    await expect(updateAccount(ctx.db, u, tarjeta, { inFlow: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAccount(ctx.db, u, ahorro, { inFlow: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rechaza registrar el flujo directamente en una cuenta de ahorro', async () => {
    await expect(createTransaction(ctx.db, u, { date: '2026-11-02', item: 'x', kind: 'expense', rawAmount: 1, accountId: ahorro })).rejects.toBeInstanceOf(ValidationError);
  });

  it('las tarjetas no son del flujo: no se registra ahí y su deuda no toca el disponible', async () => {
    await expect(createTransaction(ctx.db, u, { date: '2026-11-03', item: 'Compra', kind: 'expense', rawAmount: 200000, accountId: tarjeta })).rejects.toBeInstanceOf(ValidationError);
    expect((await bal(gnb)).balance).toBe(5000000);
    expect((await bal(tarjeta)).owed).toBe(200000);
  });

  it('no deja usar cuentas de otro usuario', async () => {
    const foreign = (await createAccount(ctx.db, other, { type: 'bank', name: 'Ajena' })).id;
    await expect(createTransaction(ctx.db, u, { date: '2026-11-03', item: 'x', kind: 'expense', rawAmount: 1, accountId: foreign })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createTransfer(ctx.db, u, { date: '2026-11-03', fromAccountId: foreign, toAccountId: gnb, rawAmount: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('transferencias y ahorros', () => {
  it('pasar a ahorro: baja el banco, sube el ahorro y queda en su objetivo', async () => {
    await createTransfer(ctx.db, u, { date: '2026-11-05', fromAccountId: gnb, toAccountId: ahorro, rawAmount: 1000000, bucket: 'Colchón' });
    await createTransfer(ctx.db, u, { date: '2026-11-06', fromAccountId: gnb, toAccountId: ahorro, rawAmount: '=300000+200000', bucket: 'Vacaciones' });
    expect((await bal(gnb)).balance).toBe(5000000 - 1500000);
    const s = await bal(ahorro);
    expect(s.balance).toBe(1500000);
    expect(s.buckets).toEqual([{ bucket: 'Colchón', balance: 1000000 }, { bucket: 'Vacaciones', balance: 500000 }]);
    const names = (await listBuckets(ctx.db, u)).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Colchón', 'Vacaciones', 'Aguinaldo', 'Ahorro', 'Emma']));
  });

  it('pagar la tarjeta desde el banco reduce la deuda', async () => {
    await createTransfer(ctx.db, u, { date: '2026-11-07', fromAccountId: gnb, toAccountId: tarjeta, rawAmount: 120000 });
    expect((await bal(tarjeta)).owed).toBe(80000);
  });

  it('préstamo desde el ahorro al flujo: queda pendiente hasta que se devuelve', async () => {
    await createTransfer(ctx.db, u, { date: '2026-11-08', fromAccountId: ahorro, toAccountId: gnb, rawAmount: 400000, kind: 'loan', bucket: 'Colchón', note: 'Para la cuota' });
    let s = await bal(ahorro);
    expect(s.loansPending).toBe(400000);
    expect(s.balance).toBe(1100000);
    await createTransfer(ctx.db, u, { date: '2026-11-20', fromAccountId: gnb, toAccountId: ahorro, rawAmount: 150000, kind: 'repayment', bucket: 'Colchón' });
    s = await bal(ahorro);
    expect(s.loansPending).toBe(250000);
    expect(s.buckets.find((b) => b.bucket === 'Colchón')!.balance).toBe(750000);
  });

  it('un préstamo solo puede salir de un ahorro y no se transfiere a la misma cuenta', async () => {
    await expect(createTransfer(ctx.db, u, { date: '2026-11-08', fromAccountId: gnb, toAccountId: fam, rawAmount: 1, kind: 'loan' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTransfer(ctx.db, u, { date: '2026-11-08', fromAccountId: gnb, toAccountId: gnb, rawAmount: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTransfer(ctx.db, u, { date: '2026-11-08', fromAccountId: gnb, toAccountId: fam, rawAmount: 0 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('saldos a una fecha pasada ignoran lo posterior', async () => {
    expect((await bal(ahorro, '2026-11-05')).balance).toBe(1000000);
    expect((await bal(gnb, '2026-11-01')).balance).toBe(5000000);
  });

  it('mover entre bancos no cambia el dinero disponible total', async () => {
    const liquid = async () => (await listBalances(ctx.db, u)).filter((a) => ['bank', 'cash'].includes(a.type)).reduce((s, a) => s + a.balance, 0);
    const antes = await liquid();
    await createTransfer(ctx.db, u, { date: '2026-11-09', fromAccountId: gnb, toAccountId: fam, rawAmount: 700000 });
    expect(await liquid()).toBe(antes);
    expect((await bal(fam)).balance).toBe(700000);
  });

  it('asigna objetivo a los movimientos antiguos sin objetivo', async () => {
    const legacy = (await createAccount(ctx.db, u, { type: 'savings', name: 'Ahorro viejo' })).id;
    await addEntry(ctx.db, u, legacy, { date: '2026-01-01', concept: 'Saldo', rawAmount: 900000 });
    expect((await bal(legacy)).buckets).toEqual([{ bucket: 'Sin asignar', balance: 900000 }]);
    expect(await assignBucket(ctx.db, u, legacy, 'Aguinaldo')).toBe(1);
    expect((await bal(legacy)).buckets).toEqual([{ bucket: 'Aguinaldo', balance: 900000 }]);
  });
});

describe('flujo con transferencias y relatorio', () => {
  it('lista de más nuevo a más viejo e incluye transferencias con saldo de la cuenta filtrada', async () => {
    const rows = await listTransactions(ctx.db, u, { accountId: gnb, order: 'desc', from: '2026-11-01', to: '2026-11-30' });
    expect(rows[0].date >= rows[rows.length - 1].date).toBe(true);
    expect(rows.some((r) => r.rowType === 'transfer')).toBe(true);
    const newest = rows[0];
    expect(newest.balance).toBe((await bal(gnb)).balance);
    expect(rows.every((r) => r.accountId === gnb || r.toAccountId === gnb)).toBe(true);
  });

  it('sin filtro, el saldo es el del dinero disponible (bancos + efectivo)', async () => {
    const rows = await listTransactions(ctx.db, u, { order: 'desc' });
    const liquid = (await listBalances(ctx.db, u)).filter((a) => ['bank', 'cash'].includes(a.type)).reduce((s, a) => s + a.balance, 0);
    expect(rows[0].balance).toBe(liquid);
  });

  it('includeTransfers=false las oculta', async () => {
    expect((await listTransactions(ctx.db, u, { includeTransfers: false })).every((r) => r.rowType === 'tx')).toBe(true);
  });

  it('el relatorio de GNB cuadra: saldo inicial + entradas − salidas = saldo final', async () => {
    const st = await accountStatement(ctx.db, u, gnb, { from: '2026-11-05', to: '2026-11-30' });
    expect(st.opening + st.totalIn - st.totalOut).toBe(st.closing);
    expect(st.closing).toBe((await bal(gnb)).balance);
    expect(st.opening).toBe(5000000);
  });

  it('borrar una transferencia revierte los saldos', async () => {
    const t = await createTransfer(ctx.db, u, { date: '2026-11-25', fromAccountId: gnb, toAccountId: efectivo, rawAmount: 50000 });
    const antes = (await bal(efectivo)).balance;
    await deleteTransfer(ctx.db, u, t.id);
    expect((await bal(efectivo)).balance).toBe(antes - 50000);
  });
});

describe('ejecutar plan', () => {
  let planId: string;
  let quincena: string;
  beforeAll(async () => {
    planId = (await createPlan(ctx.db, u, { year: 2031, name: 'Plan exec', periods: [{ label: 'Quincena', dayOfMonth: 15 }, { label: 'Fin de mes', dayOfMonth: 31 }] })).id;
    const v = await getPlanView(ctx.db, u, planId);
    quincena = v.periods[0].id;
    const sueldo = await addItem(ctx.db, u, planId, { periodId: quincena, kind: 'income', concept: 'Honorarios' });
    const luz = await addItem(ctx.db, u, planId, { periodId: quincena, kind: 'expense', concept: 'Luz' });
    await setCell(ctx.db, u, sueldo, 2, 6000000);
    await setCell(ctx.db, u, luz, 2, 250000);
    await createPlannedExpense(ctx.db, u, { concept: 'Dentista', rawAmount: 400000, periodLabel: 'Quincena', dueDate: '2031-02-10' });
  });

  it('la vista previa lista ingresos, gastos y gastos puntuales del mes, con la fecha del cobro', async () => {
    const p = await previewExecution(ctx.db, u, { planId, periodId: quincena, month: 2 });
    expect(p.date).toBe('2031-02-15');
    const names = p.lines.map((l) => `${l.kind}:${l.concept}:${l.amount}`);
    expect(names).toEqual(['income:Honorarios:6000000', 'expense:Luz:250000', 'expense:Dentista:400000']);
    expect(p.lines.every((l) => !l.executed)).toBe(true);
  });

  it('el cobro de "Fin de mes" entra el día 1 del mes, aunque el cobro sea el 30', async () => {
    const v = await getPlanView(ctx.db, u, planId);
    const fin = v.periods.find((x) => x.label === 'Fin de mes')!.id;
    expect((await previewExecution(ctx.db, u, { planId, periodId: fin, month: 11 })).date).toBe('2031-11-01');
    expect((await previewExecution(ctx.db, u, { planId, periodId: fin, month: 2 })).date).toBe('2031-02-01');
  });

  it('ejecuta en las cuentas elegidas, mueve el honorario y es idempotente', async () => {
    const p = await previewExecution(ctx.db, u, { planId, periodId: quincena, month: 2 });
    const lines = p.lines.map((l) => ({ key: l.key, accountId: l.kind === 'income' ? fam : gnb }));
    const r = await executePlan(ctx.db, u, {
      planId, periodId: quincena, month: 2, lines,
      transfers: [{ date: '2031-02-15', fromAccountId: fam, toAccountId: gnb, rawAmount: 3000000, note: 'Honorario a GNB' }],
    });
    expect(r).toEqual({ created: 3, skipped: 0, transfers: 1 });
    const gnbBefore = (await bal(gnb)).balance;
    expect((await bal(fam)).balance).toBe(700000 + 6000000 - 3000000);
    const again = await executePlan(ctx.db, u, { planId, periodId: quincena, month: 2, lines });
    expect(again).toEqual({ created: 0, skipped: 3, transfers: 0 });
    expect((await bal(gnb)).balance).toBe(gnbBefore);
    const after = await previewExecution(ctx.db, u, { planId, periodId: quincena, month: 2 });
    expect(after.lines.every((l) => l.executed)).toBe(true);
  });

  it('rechaza líneas que no son de ese cobro', async () => {
    await expect(executePlan(ctx.db, u, { planId, periodId: quincena, month: 2, lines: [{ key: 'item:x', accountId: gnb }] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('reporte de sanidad', () => {
  it('devuelve resumen, semáforos y puntaje 0-100', async () => {
    const h = await healthReport(ctx.db, u, '2026-12-05');
    expect(h.scorePct).toBeGreaterThanOrEqual(0);
    expect(h.scorePct).toBeLessThanOrEqual(100);
    const keys = h.checks.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['liquidity', 'emergency', 'card_use', 'saving_rate', 'external_debt', 'uncategorized']));
    expect(h.summary.savings).toBe(1250000 + 900000); // Ahorro Coomecipar + ahorro viejo
    expect(h.checks.find((c) => c.key === 'loans_from_savings')!.status).toBe('warn');
  });
});

describe('plata del ahorro prestada a terceros', () => {
  it('prestar a una persona, cobrarle al banco y devolver al ahorro', async () => {
    const charlie = (await createAccount(ctx.db, u, { type: 'receivable', name: 'Charlie' })).id;
    const before = await bal(ahorro);
    await createTransfer(ctx.db, u, { date: '2026-11-21', fromAccountId: ahorro, toAccountId: charlie, rawAmount: 300000, kind: 'loan', bucket: 'Colchón' });
    expect((await bal(charlie)).owed).toBe(300000);
    expect((await bal(ahorro)).loansPending).toBe(before.loansPending + 300000);
    // paga 100.000 al banco: baja lo que debe, pero el ahorro sigue esperando que se reponga
    await createTransfer(ctx.db, u, { date: '2026-11-22', fromAccountId: charlie, toAccountId: gnb, rawAmount: 100000 });
    expect((await bal(charlie)).owed).toBe(200000);
    expect((await bal(ahorro)).loansPending).toBe(before.loansPending + 300000);
    // el banco repone el ahorro
    await createTransfer(ctx.db, u, { date: '2026-11-23', fromAccountId: gnb, toAccountId: ahorro, rawAmount: 100000, kind: 'repayment', bucket: 'Colchón' });
    expect((await bal(ahorro)).loansPending).toBe(before.loansPending + 200000);
    // paga el resto directo al ahorro
    await createTransfer(ctx.db, u, { date: '2026-11-24', fromAccountId: charlie, toAccountId: ahorro, rawAmount: 200000, kind: 'repayment', bucket: 'Colchón' });
    expect((await bal(charlie)).owed).toBe(0);
    expect((await bal(ahorro)).loansPending).toBe(before.loansPending);
    expect((await bal(ahorro)).balance).toBe(before.balance);
  });
});
