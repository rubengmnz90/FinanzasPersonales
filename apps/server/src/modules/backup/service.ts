import type { Queryable } from '../../db/client';

/** Tablas del usuario y cómo se filtran. Se excluyen sesiones, claves y tokens (no son datos financieros). */
const TABLES: { name: string; where: string }[] = [
  { name: 'categories', where: 't.user_id=$1' },
  { name: 'accounts', where: 't.user_id=$1' },
  { name: 'savings_buckets', where: 't.user_id=$1' },
  { name: 'transactions', where: 't.user_id=$1' },
  { name: 'transfers', where: 't.user_id=$1' },
  { name: 'ledger_entries', where: 't.account_id IN (SELECT id FROM accounts WHERE user_id=$1)' },
  { name: 'loans', where: 't.user_id=$1' },
  { name: 'loan_installments', where: 't.loan_id IN (SELECT id FROM loans WHERE user_id=$1)' },
  { name: 'plans', where: 't.user_id=$1' },
  { name: 'plan_periods', where: 't.plan_id IN (SELECT id FROM plans WHERE user_id=$1)' },
  { name: 'plan_items', where: 't.plan_id IN (SELECT id FROM plans WHERE user_id=$1)' },
  { name: 'plan_cells', where: 't.item_id IN (SELECT i.id FROM plan_items i JOIN plans p ON p.id=i.plan_id WHERE p.user_id=$1)' },
  { name: 'planned_expenses', where: 't.user_id=$1' },
  { name: 'recovery_cobros', where: 't.user_id=$1' },
  { name: 'recovery_allocations', where: 't.user_id=$1' },
  { name: 'splits', where: 't.user_id=$1' },
  { name: 'split_items', where: 't.split_id IN (SELECT id FROM splits WHERE user_id=$1)' },
];

export interface BackupFile {
  app: 'finanzas-personales';
  format: 1;
  exportedAt: string;
  user: { email: string };
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

/** Todos los datos del usuario en un solo JSON, para guardarlo fuera del servidor. */
export async function exportUserData(db: Queryable, userId: string, email: string): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await db.query(`SELECT to_jsonb(t) AS row FROM ${t.name} t WHERE ${t.where} ORDER BY 1`, [userId]);
    tables[t.name] = r.rows.map((x: any) => x.row);
    counts[t.name] = r.rowCount ?? 0;
  }
  return { app: 'finanzas-personales', format: 1, exportedAt: new Date().toISOString(), user: { email }, counts, tables };
}
