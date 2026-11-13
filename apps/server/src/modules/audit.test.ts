import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb, makeUser, type TestCtx } from '../test/helpers';
import { NotFoundError, ValidationError } from '../db/client';
import { auditCtx } from '../db/context';
import { addEntry, createAccount, deleteEntry, getLedger, updateEntry } from './ledgers/service';
import { listAudit, revertAction } from './audit/service';

let ctx: TestCtx;
let u: string;
let other: string;
let caja: string;

const as = <T>(actor: string, fn: () => Promise<T>) => auditCtx.run({ actor, userId: u }, fn);
const entries = async () => (await getLedger(ctx.db, u, caja)).entries;

beforeAll(async () => {
  ctx = await makeTestDb();
  u = await makeUser(ctx.db);
  other = await makeUser(ctx.db);
  caja = (await as('web', () => createAccount(ctx.db, u, { type: 'cash_box', name: 'Caja prueba' }))).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('historial de cambios y deshacer', () => {
  let entryId: string;

  it('registra altas, ediciones y borrados con quién los hizo', async () => {
    entryId = await as('ia: Claude', () => addEntry(ctx.db, u, caja, { date: '2026-11-01', concept: 'Cuerdas', rawAmount: -50000 }));
    await as('web', () => updateEntry(ctx.db, u, entryId, { rawAmount: -60000, concept: 'Cuerdas nuevas' }));
    const { actions } = await listAudit(ctx.db, u, { limit: 10 });
    const mine = actions.filter((a) => a.entries.some((e) => e.table === 'ledger_entries'));
    expect(mine.map((a) => a.entries[0].op)).toEqual(['UPDATE', 'INSERT']);
    expect(mine[0].actor).toBe('web');
    expect(mine[1].actor).toBe('ia: Claude');
    expect(mine[0].entries[0].changes.map((c) => c.column).sort()).toEqual(['amount', 'concept']);
    const onlyIa = await listAudit(ctx.db, u, { actor: 'ia' });
    expect(onlyIa.actions.every((a) => a.actor.startsWith('ia'))).toBe(true);
  });

  it('deshacer una edición devuelve el valor anterior y queda registrado', async () => {
    const edit = (await listAudit(ctx.db, u, { limit: 5 })).actions.find((a) => a.entries[0].op === 'UPDATE')!;
    await revertAction(ctx.db, u, edit.txId);
    const e = (await entries()).find((x) => x.id === entryId)!;
    expect(e.amount).toBe(-50000);
    expect(e.concept).toBe('Cuerdas');
    const top = (await listAudit(ctx.db, u, { limit: 1 })).actions[0];
    expect(top.actor).toBe('deshacer');
    // no se puede deshacer dos veces la misma acción
    await expect(revertAction(ctx.db, u, edit.txId)).rejects.toBeInstanceOf(ValidationError);
    // pero sí se puede "rehacer" deshaciendo el deshacer
    await revertAction(ctx.db, u, top.txId);
    expect((await entries()).find((x) => x.id === entryId)!.amount).toBe(-60000);
  });

  it('un borrado se restaura tal cual y lo creado se puede quitar', async () => {
    await as('ia: Claude', () => deleteEntry(ctx.db, u, entryId));
    expect(await entries()).toHaveLength(0);
    const del = (await listAudit(ctx.db, u, { limit: 3 })).actions[0];
    expect(del.entries[0].op).toBe('DELETE');
    expect(del.summary).toContain('Eliminó');
    await revertAction(ctx.db, u, del.txId);
    const back = (await entries())[0];
    expect(back.id).toBe(entryId);
    expect(back.concept).toBe('Cuerdas nuevas');
    expect(back.amount).toBe(-60000);
  });

  it('borrar una cuenta con sus movimientos (cascada) se deshace completo', async () => {
    await as('ia: Claude', async () => { await ctx.db.query('DELETE FROM accounts WHERE id=$1', [caja]); });
    const gone = await ctx.db.query('SELECT 1 FROM ledger_entries WHERE account_id=$1', [caja]);
    expect(gone.rowCount).toBe(0);
    const act = (await listAudit(ctx.db, u, { limit: 3 })).actions[0];
    expect(act.entries.map((e) => e.table).sort()).toEqual(['accounts', 'ledger_entries']);
    await revertAction(ctx.db, u, act.txId);
    expect((await entries()).map((x) => x.concept)).toEqual(['Cuerdas nuevas']);
  });

  it('el historial es por usuario y no se puede deshacer lo ajeno', async () => {
    const act = (await listAudit(ctx.db, u, { limit: 1 })).actions[0];
    expect((await listAudit(ctx.db, other)).actions).toHaveLength(0);
    await expect(revertAction(ctx.db, other, act.txId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('si los datos cambiaron después, avisa en vez de pisar', async () => {
    const id = await as('ia: Claude', () => addEntry(ctx.db, u, caja, { date: '2026-11-02', concept: 'Temporal', rawAmount: 1 }));
    await as('ia: Claude', () => deleteEntry(ctx.db, u, id));
    const del = (await listAudit(ctx.db, u, { limit: 1 })).actions[0];
    // alguien vuelve a crear la cuenta de la fila a mano y la borra: el id ya no encaja con la caja
    await ctx.db.query('DELETE FROM accounts WHERE id=$1', [caja]);
    await expect(revertAction(ctx.db, u, del.txId)).rejects.toBeInstanceOf(ValidationError);
  });
});
