import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { del, get, patch, post, qs } from '../../app/api';
import type { Balance, Category, Tx } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { DataGrid, type Column } from '../../components/DataGrid';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Kpi, Money, RangePicker, monthRange, money, today, useToast, type Range } from '../../components/ui';
import { cn } from '../../lib/utils';
import { TransferDialog } from '../accounts/TransferDialog';

const now = new Date();
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const TRANSFER_LABEL = { transfer: 'Transferencia', loan: 'Préstamo del ahorro', repayment: 'Devolución al ahorro' } as const;

export function FlowPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [m0, m1] = monthRange(now.getFullYear(), now.getMonth() + 1);
  const [range, setRange] = useState<Range>({ from: m0, to: m1 });
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [topSignal, setTopSignal] = useState(0);

  const cats = useQuery({ queryKey: ['categories'], queryFn: () => get<Category[]>('/api/categories') });
  // Disponible al inicio del mes (tras el cobro de fin de mes, que entra el día 1) y en la quincena (día 15).
  const ym = (range.from || m0).slice(0, 7);
  const startBal = useQuery({ queryKey: ['transactions', 'bal', `${ym}-01`], queryFn: () => get<{ balance: number }>('/api/balance-at' + qs({ date: `${ym}-01` })) });
  const midBal = useQuery({ queryKey: ['transactions', 'bal', `${ym}-15`], queryFn: () => get<{ balance: number }>('/api/balance-at' + qs({ date: `${ym}-15` })) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get<Balance[]>('/api/accounts') });
  const txs = useQuery({
    queryKey: ['transactions', range, text, categoryId, accountId],
    queryFn: () => get<Tx[]>('/api/transactions' + qs({ from: range.from, to: range.to, text, categoryId, accountId, order: 'desc', limit: 20000 })),
  });
  const rows = txs.data ?? [];
  const accs = (accounts.data ?? []).filter((a) => a.inFlow && !a.archived);
  const allAccs = accounts.data ?? [];

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const t of rows) {
      if (t.kind === 'income') income += t.amount;
      else if (t.kind === 'expense') expense += t.amount;
    }
    return { income, expense };
  }, [rows]);
  const endBalance = rows.length ? rows[0].balance : 0;
  const selectedAcc = accs.find((a) => a.accountId === accountId);

  const refresh = () => Promise.all(['transactions', 'accounts', 'statement', 'health'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const catOptions = (cats.data ?? []).filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name, hint: c.groupName }));
  const catLabel = (id: string) => { const c = catOptions.find((o) => o.value === id); return c ? `${c.label} · ${c.hint}` : ''; };
  const catSearch = catOptions.map((o) => ({ value: o.value, label: `${o.label} · ${o.hint}` }));
  const accOptions = accs.map((a) => ({ value: a.accountId, label: a.name }));
  const isTransfer = (r: Tx) => r.rowType === 'transfer';
  /** En una transferencia, el monto cuenta como ingreso si la cuenta filtrada es el destino. */
  const asIncome = (r: Tx) => (r.kind === 'income') || (isTransfer(r) && !!accountId && r.toAccountId === accountId);
  const asExpense = (r: Tx) => (r.kind === 'expense') || (isTransfer(r) && !asIncome(r));

  const columns: Column<Tx>[] = [
    { key: 'date', label: 'Fecha', width: 112, kind: 'date', editable: true, value: (r) => r.date },
    {
      key: 'item', label: 'Item', width: 250, editable: true,
      value: (r) => r.item,
      display: (r) => isTransfer(r)
        ? <span className="inline-flex items-center gap-1.5"><ArrowRightLeft className="size-3.5 text-sky-600" /> {r.accountName} → {r.toAccountName}{r.item ? <span className="text-muted-foreground"> · {r.item}</span> : null}</span>
        : r.item,
    },
    {
      key: 'category', label: 'Categoría', width: 200, kind: 'search', options: catSearch,
      editable: (r) => !isTransfer(r),
      value: (r) => r.categoryId ?? '',
      editText: (r) => (r.categoryId ? catLabel(r.categoryId) : ''),
      parse: (draft) => {
        const d = norm(draft.trim());
        if (!d) return '';
        const hit = catSearch.find((o) => norm(o.label) === d) ?? catSearch.find((o) => norm(o.label).startsWith(d)) ?? catSearch.find((o) => norm(o.label).includes(d));
        if (!hit) throw new Error(`No hay una categoría que coincida con "${draft}"`);
        return hit.value;
      },
      display: (r) => isTransfer(r)
        ? <span className="text-xs text-sky-700 dark:text-sky-300">{TRANSFER_LABEL[r.transferKind ?? 'transfer']}{r.bucket ? ` · ${r.bucket}` : ''}</span>
        : (r.categoryName ?? <span className="warn">Sin categoría</span>),
    },
    {
      key: 'account', label: 'Cuenta', width: 120, kind: 'select', options: accOptions,
      editable: (r) => !isTransfer(r),
      value: (r) => r.accountId ?? '',
      display: (r) => (isTransfer(r) ? '' : (r.accountName ?? <span className="warn">—</span>)),
    },
    {
      key: 'income', label: 'Ingreso', width: 124, align: 'right', kind: 'money', editable: true,
      value: (r) => (asIncome(r) ? (r.amountExpr ?? r.amount) : ''),
      display: (r) => (asIncome(r) ? <span className={isTransfer(r) ? 'text-sky-700 dark:text-sky-300' : 'pos'}>{money(r.amount)}</span> : ''),
    },
    {
      key: 'expense', label: 'Egreso', width: 124, align: 'right', kind: 'money', editable: true,
      value: (r) => (asExpense(r) ? (r.amountExpr ?? r.amount) : ''),
      display: (r) => (asExpense(r) ? <span className={isTransfer(r) ? 'text-sky-700 dark:text-sky-300' : 'neg'}>{money(r.amount)}</span> : ''),
    },
    { key: 'balance', label: accountId ? 'Saldo cuenta' : 'Saldo disponible', width: 130, align: 'right', value: (r) => r.balance, display: (r) => <Money v={r.balance} /> },
    { key: 'note', label: 'Observación', width: 180, editable: (r) => !isTransfer(r), value: (r) => r.note ?? '' },
    {
      key: 'del', label: '', width: 46, value: () => '',
      display: (r) => (
        <button
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-950 dark:hover:text-rose-300"
          aria-label={`Eliminar ${isTransfer(r) ? 'transferencia' : r.item}`}
          title="Eliminar"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={async () => {
            const label = isTransfer(r) ? `la transferencia ${r.accountName} → ${r.toAccountName}` : `"${r.item}"`;
            if (!confirm(`¿Eliminar ${label} (${money(r.amount)})?`)) return;
            try {
              await del(isTransfer(r) ? `/api/transfers/${r.id}` : `/api/transactions/${r.id}`);
              await refresh();
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          <Trash2 className="size-4" />
        </button>
      ),
    },
  ];

  async function onCommit(id: string, col: string, raw: string) {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (isTransfer(row)) {
      if (col === 'income' || col === 'expense') {
        if (raw.trim() === '') return;
        await patch(`/api/transfers/${id}`, { rawAmount: raw });
      } else if (col === 'item') await patch(`/api/transfers/${id}`, { note: raw || null });
      else if (col === 'date') await patch(`/api/transfers/${id}`, { date: raw });
    } else {
      let body: Record<string, unknown>;
      if (col === 'income' || col === 'expense') {
        if (raw.trim() === '') return;
        body = { kind: col, rawAmount: raw };
      } else if (col === 'category') body = { categoryId: raw || null };
      else if (col === 'account') body = { accountId: raw || null };
      else if (col === 'note') body = { note: raw || null };
      else body = { [col]: raw };
      await patch(`/api/transactions/${id}`, body);
    }
    await refresh();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Flujo de caja</h1>
          <p className="mt-1 text-sm text-muted-foreground">Del más reciente al más antiguo. Por defecto cada movimiento sale de GNB.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          <Button variant="outline" onClick={() => setTransferOpen(true)}><ArrowRightLeft /> Transferir</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Cuenta">
        <Chip on={!accountId} onClick={() => setAccountId('')}>Todas</Chip>
        {accs.map((a) => (
          <Chip key={a.accountId} on={accountId === a.accountId} onClick={() => setAccountId(accountId === a.accountId ? '' : a.accountId)}>
            {a.name}
          </Chip>
        ))}
      </div>

      <div className="grid-cards">
        <Kpi label="Ingresos" value={<Money v={totals.income} />} tone="pos" sub={`${rows.filter((t) => t.kind === 'income').length} movimientos`} />
        <Kpi label="Egresos" value={<Money v={totals.expense} />} tone="neg" sub={`${rows.filter((t) => t.kind === 'expense').length} movimientos`} />
        <Kpi label="Neto del período" value={<Money v={totals.income - totals.expense} signed />} />
        <Kpi label={selectedAcc ? `Saldo ${selectedAcc.name}` : 'Saldo disponible'} value={<Money v={endBalance} signed />} sub={selectedAcc ? undefined : 'Cuentas del flujo'} />
        {!selectedAcc && startBal.data && <Kpi label={`Disponible a inicio de mes (${ym})`} value={<Money v={startBal.data.balance} signed />} sub='Con el cobro de fin de mes del día 1' />}
        {!selectedAcc && midBal.data && <Kpi label={`Disponible en la quincena (${ym}-15)`} value={<Money v={midBal.data.balance} signed />} sub='Con el cobro de la quincena' />}
      </div>

      <QuickAdd
        categories={cats.data ?? []}
        accounts={accs}
        defaultAccountId={accountId || accs.find((a) => a.isDefault)?.accountId || ''}
        onAdded={async () => { await refresh(); setTopSignal((n) => n + 1); }}
        onCategoryCreated={() => qc.invalidateQueries({ queryKey: ['categories'] })}
      />

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar item, nota o cuenta…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Buscar" />
        </div>
        <div className="w-64">
          <Combobox ariaLabel="Filtrar por categoría" value={categoryId} onChange={setCategoryId} options={catOptions} placeholder="Todas las categorías" allowClear searchPlaceholder="Buscar categoría…" />
        </div>
        <span className="text-xs text-muted-foreground">Click en una celda y escribe · fórmulas con = · Ctrl+D copia hacia abajo · pega desde Excel</span>
      </div>

      <DataGrid
        ariaLabel="Movimientos"
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        rowClass={(r) => (isTransfer(r) ? 'transfer' : '')}
        onCommit={onCommit}
        onError={toast.error}
        height="max(320px, calc(100vh - 470px))"
        scrollToTopSignal={topSignal}
      />

      <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} accounts={allAccs} initialFrom={accountId || undefined} />
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
        on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Alta rápida: primero el monto, luego el item, la categoría y el tipo. */
function QuickAdd({
  categories, accounts, defaultAccountId, onAdded, onCategoryCreated,
}: {
  categories: Category[];
  accounts: Balance[];
  defaultAccountId: string;
  onAdded: () => Promise<unknown>;
  onCategoryCreated: () => unknown;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [item, setItem] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState<'income' | 'expense'>('expense');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const amountRef = useRef<HTMLInputElement>(null);
  const acct = accountId || defaultAccountId;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post('/api/transactions', { date, item, kind, rawAmount: amount, categoryId: categoryId || null, accountId: acct || null });
      setAmount('');
      setItem('');
      setCategoryId('');
      await onAdded();
      amountRef.current?.focus(); // listo para cargar el siguiente
    } catch (err) {
      toast.error(err);
    }
  }

  const options = categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name, hint: c.groupName }));

  return (
    <form className="mb-4 rounded-xl border bg-card p-4 shadow-sm" onSubmit={submit} aria-label="Alta rápida">
      <div className="grid gap-3 md:grid-cols-12">
        <Field label="Monto" className="md:col-span-2">
          <Input ref={amountRef} className="num text-right font-medium" placeholder="0 o =fórmula" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="Monto" autoFocus />
        </Field>
        <Field label="Item" className="md:col-span-3">
          <Input placeholder="¿En qué fue?" value={item} onChange={(e) => setItem(e.target.value)} required aria-label="Item" />
        </Field>
        <Field label="Categoría" className="md:col-span-3">
          <Combobox
            ariaLabel="Categoría"
            value={categoryId}
            onChange={setCategoryId}
            options={options}
            placeholder="Buscar categoría…"
            searchPlaceholder="Escribe para buscar…"
            allowClear
            onCreate={async (name) => {
              const c = await post<Category>('/api/categories', { name, groupName: kind === 'income' ? 'Ingresos' : 'Gasto' });
              await onCategoryCreated();
              setCategoryId(c.id);
            }}
          />
        </Field>
        <Field label="Tipo" className="md:col-span-2">
          <div className="chips" role="group" aria-label="Tipo">
            <button type="button" className={kind === 'expense' ? 'on' : ''} onClick={() => setKind('expense')}>Egreso</button>
            <button type="button" className={kind === 'income' ? 'on' : ''} onClick={() => setKind('income')}>Ingreso</button>
          </div>
        </Field>
        <Field label="Cuenta" className="md:col-span-2">
          <Combobox ariaLabel="Cuenta" value={acct} onChange={setAccountId} options={accounts.map((a) => ({ value: a.accountId, label: a.name, hint: a.alias ?? undefined }))} placeholder="GNB" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <Field label="Fecha" className="w-44">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha" />
        </Field>
        <Button type="submit"><Plus /> Agregar movimiento</Button>
      </div>
    </form>
  );
}
