import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InvalidAmountError, parseAmount } from '@finanzas/shared';
import { z } from 'zod';
import { NotFoundError, ValidationError, type Db } from '../db/client';
import { GROUPS, categoryIdByName, createCategory, deleteCategory, listCategoriesWithUsage, suggestCategories, updateCategory } from '../modules/categories/service';
import { createTransaction, deleteTransaction, listTransactions, updateTransaction } from '../modules/transactions/service';
import { createPlannedExpense, listPlannedExpenses, markDone } from '../modules/planned-expenses/service';
import { comparePlans, getPlanView, listPlans } from '../modules/plans/service';
import { accountIdByName, accountStatement, addEntry, deleteEntry, findEntry, getAccount, listBalances, listUncategorizedCardPurchases, savingsOverview, updateEntry } from '../modules/ledgers/service';
import { createTransfer, deleteTransfer, listBuckets, saveBucket } from '../modules/transfers/service';
import { listPendingRegularization, regularize } from '../modules/regularize/service';
import { listAudit, revertAction } from '../modules/audit/service';
import { auditCtx } from '../db/context';
import { createLoan, listLoans, payInstallment, unpayInstallment } from '../modules/loans/service';
import { executePlan, previewExecution } from '../modules/plans/execution';
import { healthReport } from '../modules/summary/health';
import { adviceReport } from '../modules/summary/advice';
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
          return fail(`Error interno: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
        }
      }) as any,
    );
  }

  tool('list_audit_log', 'finanzas:read', 'Historial de cambios (altas, ediciones y borrados) con quién los hizo, agrupados por acción. Cada acción trae su txId para poder deshacerla.', { limit: z.number().int().min(1).max(100).optional(), actor: z.enum(['ia', 'web', 'otros']).optional() }, (a) => listAudit(db, userId, { limit: a.limit ?? 20, actor: a.actor }));
  tool('revert_audit_action', 'finanzas:write', 'Deshace una acción del historial (por txId de list_audit_log): restaura lo borrado, revierte ediciones y quita lo creado. Úsalo solo si el usuario lo pidió.', { txId: z.number().int() }, (a) => revertAction(db, userId, a.txId, ctx.actor ? `${ctx.actor} (deshacer)` : 'ia (deshacer)'));
  tool(
    'list_categories',
    'finanzas:read',
    'Lista todos los rubros (categorías) con su tipo (Gasto, Egresos, Ingresos, Inversion, Otros), cuántas veces se usan, la última fecha y ejemplos de conceptos. Ordenados por tipo y por uso. Úsalo para elegir el `category` al registrar un gasto; si dudas, usa suggest_category.',
    { group: z.string().optional().describe('Filtra por tipo: Gasto, Egresos, Ingresos, Inversion u Otros'), includeArchived: z.boolean().optional() },
    (a) => listCategoriesWithUsage(db, userId, a),
  );
  tool(
    'suggest_category',
    'finanzas:read',
    'Sugiere el rubro (category) más probable para un concepto, según tu historial de movimientos y compras de tarjeta. Devuelve hasta 5 opciones con el motivo. Si el mejor puntaje es claro, úsalo; si hay empate o ninguno, pregúntale al usuario.',
    { text: z.string().min(2).describe('Concepto, p. ej. "Hosting", "Cerveza salida"'), kind: z.enum(['income', 'expense']).default('expense') },
    (a) => suggestCategories(db, userId, a.text, { income: a.kind === 'income' }),
  );

  const Group = z.enum(GROUPS).describe('Tipo del rubro: Gasto, Egresos, Ingresos, Inversion u Otros');
  const catId = async (name: string) => {
    const id = await categoryIdByName(db, userId, name);
    if (!id) throw new NotFoundError(`categoría "${name}" (usa list_categories)`);
    return id;
  };
  tool(
    'create_category',
    'finanzas:write',
    'Crea un rubro (categoría) nuevo con su tipo. Falla si ya existe uno con ese nombre. Luego se puede usar como `category` en add_transaction, update_transaction, etc.',
    { name: z.string().min(1).describe('Nombre del rubro, p. ej. "Reintegros"'), group: Group },
    (a) => createCategory(db, userId, { name: a.name, groupName: a.group }),
  );
  tool(
    'update_category',
    'finanzas:write',
    'Edita un rubro: renombrarlo (newName), cambiar su tipo (group) o archivarlo/desarchivarlo (archived). Solo se cambian los campos indicados; los movimientos conservan su rubro.',
    { category: z.string().describe('Nombre actual del rubro'), newName: z.string().min(1).optional(), group: Group.optional(), archived: z.boolean().optional() },
    async (a) => updateCategory(db, userId, await catId(a.category), { name: a.newName, groupName: a.group, archived: a.archived }),
  );
  tool(
    'delete_category',
    'finanzas:write',
    'Borra un rubro. Si tiene movimientos, indica en `moveTo` el rubro al que pasarlos (sirve también para fusionar dos rubros); si no, se rechaza (alternativa: archivarlo con update_category). Se puede deshacer desde el historial.',
    { category: z.string(), moveTo: z.string().optional().describe('Rubro destino de los movimientos') },
    async (a) => deleteCategory(db, userId, await catId(a.category), { moveToId: a.moveTo ? await catId(a.moveTo) : undefined }),
  );

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
    'Registra un ingreso o egreso en el flujo de caja. Por defecto sale de la cuenta GNB; indica `account` para otro banco, efectivo o tarjeta. Si `account` es una tarjeta: un egreso es una compra y debe llevar `category` (rubro) para contar en los resúmenes por rubro en la fecha de la compra; puede llevar `payFrom` (cuenta que la pagará) y `group` (compra + IVA). Con `regularize: true` la compra queda por regularizar (ver pending_regularization y regularize). Un ingreso con `payFrom` es el pago de la tarjeta: una sola transferencia que sube la tarjeta y baja esa cuenta, y no cuenta como ingreso ni egreso. Si `account` es una caja (p. ej. Vibra Lejana) o un fondo (p. ej. Ahorro Emma) se anota como movimiento de esa cuenta (ingreso suma, egreso resta; para descontar de un fondo usa un egreso, no hace falta transferencia). Lo mismo para deudas y personas que me deben. Si `account` es un ahorro (p. ej. Ahorro Coomecipar) se anota en la cuenta: un ingreso sin `bucket` es la devolución de un retiro temporal; con `bucket` es un aporte a ese objetivo; un egreso es un préstamo del ahorro (hay que devolverlo; indica `person`), salvo `extraction: true`, que es sacar tu ahorro.',
    { date: D.optional().describe('Por defecto hoy'), item: z.string().min(1), kind: z.enum(['income', 'expense']), amount: Amt, category: z.string().optional().describe('Nombre exacto de la categoría'), account: z.string().optional().describe('Nombre de la cuenta (list_accounts)'), payer: z.string().optional().describe('Solo ingresos: quién pagó (Tellma, CBG...)'), bucket: z.string().optional().describe('Solo ahorros: objetivo del aporte o de la extracción (Ahorro, Vacaciones...)'), person: z.string().optional().describe('Solo ahorros: a quién se le prestó o quién devolvió (Osky, Charlie, Amor, Devolver en cobro...). Sin persona = préstamo normal'), extraction: z.boolean().optional().describe('Solo ahorros, egreso: true = sacaste tu ahorro (meta cumplida); no es préstamo ni hay que devolverlo'), note: z.string().optional(), payFrom: z.string().optional().describe('Solo tarjetas: cuenta desde la que se paga (GNB…). En una compra queda anotada; en un pago (ingreso) descuenta de esa cuenta en la misma operación'), group: z.string().optional().describe('Solo tarjetas: agrupa movimientos relacionados, p. ej. una compra y su IVA (Juegos nov)'), regularize: z.boolean().optional().describe('Solo tarjetas, egreso: true = compra por regularizar (gasto del presupuesto pagado con la tarjeta; el dinero real aún no salió de una cuenta). Luego se regulariza con la herramienta regularize') },
    async (a) => {
      if (a.account) {
        const sid = await accountIdByName(db, userId, a.account);
        const accType = sid ? (await getAccount(db, userId, sid)).type : null;
        if (sid && accType === 'card') {
          const date = a.date ?? new Date().toISOString().slice(0, 10);
          const value = Math.abs(parseAmount(a.amount));
          const payFromId = a.payFrom ? await accountIdByName(db, userId, a.payFrom) : null;
          if (a.payFrom && !payFromId) throw new NotFoundError(`cuenta "${a.payFrom}" (usa list_accounts)`);
          if (a.kind === 'income' && payFromId) {
            // Pago de la tarjeta: una sola transferencia que sube la tarjeta y baja la cuenta de origen. No es ingreso ni egreso.
            const t = await createTransfer(db, userId, { date, fromAccountId: payFromId, toAccountId: sid, rawAmount: value, kind: 'transfer', note: a.item });
            return { id: t.id, type: 'transfer', from: t.fromName, to: t.toName, date, amount: value, nota: 'Pago de tarjeta: no cuenta como ingreso ni egreso en los resúmenes.' };
          }
          const categoryId = a.category ? await categoryIdByName(db, userId, a.category) : null;
          if (a.category && !categoryId) throw new NotFoundError(`categoría "${a.category}" (usa list_categories)`);
          const id = await addEntry(db, userId, sid, {
            date, concept: a.item, rawAmount: a.kind === 'income' ? value : -value, categoryId, payFromAccountId: a.kind === 'expense' ? payFromId : null, groupKey: a.group ?? null,
            regularize: a.kind === 'expense' && a.regularize === true,
          });
          const warning = a.kind === 'expense' && !categoryId
            ? 'Sin category: esta compra NO cuenta en los resúmenes por rubro. Indica category para que cuente.'
            : a.kind === 'income' && !categoryId
              ? 'Este ingreso a la tarjeta no descontó de ninguna cuenta. Si es un pago de la tarjeta, indica payFrom (p. ej. GNB).'
              : undefined;
          return { id, account: a.account, date, concept: a.item, kind: a.kind, category: a.category ?? null, payFrom: a.kind === 'expense' ? a.payFrom ?? null : null, group: a.group ?? null, regularize: a.kind === 'expense' && a.regularize === true ? 'pending' : null, warning };
        }
        if (sid && (accType === 'cash_box' || accType === 'fund' || accType === 'debt' || accType === 'receivable')) {
          // Caja (Vibra Lejana), fondo (Ahorro Emma), deuda o persona que me debe: un egreso baja el saldo, un ingreso lo sube. No toca el flujo de caja.
          const date = a.date ?? new Date().toISOString().slice(0, 10);
          const value = Math.abs(parseAmount(a.amount));
          const id = await addEntry(db, userId, sid, { date, concept: a.item, rawAmount: a.kind === 'income' ? value : -value });
          return { id, account: a.account, date, concept: a.item, kind: a.kind };
        }
        if (sid && accType === 'savings') {
          const date = a.date ?? new Date().toISOString().slice(0, 10);
          const value = Math.abs(parseAmount(a.amount));
          const tag = a.kind === 'expense' ? (a.extraction ? null : 'temp_withdrawal') : a.bucket ? null : 'return';
          const person = tag ? a.person ?? null : null;
          const id = await addEntry(db, userId, sid, { date, concept: a.item, rawAmount: a.kind === 'income' ? value : -value, tag, bucket: a.bucket ?? null, person });
          return { id, account: a.account, date, concept: a.item, kind: a.kind, tag, bucket: a.bucket ?? null, person };
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
        payer: a.payer ?? null,
      });
    },
  );

  tool(
    'savings_overview',
    'finanzas:read',
    'Ahorro por tipo (depósitos, extracciones, préstamos, devoluciones) y lo que debe cada persona (Osky, Charlie, Amor, Devolver en cobro; sin persona = préstamos normales).',
    { account: z.string().optional().describe('Por defecto Ahorro Coomecipar') },
    async (a) => {
      const id = await accountIdByName(db, userId, a.account ?? 'Ahorro Coomecipar');
      if (!id) throw new NotFoundError(`cuenta "${a.account ?? 'Ahorro Coomecipar'}" (usa list_accounts)`);
      return savingsOverview(db, userId, id);
    },
  );

  tool(
    'update_transaction',
    'finanzas:write',
    'Edita un movimiento (id de list_transactions o account_statement): del flujo o de una cuenta como una tarjeta. Solo se cambian los campos indicados. En una compra de tarjeta puedes cambiar category, payFrom y group.',
    { id: z.string().uuid(), date: D.optional(), item: z.string().optional(), kind: z.enum(['income', 'expense']).optional(), amount: Amt.optional(), category: z.string().optional(), account: z.string().optional(), payer: z.string().optional(), note: z.string().optional(), payFrom: z.string().optional().describe('Solo tarjetas'), group: z.string().optional().describe('Solo tarjetas'), regularize: z.boolean().optional().describe('Solo tarjetas: true = marcar por regularizar, false = quitar la marca') },
    async (a) => {
      const categoryId = a.category ? await categoryIdByName(db, userId, a.category) : undefined;
      if (a.category && !categoryId) throw new NotFoundError(`categoría "${a.category}"`);
      const entry = await findEntry(db, userId, a.id);
      if (entry) {
        const payFromAccountId = a.payFrom ? await accountIdByName(db, userId, a.payFrom) : undefined;
        if (a.payFrom && !payFromAccountId) throw new NotFoundError(`cuenta "${a.payFrom}"`);
        // El monto de una entrada lleva signo: negativo = egreso/uso, positivo = ingreso/pago.
        const negative = a.kind ? a.kind === 'expense' : entry.amount < 0;
        const rawAmount = a.amount === undefined && a.kind === undefined ? undefined : (negative ? -1 : 1) * Math.abs(a.amount === undefined ? entry.amount : parseAmount(a.amount));
        await updateEntry(db, userId, a.id, { date: a.date, concept: a.item, rawAmount, categoryId, payFromAccountId, groupKey: a.group, regularize: a.regularize });
        return { ok: true, id: a.id, type: 'entry' };
      }
      const accountId = a.account ? await accountIdByName(db, userId, a.account) : undefined;
      if (a.account && !accountId) throw new NotFoundError(`cuenta "${a.account}"`);
      return updateTransaction(db, userId, a.id, { date: a.date, item: a.item, kind: a.kind, rawAmount: a.amount, categoryId, accountId, payer: a.payer, note: a.note });
    },
  );
  tool('delete_transaction', 'finanzas:write', 'Elimina un movimiento (id de list_transactions o account_statement): del flujo o de una cuenta como una tarjeta. Úsalo solo si el usuario lo pidió.', { id: z.string().uuid() }, async (a) => {
    if (await findEntry(db, userId, a.id)) await deleteEntry(db, userId, a.id);
    else await deleteTransaction(db, userId, a.id);
    return { ok: true };
  });

  tool(
    'uncategorized_card_purchases',
    'finanzas:read',
    'Compras de tarjeta sin rubro: no cuentan en los resúmenes por rubro hasta tener uno. Devuelve cada compra (id, fecha, concepto, monto, tarjeta) con un rubro sugerido según tu historial (`suggested`, null si no hay pista) y el total. Para asignar el rubro usa update_transaction con el id y `category`.',
    {},
    async () => {
      const rows = await listUncategorizedCardPurchases(db, userId);
      const out = [];
      for (const r of rows) out.push({ ...r, suggested: (await suggestCategories(db, userId, r.concept))[0]?.category ?? null });
      return { count: out.length, total: out.reduce((s, r) => s + r.amount, 0), purchases: out };
    },
  );
  tool(
    'pending_regularization',
    'finanzas:read',
    'Cuánto falta regularizar: compras de tarjeta marcadas "por regularizar" (gastos del presupuesto pagados con la tarjeta) cuyo dinero real aún no salió de una cuenta. Devuelve cada compra con lo ya regularizado y lo que le falta, el total pendiente y el total por tarjeta.',
    {},
    () => listPendingRegularization(db, userId),
  );
  tool(
    'regularize',
    'finanzas:write',
    'Regulariza pagando con una cuenta. Con `amount` paga solo ese monto, repartido de la compra más vieja a la más nueva (la última puede quedar a medias, como devolver al ahorro en el cobro); sin `amount` paga todo lo pendiente. Crea UNA transferencia cuenta → tarjeta (no cuenta como ingreso ni egreso) y deja cada abono ligado a su compra. `ids` limita a esas compras; sin `account` usa la cuenta anotada (payFrom) en cada compra. Para pagar con varias cuentas, llámalo varias veces. Borrar la transferencia (delete_transfer) deshace el abono.',
    { account: z.string().optional().describe('Cuenta con la que se paga (GNB, Familiar…)'), amount: Amt.optional().describe('Monto a regularizar ahora; por defecto todo lo pendiente'), ids: z.array(z.string().uuid()).optional().describe('Ids de pending_regularization; por defecto todas'), date: D.optional().describe('Por defecto hoy') },
    async (a) => {
      const fromAccountId = a.account ? await accountIdByName(db, userId, a.account) : null;
      if (a.account && !fromAccountId) throw new NotFoundError(`cuenta "${a.account}" (usa list_accounts)`);
      return regularize(db, userId, { ids: a.ids, fromAccountId, amount: a.amount, date: a.date ?? new Date().toISOString().slice(0, 10) });
    },
  );

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

  tool('get_recommendations', 'finanzas:read', 'Recomendaciones y pasos a seguir según el estado real de las finanzas: cuentas en negativo, saldo proyectado del plan, cuotas y gastos próximos, tarjetas, colchón, ahorro mensual, rubros que se dispararon, deudas y orden de datos. Vienen priorizadas (urgent, important, improve, good) con el motivo, cifras y pasos. Úsalo cuando el usuario pregunte qué hacer, cómo mejorar o qué sigue; explícaselas con tus palabras y ofrécete a ejecutar los pasos.', { asOf: D.optional() }, (a) => adviceReport(db, userId, a.asOf));
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
