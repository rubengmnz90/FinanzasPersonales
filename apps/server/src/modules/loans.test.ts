import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';
import { ValidationError } from '../db/client';
import { accountIdByName, addEntry, createAccount, getLedger, listBalances, seedDefaultAccounts } from './ledgers/service';
import { createTransfer, saveBucket } from './transfers/service';
import { addInstallment, createLoan, listLoans, payInstallment, seedDefaultLoans, unpayInstallment, updateLoan } from './loans/service';
import { seedCategories } from './categories/service';
import { listTransactions } from './transactions/service';
import { listPlannedExpenses } from './planned-expenses/service';

let ctx: TestCtx;
let u: string;
let gnb: string;
let ahorro: string;

beforeAll(async () => {
  ctx = await makeTestDb();
  u = await makeUser(ctx.db);
  await seedCategories(ctx.db, u);
  await seedDefaultAccounts(ctx.db, u);
  gnb = (await accountIdByName(ctx.db, u, 'GNB'))!;
  ahorro = (await createAccount(ctx.db, u, { type: 'savings', name: 'Ahorro Coomecipar' })).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('objetivos de ahorro tocables e intocables', () => {
  it('separa el monto intocable (Aguinaldo, Vacaciones, Emma) de lo que se puede tocar', async () => {
    await addEntry(ctx.db, u, ahorro, { date: '2026-01-10', concept: 'Ahorro', rawAmount: 1000000, bucket: 'Ahorro' });
    await addEntry(ctx.db, u, ahorro, { date: '2026-01-11', concept: 'Aguinaldo', rawAmount: 600000, bucket: 'Aguinaldo' });
    await addEntry(ctx.db, u, ahorro, { date: '2026-01-12', concept: 'Vacaciones', rawAmount: 400000, bucket: 'Vacaciones' });
    const s = (await listBalances(ctx.db, u)).find((b) => b.accountId === ahorro)!;
    expect(s).toMatchObject({ balance: 2000000, untouchable: 1000000, touchable: 1000000 });
  });

  it('un préstamo desde un objetivo intocable exige confirmarlo', async () => {
    const base = { date: '2026-02-01', fromAccountId: ahorro, toAccountId: gnb, rawAmount: 100000, kind: 'loan' as const, bucket: 'Vacaciones' };
    await expect(createTransfer(ctx.db, u, base)).rejects.toMatchObject({ code: 'BUCKET_UNTOUCHABLE' });
    await createTransfer(ctx.db, u, { ...base, useUntouchable: true });
    await createTransfer(ctx.db, u, { ...base, bucket: 'Ahorro', rawAmount: 50000 }); // tocable: sin confirmar
  });

  it('marcar un objetivo como tocable lo libera', async () => {
    await saveBucket(ctx.db, u, 'Aguinaldo', false);
    await createTransfer(ctx.db, u, { date: '2026-02-02', fromAccountId: ahorro, toAccountId: gnb, rawAmount: 10000, kind: 'loan', bucket: 'Aguinaldo' });
    await saveBucket(ctx.db, u, 'Aguinaldo', true);
  });
});

describe('préstamos con cuotas', () => {
  it('crea cuotas mensuales y, en proyección, genera gastos planeados', async () => {
    const l = await createLoan(ctx.db, u, { name: 'Moto', installmentAmount: 300000, installments: 3, firstDue: '2026-12-31', inProjection: true });
    expect(l.installments.map((i) => i.dueDate)).toEqual(['2026-12-31', '2027-01-31', '2027-02-28']);
    expect(l.pendingTotal).toBe(900000);
    const planned = (await listPlannedExpenses(ctx.db, u)).filter((p) => p.concept.startsWith('Moto'));
    expect(planned).toHaveLength(3);
    expect(planned[0]).toMatchObject({ periodLabel: 'Fin de mes', amount: 300000 });
  });

  it('pagar una cuota registra el egreso en el flujo (categoría Prestamos) y cierra el gasto planeado; deshacer lo revierte', async () => {
    const l = (await listLoans(ctx.db, u)).find((x) => x.name === 'Moto')!;
    const paid = await payInstallment(ctx.db, u, l.installments[0].id, { date: '2026-12-31', accountId: gnb });
    expect(paid).toMatchObject({ paidCount: 1, pendingCount: 2 });
    const tx = (await listTransactions(ctx.db, u, { text: 'Moto' })).filter((t) => t.rowType === 'tx');
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ amount: 300000, kind: 'expense', categoryName: 'Prestamos', accountName: 'GNB' });
    expect((await listPlannedExpenses(ctx.db, u, { done: true })).some((p) => p.concept.startsWith('Moto'))).toBe(true);
    await expect(payInstallment(ctx.db, u, l.installments[0].id)).rejects.toBeInstanceOf(ValidationError);
    await unpayInstallment(ctx.db, u, l.installments[0].id);
    expect((await listTransactions(ctx.db, u, { text: 'Moto' })).filter((t) => t.rowType === 'tx')).toHaveLength(0);
    expect((await listLoans(ctx.db, u)).find((x) => x.name === 'Moto')).toMatchObject({ paidCount: 0 });
  });

  it('sacar el préstamo de la proyección quita los gastos planeados pendientes', async () => {
    const l = (await listLoans(ctx.db, u)).find((x) => x.name === 'Moto')!;
    await updateLoan(ctx.db, u, l.id, { inProjection: false });
    expect((await listPlannedExpenses(ctx.db, u)).filter((p) => p.concept.startsWith('Moto'))).toHaveLength(0);
    await updateLoan(ctx.db, u, l.id, { inProjection: true });
    expect((await listPlannedExpenses(ctx.db, u)).filter((p) => p.concept.startsWith('Moto'))).toHaveLength(3);
  });

  it('un préstamo pagado desde una caja anota un movimiento negativo en ella', async () => {
    const caja = (await createAccount(ctx.db, u, { type: 'cash_box', name: 'Vibra Lejana' })).id;
    await addEntry(ctx.db, u, caja, { date: '2026-01-01', concept: 'Saldo', rawAmount: 2000000 });
    const l = await createLoan(ctx.db, u, { name: 'Equipo', installmentAmount: 500000, installments: 2, firstDue: '2026-12-01', ledgerAccountId: caja });
    await payInstallment(ctx.db, u, l.installments[0].id, { date: '2026-12-01' });
    expect((await getLedger(ctx.db, u, caja)).balance).toBe(1500000);
    await unpayInstallment(ctx.db, u, l.installments[0].id);
    expect((await getLedger(ctx.db, u, caja)).balance).toBe(2000000);
  });

  it('agrega cuotas sueltas a un préstamo que no amortiza en cuotas iguales', async () => {
    const l = await createLoan(ctx.db, u, { name: 'Libre', principal: 1000000, schedule: [{ dueDate: '2026-09-15', amount: 100000, paid: true }] });
    const l2 = await addInstallment(ctx.db, u, l.id, { dueDate: '2026-10-15', rawAmount: '=90000+5000' });
    expect(l2.installments.map((i) => [i.number, i.amount, i.paid])).toEqual([[1, 100000, true], [2, 95000, false]]);
  });

  it('los préstamos iniciales (Coomecipar y Vibra Lejana) se siembran una sola vez con sus cuotas', async () => {
    await createAccount(ctx.db, u, { type: 'cash_box', name: 'Vibra Lejana' });
    await seedDefaultLoans(ctx.db, u);
    await seedDefaultLoans(ctx.db, u);
    const loans = await listLoans(ctx.db, u);
    const coo = loans.find((l) => l.name === 'Préstamo Coomecipar')!;
    expect(coo).toMatchObject({ principal: 10000000, paidCount: 3, inProjection: false });
    expect(coo.installments.map((i) => i.amount)).toEqual([828867, 883114, 883114]);
    const vib = loans.find((l) => l.name === 'Préstamo equipos Vibra Lejana')!;
    expect(vib).toMatchObject({ paidCount: 3, pendingCount: 9 });
    expect(vib.installments[0].amount).toBe(1074202);
    expect(vib.installments[3].amount).toBe(1059737);
  });
});
