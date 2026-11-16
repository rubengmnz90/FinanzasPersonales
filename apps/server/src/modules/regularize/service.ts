import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Queryable } from '../../db/client';
import { getAccount } from '../ledgers/service';
import { createTransfer, type Transfer } from '../transfers/service';

export interface PendingEntry {
  id: string;
  date: string;
  concept: string;
  /** Monto de la compra (positivo). */
  amount: number;
  /** Cuánto de la compra ya se regularizó. */
  regularized: number;
  /** Lo que falta regularizar de esta compra. */
  pending: number;
  card: string;
  cardId: string;
  category: string | null;
  group: string | null;
  /** Cuenta anotada para pagarla, si la hay. */
  payFrom: string | null;
}

export interface PendingRegularization {
  /** Total que falta regularizar. */
  total: number;
  count: number;
  entries: PendingEntry[];
  /** Cuánto falta por tarjeta. */
  byCard: { card: string; total: number; count: number }[];
}

/** Compras de tarjeta marcadas "por regularizar": lo que se gastó con la tarjeta y aún no se pagó desde una cuenta (parcial o total). */
export async function listPendingRegularization(db: Queryable, userId: string): Promise<PendingRegularization> {
  const r = await db.query(
    `SELECT * FROM (
       SELECT e.id, e.date::text AS date, e.seq, e.concept, (-e.amount)::bigint AS amount,
              COALESCE((SELECT SUM(g.amount) FROM entry_regularizations g WHERE g.entry_id=e.id), 0)::bigint AS regularized,
              a.name AS card, a.id AS card_id, c.name AS category, e.group_key, pf.name AS pay_from
         FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
         LEFT JOIN categories c ON c.id=e.category_id LEFT JOIN accounts pf ON pf.id=e.pay_from_account_id
        WHERE a.user_id=$1 AND e.needs_regularize AND e.amount < 0) x
      WHERE amount - regularized > 0
      ORDER BY date, seq`,
    [userId],
  );
  const entries: PendingEntry[] = r.rows.map((x: any) => ({
    id: x.id, date: x.date, concept: x.concept, amount: Number(x.amount), regularized: Number(x.regularized),
    pending: Number(x.amount) - Number(x.regularized), card: x.card, cardId: x.card_id,
    category: x.category, group: x.group_key, payFrom: x.pay_from,
  }));
  const byCard = new Map<string, { card: string; total: number; count: number }>();
  for (const e of entries) {
    const c = byCard.get(e.cardId) ?? { card: e.card, total: 0, count: 0 };
    c.total += e.pending;
    c.count += 1;
    byCard.set(e.cardId, c);
  }
  return { total: entries.reduce((s, e) => s + e.pending, 0), count: entries.length, entries, byCard: [...byCard.values()] };
}

export interface RegularizeResult {
  transfers: Transfer[];
  /** Cuánto se aplicó a cada compra y cuánto le queda. */
  applied: { id: string; concept: string; applied: number; remaining: number }[];
  total: number;
  /** Lo que sigue pendiente después de regularizar. */
  stillPending: number;
}

/**
 * Regulariza compras de tarjeta pendientes pagando con una cuenta. Con `amount` se paga ese monto (o menos que lo pendiente)
 * repartiéndolo de la compra más vieja a la más nueva; la última puede quedar a medias. Sin `amount` se paga todo lo
 * pendiente. Con `ids` solo se tocan esas compras. Por cada tarjeta se crea UNA transferencia (cuenta → tarjeta) y cada
 * abono queda ligado a su compra. Sin `fromAccountId` se usa la cuenta anotada (payFrom) en cada compra.
 */
export async function regularize(
  db: Queryable,
  userId: string,
  input: { ids?: string[]; fromAccountId?: string | null; amount?: string | number | null; date: string },
): Promise<RegularizeResult> {
  const pending = await listPendingRegularization(db, userId);
  let chosen = pending.entries;
  if (input.ids?.length) {
    chosen = pending.entries.filter((e) => input.ids!.includes(e.id));
    const missing = input.ids.filter((id) => !chosen.some((e) => e.id === id));
    if (missing.length) throw new NotFoundError(`compra por regularizar ${missing[0]} (usa pending_regularization)`);
  }
  if (!chosen.length) throw new ValidationError('NOTHING_TO_REGULARIZE', 'No hay compras por regularizar');
  const available = chosen.reduce((s, e) => s + e.pending, 0);

  let budget = available;
  if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
    budget = parseAmount(input.amount);
    if (!(budget > 0)) throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', 'El monto debe ser mayor a cero');
    if (budget > available) throw new ValidationError('AMOUNT_EXCEEDS_PENDING', `Solo hay ${available} por regularizar; pediste ${budget}`);
  }

  // Reparto: de la más vieja a la más nueva hasta agotar el monto.
  const shares: { e: PendingEntry; take: number }[] = [];
  let left = budget;
  for (const e of chosen) {
    if (left <= 0) break;
    const take = Math.min(left, e.pending);
    shares.push({ e, take });
    left -= take;
  }

  // Cuenta de pago de cada compra.
  const payIds = new Map<string, string>();
  if (input.fromAccountId) await getAccount(db, userId, input.fromAccountId);
  else {
    const names = [...new Set(shares.map((s) => s.e.payFrom))];
    if (names.includes(null)) throw new ValidationError('PAY_ACCOUNT_REQUIRED', 'Algunas compras no tienen cuenta de pago anotada: indica con qué cuenta regularizas');
    for (const n of names as string[]) {
      const a = (await db.query('SELECT id FROM accounts WHERE user_id=$1 AND name=$2', [userId, n])).rows[0];
      if (!a) throw new NotFoundError(`cuenta "${n}"`);
      payIds.set(n, a.id);
    }
  }
  const groups = new Map<string, { from: string; cardId: string; shares: typeof shares }>();
  for (const s of shares) {
    const from = input.fromAccountId ?? payIds.get(s.e.payFrom!)!;
    const k = `${from}|${s.e.cardId}`;
    const g = groups.get(k) ?? { from, cardId: s.e.cardId, shares: [] };
    g.shares.push(s);
    groups.set(k, g);
  }

  const transfers: Transfer[] = [];
  for (const g of groups.values()) {
    const total = g.shares.reduce((a, s) => a + s.take, 0);
    const t = await createTransfer(db, userId, {
      date: input.date, fromAccountId: g.from, toAccountId: g.cardId, rawAmount: total, kind: 'transfer',
      note: `Regulariza: ${g.shares.map((s) => s.e.concept).join(', ')}`.slice(0, 200),
    });
    transfers.push(t);
    for (const s of g.shares) {
      await db.query('INSERT INTO entry_regularizations(entry_id,transfer_id,amount,date) VALUES ($1,$2,$3,$4)', [s.e.id, t.id, s.take, input.date]);
    }
  }
  return {
    transfers,
    applied: shares.map((s) => ({ id: s.e.id, concept: s.e.concept, applied: s.take, remaining: s.e.pending - s.take })),
    total: budget,
    stillPending: pending.total - budget,
  };
}
