import { listAudit, revertAction } from '../modules/audit/service';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { auditCtx } from '../db/context';
import { importWorkbook } from '../import/importer';
import { z } from 'zod';
import type { Db } from '../db/client';
import {
  addInstallment, createLoan, deleteInstallment, deleteLoan, listLoans, payInstallment, unpayInstallment, updateInstallment, updateLoan,
} from '../modules/loans/service';
import { GROUPS, listCategories, upsertCategory } from '../modules/categories/service';
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  balanceAt,
  listTransactions,
  updateTransaction,
} from '../modules/transactions/service';
import {
  createPlannedExpense,
  deletePlannedExpense,
  listPlannedExpenses,
  markDone,
  updatePlannedExpense,
} from '../modules/planned-expenses/service';
import {
  addItem,
  applyAdjust,
  clearOverride,
  clonePlan,
  comparePlans,
  createPlan,
  fillRight,
  getPlanView,
  listPlans,
  removeItem,
  removePeriod,
  renameItem,
  setCell,
} from '../modules/plans/service';
import {
  accountStatement,
  addEntry,
  assignBucket,
  createAccount,
  deleteEntry,
  getLedger,
  listAccounts,
  listBalances,
  updateAccount,
  updateEntry,
} from '../modules/ledgers/service';
import { createTransfer, deleteTransfer, listBuckets, saveBucket, updateTransfer } from '../modules/transfers/service';
import { executePlan, previewExecution } from '../modules/plans/execution';
import { healthReport } from '../modules/summary/health';
import {
  addAllocation,
  getRecovery,
  removeAllocation,
  setCobro,
  updateAllocation,
} from '../modules/recovery/service';
import {
  addSplitItem,
  createSplit,
  deleteSplit,
  deleteSplitItem,
  getSplit,
  listSplits,
  updateSplitItem,
} from '../modules/splits/service';
import { annualSummary, monthlySummary, planVsActual, projectedBalance, rangeSummary } from '../modules/summary/service';
import { rolloverYear } from '../modules/plans/rollover';

const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD');
const Amt = z.union([z.string(), z.number()]);
const uid = (req: any): string => req.user.id;

export function registerApiRoutes(app: FastifyInstance, db: Db): void {
  // ── importar el Excel: el archivo llega en el cuerpo, se lee desde un temporal y se BORRA siempre al terminar ──
  const MAX_XLSX = 20 * 1024 * 1024;
  app.addContentTypeParser(
    ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    { parseAs: 'buffer', bodyLimit: MAX_XLSX },
    (_req, body, done) => done(null, body),
  );
  app.post('/api/import', { bodyLimit: MAX_XLSX }, async (req, reply) => {
    const { dryRun } = z.object({ dryRun: z.enum(['0', '1']).optional() }).parse(req.query);
    const buf = req.body as unknown;
    // Un .xlsx es un ZIP: empieza con "PK\x03\x04".
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.readUInt32BE(0) !== 0x504b0304) {
      return reply.code(400).send({ error: 'ARCHIVO_INVALIDO', detail: 'Sube un archivo Excel (.xlsx)' });
    }
    const dir = await mkdtemp(join(tmpdir(), 'import-'));
    const file = join(dir, 'libro.xlsx');
    let report: Awaited<ReturnType<typeof importWorkbook>> | null = null;
    let failure: unknown = null;
    try {
      await writeFile(file, buf, { mode: 0o600 });
      const userId = uid(req);
      report = await auditCtx.run({ actor: 'importación', userId }, () => importWorkbook(db, userId, file, { dryRun: dryRun === '1' }));
    } catch (e) {
      failure = e;
    } finally {
      // El borrado termina ANTES de responder: el archivo no queda en el servidor pase lo que pase.
      await rm(dir, { recursive: true, force: true });
    }
    if (report) return report;
    const name = (failure as any)?.name;
    if (name === 'NotFoundError' || name === 'ValidationError') throw failure;
    console.error('[import]', failure);
    return reply.code(400).send({ error: 'ARCHIVO_INVALIDO', detail: 'No pude leer ese Excel. Usa el archivo "Administracion 2026.xlsx".' });
  });

  // ── categorías ──
  app.get('/api/categories', async (req) => listCategories(db, uid(req)));
  app.post('/api/categories', async (req) => {
    const b = z.object({ id: z.string().uuid().optional(), name: z.string().min(1), groupName: z.enum(GROUPS), archived: z.boolean().optional() }).parse(req.body);
    return upsertCategory(db, uid(req), b);
  });

  // ── movimientos (flujo) ──
  const txBody = z.object({
    date: D,
    item: z.string(),
    kind: z.enum(['income', 'expense']),
    rawAmount: Amt,
    categoryId: z.string().uuid().nullable().optional(),
    note: z.string().nullable().optional(),
    accountId: z.string().uuid().nullable().optional(),
  });
  app.get('/api/transactions', async (req) => {
    const q = z.object({
      from: D.optional(), to: D.optional(), categoryId: z.string().uuid().optional(),
      groupName: z.enum(GROUPS).optional(), text: z.string().optional(), limit: z.coerce.number().optional(),
      accountId: z.string().uuid().optional(), order: z.enum(['asc', 'desc']).optional(),
      includeTransfers: z.enum(['true', 'false']).optional(),
    }).parse(req.query);
    const { includeTransfers, ...rest } = q;
    return listTransactions(db, uid(req), { ...rest, includeTransfers: includeTransfers === undefined ? undefined : includeTransfers === 'true' });
  });
  app.post('/api/transactions', async (req, reply) => reply.code(201).send(await createTransaction(db, uid(req), txBody.parse(req.body))));
  app.patch('/api/transactions/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return updateTransaction(db, uid(req), id, txBody.partial().parse(req.body));
  });
  app.get('/api/transactions/:id', async (req) => getTransaction(db, uid(req), (req.params as any).id));
  app.delete('/api/transactions/:id', async (req) => {
    await deleteTransaction(db, uid(req), (req.params as any).id);
    return { ok: true };
  });

  // ── gastos puntuales ──
  const peBody = z.object({ concept: z.string().min(1), rawAmount: Amt, periodLabel: z.string().min(1), dueDate: D });
  app.get('/api/planned-expenses', async (req) => {
    const q = z.object({ from: D.optional(), to: D.optional(), done: z.enum(['true', 'false']).optional() }).parse(req.query);
    return listPlannedExpenses(db, uid(req), { from: q.from, to: q.to, done: q.done === undefined ? undefined : q.done === 'true' });
  });
  app.post('/api/planned-expenses', async (req, reply) => reply.code(201).send(await createPlannedExpense(db, uid(req), peBody.parse(req.body))));
  app.patch('/api/planned-expenses/:id', async (req) => updatePlannedExpense(db, uid(req), (req.params as any).id, peBody.partial().parse(req.body)));
  app.delete('/api/planned-expenses/:id', async (req) => {
    await deletePlannedExpense(db, uid(req), (req.params as any).id);
    return { ok: true };
  });
  app.post('/api/planned-expenses/:id/done', async (req) => {
    const b = z.object({ createTransaction: z.boolean(), categoryId: z.string().uuid().nullable().optional(), date: D.optional() }).parse(req.body);
    return markDone(db, uid(req), (req.params as any).id, b);
  });

  // ── planes ──
  app.get('/api/plans', async (req) => listPlans(db, uid(req), z.coerce.number().optional().parse((req.query as any).year)));
  app.post('/api/plans', async (req, reply) => {
    const b = z.object({
      year: z.number().int(), name: z.string().min(1),
      periods: z.array(z.object({ label: z.string().min(1), dayOfMonth: z.number().int().min(1).max(31) })).min(1),
    }).parse(req.body);
    return reply.code(201).send(await createPlan(db, uid(req), b));
  });
  app.get('/api/plans/:id', async (req) => getPlanView(db, uid(req), (req.params as any).id));
  app.post('/api/plans/:id/clone', async (req) => {
    const b = z.object({ name: z.string().min(1), year: z.number().int().optional() }).parse(req.body);
    return clonePlan(db, uid(req), (req.params as any).id, b);
  });
  app.post('/api/plans/:id/rollover', async (req) => {
    const b = z.object({ toYear: z.number().int(), name: z.string().optional() }).parse(req.body);
    return rolloverYear(db, uid(req), { fromPlanId: (req.params as any).id, ...b });
  });
  app.post('/api/plans/:id/items', async (req, reply) => {
    const b = z.object({ periodId: z.string().uuid(), kind: z.enum(['income', 'expense']), concept: z.string().min(1) }).parse(req.body);
    const id = await addItem(db, uid(req), (req.params as any).id, b);
    return reply.code(201).send({ id });
  });
  app.post('/api/plans/:id/adjust', async (req) => {
    const b = z.object({ itemIds: z.array(z.string().uuid()), months: z.array(z.number().int().min(1).max(12)), pct: z.number().optional(), delta: z.number().optional() }).parse(req.body);
    return applyAdjust(db, uid(req), (req.params as any).id, b);
  });
  app.get('/api/plans/:id/execution', async (req) => {
    const q = z.object({ periodId: z.string().uuid(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
    return previewExecution(db, uid(req), { planId: (req.params as any).id, ...q });
  });
  app.post('/api/plans/:id/execute', async (req) => {
    const b = z.object({
      periodId: z.string().uuid(), month: z.number().int().min(1).max(12),
      lines: z.array(z.object({ key: z.string(), accountId: z.string().uuid(), amount: Amt.optional(), categoryId: z.string().uuid().nullable().optional() })),
      transfers: z.array(trBody).optional(),
    }).parse(req.body);
    return executePlan(db, uid(req), {
      planId: (req.params as any).id, ...b });
  });
  app.get('/api/plans/:id/compare/:otherId', async (req) => comparePlans(db, uid(req), (req.params as any).id, (req.params as any).otherId));
  app.get('/api/plans/:id/vs-actual', async (req) => planVsActual(db, uid(req), (req.params as any).id));
  app.get('/api/plans/:id/projection', async (req) => {
    const q = z.object({ from: D }).parse(req.query);
    return projectedBalance(db, uid(req), (req.params as any).id, q.from);
  });
  app.delete('/api/plan-periods/:id', async (req) => {
    const b = z.object({ moveToPeriodId: z.string().uuid().optional(), confirmDiscard: z.boolean().optional() }).parse(req.body ?? {});
    await removePeriod(db, uid(req), (req.params as any).id, b);
    return { ok: true };
  });
  app.patch('/api/plan-items/:id', async (req) => {
    await renameItem(db, uid(req), (req.params as any).id, z.object({ concept: z.string().min(1) }).parse(req.body).concept);
    return { ok: true };
  });
  app.delete('/api/plan-items/:id', async (req) => {
    await removeItem(db, uid(req), (req.params as any).id);
    return { ok: true };
  });
  app.put('/api/plan-items/:id/cells/:month', async (req) => {
    const p = req.params as any;
    const amount = await setCell(db, uid(req), p.id, Number(p.month), z.object({ rawAmount: Amt }).parse(req.body).rawAmount);
    return { amount };
  });
  app.delete('/api/plan-items/:id/cells/:month/override', async (req) => {
    const p = req.params as any;
    await clearOverride(db, uid(req), p.id, Number(p.month));
    return { ok: true };
  });
  app.post('/api/plan-items/:id/fill-right', async (req) => {
    const b = z.object({ fromMonth: z.number().int().min(1).max(12) }).parse(req.body);
    await fillRight(db, uid(req), (req.params as any).id, b.fromMonth);
    return { ok: true };
  });

  // ── cuentas ──
  app.get('/api/audit', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().optional(), before: z.coerce.number().int().optional(), actor: z.enum(['ia', 'web', 'otros']).optional() }).parse(req.query);
    return listAudit(db, uid(req), { limit: q.limit, beforeSeq: q.before, actor: q.actor });
  });
  app.post('/api/audit/:txId/revert', async (req) => revertAction(db, uid(req), z.object({ txId: z.coerce.number().int() }).parse(req.params).txId));
  app.get('/api/balance-at', async (req) => ({ balance: await balanceAt(db, uid(req), z.object({ date: D }).parse(req.query).date) }));
  app.get('/api/accounts', async (req) => listBalances(db, uid(req), { asOf: z.object({ asOf: D.optional() }).parse(req.query).asOf }));
  app.post('/api/accounts', async (req, reply) => {
    const b = z.object({
      type: z.enum(['bank', 'cash', 'savings', 'card', 'cash_box', 'fund', 'debt', 'receivable']), name: z.string().min(1),
      creditLimit: z.number().int().positive().nullable().optional(), counterparty: z.string().nullable().optional(),
      alias: z.string().nullable().optional(), institution: z.string().nullable().optional(),
      openingBalance: z.number().int().optional(), isDefault: z.boolean().optional(), inFlow: z.boolean().optional(),
    }).parse(req.body);
    return reply.code(201).send(await createAccount(db, uid(req), b));
  });
  app.patch('/api/accounts/:id', async (req) => {
    const b = z.object({
      name: z.string().min(1), alias: z.string().nullable(), institution: z.string().nullable(),
      creditLimit: z.number().int().positive().nullable(), openingBalance: z.number().int(), isDefault: z.boolean(),
      archived: z.boolean(), sort: z.number().int(), inFlow: z.boolean(),
    }).partial().parse(req.body);
    return updateAccount(db, uid(req), (req.params as any).id, b);
  });
  app.get('/api/accounts/:id/statement', async (req) => {
    const q = z.object({ from: D.optional(), to: D.optional() }).parse(req.query);
    return accountStatement(db, uid(req), (req.params as any).id, q);
  });
  app.post('/api/accounts/:id/assign-bucket', async (req) => {
    const b = z.object({ bucket: z.string().min(1) }).parse(req.body);
    return { updated: await assignBucket(db, uid(req), (req.params as any).id, b.bucket) };
  });
  app.get('/api/buckets', async (req) => listBuckets(db, uid(req)));
  app.put('/api/buckets', async (req) => {
    const b = z.object({ name: z.string().min(1), untouchable: z.boolean() }).parse(req.body);
    return saveBucket(db, uid(req), b.name, b.untouchable);
  });

  // ── préstamos formales y sus cuotas ──
  const loanBody = z.object({
    name: z.string().min(1), lender: z.string().nullable().optional(), principal: z.number().int().nonnegative().optional(),
    installmentAmount: z.number().int().nonnegative().optional(), installments: z.number().int().positive().max(600).optional(),
    firstDue: D.optional(), inProjection: z.boolean().optional(), payAccountId: z.string().uuid().nullable().optional(),
    ledgerAccountId: z.string().uuid().nullable().optional(), note: z.string().nullable().optional(),
    schedule: z.array(z.object({ number: z.number().int().optional(), dueDate: D, amount: z.number().int(), paid: z.boolean().optional(), paidDate: D.nullable().optional() })).optional(),
  });
  app.get('/api/loans', async (req) => listLoans(db, uid(req)));
  app.post('/api/loans', async (req, reply) => reply.code(201).send(await createLoan(db, uid(req), loanBody.parse(req.body))));
  app.patch('/api/loans/:id', async (req) =>
    updateLoan(db, uid(req), (req.params as any).id, loanBody.pick({ name: true, lender: true, principal: true, installmentAmount: true, inProjection: true, payAccountId: true, note: true }).partial().parse(req.body)));
  app.delete('/api/loans/:id', async (req) => {
    await deleteLoan(db, uid(req), (req.params as any).id);
    return { ok: true };
  });
  app.post('/api/loans/:id/installments', async (req, reply) => {
    const b = z.object({ dueDate: D, rawAmount: Amt }).parse(req.body);
    return reply.code(201).send(await addInstallment(db, uid(req), (req.params as any).id, b));
  });
  app.patch('/api/installments/:id', async (req) => {
    const b = z.object({ dueDate: D, rawAmount: Amt }).partial().parse(req.body);
    return updateInstallment(db, uid(req), (req.params as any).id, b);
  });
  app.delete('/api/installments/:id', async (req) => deleteInstallment(db, uid(req), (req.params as any).id));
  app.post('/api/installments/:id/pay', async (req) => {
    const b = z.object({ date: D.optional(), accountId: z.string().uuid().nullable().optional(), record: z.boolean().optional() }).parse(req.body ?? {});
    return payInstallment(db, uid(req), (req.params as any).id, b);
  });
  app.post('/api/installments/:id/unpay', async (req) => unpayInstallment(db, uid(req), (req.params as any).id));

  // ── transferencias entre cuentas (incluye pasar a ahorro y préstamos desde el ahorro) ──
  const trBody = z.object({
    date: D, fromAccountId: z.string().uuid(), toAccountId: z.string().uuid(), rawAmount: Amt,
    kind: z.enum(['transfer', 'loan', 'repayment']).optional(), bucket: z.string().nullable().optional(), note: z.string().nullable().optional(),
    useUntouchable: z.boolean().optional(),
  });
  app.post('/api/transfers', async (req, reply) => reply.code(201).send(await createTransfer(db, uid(req), trBody.parse(req.body))));
  app.patch('/api/transfers/:id', async (req) => updateTransfer(db, uid(req), (req.params as any).id, trBody.partial().parse(req.body)));
  app.delete('/api/transfers/:id', async (req) => {
    await deleteTransfer(db, uid(req), (req.params as any).id);
    return { ok: true };
  });
  app.get('/api/accounts/list', async (req) => listAccounts(db, uid(req)));
  app.get('/api/accounts/:id', async (req) => {
    const q = z.object({ from: D.optional(), to: D.optional() }).parse(req.query);
    return getLedger(db, uid(req), (req.params as any).id, q);
  });
  app.post('/api/accounts/:id/entries', async (req, reply) => {
    const b = z.object({ date: D, concept: z.string(), rawAmount: Amt, tag: z.string().nullable().optional(), bucket: z.string().nullable().optional() }).parse(req.body);
    return reply.code(201).send({ id: await addEntry(db, uid(req), (req.params as any).id, b) });
  });
  app.patch('/api/entries/:id', async (req) => {
    const b = z.object({ date: D, concept: z.string(), rawAmount: Amt, tag: z.string().nullable(), bucket: z.string().nullable() }).partial().parse(req.body);
    await updateEntry(db, uid(req), (req.params as any).id, b);
    return { ok: true };
  });
  app.delete('/api/entries/:id', async (req) => {
    await deleteEntry(db, uid(req), (req.params as any).id);
    return { ok: true };
  });

  // ── recuperación ──
  app.get('/api/recovery', async (req) => getRecovery(db, uid(req)));
  app.put('/api/recovery/cobros/:index', async (req) => {
    const b = z.object({ label: z.string().min(1), income: Amt }).parse(req.body);
    await setCobro(db, uid(req), Number((req.params as any).index), b.label, b.income);
    return { ok: true };
  });
  app.post('/api/recovery/allocations', async (req, reply) => {
    const b = z.object({ cobroIndex: z.number().int(), concept: z.string().min(1), rawAmount: Amt, tag: z.enum(['T', 'A', 'V', 'F']).nullable().optional() }).parse(req.body);
    return reply.code(201).send({ id: await addAllocation(db, uid(req), b) });
  });
  app.patch('/api/recovery/allocations/:id', async (req) => {
    const b = z.object({ concept: z.string(), rawAmount: Amt, tag: z.enum(['T', 'A', 'V', 'F']).nullable() }).partial().parse(req.body);
    await updateAllocation(db, uid(req), (req.params as any).id, b);
    return { ok: true };
  });
  app.delete('/api/recovery/allocations/:id', async (req) => {
    await removeAllocation(db, uid(req), (req.params as any).id);
    return { ok: true };
  });

  // ── reparto de compras ──
  const shares = z.record(z.string(), z.number().min(0).max(1));
  app.get('/api/splits', async (req) => listSplits(db, uid(req)));
  app.post('/api/splits', async (req, reply) => {
    const b = z.object({ name: z.string().min(1), date: D.optional(), participants: z.array(z.string().min(1)).min(1) }).parse(req.body);
    return reply.code(201).send({ id: await createSplit(db, uid(req), b) });
  });
  app.get('/api/splits/:id', async (req) => getSplit(db, uid(req), (req.params as any).id));
  app.delete('/api/splits/:id', async (req) => {
    await deleteSplit(db, uid(req), (req.params as any).id);
    return { ok: true };
  });
  app.post('/api/splits/:id/items', async (req, reply) => {
    const b = z.object({ label: z.string().optional(), total: z.number().min(0), discountPct: z.number().min(0).max(1).optional(), shares }).parse(req.body);
    return reply.code(201).send({ id: await addSplitItem(db, uid(req), (req.params as any).id, b) });
  });
  app.patch('/api/split-items/:id', async (req) => {
    const b = z.object({ label: z.string(), total: z.number().min(0), discountPct: z.number().min(0).max(1), shares }).partial().parse(req.body);
    await updateSplitItem(db, uid(req), (req.params as any).id, b);
    return { ok: true };
  });
  app.delete('/api/split-items/:id', async (req) => {
    await deleteSplitItem(db, uid(req), (req.params as any).id);
    return { ok: true };
  });

  // ── resúmenes ──
  app.get('/api/summary/range', async (req) => {
    const q = z.object({ from: D, to: D }).parse(req.query);
    return rangeSummary(db, uid(req), q.from, q.to);
  });
  app.get('/api/summary/monthly', async (req) => {
    const q = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
    return monthlySummary(db, uid(req), q.year, q.month);
  });
  app.get('/api/summary/health', async (req) => healthReport(db, uid(req), z.object({ asOf: D.optional() }).parse(req.query).asOf));
  app.get('/api/summary/annual', async (req) => annualSummary(db, uid(req), z.coerce.number().int().parse((req.query as any).year)));
}
