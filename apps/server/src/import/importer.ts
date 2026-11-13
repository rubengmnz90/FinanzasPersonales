import { NotFoundError, withTx, type Db, type Tx } from '../db/client';
import { DEFAULT_CATEGORIES, ensureCategory, GROUPS, type GroupName } from '../modules/categories/service';
import { seedDefaultLoans } from '../modules/loans/service';
import { createAccount, defaultAccountId, getLedger, listBalances, pendingTempWithdrawals, seedDefaultAccounts } from '../modules/ledgers/service';
import { getRecovery } from '../modules/recovery/service';
import { getSplit } from '../modules/splits/service';
import { getPlanView } from '../modules/plans/service';
import { balanceAt } from '../modules/transactions/service';
import { date, lastRow, num, openWorkbook, simpleExpr, text, val, type Sheet } from './excel-reader';

export interface ImportReport {
  created: Record<string, number>;
  skipped: { sheet: string; row: number; reason: string }[];
  warnings: string[];
  reconciliation: { name: string; excel: number; app: number; ok: boolean; note?: string }[];
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

class Ctx {
  report: ImportReport = { created: {}, skipped: [], warnings: [], reconciliation: [] };
  constructor(public tx: Tx, public userId: string) {}
  inc(k: string, n = 1) {
    this.report.created[k] = (this.report.created[k] ?? 0) + n;
  }
  skip(sheet: string, row: number, reason: string) {
    this.report.skipped.push({ sheet, row, reason });
  }
  warn(m: string) {
    this.report.warnings.push(m);
  }
  check(name: string, excel: number, app: number, tol = 1) {
    this.report.reconciliation.push({ name, excel, app, ok: Math.abs(excel - app) <= tol });
  }
  /** Diferencia esperada (el Excel tiene un valor manual desactualizado): se informa pero no falla. */
  info(name: string, excel: number, app: number, note: string) {
    this.report.reconciliation.push({ name, excel, app, ok: true, note });
  }
}

function sheet(wb: any, name: string, c: Ctx): Sheet | null {
  const ws = wb.getWorksheet(name);
  if (!ws) c.warn(`No se encontró la hoja "${name}"`);
  return ws ?? null;
}

// ───────────────────────────── Grupos + Flujo ─────────────────────────────

async function importCategories(ws: Sheet, c: Ctx) {
  for (let r = 1; r <= lastRow(ws); r++) {
    const name = text(ws, r, 3);
    const group = text(ws, r, 4);
    if (!name) continue;
    if (!(GROUPS as readonly string[]).includes(group)) {
      c.skip('Grupos', r, `grupo inválido "${group}"`);
      continue;
    }
    const had = await c.tx.query('SELECT 1 FROM categories WHERE user_id=$1 AND name=$2', [c.userId, name]);
    await ensureCategory(c.tx, c.userId, name, group as GroupName);
    if (!had.rowCount) c.inc('categorías'); // solo cuenta las nuevas
  }
}

async function importFlujo(ws: Sheet, c: Ctx) {
  await seedDefaultAccounts(c.tx, c.userId);
  const defaultAcc = await defaultAccountId(c.tx, c.userId);
  const SIN = await ensureCategory(c.tx, c.userId, 'Sin categoría', 'Otros');
  const catCache = new Map<string, string>();
  let lastBalance = 0;
  for (let r = 2; r <= lastRow(ws); r++) {
    const d = date(ws, r, 1);
    if (!d) {
      if (text(ws, r, 4) || num(ws, r, 5) || num(ws, r, 6)) c.skip('Flujo', r, 'fila con datos pero sin fecha válida');
      continue;
    }
    const inc = num(ws, r, 5);
    const exp = num(ws, r, 6);
    if (!inc && !exp) {
      c.skip('Flujo', r, 'ingreso y egreso en 0');
      continue;
    }
    const item = text(ws, r, 4);
    const sub = text(ws, r, 9);
    let catId = SIN;
    if (sub) {
      if (!catCache.has(sub)) {
        const g = text(ws, r, 8);
        const known = DEFAULT_CATEGORIES.find(([n]) => n.toLowerCase() === sub.toLowerCase());
        const group = known?.[1] ?? ((GROUPS as readonly string[]).includes(g) ? (g as GroupName) : 'Otros');
        if (!known) c.warn(`Subgrupo "${sub}" no está en la hoja Grupos; creado en grupo ${group}`);
        catCache.set(sub, await ensureCategory(c.tx, c.userId, sub, group));
      }
      catId = catCache.get(sub)!;
    } else {
      c.warn(`Flujo fila ${r}: sin subgrupo ("${item}") → Sin categoría`);
    }
    const note = text(ws, r, 10) || null;
    const rows: ['income' | 'expense', number, number][] = [];
    if (inc) rows.push(['income', inc, 5]);
    if (exp) rows.push(['expense', exp, 6]);
    for (const [kind, amount, col] of rows) {
      const abs = Math.abs(Math.round(amount));
      // Un monto negativo en una columna equivale a invertir el tipo.
      const k = amount < 0 ? (kind === 'income' ? 'expense' : 'income') : kind;
      const r2 = await c.tx.query(
        `INSERT INTO transactions(user_id,date,item,kind,amount,amount_expr,category_id,note,import_key,account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,import_key) DO NOTHING`,
        [c.userId, d, item, k, abs, simpleExpr(ws, r, col), catId, note, `flujo:${r}:${kind}`, defaultAcc],
      );
      if (r2.rowCount) c.inc('movimientos');
    }
    const g = val(ws, r, 7);
    if (typeof g === 'number') lastBalance = g;
  }
  const app = await balanceAt(c.tx, c.userId, '9999-12-31');
  c.check('Flujo: saldo final', lastBalance, app);
}

// ───────────────────────────── Proyección ─────────────────────────────

interface ParsedItem { kind: 'income' | 'expense'; concept: string; auto: boolean; cells: number[]; exprs: (string | null)[]; overrides: boolean[] }
interface ParsedPeriod { label: string; day: number; items: ParsedItem[] }

function parsePlanSheet(ws: Sheet): ParsedPeriod[] {
  const blocks = [
    { label: 'Fin de mes', day: 30, marker: 2, concept: 3, first: 4 },
    { label: 'Quincena', day: 15, marker: 18, concept: 19, first: 20 },
  ];
  return blocks.map((b) => {
    const items: ParsedItem[] = [];
    let kind: 'income' | 'expense' | null = null;
    for (let r = 4; r <= lastRow(ws); r++) {
      const mk = text(ws, r, b.marker).toUpperCase();
      if (mk === 'GASTOS') kind = 'expense';
      else if (mk === 'INGRESOS') kind = 'income';
      const concept = text(ws, r, b.concept);
      if (!concept) continue;
      if (/^(total|neto)/i.test(concept)) { kind = null; continue; }
      if (!kind) continue;
      const cells: number[] = [];
      const exprs: (string | null)[] = [];
      const overrides: boolean[] = [];
      const auto = kind === 'expense' && /^otros gastos$/i.test(concept);
      for (let m = 0; m < 12; m++) {
        const col = b.first + m;
        cells.push(Math.round(num(ws, r, col)));
        exprs.push(simpleExpr(ws, r, col));
        // En la fila automática, una celda que NO es SUMIFS es un valor manual que pisa al cálculo.
        const f = (ws.getCell(r, col).value as any)?.formula;
        overrides.push(auto && !(typeof f === 'string' && /SUMIFS/i.test(f)));
      }
      items.push({ kind, concept, auto, cells, exprs, overrides });
    }
    return { label: b.label, day: b.day, items };
  });
}

async function importPlan(ws: Sheet, year: number, c: Ctx, netCells: { fin: [number, number]; qui: [number, number] }) {
  const key = `plan:${year}`;
  const exists = await c.tx.query('SELECT id FROM plans WHERE user_id=$1 AND import_key=$2', [c.userId, key]);
  if (exists.rowCount) {
    c.warn(`Plan ${year} ya estaba importado; se omite`);
    return;
  }
  const parsed = parsePlanSheet(ws);
  const p = (await c.tx.query('INSERT INTO plans(user_id,year,name,import_key) VALUES ($1,$2,$3,$4) RETURNING id', [
    c.userId, year, `Proyección ${year}`, key,
  ])).rows[0];
  let sort = 0;
  for (const per of parsed) {
    const pid = (await c.tx.query(
      'INSERT INTO plan_periods(plan_id,label,day_of_month,sort) VALUES ($1,$2,$3,$4) RETURNING id',
      [p.id, per.label, per.day, sort++],
    )).rows[0].id;
    let isort = 0;
    for (const it of per.items) {
      const iid = (await c.tx.query(
        'INSERT INTO plan_items(plan_id,period_id,kind,concept,sort,auto_source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [p.id, pid, it.kind, it.concept, isort++, it.auto ? 'planned_expenses' : null],
      )).rows[0].id;
      for (let m = 0; m < 12; m++) {
        const ov = it.auto && it.overrides[m];
        await c.tx.query('INSERT INTO plan_cells(item_id,month,amount,amount_expr,is_override) VALUES ($1,$2,$3,$4,$5)', [
          iid, m + 1, !it.auto || ov ? it.cells[m] : 0, ov || !it.auto ? it.exprs[m] : null, ov,
        ]);
      }
      c.inc('filas de plan');
    }
  }
  c.inc('planes');
  // Se verifica después de importar "Otros gastos" (ver importWorkbook).
  (c as any).pendingPlanChecks = [...((c as any).pendingPlanChecks ?? []), { year, planId: p.id, ws, netCells }];
}

async function importOtrosGastos(ws: Sheet, c: Ctx) {
  let inferred = 0;
  for (let r = 2; r <= lastRow(ws); r++) {
    const concept = text(ws, r, 2);
    if (!concept) continue;
    const amount = Math.round(num(ws, r, 3));
    const grp = text(ws, r, 4).toLowerCase();
    const mes = MONTHS[text(ws, r, 5).toLowerCase()];
    if (!mes) {
      c.skip('Otros gastos', r, `mes inválido "${text(ws, r, 5)}"`);
      continue;
    }
    const quincena = grp.startsWith('quin');
    const due = `2026-${pad(mes)}-${pad(quincena ? 15 : lastDay(2026, mes))}`;
    inferred++;
    const r2 = await c.tx.query(
      `INSERT INTO planned_expenses(user_id,concept,amount,period_label,due_date,done,import_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id,import_key) DO NOTHING`,
      [c.userId, concept, amount, quincena ? 'Quincena' : 'Fin de mes', due, text(ws, r, 6).toLowerCase() === 'ok', `otros:${r}`],
    );
    if (r2.rowCount) c.inc('gastos puntuales');
  }
  if (inferred) c.warn(`Otros gastos: ${inferred} fechas inferidas (Quincena→día 15, Fin→último día del mes, año 2026); edítalas si hace falta`);

  // Fondo "Ahorro Emma" (I:M)
  const acc = await createAccount(c.tx, c.userId, { type: 'fund', name: 'Ahorro Emma' });
  let sum = 0;
  for (let r = 2; r <= lastRow(ws); r++) {
    const d = date(ws, r, 12);
    const amount = Math.round(num(ws, r, 11));
    if (!d || !amount) continue;
    sum += amount;
    const r2 = await c.tx.query(
      `INSERT INTO ledger_entries(account_id,date,concept,amount,import_key) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id,import_key) DO NOTHING`,
      [acc.id, d, text(ws, r, 10), amount, `emma:${r}`],
    );
    if (r2.rowCount) c.inc('movimientos de cuentas');
  }
  c.check('Ahorro Emma: saldo', num(ws, 2, 13), (await getLedger(c.tx, c.userId, acc.id)).balance);
  void sum;
}

// ───────────────────────────── Cuentas ─────────────────────────────

async function entry(c: Ctx, accId: string, d: string, concept: string, amount: number, key: string, tag: string | null = null, bucket: string | null = null) {
  const r = await c.tx.query(
    `INSERT INTO ledger_entries(account_id,date,concept,amount,tag,bucket,import_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id,import_key) DO NOTHING`,
    [accId, d, concept, Math.round(amount), tag, bucket, key],
  );
  if (r.rowCount) c.inc('movimientos de cuentas');
}

async function importAhorro(ws: Sheet, c: Ctx) {
  const savingsByName = new Map<string, string>();
  const acc = async (name: string) => {
    if (!savingsByName.has(name)) savingsByName.set(name, (await createAccount(c.tx, c.userId, { type: 'savings', name: `Ahorro ${name}`, ...(name === 'Coomecipar' ? { alias: '2946999-6', institution: 'Coomecipar' } : {}) })).id);
    return savingsByName.get(name)!;
  };
  for (let r = 2; r <= lastRow(ws); r++) {
    // Aportes A:D
    const d1 = date(ws, r, 1);
    if (d1) await entry(c, await acc(text(ws, r, 3) || 'General'), d1, text(ws, r, 4), num(ws, r, 2), `ahorro:A:${r}`, null, text(ws, r, 4) || null); // el concepto es el objetivo (Ahorro, Aguinaldo, Vacaciones, Emma)
    // Retiros temporales K:N
    const d2 = date(ws, r, 11);
    if (d2) {
      const amount = num(ws, r, 12);
      await entry(c, await acc(text(ws, r, 13) || 'General'), d2, text(ws, r, 14), amount, `ahorro:K:${r}`, amount < 0 ? 'temp_withdrawal' : 'return');
    }
  }
  // Caja de Vibra Lejana (F:G): sin fechas en el Excel.
  const caja = await createAccount(c.tx, c.userId, { type: 'cash_box', name: 'Vibra Lejana', alias: 'rubengmnz90@gmail.com', institution: 'Banco Familiar' });
  let started = false;
  let total = 0;
  let sawDateless = false;
  for (let r = 1; r <= lastRow(ws); r++) {
    const label = text(ws, r, 6);
    if (!label) continue;
    if (/^saldo vibra lejana$/i.test(label)) {
      if (!started) { started = true; continue; }
      total = num(ws, r, 7);
      break;
    }
    if (!started) continue;
    sawDateless = true;
    await entry(c, caja.id, '2026-01-01', label, num(ws, r, 7), `vibra:${r}`);
  }
  if (sawDateless) c.warn('Caja Vibra Lejana: el Excel no tiene fechas; se cargó con 2026-01-01 manteniendo el orden original');
  c.check('Vibra Lejana: saldo', total, (await getLedger(c.tx, c.userId, caja.id)).balance);

  // Tarjeta Coomecipar duplicada en P:T: se verifica contra la hoja Tarjetas más abajo.
  return ws;
}

async function importTarjetas(ws: Sheet, ahorro: Sheet | null, c: Ctx) {
  const card1 = await createAccount(c.tx, c.userId, { type: 'card', name: 'Tarjeta Coomecipar', creditLimit: 3000000, openingBalance: 0 });
  const card2 = await createAccount(c.tx, c.userId, { type: 'card', name: 'Tarjeta GNB', creditLimit: 7000000, openingBalance: 0 });
  let s1 = 0;
  let s2 = 0;
  let last1 = 0;
  let last2 = 0;
  for (let r = 2; r <= lastRow(ws); r++) {
    const d1 = date(ws, r, 2);
    if (d1) {
      const a = num(ws, r, 4);
      s1 += a;
      await entry(c, card1.id, d1, text(ws, r, 3), a, `tarjeta1:${r}`);
      last1 = num(ws, r, 6);
    }
    const d2 = date(ws, r, 10);
    if (d2) {
      const a = num(ws, r, 12);
      s2 += a;
      await entry(c, card2.id, d2, text(ws, r, 11), a, `tarjeta2:${r}`);
      last2 = num(ws, r, 14);
    }
  }
  const l1 = await getLedger(c.tx, c.userId, card1.id);
  const l2 = await getLedger(c.tx, c.userId, card2.id);
  c.check('Tarjeta Coomecipar: deuda', -last1, l1.owed);
  c.check('Tarjeta GNB: deuda', -last2, l2.owed);
  if (ahorro) {
    let dup = 0;
    for (let r = 2; r <= lastRow(ahorro); r++) if (date(ahorro, r, 16)) dup += num(ahorro, r, 18);
    if (Math.abs(dup - s1) > 1) c.warn(`Ahorro!P:T (tarjeta duplicada) difiere de Tarjetas!B:F: ${dup} vs ${s1}. Se usó Tarjetas.`);
  }
}

async function importPrestamos(ws: Sheet, c: Ctx) {
  const blocks = [
    { name: 'Deuda Casa', dateCol: 20, conceptCol: 21, debe: 22, haber: 23, summaryRow: 4, key: 'casa' },
    { name: 'Deuda Préstamo (Boda)', dateCol: 14, conceptCol: 15, debe: 16, haber: 17, summaryRow: 5, key: 'boda' },
    { name: 'Deuda Normal', dateCol: 8, conceptCol: 9, debe: 10, haber: 11, summaryRow: 6, key: 'normal' },
  ];
  let total = 0;
  for (const b of blocks) {
    const acc = await createAccount(c.tx, c.userId, { type: 'debt', name: b.name, counterparty: 'Esposa' });
    for (let r = 2; r <= lastRow(ws); r++) {
      const d = date(ws, r, b.dateCol);
      const debe = num(ws, r, b.debe);
      const haber = num(ws, r, b.haber);
      if (!d) {
        if (debe || haber) c.skip('Prestamos', r, `${b.name}: monto sin fecha`);
        continue;
      }
      if (!debe && !haber) continue;
      await entry(c, acc.id, d, text(ws, r, b.conceptCol), debe - haber, `prestamo:${b.key}:${r}`);
    }
    const bal = (await getLedger(c.tx, c.userId, acc.id)).balance;
    c.check(`${b.name}: saldo`, num(ws, b.summaryRow, 3), bal);
    total += bal;
  }
  // Casamiento: monto fijo del resumen (C7), sin libro.
  const cas = await createAccount(c.tx, c.userId, { type: 'debt', name: 'Deuda Casamiento', counterparty: 'Esposa' });
  const casAmount = num(ws, 7, 3);
  if (casAmount) await entry(c, cas.id, '2024-01-01', 'Saldo del resumen', casAmount, 'prestamo:casamiento');
  total += casAmount;
  c.warn('Deuda Casamiento: el Excel tiene un monto fijo sin fecha; se cargó con 2024-01-01');
  // Devoluciones (E:F)
  const dev = await createAccount(c.tx, c.userId, { type: 'debt', name: 'Devoluciones', counterparty: 'Esposa' });
  for (let r = 2; r <= lastRow(ws); r++) {
    const d = date(ws, r, 5);
    const a = num(ws, r, 6);
    if (d && a) await entry(c, dev.id, d, 'Devolución', a, `prestamo:dev:${r}`);
  }
  total += (await getLedger(c.tx, c.userId, dev.id)).balance;
  c.check('Préstamos: total', num(ws, 9, 3), total);
}

// ───────────────────────────── Como + Plantilla ─────────────────────────────

async function importComo(ws: Sheet, c: Ctx) {
  for (let col = 7; col <= 15; col++) {
    const idx = num(ws, 9, col);
    const label = text(ws, 8, col);
    if (!idx || !label) continue;
    const cobro = await c.tx.query(
      `INSERT INTO recovery_cobros(user_id,cobro_index,label,income) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id,cobro_index) DO UPDATE SET label=EXCLUDED.label, income=EXCLUDED.income
       RETURNING (xmax = 0) AS inserted`,
      [c.userId, idx, label, Math.round(num(ws, 10, col))],
    );
    if (cobro.rows[0]?.inserted) c.inc('cobros de recuperación'); // solo cuenta los nuevos
  }
  for (let r = 13; r <= lastRow(ws); r++) {
    const concept = text(ws, r, 2);
    const idx = num(ws, r, 5);
    if (!concept || !idx) continue;
    const tag = text(ws, r, 4).toUpperCase() || null;
    if (tag && !['T', 'A', 'V', 'F'].includes(tag)) { c.skip('Como', r, `etiqueta inválida "${tag}"`); continue; }
    const cobro = (await c.tx.query('SELECT label FROM recovery_cobros WHERE user_id=$1 AND cobro_index=$2', [c.userId, idx])).rows[0];
    if (!cobro) { c.skip('Como', r, `cobro ${idx} inexistente`); continue; }
    const r2 = await c.tx.query(
      `INSERT INTO recovery_allocations(user_id,cobro_label,cobro_index,concept,amount,tag,import_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id,import_key) DO NOTHING`,
      [c.userId, cobro.label, idx, concept, Math.round(num(ws, r, 3)), tag, `como:${r}`],
    );
    if (r2.rowCount) c.inc('asignaciones');
  }
  const rec = await getRecovery(c.tx, c.userId);
  const card = rec.debts.find((d) => d.key === 'card')!;
  const sav = rec.debts.find((d) => d.key === 'savings')!;
  c.check('Como: tarjeta pagado', num(ws, 3, 11), card.paid);
  c.check('Como: tarjeta pendiente', num(ws, 3, 12), card.pending);
  c.check('Como: ahorro pagado', num(ws, 4, 11), sav.paid);
  c.info('Como: ahorro pendiente', num(ws, 4, 12), sav.pending, 'el Excel tiene la deuda de ahorro escrita a mano (2.188.387); la app la calcula en vivo desde los retiros');
  c.check('Como: vacaciones', num(ws, 2, 14), rec.byTag.V);
}

async function importPlantilla(ws: Sheet, c: Ctx) {
  const key = 'plantilla:1';
  const ex = await c.tx.query('SELECT id FROM splits WHERE user_id=$1 AND import_key=$2', [c.userId, key]);
  if (ex.rowCount) { c.warn('Plantilla de distribución ya importada; se omite'); return; }
  const people = [text(ws, 1, 6), text(ws, 1, 7), text(ws, 1, 8)].filter(Boolean);
  const s = (await c.tx.query(
    `INSERT INTO splits(user_id,name,date,participants,import_key) VALUES ($1,'Plantilla 2026','2026-01-01',$2,$3) RETURNING id`,
    [c.userId, JSON.stringify(people), key],
  )).rows[0];
  let sort = 0;
  for (let r = 2; r <= lastRow(ws); r++) {
    const total = num(ws, r, 3);
    if (!total) continue;
    const shares: Record<string, number> = {};
    people.forEach((p, i) => { shares[p] = num(ws, r, 6 + i); });
    await c.tx.query(
      'INSERT INTO split_items(split_id,sort,label,total,discount_pct,shares) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.id, sort++, text(ws, r, 2), total, num(ws, r, 4), JSON.stringify(shares)],
    );
    c.inc('ítems de reparto');
  }
  const v = await getSplit(c.tx, c.userId, s.id);
  c.check('Plantilla: total Emma', num(ws, 1, 16), v.result.totals['Emma'] ?? 0);
  c.check('Plantilla: total Yo', num(ws, 2, 16), v.result.totals['Yo'] ?? 0);
  c.check('Plantilla: total Ali', num(ws, 4, 16), v.result.totals['Ali'] ?? 0);
  if (v.shareErrors.length) c.warn(`Plantilla: ${v.shareErrors.length} filas con porcentajes que no suman 100%`);
}

// ───────────────────────────── Orquestación ─────────────────────────────

export async function importWorkbook(
  db: Db,
  userId: string,
  filePath: string,
  opts: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const wb = await openWorkbook(filePath);
  class Rollback extends Error {}
  let report!: ImportReport;
  try {
    await withTx(db, async (tx) => {
      const u = await tx.query('SELECT 1 FROM users WHERE id=$1', [userId]);
      if (!u.rowCount) throw new NotFoundError('usuario');
      const c = new Ctx(tx, userId);
      const g = sheet(wb, 'Grupos', c);
      if (g) await importCategories(g, c);
      const f = sheet(wb, 'Flujo', c);
      if (f) await importFlujo(f, c);
      const o = sheet(wb, 'Otros gastos', c);
      if (o) await importOtrosGastos(o, c);
      const p26 = sheet(wb, 'Proyeccion Mensual 2026', c);
      if (p26) await importPlan(p26, 2026, c, { fin: [35, 16], qui: [35, 32] });
      const p27 = sheet(wb, 'Proyeccion Mensual 2027', c);
      if (p27) await importPlan(p27, 2027, c, { fin: [34, 16], qui: [34, 32] });
      for (const chk of (c as any).pendingPlanChecks ?? []) {
        const v = await getPlanView(tx, userId, chk.planId);
        const netSum = (i: number) => v.periods[i].totals.net.reduce((a, b) => a + b, 0);
        c.check(`Plan ${chk.year}: neto Fin de mes`, num(chk.ws, chk.netCells.fin[0], chk.netCells.fin[1]), netSum(0));
        c.check(`Plan ${chk.year}: neto Quincena`, num(chk.ws, chk.netCells.qui[0], chk.netCells.qui[1]), netSum(1));
      }
      const a = sheet(wb, 'Ahorro', c);
      if (a) await importAhorro(a, c);
      const t = sheet(wb, 'Tarjetas', c);
      if (t) await importTarjetas(t, a, c);
      const pr = sheet(wb, 'Prestamos', c);
      if (pr) await importPrestamos(pr, c);
      await seedDefaultLoans(c.tx, c.userId);
      const co = sheet(wb, 'Como', c);
      if (co) await importComo(co, c);
      const pl = sheet(wb, 'Plantilla distribucion', c);
      if (pl) await importPlantilla(pl, c);
      report = c.report;
      if (opts.dryRun) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return report;
}

export { listBalances, pendingTempWithdrawals };
