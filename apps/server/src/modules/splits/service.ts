import { computeSplit, type SplitResult } from '@finanzas/shared';
import { NotFoundError, withTx, type Db, type Queryable } from '../../db/client';

export interface SplitItem {
  id: string;
  label: string;
  total: number;
  discountPct: number;
  shares: Record<string, number>;
}

export interface SplitView {
  id: string;
  name: string;
  date: string;
  participants: string[];
  items: SplitItem[];
  result: SplitResult;
  shareErrors: { itemId: string; sum: number }[]; // filas cuyos % no suman 1
}

async function own(db: Queryable, userId: string, id: string) {
  const r = await db.query('SELECT * FROM splits WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFoundError('reparto');
  return r.rows[0];
}

export async function listSplits(db: Queryable, userId: string) {
  return (await db.query('SELECT id,name,date FROM splits WHERE user_id=$1 ORDER BY date DESC, name', [userId])).rows;
}

export async function createSplit(
  db: Queryable,
  userId: string,
  input: { name: string; date?: string; participants: string[]; importKey?: string },
): Promise<string> {
  const r = await db.query(
    `INSERT INTO splits(user_id,name,date,participants,import_key) VALUES ($1,$2,COALESCE($3::date,current_date),$4,$5) RETURNING id`,
    [userId, input.name, input.date ?? null, JSON.stringify(input.participants), input.importKey ?? null],
  );
  return r.rows[0].id;
}

export async function addSplitItem(
  db: Queryable,
  userId: string,
  splitId: string,
  input: { label?: string; total: number; discountPct?: number; shares: Record<string, number> },
): Promise<string> {
  await own(db, userId, splitId);
  const sort = (await db.query('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM split_items WHERE split_id=$1', [splitId])).rows[0].s;
  const r = await db.query(
    `INSERT INTO split_items(split_id,sort,label,total,discount_pct,shares) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [splitId, sort, input.label ?? '', input.total, input.discountPct ?? 0, JSON.stringify(input.shares)],
  );
  return r.rows[0].id;
}

export async function updateSplitItem(
  db: Queryable,
  userId: string,
  itemId: string,
  patch: Partial<{ label: string; total: number; discountPct: number; shares: Record<string, number> }>,
): Promise<void> {
  const cur = (await db.query(
    `SELECT i.* FROM split_items i JOIN splits s ON s.id=i.split_id WHERE i.id=$1 AND s.user_id=$2`,
    [itemId, userId],
  )).rows[0];
  if (!cur) throw new NotFoundError('ítem del reparto');
  await db.query('UPDATE split_items SET label=$2,total=$3,discount_pct=$4,shares=$5 WHERE id=$1', [
    itemId,
    patch.label ?? cur.label,
    patch.total ?? cur.total,
    patch.discountPct ?? cur.discount_pct,
    JSON.stringify(patch.shares ?? cur.shares),
  ]);
}

export async function deleteSplitItem(db: Queryable, userId: string, itemId: string): Promise<void> {
  const r = await db.query(
    `DELETE FROM split_items i USING splits s WHERE i.id=$1 AND s.id=i.split_id AND s.user_id=$2`,
    [itemId, userId],
  );
  if (!r.rowCount) throw new NotFoundError('ítem del reparto');
}

export async function deleteSplit(db: Db, userId: string, id: string): Promise<void> {
  await own(db, userId, id);
  await withTx(db, async (tx) => {
    await tx.query('DELETE FROM splits WHERE id=$1', [id]);
  });
}

export async function getSplit(db: Queryable, userId: string, id: string): Promise<SplitView> {
  const s = await own(db, userId, id);
  const rows = (await db.query('SELECT * FROM split_items WHERE split_id=$1 ORDER BY sort', [id])).rows;
  const items: SplitItem[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    total: r.total,
    discountPct: r.discount_pct,
    shares: r.shares,
  }));
  const participants: string[] = s.participants;
  const result = computeSplit({ people: participants, items });
  const shareErrors = items
    .map((i) => ({ itemId: i.id, sum: Object.values(i.shares).reduce((a, b) => a + b, 0) }))
    .filter((e) => Math.abs(e.sum - 1) > 1e-9);
  return { id: s.id, name: s.name, date: s.date, participants, items, result, shareErrors };
}
