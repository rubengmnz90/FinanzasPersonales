import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';
import { importWorkbook } from './importer';

const FILE = process.env.EXCEL_FILE ?? 'C:\\Users\\Ruben\\Downloads\\Administracion 2026.xlsx';
const has = existsSync(FILE);

let ctx: TestCtx;
let u: string;
beforeAll(async () => {
  ctx = await makeTestDb();
  u = await makeUser(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});

const count = async (table: string) => (await ctx.db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n as number;

describe.skipIf(!has)('importWorkbook con el Excel real', () => {
  it('simulación no escribe nada', async () => {
    const r = await importWorkbook(ctx.db, u, FILE, { dryRun: true });
    expect(r.reconciliation.length).toBeGreaterThan(15);
    expect(await count('transactions')).toBe(0);
    expect(await count('plans')).toBe(0);
  });

  it('importa y todo cuadra con los valores calculados del Excel', async () => {
    const r = await importWorkbook(ctx.db, u, FILE);
    const bad = r.reconciliation.filter((x) => !x.ok);
    expect(bad).toEqual([]);
    const by = Object.fromEntries(r.reconciliation.map((x) => [x.name, x]));
    expect(by['Flujo: saldo final'].app).toBe(by['Flujo: saldo final'].excel);
    expect(by['Plan 2026: neto Fin de mes'].app).toBe(15225138);
    expect(by['Plan 2026: neto Quincena'].app).toBe(20660518);
    expect(by['Vibra Lejana: saldo'].app).toBe(1189912);
    expect(by['Préstamos: total'].app).toBe(-21788789);
    expect(by['Plantilla: total Emma'].app).toBe(92652);
    // filas sin subgrupo no se pierden
    expect(await count('transactions')).toBeGreaterThan(1380);
  });

  it('es idempotente: importar de nuevo no duplica', async () => {
    const before = {
      t: await count('transactions'),
      l: await count('ledger_entries'),
      p: await count('planned_expenses'),
      pl: await count('plans'),
      si: await count('split_items'),
    };
    const r = await importWorkbook(ctx.db, u, FILE);
    expect(await count('transactions')).toBe(before.t);
    expect(await count('ledger_entries')).toBe(before.l);
    expect(await count('planned_expenses')).toBe(before.p);
    expect(await count('plans')).toBe(before.pl);
    expect(await count('split_items')).toBe(before.si);
    expect(r.reconciliation.filter((x) => !x.ok)).toEqual([]);
  });

  it('el saldo final de un segundo usuario no se mezcla con el primero', async () => {
    const u2 = await makeUser(ctx.db);
    const r = await importWorkbook(ctx.db, u2, FILE);
    expect(r.reconciliation.filter((x) => !x.ok)).toEqual([]);
    expect(await count('plans')).toBe(4);
  });
});
