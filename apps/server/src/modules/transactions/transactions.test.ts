import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../../test/helpers';
import { NotFoundError } from '../../db/client';
import { ensureCategory } from '../categories/service';
import {
  balanceAt,
  createTransaction,
  deleteTransaction,
  listPayers,
  listTransactions,
  updateTransaction,
} from './service';

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

describe('transactions', () => {
  it('registra quién pagó solo en ingresos y lo sugiere después', async () => {
    const u = await makeUser(ctx.db);
    const inc = await createTransaction(ctx.db, u, { date: '2026-09-01', item: 'Honorarios', kind: 'income', rawAmount: 440000, payer: 'CBG' });
    expect(inc.payer).toBe('CBG');
    const exp = await createTransaction(ctx.db, u, { date: '2026-09-02', item: 'Super', kind: 'expense', rawAmount: 1000, payer: 'CBG' });
    expect(exp.payer).toBeNull();
    const up = await updateTransaction(ctx.db, u, inc.id, { payer: 'Tellma' });
    expect(up.payer).toBe('Tellma');
    expect(await listPayers(ctx.db, u)).toEqual(['Tellma']);
    expect((await listTransactions(ctx.db, u, { text: 'tellma' })).map((r) => r.id)).toEqual([inc.id]);
  });

  it('guarda la expresión y calcula saldo acumulado respetando el orden de entrada', async () => {
    const cat = await ensureCategory(ctx.db, a, 'Honorarios', 'Ingresos');
    await createTransaction(ctx.db, a, { date: '2026-08-01', item: 'Honorarios', kind: 'income', rawAmount: 1000000, categoryId: cat });
    const t2 = await createTransaction(ctx.db, a, { date: '2026-08-01', item: 'Google', kind: 'expense', rawAmount: '=45814+4581' });
    const t3 = await createTransaction(ctx.db, a, { date: '2026-08-01', item: 'Gaseosa', kind: 'expense', rawAmount: '7.000' });
    expect(t2.amount).toBe(50395);
    expect(t2.amountExpr).toBe('=45814+4581');
    expect(t2.balance).toBe(949605);
    expect(t3.balance).toBe(942605);
  });

  it('filtra por rango de fechas y conserva el saldo global', async () => {
    await createTransaction(ctx.db, a, { date: '2026-09-15', item: 'x', kind: 'expense', rawAmount: 5000 });
    const sep = await listTransactions(ctx.db, a, { from: '2026-09-01', to: '2026-09-30' });
    expect(sep).toHaveLength(1);
    expect(sep[0].balance).toBe(937605);
    expect(await balanceAt(ctx.db, a, '2026-08-31')).toBe(942605);
    expect(await listTransactions(ctx.db, a, { text: 'goo' })).toHaveLength(1);
  });

  it('rechaza monto negativo y expresiones peligrosas', async () => {
    await expect(createTransaction(ctx.db, a, { date: '2026-01-01', item: 'x', kind: 'expense', rawAmount: -5 })).rejects.toThrow('NEGATIVE_AMOUNT');
    await expect(createTransaction(ctx.db, a, { date: '2026-01-01', item: 'x', kind: 'expense', rawAmount: '=process.exit()' })).rejects.toThrow('INVALID_AMOUNT');
  });

  it('aísla usuarios: B no ve ni toca movimientos de A', async () => {
    const [t] = await listTransactions(ctx.db, a, { limit: 1 });
    await expect(updateTransaction(ctx.db, b, t.id, { item: 'hack' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteTransaction(ctx.db, b, t.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listTransactions(ctx.db, b)).toHaveLength(0);
    const cat = await ensureCategory(ctx.db, a, 'Privada', 'Gasto');
    await expect(createTransaction(ctx.db, b, { date: '2026-01-01', item: 'x', kind: 'expense', rawAmount: 1, categoryId: cat })).rejects.toBeInstanceOf(NotFoundError);
  });
});
