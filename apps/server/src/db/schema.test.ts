import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeTestDb();
});
afterAll(async () => {
  await ctx.close();
});

describe('schema', () => {
  it('valida kind, monto y clave de importación única por usuario', async () => {
    const u = await makeUser(ctx.db);
    const ins = (kind: string, amount: number, key: string | null) =>
      ctx.db.query(
        "INSERT INTO transactions(user_id,date,item,kind,amount,import_key) VALUES ($1,'2026-01-01','x',$2,$3,$4)",
        [u, kind, amount, key],
      );
    await expect(ins('x', 1, null)).rejects.toThrow();
    await expect(ins('expense', -1, null)).rejects.toThrow();
    await ins('expense', 1, 'k1');
    await expect(ins('expense', 1, 'k1')).rejects.toThrow();
    const u2 = await makeUser(ctx.db);
    await ctx.db.query(
      "INSERT INTO transactions(user_id,date,item,kind,amount,import_key) VALUES ($1,'2026-01-01','x','expense',1,'k1')",
      [u2],
    );
  });
});
