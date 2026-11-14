import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, type Queryable } from '../../db/client';

export type AccountType = 'bank' | 'cash' | 'savings' | 'card' | 'cash_box' | 'fund' | 'debt' | 'receivable';

/** Cuentas con las que se mueve el día a día (el flujo de caja). */
export const LIQUID_TYPES: AccountType[] = ['bank', 'cash'];

export interface Account {
  id: string;
  type: AccountType;
  name: string;
  creditLimit: number | null;
  counterparty: string | null;
  alias: string | null;
  institution: string | null;
  openingBalance: number;
  isDefault: boolean;
  archived: boolean;
  inFlow: boolean;
  sort: number;
}

export interface LedgerEntry {
  id: string;
  date: string;
  concept: string;
  amount: number;
  tag: string | null;
  bucket: string | null;
  person: string | null;
  balance: number;
}

const mapAcc = (r: any): Account => ({
  id: r.id,
  type: r.type,
  name: r.name,
  creditLimit: r.credit_limit,
  counterparty: r.counterparty,
  alias: r.alias,
  institution: r.institution,
  openingBalance: r.opening_balance,
  isDefault: r.is_default,
  archived: r.archived,
  inFlow: r.in_flow,
  sort: r.sort,
});

export interface AccountInput {
  type: AccountType;
  name: string;
  creditLimit?: number | null;
  counterparty?: string | null;
  alias?: string | null;
  institution?: string | null;
  openingBalance?: number;
  isDefault?: boolean;
  /** Si aparece en el flujo de caja (solo cuentas propias: bancos y efectivo). */
  inFlow?: boolean;
  sort?: number;
}

export async function createAccount(db: Queryable, userId: string, input: AccountInput): Promise<Account> {
  if (input.type === 'card' && !input.creditLimit) throw new ValidationError('CARD_NEEDS_LIMIT');
  if (input.isDefault) await db.query('UPDATE accounts SET is_default=false WHERE user_id=$1', [userId]);
  // Una tarjeta nueva parte con todo su límite disponible (saldo = disponible; deuda = límite − saldo).
  const opening = input.openingBalance ?? (input.type === 'card' ? input.creditLimit ?? 0 : 0);
  const r = await db.query(
    `INSERT INTO accounts(user_id,type,name,credit_limit,counterparty,alias,institution,opening_balance,is_default,sort,in_flow)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id,name) DO UPDATE SET type=EXCLUDED.type, credit_limit=EXCLUDED.credit_limit,
       counterparty=EXCLUDED.counterparty, alias=COALESCE(EXCLUDED.alias, accounts.alias),
       institution=COALESCE(EXCLUDED.institution, accounts.institution) RETURNING *`,
    [
      userId, input.type, input.name, input.creditLimit ?? null, input.counterparty ?? null, input.alias ?? null,
      input.institution ?? null, opening, input.isDefault ?? false, input.sort ?? 0,
      input.inFlow ?? (input.type === 'bank' || input.type === 'cash'),
    ],
  );
  return mapAcc(r.rows[0]);
}

export async function updateAccount(
  db: Queryable,
  userId: string,
  accountId: string,
  patch: Partial<Pick<AccountInput, 'name' | 'alias' | 'institution' | 'creditLimit' | 'openingBalance' | 'isDefault' | 'sort' | 'inFlow'>> & { archived?: boolean },
): Promise<Account> {
  const cur = await getAccount(db, userId, accountId);
  if (patch.inFlow && cur.type !== 'bank' && cur.type !== 'cash') throw new ValidationError('FLOW_ONLY_OWN_ACCOUNTS', 'Solo los bancos y el efectivo pueden estar en el flujo');
  if (patch.isDefault) {
    if (cur.type !== 'bank' && cur.type !== 'cash') throw new ValidationError('DEFAULT_MUST_BE_LIQUID');
    await db.query('UPDATE accounts SET is_default=false WHERE user_id=$1', [userId]);
  }
  const r = await db.query(
    `UPDATE accounts SET name=$3, alias=$4, institution=$5, credit_limit=$6, opening_balance=$7, is_default=$8, sort=$9, archived=$10, in_flow=$11
     WHERE id=$1 AND user_id=$2 RETURNING *`,
    [
      accountId, userId,
      patch.name ?? cur.name,
      patch.alias === undefined ? cur.alias : patch.alias,
      patch.institution === undefined ? cur.institution : patch.institution,
      patch.creditLimit === undefined ? cur.creditLimit : patch.creditLimit,
      patch.openingBalance ?? cur.openingBalance,
      patch.isDefault ?? cur.isDefault,
      patch.sort ?? cur.sort,
      patch.archived ?? cur.archived,
      patch.inFlow ?? cur.inFlow,
    ],
  );
  return mapAcc(r.rows[0]);
}

/** Cuentas iniciales de un usuario nuevo (idempotente). GNB y Familiar son las cuentas del flujo; GNB es la predeterminada. */
export async function seedDefaultAccounts(db: Queryable, userId: string): Promise<void> {
  const defs: [AccountType, string, string | null, string | null, boolean, boolean, number][] = [
    ['bank', 'GNB', '0971185507', 'GNB', true, true, 1],
    ['bank', 'Familiar', '2946999', 'Banco Familiar', false, true, 2],
    ['cash', 'Efectivo', null, null, false, false, 3],
  ];
  for (const [type, name, alias, institution, isDefault, inFlow, sort] of defs) {
    await db.query(
      `INSERT INTO accounts(user_id,type,name,alias,institution,is_default,in_flow,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id,name) DO NOTHING`,
      [userId, type, name, alias, institution, isDefault, inFlow, sort],
    );
  }
  const buckets: [string, boolean, number][] = [['Ahorro', false, 1], ['Aguinaldo', true, 2], ['Vacaciones', true, 3], ['Emma', true, 4]];
  for (const [name, untouchable, sort] of buckets) {
    await db.query(
      'INSERT INTO savings_buckets(user_id,name,untouchable,sort) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,name) DO NOTHING',
      [userId, name, untouchable, sort],
    );
  }
}

export async function getAccount(db: Queryable, userId: string, accountId: string): Promise<Account> {
  const r = await db.query('SELECT * FROM accounts WHERE id=$1 AND user_id=$2', [accountId, userId]);
  if (!r.rowCount) throw new NotFoundError('cuenta');
  return mapAcc(r.rows[0]);
}

export async function accountIdByName(db: Queryable, userId: string, name: string): Promise<string | null> {
  const r = await db.query('SELECT id FROM accounts WHERE user_id=$1 AND lower(name)=lower($2)', [userId, name.trim()]);
  return r.rows[0]?.id ?? null;
}

export async function defaultAccountId(db: Queryable, userId: string): Promise<string | null> {
  const r = await db.query(
    `SELECT id FROM accounts WHERE user_id=$1 AND type IN ('bank','cash') AND NOT archived
     ORDER BY in_flow DESC, is_default DESC, sort, name LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.id ?? null;
}

export async function listAccounts(db: Queryable, userId: string): Promise<Account[]> {
  return (await db.query('SELECT * FROM accounts WHERE user_id=$1 ORDER BY sort, type, name', [userId])).rows.map(mapAcc);
}

export async function addEntry(
  db: Queryable,
  userId: string,
  accountId: string,
  input: { date: string; concept: string; rawAmount: string | number; tag?: string | null; bucket?: string | null; person?: string | null; importKey?: string },
): Promise<string> {
  await getAccount(db, userId, accountId);
  const r = await db.query(
    `INSERT INTO ledger_entries(account_id,date,concept,amount,tag,bucket,person,import_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [accountId, input.date, input.concept, parseAmount(input.rawAmount), input.tag ?? null, input.bucket ?? null, input.person?.trim() || null, input.importKey ?? null],
  );
  return r.rows[0].id;
}

export async function updateEntry(
  db: Queryable,
  userId: string,
  entryId: string,
  patch: Partial<{ date: string; concept: string; rawAmount: string | number; tag: string | null; bucket: string | null; person: string | null }>,
): Promise<void> {
  const cur = (await db.query(
    `SELECT e.* FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.id=$1 AND a.user_id=$2`,
    [entryId, userId],
  )).rows[0];
  if (!cur) throw new NotFoundError('movimiento de cuenta');
  await db.query('UPDATE ledger_entries SET date=$2, concept=$3, amount=$4, tag=$5, bucket=$6, person=$7 WHERE id=$1', [
    entryId,
    patch.date ?? cur.date,
    patch.concept ?? cur.concept,
    patch.rawAmount === undefined ? cur.amount : parseAmount(patch.rawAmount),
    patch.tag === undefined ? cur.tag : patch.tag,
    patch.bucket === undefined ? cur.bucket : patch.bucket,
    patch.person === undefined ? cur.person : patch.person?.trim() || null,
  ]);
}

/** Asigna un objetivo (colchón, vacaciones…) a todos los movimientos del ahorro que aún no tienen uno. */
export async function assignBucket(db: Queryable, userId: string, accountId: string, bucket: string): Promise<number> {
  await getAccount(db, userId, accountId);
  const r = await db.query('UPDATE ledger_entries SET bucket=$2 WHERE account_id=$1 AND bucket IS NULL', [accountId, bucket.trim()]);
  return r.rowCount ?? 0;
}

export async function deleteEntry(db: Queryable, userId: string, entryId: string): Promise<void> {
  const r = await db.query(
    `DELETE FROM ledger_entries e USING accounts a WHERE e.id=$1 AND a.id=e.account_id AND a.user_id=$2`,
    [entryId, userId],
  );
  if (!r.rowCount) throw new NotFoundError('movimiento de cuenta');
}

function owedOf(acc: Pick<Account, 'type' | 'creditLimit'>, balance: number): number {
  if (acc.type === 'card') return (acc.creditLimit ?? 0) - balance;
  if (acc.type === 'debt') return Math.max(0, -balance);
  // En una persona que me debe, el saldo es lo que me falta recuperar.
  if (acc.type === 'receivable') return Math.max(0, balance);
  return 0;
}

/** Saldo = saldo inicial + movimientos propios + flujo asignado a la cuenta + transferencias (hasta `asOf`). */
const BALANCE_SQL = `
  a.opening_balance
  + COALESCE((SELECT SUM(e.amount) FROM ledger_entries e WHERE e.account_id=a.id AND ($2::date IS NULL OR e.date <= $2)),0)
  + COALESCE((SELECT SUM(CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END) FROM transactions t
              WHERE t.account_id=a.id AND ($2::date IS NULL OR t.date <= $2)),0)
  + COALESCE((SELECT SUM(CASE WHEN x.to_account_id=a.id THEN x.amount ELSE -x.amount END) FROM transfers x
              WHERE (x.to_account_id=a.id OR x.from_account_id=a.id) AND ($2::date IS NULL OR x.date <= $2)),0)`;

export async function getLedger(
  db: Queryable,
  userId: string,
  accountId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ account: Account; entries: LedgerEntry[]; balance: number; owed: number }> {
  const account = await getAccount(db, userId, accountId);
  const r = await db.query(
    `SELECT * FROM (
       SELECT id, date, seq, concept, amount, tag, bucket, person,
              SUM(amount) OVER (ORDER BY date, seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
       FROM ledger_entries WHERE account_id=$1) x
     WHERE ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
     ORDER BY date, seq`,
    [accountId, range.from ?? null, range.to ?? null],
  );
  const total = (await db.query(`SELECT ${BALANCE_SQL} AS b FROM accounts a WHERE a.id=$1`, [accountId, null])).rows[0].b;
  return {
    account,
    entries: r.rows.map((e: any) => ({ id: e.id, date: e.date, concept: e.concept, amount: e.amount, tag: e.tag, bucket: e.bucket, person: e.person, balance: e.balance })),
    balance: total,
    owed: owedOf(account, total),
  };
}

export interface BucketBalance { bucket: string; balance: number }

export interface Balance {
  accountId: string;
  type: AccountType;
  name: string;
  alias: string | null;
  institution: string | null;
  counterparty: string | null;
  isDefault: boolean;
  archived: boolean;
  inFlow: boolean;
  balance: number;
  owed: number;
  creditLimit: number | null;
  openingBalance: number;
  /** Solo ahorros: saldo por objetivo. */
  buckets: BucketBalance[];
  /** Solo ahorros: lo prestado desde el ahorro que aún no se repuso. */
  loansPending: number;
  /** Solo ahorros: monto de los objetivos intocables (Aguinaldo, Vacaciones…) y lo que queda libre. */
  untouchable: number;
  touchable: number;
}

export async function listBalances(db: Queryable, userId: string, opts: { asOf?: string } = {}): Promise<Balance[]> {
  const asOf = opts.asOf ?? null;
  const r = await db.query(
    `SELECT a.*, (${BALANCE_SQL}) AS balance FROM accounts a WHERE a.user_id=$1 ORDER BY a.sort, a.type, a.name`,
    [userId, asOf],
  );
  const bk = await db.query(
    `SELECT account_id, COALESCE(bucket,'Sin asignar') AS bucket, SUM(amt) AS balance FROM (
       SELECT e.account_id, e.bucket, e.amount AS amt FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
         WHERE a.user_id=$1 AND a.type='savings' AND ($2::date IS NULL OR e.date <= $2)
       UNION ALL
       SELECT x.to_account_id, x.bucket, x.amount FROM transfers x JOIN accounts a ON a.id=x.to_account_id
         WHERE a.user_id=$1 AND a.type='savings' AND ($2::date IS NULL OR x.date <= $2)
       UNION ALL
       SELECT x.from_account_id, x.bucket, -x.amount FROM transfers x JOIN accounts a ON a.id=x.from_account_id
         WHERE a.user_id=$1 AND a.type='savings' AND ($2::date IS NULL OR x.date <= $2)
     ) u GROUP BY 1, 2 HAVING SUM(amt) <> 0 ORDER BY 2`,
    [userId, asOf],
  );
  const loans = await db.query(
    `SELECT a.id,
       COALESCE((SELECT SUM(x.amount) FROM transfers x WHERE x.from_account_id=a.id AND x.kind='loan' AND ($2::date IS NULL OR x.date <= $2)),0)
     - COALESCE((SELECT SUM(x.amount) FROM transfers x WHERE x.to_account_id=a.id AND x.kind='repayment' AND ($2::date IS NULL OR x.date <= $2)),0)
     + COALESCE((SELECT SUM(CASE WHEN e.tag='temp_withdrawal' OR e.tag='return' THEN -e.amount ELSE 0 END) FROM ledger_entries e
                 WHERE e.account_id=a.id AND ($2::date IS NULL OR e.date <= $2)),0) AS pending
     FROM accounts a WHERE a.user_id=$1 AND a.type='savings'`,
    [userId, asOf],
  );
  const locked = new Set<string>((await db.query('SELECT name FROM savings_buckets WHERE user_id=$1 AND untouchable', [userId])).rows.map((x: any) => x.name));
  const pend = new Map<string, number>(loans.rows.map((x: any) => [x.id, Math.max(0, x.pending)]));
  return r.rows.map((x: any) => {
    const acc = mapAcc(x);
    const buckets = bk.rows.filter((b: any) => b.account_id === acc.id).map((b: any) => ({ bucket: b.bucket as string, balance: b.balance as number }));
    const untouchable = buckets.filter((b) => locked.has(b.bucket)).reduce((q, b) => q + b.balance, 0);
    return {
      accountId: acc.id, type: acc.type, name: acc.name, alias: acc.alias, institution: acc.institution, counterparty: acc.counterparty,
      isDefault: acc.isDefault, archived: acc.archived, inFlow: acc.inFlow, balance: x.balance, owed: owedOf(acc, x.balance),
      creditLimit: acc.creditLimit, openingBalance: acc.openingBalance,
      buckets,
      loansPending: pend.get(acc.id) ?? 0,
      untouchable, touchable: acc.type === 'savings' ? x.balance - untouchable : 0,
    };
  });
}

export interface StatementRow {
  key: string;
  date: string;
  source: 'opening' | 'entry' | 'flow' | 'transfer';
  id: string | null;
  concept: string;
  detail: string | null;
  delta: number;
  balance: number;
  bucket: string | null;
}

/** Relatorio de una cuenta: saldo inicial del rango, todos sus movimientos (propios, flujo y transferencias) y saldo final. */
export async function accountStatement(
  db: Queryable,
  userId: string,
  accountId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ account: Account; opening: number; closing: number; totalIn: number; totalOut: number; rows: StatementRow[] }> {
  const account = await getAccount(db, userId, accountId);
  const r = await db.query(
    `SELECT * FROM (
       SELECT e.date, 1 AS rank, e.seq, 'entry' AS source, e.id, e.concept, e.tag AS detail, e.amount AS delta, e.bucket
         FROM ledger_entries e WHERE e.account_id=$1
       UNION ALL
       SELECT t.date, 2, t.seq, 'flow', t.id, t.item, c.name, CASE WHEN t.kind='income' THEN t.amount ELSE -t.amount END, NULL
         FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.account_id=$1
       UNION ALL
       SELECT x.date, 3, x.seq, 'transfer', x.id,
              CASE WHEN x.to_account_id=$1 THEN 'Desde ' || f.name ELSE 'Hacia ' || o.name END,
              CASE x.kind WHEN 'loan' THEN 'préstamo' WHEN 'repayment' THEN 'devolución' ELSE x.note END,
              CASE WHEN x.to_account_id=$1 THEN x.amount ELSE -x.amount END, x.bucket
         FROM transfers x JOIN accounts f ON f.id=x.from_account_id JOIN accounts o ON o.id=x.to_account_id
         WHERE x.from_account_id=$1 OR x.to_account_id=$1
     ) u ORDER BY date, rank, seq`,
    [accountId],
  );
  let bal = account.openingBalance;
  const before: StatementRow[] = [];
  const rows: StatementRow[] = [];
  for (const x of r.rows) {
    bal += x.delta;
    const row: StatementRow = {
      key: `${x.source}:${x.id}`, date: x.date, source: x.source, id: x.id, concept: x.concept, detail: x.detail,
      delta: x.delta, balance: bal, bucket: x.bucket,
    };
    if (range.from && x.date < range.from) before.push(row);
    else if (!range.to || x.date <= range.to) rows.push(row);
  }
  const opening = before.length ? before[before.length - 1].balance : account.openingBalance;
  const closing = rows.length ? rows[rows.length - 1].balance : opening;
  return {
    account, opening, closing,
    totalIn: rows.filter((x) => x.delta > 0).reduce((s, x) => s + x.delta, 0),
    totalOut: -rows.filter((x) => x.delta < 0).reduce((s, x) => s + x.delta, 0),
    rows,
  };
}

/** Retiros temporales del ahorro aún por reponer: retiros (tag temp_withdrawal) menos devoluciones (tag return). */
export async function pendingTempWithdrawals(db: Queryable, userId: string, accountId: string): Promise<number> {
  await getAccount(db, userId, accountId);
  const r = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN tag='temp_withdrawal' THEN -amount WHEN tag='return' THEN -amount ELSE 0 END),0) AS p
     FROM ledger_entries WHERE account_id=$1`,
    [accountId],
  );
  return r.rows[0].p;
}

export type SavingsMoveKind = 'deposit' | 'withdrawal' | 'loan' | 'return';

export interface SavingsMove {
  key: string;
  source: 'entry' | 'transfer';
  id: string;
  date: string;
  kind: SavingsMoveKind;
  concept: string;
  /** Con signo respecto del ahorro: lo que entra suma, lo que sale resta. */
  amount: number;
  bucket: string | null;
  /** Solo préstamos y devoluciones: a quién se le prestó. null = préstamo normal. */
  person: string | null;
  balance: number;
}

export interface SavingsPerson {
  /** null = préstamos normales (sin persona). */
  person: string | null;
  lent: number;
  returned: number;
  pending: number;
}

export interface SavingsOverview {
  /** Todos los movimientos del ahorro, del más viejo al más nuevo (la pantalla los invierte). */
  moves: SavingsMove[];
  people: SavingsPerson[];
  totals: { deposits: number; withdrawals: number; lent: number; returned: number; pending: number };
}

/**
 * Lo que pasó en el ahorro, separado en depósitos, extracciones (sacaste de tu ahorro), préstamos
 * (sale pero hay que devolver) y devoluciones, con el pendiente por persona.
 */
export async function savingsOverview(db: Queryable, userId: string, accountId: string): Promise<SavingsOverview> {
  await getAccount(db, userId, accountId);
  const r = await db.query(
    `SELECT * FROM (
       SELECT e.date, e.seq, 'entry' AS source, e.id, e.concept, e.amount, e.tag, e.bucket, e.person, NULL AS kind, NULL AS other
         FROM ledger_entries e WHERE e.account_id=$1
       UNION ALL
       SELECT x.date, x.seq, 'transfer', x.id,
              COALESCE(NULLIF(x.note,''), CASE x.kind WHEN 'loan' THEN 'Préstamo a ' || o.name WHEN 'repayment' THEN 'Devolución de ' || f.name
                WHEN 'transfer' THEN CASE WHEN x.to_account_id=$1 THEN 'Desde ' || f.name ELSE 'Hacia ' || o.name END END),
              CASE WHEN x.to_account_id=$1 THEN x.amount ELSE -x.amount END, NULL, x.bucket, NULL, x.kind,
              CASE WHEN x.to_account_id=$1 THEN f.name ELSE o.name END
         FROM transfers x JOIN accounts f ON f.id=x.from_account_id JOIN accounts o ON o.id=x.to_account_id
         WHERE x.from_account_id=$1 OR x.to_account_id=$1
     ) u ORDER BY date, seq`,
    [accountId],
  );
  const acc = (await db.query('SELECT opening_balance FROM accounts WHERE id=$1', [accountId])).rows[0];
  let bal = Number(acc.opening_balance);
  const moves: SavingsMove[] = [];
  for (const x of r.rows) {
    let kind: SavingsMoveKind;
    let person: string | null = null;
    if (x.source === 'entry') {
      kind = x.tag === 'temp_withdrawal' ? 'loan' : x.tag === 'return' ? 'return' : x.amount >= 0 ? 'deposit' : 'withdrawal';
      if (kind === 'loan' || kind === 'return') person = x.person;
    } else if (x.kind === 'loan') {
      kind = 'loan';
      person = x.other;
    } else if (x.kind === 'repayment') {
      kind = 'return';
      person = x.other;
    } else kind = x.amount >= 0 ? 'deposit' : 'withdrawal';
    bal += Number(x.amount);
    moves.push({ key: `${x.source}:${x.id}`, source: x.source, id: x.id, date: x.date, kind, concept: x.concept, amount: Number(x.amount), bucket: x.bucket, person, balance: bal });
  }
  const byPerson = new Map<string | null, SavingsPerson>();
  for (const m of moves) {
    if (m.kind !== 'loan' && m.kind !== 'return') continue;
    const p = byPerson.get(m.person) ?? { person: m.person, lent: 0, returned: 0, pending: 0 };
    if (m.kind === 'loan') p.lent += -m.amount;
    else p.returned += m.amount;
    p.pending = p.lent - p.returned;
    byPerson.set(m.person, p);
  }
  const people = [...byPerson.values()].sort((a, b) => b.pending - a.pending || String(a.person ?? '~').localeCompare(String(b.person ?? '~')));
  const sum = (k: SavingsMoveKind) => moves.filter((m) => m.kind === k).reduce((s, m) => s + Math.abs(m.amount), 0);
  const lent = sum('loan');
  const returned = sum('return');
  return { moves, people, totals: { deposits: sum('deposit'), withdrawals: sum('withdrawal'), lent, returned, pending: lent - returned } };
}
