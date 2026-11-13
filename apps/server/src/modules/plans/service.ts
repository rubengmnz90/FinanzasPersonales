import { parseAmount } from '@finanzas/shared';
import { NotFoundError, ValidationError, withTx, type Db, type Queryable } from '../../db/client';

export interface Plan {
  id: string;
  year: number;
  name: string;
  archived: boolean;
}

export interface PlanItemView {
  id: string;
  kind: 'income' | 'expense';
  concept: string;
  auto: 'planned_expenses' | null;
  cells: number[]; // 12 meses (filas automáticas: valor manual si existe, si no el calculado)
  exprs: (string | null)[];
  overrides: boolean[]; // solo filas automáticas: true = valor manual que pisa al calculado
  computed: number[]; // solo filas automáticas: suma de gastos puntuales
}

export interface PlanPeriodView {
  id: string;
  label: string;
  dayOfMonth: number;
  items: PlanItemView[];
  totals: { expense: number[]; income: number[]; net: number[] };
}

export interface PlanView {
  plan: Plan;
  periods: PlanPeriodView[];
  grand: { expense: number; income: number; net: number };
  grandByMonth: { expense: number[]; income: number[]; net: number[] };
}

const zeros = () => Array<number>(12).fill(0);
const mapPlan = (r: any): Plan => ({ id: r.id, year: r.year, name: r.name, archived: r.archived });

async function ownPlan(db: Queryable, userId: string, planId: string): Promise<Plan> {
  const r = await db.query('SELECT * FROM plans WHERE id=$1 AND user_id=$2', [planId, userId]);
  if (!r.rowCount) throw new NotFoundError('plan');
  return mapPlan(r.rows[0]);
}

async function ownItem(db: Queryable, userId: string, itemId: string) {
  const r = await db.query(
    `SELECT i.* FROM plan_items i JOIN plans p ON p.id=i.plan_id WHERE i.id=$1 AND p.user_id=$2`,
    [itemId, userId],
  );
  if (!r.rowCount) throw new NotFoundError('fila del plan');
  return r.rows[0];
}

export async function listPlans(db: Queryable, userId: string, year?: number): Promise<Plan[]> {
  const r = await db.query(
    `SELECT * FROM plans WHERE user_id=$1 AND ($2::int IS NULL OR year=$2) AND NOT archived ORDER BY year DESC, name`,
    [userId, year ?? null],
  );
  return r.rows.map(mapPlan);
}

export async function createPlan(
  db: Db,
  userId: string,
  input: { year: number; name: string; periods: { label: string; dayOfMonth: number }[]; importKey?: string },
): Promise<Plan> {
  if (!input.periods.length) throw new ValidationError('NO_PERIODS', 'Un plan necesita al menos un cobro');
  return withTx(db, async (tx) => {
    const r = await tx.query(
      'INSERT INTO plans(user_id,year,name,import_key) VALUES ($1,$2,$3,$4) RETURNING *',
      [userId, input.year, input.name, input.importKey ?? null],
    );
    const plan = mapPlan(r.rows[0]);
    let sort = 0;
    for (const p of input.periods) {
      await tx.query('INSERT INTO plan_periods(plan_id,label,day_of_month,sort) VALUES ($1,$2,$3,$4)', [
        plan.id,
        p.label,
        p.dayOfMonth,
        sort++,
      ]);
    }
    return plan;
  });
}

export async function addItem(
  db: Queryable,
  userId: string,
  planId: string,
  input: { periodId: string; kind: 'income' | 'expense'; concept: string; autoSource?: 'planned_expenses' | null },
): Promise<string> {
  await ownPlan(db, userId, planId);
  const per = await db.query('SELECT 1 FROM plan_periods WHERE id=$1 AND plan_id=$2', [input.periodId, planId]);
  if (!per.rowCount) throw new NotFoundError('cobro');
  const sort = (await db.query('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM plan_items WHERE period_id=$1 AND kind=$2', [
    input.periodId,
    input.kind,
  ])).rows[0].s;
  const r = await db.query(
    'INSERT INTO plan_items(plan_id,period_id,kind,concept,sort,auto_source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [planId, input.periodId, input.kind, input.concept, sort, input.autoSource ?? null],
  );
  const id = r.rows[0].id;
  await db.query('INSERT INTO plan_cells(item_id,month) SELECT $1, generate_series(1,12)', [id]);
  return id;
}

export async function renameItem(db: Queryable, userId: string, itemId: string, concept: string): Promise<void> {
  await ownItem(db, userId, itemId);
  await db.query('UPDATE plan_items SET concept=$2 WHERE id=$1', [itemId, concept]);
}

export async function removeItem(db: Queryable, userId: string, itemId: string): Promise<void> {
  await ownItem(db, userId, itemId);
  await db.query('DELETE FROM plan_items WHERE id=$1', [itemId]);
}

export async function setCell(
  db: Queryable,
  userId: string,
  itemId: string,
  month: number,
  rawInput: string | number,
): Promise<number> {
  const item = await ownItem(db, userId, itemId);
  if (month < 1 || month > 12) throw new ValidationError('BAD_MONTH');
  const amount = parseAmount(rawInput);
  const expr = typeof rawInput === 'string' && /[=+\-*/()]/.test(rawInput.trim().replace(/^-/, '')) ? rawInput.trim() : null;
  // En filas automáticas, escribir una celda crea un valor manual que pisa al calculado.
  await db.query('UPDATE plan_cells SET amount=$3, amount_expr=$4, is_override=$5 WHERE item_id=$1 AND month=$2', [
    itemId,
    month,
    amount,
    expr,
    !!item.auto_source,
  ]);
  return amount;
}

/** Quita el valor manual de una celda de fila automática y vuelve al valor calculado. */
export async function clearOverride(db: Queryable, userId: string, itemId: string, month: number): Promise<void> {
  const item = await ownItem(db, userId, itemId);
  if (!item.auto_source) throw new ValidationError('NOT_AUTO_ITEM');
  await db.query('UPDATE plan_cells SET amount=0, amount_expr=NULL, is_override=false WHERE item_id=$1 AND month=$2', [
    itemId,
    month,
  ]);
}

/** Copia el valor de `fromMonth` a los meses siguientes de la misma fila. */
export async function fillRight(db: Queryable, userId: string, itemId: string, fromMonth: number): Promise<void> {
  const item = await ownItem(db, userId, itemId);
  if (item.auto_source) throw new ValidationError('AUTO_ITEM');
  await db.query(
    `UPDATE plan_cells c SET amount=s.amount, amount_expr=s.amount_expr
     FROM plan_cells s WHERE s.item_id=$1 AND s.month=$2 AND c.item_id=$1 AND c.month > $2`,
    [itemId, fromMonth],
  );
}

export async function applyAdjust(
  db: Queryable,
  userId: string,
  planId: string,
  input: { itemIds: string[]; months: number[]; pct?: number; delta?: number },
): Promise<PlanView> {
  await ownPlan(db, userId, planId);
  if (input.pct === undefined && input.delta === undefined) throw new ValidationError('NO_ADJUST');
  await db.query(
    `UPDATE plan_cells c SET amount = GREATEST(0, ROUND(c.amount * (1 + COALESCE($4::numeric,0)/100) + COALESCE($5::numeric,0))), amount_expr = NULL
     FROM plan_items i
     WHERE c.item_id = i.id AND i.plan_id=$1 AND i.auto_source IS NULL
       AND i.id = ANY($2::uuid[]) AND c.month = ANY($3::int[])`,
    [planId, input.itemIds, input.months, input.pct ?? null, input.delta ?? null],
  );
  return getPlanView(db, userId, planId);
}

export async function getPlanView(db: Queryable, userId: string, planId: string): Promise<PlanView> {
  const plan = await ownPlan(db, userId, planId);
  const periods = (await db.query('SELECT * FROM plan_periods WHERE plan_id=$1 ORDER BY sort', [planId])).rows;
  const items = (await db.query('SELECT * FROM plan_items WHERE plan_id=$1 ORDER BY kind DESC, sort', [planId])).rows;
  const cells = (await db.query(
    `SELECT c.* FROM plan_cells c JOIN plan_items i ON i.id=c.item_id WHERE i.plan_id=$1`,
    [planId],
  )).rows;
  const auto = (await db.query(
    `SELECT period_label, EXTRACT(MONTH FROM due_date)::int AS m, SUM(amount)::bigint AS s
     FROM planned_expenses WHERE user_id=$1 AND EXTRACT(YEAR FROM due_date)=$2
     GROUP BY period_label, m`,
    [userId, plan.year],
  )).rows;

  const cellMap = new Map<string, { amount: number; expr: string | null; override: boolean }>();
  for (const c of cells) cellMap.set(`${c.item_id}:${c.month}`, { amount: c.amount, expr: c.amount_expr, override: c.is_override });

  const out: PlanPeriodView[] = periods.map((p) => {
    const pItems: PlanItemView[] = items
      .filter((i) => i.period_id === p.id)
      .map((i) => {
        const arr = zeros();
        const computed = zeros();
        const overrides: boolean[] = Array(12).fill(false);
        const exprs: (string | null)[] = Array(12).fill(null);
        for (let m = 1; m <= 12; m++) {
          const c = cellMap.get(`${i.id}:${m}`);
          if (i.auto_source === 'planned_expenses') {
            computed[m - 1] = auto.find((a) => a.period_label === p.label && a.m === m)?.s ?? 0;
            overrides[m - 1] = !!c?.override;
            arr[m - 1] = c?.override ? c.amount : computed[m - 1];
            exprs[m - 1] = c?.override ? (c.expr ?? null) : null;
          } else {
            arr[m - 1] = c?.amount ?? 0;
            exprs[m - 1] = c?.expr ?? null;
          }
        }
        return { id: i.id, kind: i.kind, concept: i.concept, auto: i.auto_source, cells: arr, exprs, overrides, computed };
      });
    const expense = zeros();
    const income = zeros();
    for (const it of pItems) for (let m = 0; m < 12; m++) (it.kind === 'expense' ? expense : income)[m] += it.cells[m];
    return {
      id: p.id,
      label: p.label,
      dayOfMonth: p.day_of_month,
      items: pItems,
      totals: { expense, income, net: income.map((v, m) => v - expense[m]) },
    };
  });

  const gE = zeros();
  const gI = zeros();
  for (const p of out) for (let m = 0; m < 12; m++) { gE[m] += p.totals.expense[m]; gI[m] += p.totals.income[m]; }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    plan,
    periods: out,
    grand: { expense: sum(gE), income: sum(gI), net: sum(gI) - sum(gE) },
    grandByMonth: { expense: gE, income: gI, net: gI.map((v, m) => v - gE[m]) },
  };
}

export async function clonePlan(
  db: Db,
  userId: string,
  planId: string,
  input: { name: string; year?: number },
): Promise<Plan> {
  const src = await ownPlan(db, userId, planId);
  return withTx(db, async (tx) => {
    const np = mapPlan(
      (await tx.query('INSERT INTO plans(user_id,year,name) VALUES ($1,$2,$3) RETURNING *', [
        userId,
        input.year ?? src.year,
        input.name,
      ])).rows[0],
    );
    const pmap = new Map<string, string>();
    for (const p of (await tx.query('SELECT * FROM plan_periods WHERE plan_id=$1 ORDER BY sort', [planId])).rows) {
      const r = await tx.query(
        'INSERT INTO plan_periods(plan_id,label,day_of_month,sort) VALUES ($1,$2,$3,$4) RETURNING id',
        [np.id, p.label, p.day_of_month, p.sort],
      );
      pmap.set(p.id, r.rows[0].id);
    }
    for (const i of (await tx.query('SELECT * FROM plan_items WHERE plan_id=$1', [planId])).rows) {
      const r = await tx.query(
        'INSERT INTO plan_items(plan_id,period_id,kind,concept,sort,auto_source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [np.id, pmap.get(i.period_id), i.kind, i.concept, i.sort, i.auto_source],
      );
      await tx.query(
        `INSERT INTO plan_cells(item_id,month,amount,amount_expr,is_override)
         SELECT $2, month, amount, amount_expr, is_override FROM plan_cells WHERE item_id=$1`,
        [i.id, r.rows[0].id],
      );
    }
    return np;
  });
}

export async function comparePlans(
  db: Queryable,
  userId: string,
  aId: string,
  bId: string,
): Promise<{ month: number; netA: number; netB: number; diff: number }[]> {
  const a = await getPlanView(db, userId, aId);
  const b = await getPlanView(db, userId, bId);
  return Array.from({ length: 12 }, (_, m) => ({
    month: m + 1,
    netA: a.grandByMonth.net[m],
    netB: b.grandByMonth.net[m],
    diff: b.grandByMonth.net[m] - a.grandByMonth.net[m],
  }));
}

export async function removePeriod(
  db: Db,
  userId: string,
  periodId: string,
  opts: { moveToPeriodId?: string; confirmDiscard?: boolean } = {},
): Promise<void> {
  const per = (await db.query(
    `SELECT pp.* FROM plan_periods pp JOIN plans p ON p.id=pp.plan_id WHERE pp.id=$1 AND p.user_id=$2`,
    [periodId, userId],
  )).rows[0];
  if (!per) throw new NotFoundError('cobro');
  const count = (await db.query('SELECT COUNT(*)::int AS n FROM plan_periods WHERE plan_id=$1', [per.plan_id])).rows[0].n;
  if (count <= 1) throw new ValidationError('LAST_PERIOD', 'Un plan necesita al menos un cobro');
  const hasData = (await db.query(
    `SELECT 1 FROM plan_items i JOIN plan_cells c ON c.item_id=i.id
     WHERE i.period_id=$1 AND c.amount <> 0 LIMIT 1`,
    [periodId],
  )).rowCount! > 0;
  if (hasData && !opts.moveToPeriodId && !opts.confirmDiscard) {
    throw new ValidationError('PERIOD_HAS_DATA', 'El cobro tiene montos: muévelos o confirma descartarlos');
  }
  await withTx(db, async (tx) => {
    if (opts.moveToPeriodId) {
      const dest = await tx.query('SELECT 1 FROM plan_periods WHERE id=$1 AND plan_id=$2', [opts.moveToPeriodId, per.plan_id]);
      if (!dest.rowCount) throw new NotFoundError('cobro destino');
      await tx.query('UPDATE plan_items SET period_id=$2 WHERE period_id=$1', [periodId, opts.moveToPeriodId]);
    }
    await tx.query('DELETE FROM plan_periods WHERE id=$1', [periodId]);
  });
}
