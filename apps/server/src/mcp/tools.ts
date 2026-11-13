import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InvalidAmountError, parseAmount } from '@finanzas/shared';
import { z } from 'zod';
import { NotFoundError, ValidationError, type Db } from '../db/client';
import { categoryIdByName, listCategories } from '../modules/categories/service';
import { createTransaction, deleteTransaction, listTransactions, updateTransaction } from '../modules/transactions/service';
import { createPlannedExpense, listPlannedExpenses, markDone } from '../modules/planned-expenses/service';
import { comparePlans, getPlanView, listPlans } from '../modules/plans/service';
import { accountIdByName, accountStatement, addEntry, getAccount, listBalances, savingsWithdrawals } from '../modules/ledgers/service';
import { createTransfer, deleteTransfer, listBuckets, saveBucket } from '../modules/transfers/service';
import { listAudit, revertAction } from '../modules/audit/service';
import { auditCtx } from '../db/context';
import { createLoan, listLoans, payInstallment, unpayInstallment } from '../modules/loans/service';
import { executePlan, previewExecution } from '../modules/plans/execution';
import { healthReport } from '../modules/summary/health';
import { addSplitItem, createSplit, getSplit, listSplits } from '../modules/splits/service';
import { annualSummary, monthlySummary, projectedBalance, rangeSummary } from '../modules/summary/service';

const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha YYYY-MM-DD');
const Amt = z.union([z.string(), z.number()]).describe('Monto en guaraníes (entero) o expresión como "=45814+4581"');

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string): Result => ({ content: [{ type: 'text', text: msg }], isError: true });

export interface McpCtx {
  db: Db;
  userId: string;
  scopes: string[];
  /** Quién aparece en el historial (p. ej. "ia: Claude"). */
  actor?: string;
}

export function createMcpServer(ctx: McpCtx): McpServer {
  const server = new McpServer({ name: 'finanzas-personales', version: '1.0.0' });
  const { db, userId } = ctx;

  /** Registra una herramienta exigiendo el scope; traduce errores del dominio a mensajes legibles. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    scope: 'finanzas:read' | 'finanzas:write',
    description: string,
    shape: S,
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { description: `${description} (permiso: ${scope})`, inputSchema: shape, annotations: { readOnlyHint: scope === 'finanzas:read' } },
      (async (args: any) => {
        if (!ctx.scopes.includes(scope)) return fail(`Falta el permiso ${scope}. Vuelve a autorizar la conexión con ese permiso.`);
        try {
          return ok(await auditCtx.run({ actor: ctx.actor ?? 'ia', userId }, () => fn(args)));
        } catch (e) {
          if (e instanceof NotFoundError) return fail(`No encontrado: ${e.message}`);
          if (e instanceof InvalidAmountError) return fail('Monto inválido: usa un entero o una expresión aritmética simple.');
          if (e instanceof ValidationError) return fail(`${e.code}${e.detail ? ': ' + e.detail : ''}`);
          console.error('[mcp]', e);
          return fail('Error interno');
        }
      }) as any,
    );
  }

  tool('list_audit_log', 'finanzas:read', 'Historial de cambios (altas, ediciones y borrados) con quién los hizo, agrupados por acción. Cada acción trae su txId para poder deshacerla.', { limit: z.number().int().min(1).max(100).optional(), actor: z.enum(['ia', 'web', 'otros']).optional() }, (a) => listAudit(db, userId, { limit: a.limit ?? 20, actor: a.actor }));
  tool('revert_audit_action', 'finanzas:write', 'Deshace una acción del historial (por txId de list_audit_log): restaura lo borrado, revierte ediciones y quita lo creado. Úsalo solo si el usuario lo pidió.', { txId: z.number().int() }, (a) => revertAction(db, userId, a.txId, ctx.actor ? `${ctx.actor} (deshacer)` : 'ia (deshacer)'));
  tool('list_categories', 'finanzas:read', 'Lista las categorías (subgrupos) y su grupo.', {}, () => listCategories(db, userId));

  tool(
    'list_transactions',
    'finanzas:read',
    'Lista movimientos del flujo (ingresos, egresos y transferencias entre cuentas) con saldo acumulado, del más viejo al más nuevo. Filtra por fechas, categoría, cuenta o texto.',
    { from: D.optional(), to: D.optional(), category: z.string().optional().describe('Nombre de categoría'), account: z.string().optional().describe('Nombre de la cuenta, p. ej. GNB'), text: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    async (a) => {
      const accountId = a.account ? await accountIdByName(db, userId, a.account) : undefined;
      if (a.account && !accountId) throw new NotFoundError(`cuenta "${a.account}" (usa list_accounts)`);
      const categoryId = a.category ? await categoryIdByName(db, userId, a.category) : undefined;
      if (a.category && !categoryId) throw new NotFoundError(`categoría "${a.category}" (usa list_categories)`);
      const rows = await listTransactions(db, userId, { from: a.from, to: a.to, categoryId: categoryId ?? undefined, accountId: accountId ?? undefined, text: a.text, limit: 100000 });
      const limit = a.limit ?? 200;
      return { total: rows.length, shown: Math.min(limit, rows.length), rows: rows.slice(-limit) };
    },
  );

  tool(
    'add_transaction',
    'finanzas:write',
    'Registra un ingreso o egreso en el flujo de caja. Por defecto sale de la cuenta GNB; indica `account` para otro banco, efectivo o tarjeta. Si `account` es un ahorro (p. ej. Ahorro Coomecipar) se anota en la cuenta: un ingreso sin `bucket` es la devolución de un retiro temporal; con `bucket` es un aporte a ese objetivo; un egreso es un retiro temporal.',
    { date: D.optional().describe('Por defecto hoy'), item: z.string().min(1), kind: z.enum(['income', 'expense']), amount: Amt, category: z.string().optional().describe('Nombre exacto de la categoría'), account: z.string().optional().describe('Nombre de la cuenta (list_accounts)'), bucket: z.string().optional().describe('Solo ahorros: objetivo del aporte (Ahorro, Vacaciones...)'), note: z.string().optional() },
    async (a) => {
      if (a.account) {
        const sid = await accountIdByName(db, userId, a.account);
        if (sid && (await getAccount(db, userId, sid)).type === 'savings') {
          const date = a.date ?? new Date().toISOString().slice(0, 10);
          const value = Math.abs(parseAmount(a.amount));
          const tag = a.kind === 'expense' ? 'temp_withdrawal' : a.bucket ? null : 'return';
          const id = await addEntry(db, userId, sid, { date, concept: a.item, rawAmount: a.kind === 'income' ? value : -value, tag, bucket: a.bucket ?? null });
          return { id, account: a.account, date, concept: a.item, kind: a.kind, tag, bucket: a.bucket ?? null };
        }
      }
      const categoryId = a.category ? await categoryIdByName(db, userId, a.category) : null;
      if (a.category && !categoryId) throw new NotFoundError(`categoría "${a.category}" (usa list_categories)`);
      const accountId = a.account ? await accountIdByName(db, userId, a.account) : undefined;
      if (a.account && !accountId) throw new NotFoundError(`cuenta "${a.account}" (usa list_accounts)`);
      return createTransaction(db, userId, {
        accountId,
        date: a.date ?? new Date().toISOString().slice(0, 10),
        item: a.item,
        kind: a.kind,
        rawAmount: a.amount,
        categoryId,
        note: a.note ?? null,
      });
    },
  );

  tool(
    'savings_withdrawals',
    'finanzas:read',
    'Detalle de lo retirado del ahorro (por concepto, ej. "Reponer Osky") y lo ya devuelto, con el pendiente.',
    { account: z.string().optional().describe('Por defecto Ahorro Coomecipar') },
    async (a) => {
      const id = await accountIdByName(db, userId, a.account ?? 'Ahorro Coomecipar');
      if (!id) throw new NotFoundError(`cuenta "${a.account ?? 'Ahorro Coomecipar'}" (usa list_accounts)`);
      return savingsWithdrawals(db, userId, id);
    },
  );

  tool(
    'update_transaction',
    'finanzas:write',
    'Edita un movimiento del flujo (id de list_transactions). Solo se cambian los campos indicados.',
    { id: z.string().uuid(), date: D.optional(), item: z.string().optional(), kind: z.enum(['income', 'expense']).optional(), amount: Amt.optional(), category: z.string().optional(), account: z.string().optional(), note: z.string().optional() },
    async (a) => {
      const categoryId = a.category ? await categoryIdByName(db, userId, a.category) : undefined;
      if (a.category && !categoryId) throw new NotFoundError(`categoría "${a.category}"`);
      const accountId = a.account ? await accountIdByName(db, userId, a.account) : undefined;
      if (a.account && !accountId) throw new NotFoundError(`cuenta "${a.account}"`);
      return updateTransaction(db, userId, a.id, { date: a.date, item: a.item, kind: a.kind, rawAmount: a.amount, categoryId, accountId, note: a.note });
    },
  );
  tool('delete_transaction', 'finanzas:write', 'Elimina un movimiento del flujo. Úsalo solo si el usuario lo pidió.', { id: z.string().uuid() }, async (a) => {
    await deleteTransaction(db, userId, a.id);
    return { ok: true };
  });

  tool('list_planned_expenses', 'finanzas:read', 'Lista gastos puntuales ("otros gastos") con fecha de pago, en un rango.', { from: D.optional(), to: D.optional(), done: z.boolean().optional() }, (a) =>
    listPlannedExpenses(db, userId, a),
  );

  tool(
    'add_planned_expense',
    'finanzas:write',
    'Agrega un gasto puntual con fecha de pago a un cobro (por ejemplo "Quincena" o "Fin de mes").',
    { concept: z.string().min(1), amount: Amt, period: z.string().default('Fin de mes').describe('Etiqueta del cobro, p. ej. "Quincena" o "Fin de mes"'), dueDate: D },
    (a) => createPlannedExpense(db, userId, { concept: a.concept, rawAmount: a.amount, periodLabel: a.period, dueDate: a.dueDate }),
  );

  tool(
    'mark_planned_expense_done',
    'finanzas:write',
    'Marca un gasto puntual como realizado; opcionalmente crea el movimiento en el flujo.',
    { id: z.string().uuid(), createTransaction: z.boolean().default(true) },
    (a) => markDone(db, userId, a.id, { createTransaction: a.createTransaction }),
  );

  tool('list_plans', 'finanzas:read', 'Lista los planes (proyecciones) por año.', { year: z.number().int().optional() }, (a) => listPlans(db, userId, a.year));

  tool(
    'get_plan',
    'finanzas:read',
    'Devuelve un plan con filas, totales y neto por mes y por cobro.',
    { planId: z.string().uuid().optional(), year: z.number().int().optional() },
    async (a) => {
      const id = a.planId ?? (await listPlans(db, userId, a.year))[0]?.id;
      if (!id) throw new NotFoundError('plan');
      return getPlanView(db, userId, id);
    },
  );

  tool('compare_plans', 'finanzas:read', 'Compara el neto mensual de dos planes.', { planA: z.string().uuid(), planB: z.string().uuid() }, (a) => comparePlans(db, userId, a.planA, a.planB));

  tool('monthly_summary', 'finanzas:read', 'Resumen de un mes por grupo y categoría.', { year: z.number().int(), month: z.number().int().min(1).max(12) }, (a) => monthlySummary(db, userId, a.year, a.month));
  tool('range_summary', 'finanzas:read', 'Resumen por grupo y categoría para un rango de fechas.', { from: D, to: D }, (a) => rangeSummary(db, userId, a.from, a.to));
  tool('annual_summary', 'finanzas:read', 'Resumen anual por categoría y mes.', { year: z.number().int() }, (a) => annualSummary(db, userId, a.year));

  tool('list_accounts', 'finanzas:read', 'Saldos de todas las cuentas a una fecha: bancos, efectivo, tarjetas (disponible y deuda), ahorros por objetivo, caja Vibra Lejana y deudas externas.', { asOf: D.optional().describe('Por defecto hoy') }, (a) =>
    listBalances(db, userId, { asOf: a.asOf }),
  );
  tool('account_statement', 'finanzas:read', 'Relatorio de una cuenta (por nombre): saldo inicial, movimientos y saldo final en un rango.', { account: z.string(), from: D.optional(), to: D.optional() }, async (a) => {
    const id = await accountIdByName(db, userId, a.account);
    if (!id) throw new NotFoundError(`cuenta "${a.account}" (usa list_accounts)`);
    return accountStatement(db, userId, id, { from: a.from, to: a.to });
  });
  tool('list_savings_buckets', 'finanzas:read', 'Objetivos de ahorro (Ahorro, Aguinaldo, Vacaciones, Emma…) con su marca de intocable.', {}, () => listBuckets(db, userId));
  tool('set_savings_bucket', 'finanzas:write', 'Crea un objetivo de ahorro o cambia si es intocable (no se presta sin confirmarlo).', { name: z.string().min(1), untouchable: z.boolean() }, (a) => saveBucket(db, userId, a.name, a.untouchable));

  tool('list_loans', 'finanzas:read', 'Préstamos formales (Coomecipar, equipos de Vibra Lejana…) con sus cuotas, pagadas y pendientes.', {}, () => listLoans(db, userId));
  tool(
    'create_loan',
    'finanzas:write',
    'Registra un préstamo con cuotas iguales mensuales. Con inProjection las cuotas pendientes entran a los gastos planeados y a la proyección.',
    { name: z.string().min(1), lender: z.string().optional(), principal: z.number().int().optional(), installmentAmount: z.number().int().positive(), installments: z.number().int().positive().max(600), firstDue: D, inProjection: z.boolean().default(true), payAccount: z.string().optional().describe('Cuenta del flujo desde la que se paga') },
    async (a) => {
      const payAccountId = a.payAccount ? await accountIdByName(db, userId, a.payAccount) : null;
      if (a.payAccount && !payAccountId) throw new NotFoundError(`cuenta "${a.payAccount}" (usa list_accounts)`);
      return createLoan(db, userId, { name: a.name, lender: a.lender ?? null, principal: a.principal, installmentAmount: a.installmentAmount, installments: a.installments, firstDue: a.firstDue, inProjection: a.inProjection, payAccountId });
    },
  );
  tool('pay_installment', 'finanzas:write', 'Marca una cuota pagada (id de list_loans) y registra el egreso en el flujo o en la caja del préstamo.', { installmentId: z.string().uuid(), date: D.optional(), account: z.string().optional() }, async (a) => {
    const accountId = a.account ? await accountIdByName(db, userId, a.account) : null;
    if (a.account && !accountId) throw new NotFoundError(`cuenta "${a.account}" (usa list_accounts)`);
    return payInstallment(db, userId, a.installmentId, { date: a.date, accountId });
  });
  tool('unpay_installment', 'finanzas:write', 'Deshace el pago de una cuota y borra el movimiento que había creado. Úsalo solo si el usuario lo pidió.', { installmentId: z.string().uuid() }, (a) => unpayInstallment(db, userId, a.installmentId));

  tool(
    'add_transfer',
    'finanzas:write',
    'Mueve plata entre cuentas propias por nombre. Ejemplos: GNB → Ahorro Coomecipar con bucket "Ahorro" (pasar a ahorro); kind "loan" desde un ahorro hacia GNB o una tarjeta (préstamo del ahorro); kind "repayment" para devolver al ahorro; pago de tarjeta = GNB → Tarjeta GNB.',
    { date: D.optional().describe('Por defecto hoy'), from: z.string().describe('Cuenta de origen'), to: z.string().describe('Cuenta de destino'), amount: Amt, kind: z.enum(['transfer', 'loan', 'repayment']).default('transfer'), bucket: z.string().optional().describe('Objetivo del ahorro: Ahorro, Aguinaldo, Vacaciones, Emma…'), useUntouchable: z.boolean().optional().describe('Solo si el usuario confirmó usar un objetivo intocable'), note: z.string().optional() },
    async (a) => {
      const fromAccountId = await accountIdByName(db, userId, a.from);
      const toAccountId = await accountIdByName(db, userId, a.to);
      if (!fromAccountId) throw new NotFoundError(`cuenta "${a.from}" (usa list_accounts)`);
      if (!toAccountId) throw new NotFoundError(`cuenta "${a.to}" (usa list_accounts)`);
      return createTransfer(db, userId, { date: a.date ?? new Date().toISOString().slice(0, 10), fromAccountId, toAccountId, rawAmount: a.amount, kind: a.kind, bucket: a.bucket ?? null, note: a.note ?? null, useUntouchable: a.useUntouchable });
    },
  );
  tool('delete_transfer', 'finanzas:write', 'Elimina una transferencia (id de list_transactions). Úsalo solo si el usuario lo pidió.', { id: z.string().uuid() }, async (a) => {
    await deleteTransfer(db, userId, a.id);
    return { ok: true };
  });

  tool(
    'plan_execution_preview',
    'finanzas:read',
    'Muestra lo que "ejecutar el plan" registraría para un cobro (p. ej. Quincena) en un mes: honorario/ingresos, gastos planificados y gastos puntuales con fecha. Indica cuáles ya fueron ejecutados.',
    { planId: z.string().uuid().optional(), year: z.number().int().optional(), period: z.string().describe('Etiqueta del cobro: "Quincena" o "Fin de mes"'), month: z.number().int().min(1).max(12) },
    async (a) => {
      const plan = a.planId ?? (await listPlans(db, userId, a.year ?? new Date().getFullYear()))[0]?.id;
      if (!plan) throw new NotFoundError('plan');
      const v = await getPlanView(db, userId, plan);
      const per = v.periods.find((p) => p.label.toLowerCase() === a.period.toLowerCase());
      if (!per) throw new NotFoundError(`cobro "${a.period}" (${v.periods.map((p) => p.label).join(', ')})`);
      return previewExecution(db, userId, { planId: plan, periodId: per.id, month: a.month });
    },
  );
  tool(
    'execute_plan',
    'finanzas:write',
    'Ejecuta el plan de un cobro en un mes: registra en el flujo los ingresos y gastos indicados (lo ya ejecutado se omite). Llama antes a plan_execution_preview y confirma con el usuario. `account` es la cuenta por defecto de las líneas; `moves` mueve plata entre cuentas (p. ej. honorario de Familiar a GNB).',
    {
      planId: z.string().uuid().optional(), year: z.number().int().optional(), period: z.string(), month: z.number().int().min(1).max(12),
      account: z.string().default('GNB'),
      keys: z.array(z.string()).optional().describe('Líneas a ejecutar (key del preview); por defecto todas las pendientes'),
      incomeAccount: z.string().optional().describe('Cuenta donde entra el honorario/ingresos; por defecto = account'),
      moves: z.array(z.object({ from: z.string(), to: z.string(), amount: Amt, note: z.string().optional() })).optional(),
    },
    async (a) => {
      const plan = a.planId ?? (await listPlans(db, userId, a.year ?? new Date().getFullYear()))[0]?.id;
      if (!plan) throw new NotFoundError('plan');
      const v = await getPlanView(db, userId, plan);
      const per = v.periods.find((p) => p.label.toLowerCase() === a.period.toLowerCase());
      if (!per) throw new NotFoundError(`cobro "${a.period}"`);
      const need = async (name: string) => {
        const id = await accountIdByName(db, userId, name);
        if (!id) throw new NotFoundError(`cuenta "${name}" (usa list_accounts)`);
        return id;
      };
      const pay = await need(a.account);
      const inc = a.incomeAccount ? await need(a.incomeAccount) : pay;
      const pv = await previewExecution(db, userId, { planId: plan, periodId: per.id, month: a.month });
      const chosen = pv.lines.filter((l) => !l.executed && (!a.keys || a.keys.includes(l.key)));
      const transfers = [];
      for (const m of a.moves ?? []) {
        transfers.push({ date: pv.date, fromAccountId: await need(m.from), toAccountId: await need(m.to), rawAmount: m.amount, note: m.note ?? null });
      }
      return executePlan(db, userId, {
        planId: plan, periodId: per.id, month: a.month,
        lines: chosen.map((l) => ({ key: l.key, accountId: l.kind === 'income' ? inc : pay })),
        transfers,
      });
    },
  );

  tool('health_report', 'finanzas:read', 'Reporte de sanidad financiera: liquidez, colchón, tarjetas, deudas, ahorro mensual, plan y orden de datos, con semáforo y puntaje.', { asOf: D.optional() }, (a) => healthReport(db, userId, a.asOf));

  tool('list_splits', 'finanzas:read', 'Lista los repartos de compras compartidas (supermercado).', {}, () => listSplits(db, userId));
  tool('get_split', 'finanzas:read', 'Detalle de un reparto con lo que paga cada persona.', { id: z.string().uuid() }, (a) => getSplit(db, userId, a.id));
  tool(
    'create_split',
    'finanzas:write',
    'Crea un reparto de compra compartida. Sirve para cargar una factura leída de una foto: pasa cada línea con su total y cómo se divide entre participantes (shares suma 1 por línea; si falta, se reparte en partes iguales).',
    {
      name: z.string().min(1).describe('Ej. "Stock Mayo"'), date: D.optional(), participants: z.array(z.string().min(1)).min(1),
      items: z.array(z.object({ label: z.string(), total: z.number().min(0), discountPct: z.number().min(0).max(1).optional(), shares: z.record(z.string(), z.number().min(0).max(1)).optional() })).min(1),
    },
    async (a) => {
      const id = await createSplit(db, userId, { name: a.name, date: a.date, participants: a.participants });
      const even = Object.fromEntries(a.participants.map((p) => [p, 1 / a.participants.length]));
      for (const it of a.items) await addSplitItem(db, userId, id, { label: it.label, total: it.total, discountPct: it.discountPct, shares: it.shares ?? even });
      return getSplit(db, userId, id);
    },
  );

  tool(
    'projected_balance',
    'finanzas:read',
    'Saldo proyectado cobro a cobro desde una fecha, según un plan.',
    { planId: z.string().uuid().optional(), year: z.number().int().optional(), from: D.optional().describe('Por defecto hoy') },
    async (a) => {
      const id = a.planId ?? (await listPlans(db, userId, a.year ?? new Date().getFullYear()))[0]?.id;
      if (!id) throw new NotFoundError('plan');
      return projectedBalance(db, userId, id, a.from ?? new Date().toISOString().slice(0, 10));
    },
  );

  return server;
}
