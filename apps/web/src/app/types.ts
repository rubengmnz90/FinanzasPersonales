export interface Me { id: string; email: string; mustChangePassword: boolean }
export interface Category { id: string; name: string; groupName: string; archived: boolean }
export type AccountType = 'bank' | 'cash' | 'savings' | 'card' | 'cash_box' | 'fund' | 'debt' | 'receivable';
export interface Tx {
  id: string; rowType: 'tx' | 'transfer'; date: string; item: string; kind: 'income' | 'expense' | 'transfer'; amount: number; amountExpr: string | null;
  categoryId: string | null; categoryName: string | null; groupName: string | null; note: string | null; payer: string | null;
  accountId: string | null; accountName: string | null; toAccountId: string | null; toAccountName: string | null;
  bucket: string | null; transferKind: 'transfer' | 'loan' | 'repayment' | null; balance: number;
}
export interface PlannedExpense { id: string; concept: string; amount: number; periodLabel: string; dueDate: string; done: boolean; transactionId: string | null }
export interface PlanItem { id: string; kind: 'income' | 'expense'; concept: string; auto: string | null; cells: number[]; exprs: (string | null)[]; overrides: boolean[]; computed: number[] }
export interface PlanPeriod { id: string; label: string; dayOfMonth: number; items: PlanItem[]; totals: { expense: number[]; income: number[]; net: number[] } }
export interface PlanView { plan: { id: string; year: number; name: string }; periods: PlanPeriod[]; grand: { expense: number; income: number; net: number }; grandByMonth: { expense: number[]; income: number[]; net: number[] } }
export interface PlanSummary { id: string; year: number; name: string }
export interface Balance {
  accountId: string; type: AccountType; name: string; alias: string | null; institution: string | null; counterparty: string | null; isDefault: boolean; archived: boolean; inFlow: boolean;
  balance: number; owed: number; creditLimit: number | null; openingBalance: number;
  buckets: { bucket: string; balance: number }[]; loansPending: number; untouchable: number; touchable: number;
}
export interface StatementRow { key: string; date: string; source: 'opening' | 'entry' | 'flow' | 'transfer'; id: string | null; concept: string; detail: string | null; delta: number; balance: number; bucket: string | null }
export interface Statement { account: { id: string; type: AccountType; name: string; alias: string | null; creditLimit: number | null }; opening: number; closing: number; totalIn: number; totalOut: number; rows: StatementRow[] }
export interface ExecLine { key: string; source: 'item' | 'planned'; refId: string; kind: 'income' | 'expense'; concept: string; amount: number; date: string; executed: boolean; categoryId: string | null }
export interface ExecPreview { planId: string; planName: string; year: number; month: number; periodId: string; periodLabel: string; date: string; lines: ExecLine[] }
export interface HealthCheck { key: string; label: string; value: number; unit: 'pyg' | 'months' | 'pct' | 'count'; status: 'ok' | 'warn' | 'bad' | 'info'; hint: string }
export interface Health {
  asOf: string; scorePct: number; avgMonthlyIncome: number; avgMonthlyExpense: number; checks: HealthCheck[];
  summary: { liquid: number; savings: number; cardDebt: number; externalDebt: number; loansFromSavings: number; netWorth: number };
}
export interface Allocation { id: string; cobroIndex: number; cobroLabel: string; concept: string; amount: number; tag: 'T' | 'A' | 'V' | 'F' | null }
export interface Recovery {
  debts: { key: 'card' | 'savings'; accountName: string | null; owed: number; paid: number; pending: number }[];
  byTag: { V: number; F: number };
  cobros: { index: number; label: string; income: number; allocations: Allocation[]; spent: number; left: number }[];
}
export interface SplitView {
  id: string; name: string; date: string; participants: string[];
  items: { id: string; label: string; total: number; discountPct: number; shares: Record<string, number> }[];
  result: { items: { net: number; byPerson: Record<string, number> }[]; totals: Record<string, number>; roundingDiff: number };
  shareErrors: { itemId: string; sum: number }[];
}
export interface RangeSummary { from: string; to: string; groups: { group: string; total: number; categories: { name: string; total: number }[] }[]; income: number; expense: number; net: number }
export interface LedgerEntry { id: string; date: string; concept: string; amount: number; tag: string | null; bucket: string | null; person: string | null; balance: number }
export interface Ledger { account: { id: string; type: string; name: string; creditLimit: number | null; counterparty: string | null }; entries: LedgerEntry[]; balance: number; owed: number }
export interface SavingsBucket { name: string; untouchable: boolean }
export interface Installment { id: string; number: number; dueDate: string; amount: number; paid: boolean; paidDate: string | null }
export interface Loan {
  id: string; name: string; lender: string | null; principal: number; installmentAmount: number; inProjection: boolean;
  payAccountId: string | null; ledgerAccountId: string | null; note: string | null; installments: Installment[];
  paidCount: number; paidTotal: number; pendingCount: number; pendingTotal: number; nextDue: string | null;
}

export type SavingsMoveKind = 'deposit' | 'withdrawal' | 'loan' | 'return';
export interface SavingsMove { key: string; source: 'entry' | 'transfer'; id: string; date: string; kind: SavingsMoveKind; concept: string; amount: number; bucket: string | null; person: string | null; balance: number }
export interface SavingsPerson { person: string | null; lent: number; returned: number; pending: number }
export interface SavingsOverview { moves: SavingsMove[]; people: SavingsPerson[]; totals: { deposits: number; withdrawals: number; lent: number; returned: number; pending: number } }
