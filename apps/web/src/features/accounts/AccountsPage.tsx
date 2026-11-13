import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Banknote, Download, Landmark, Pencil, Plus, Printer, Wallet } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, qs } from '../../app/api';
import { BOX_LABELS, LedgerView } from '../loans/LedgerView';
import type { AccountType, Balance, Statement } from '../../app/types';
import { Combobox } from '../../components/Combobox';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input, NativeSelect } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Kpi, Money, RangePicker, money, monthRange, today, useToast, type Range } from '../../components/ui';
import { cn } from '../../lib/utils';
import { TransferDialog, type TransferMode } from './TransferDialog';

export const TYPE_LABEL: Record<string, string> = { bank: 'Banco', cash: 'Efectivo', card: 'Tarjeta', savings: 'Ahorro', cash_box: 'Caja de grupo', fund: 'Fondo', receivable: 'Persona que me debe' };

export function AccountsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [asOf, setAsOf] = useState(today());
  const [tab, setTab] = useState('resumen');
  const [stmtId, setStmtId] = useState('');
  const [boxId, setBoxId] = useState('');
  const [transfer, setTransfer] = useState<{ open: boolean }>({ open: false });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Balance | null>(null);

  const accounts = useQuery({ queryKey: ['accounts', asOf], queryFn: () => get<Balance[]>('/api/accounts' + qs({ asOf })) });
  // Las deudas con la esposa viven en Préstamos; tarjetas y ahorros en "Tarjetas y ahorro".
  const all = (accounts.data ?? []).filter((a) => a.type !== 'debt' && a.type !== 'receivable' && !a.archived);
  const own = all.filter((a) => a.type === 'bank' || a.type === 'cash');
  const boxes = all.filter((a) => a.type === 'cash_box' || a.type === 'fund');

  const inFlow = own.filter((a) => a.inFlow).reduce((s, a) => s + a.balance, 0);
  const outside = own.filter((a) => !a.inFlow).reduce((s, a) => s + a.balance, 0);
  const boxTotal = boxes.filter((a) => a.type === 'cash_box').reduce((s, a) => s + a.balance, 0);

  useEffect(() => {
    if (!stmtId && all.length) setStmtId((all.find((a) => a.isDefault) ?? all[0]).accountId);
    if (!boxId && boxes.length) setBoxId(boxes[0].accountId);
  }, [all.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const openStatement = (id: string) => { setStmtId(id); setTab('relatorio'); };
  const openBox = (id: string) => { setBoxId(id); setTab('movimientos'); };
  const isToday = asOf === today();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cuentas</h1>
          <p className="mt-1 text-sm text-muted-foreground">Tus bancos, efectivo y cajas{isToday ? '' : ` al ${asOf}`}. Las tarjetas y el ahorro están en “Tarjetas y ahorro”.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Al día
            <Input type="date" className="w-40" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} aria-label="Saldos al día" />
          </label>
          {!isToday && <Button variant="ghost" size="sm" onClick={() => setAsOf(today())}>Hoy</Button>}
          <Button variant="outline" onClick={() => setTransfer({ open: true })}><ArrowRightLeft /> Transferir</Button>
          <Button onClick={() => setCreating(true)}><Plus /> Nueva cuenta</Button>
        </div>
      </div>

      <div className="grid-cards">
        <Kpi label="Disponible en el flujo" value={<Money v={inFlow} signed />} sub="Cuentas marcadas para el flujo de caja" />
        {own.some((a) => !a.inFlow) && <Kpi label="Otras cuentas propias" value={<Money v={outside} signed />} sub="Fuera del flujo" />}
        <Kpi label="Caja Vibra Lejana" value={<Money v={boxTotal} signed />} tone="pos" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos</TabsTrigger>
          <TabsTrigger value="relatorio">Relatorio</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="space-y-7">
          <Section title="Bancos y efectivo" icon={<Landmark className="size-4" />}>
            {own.map((a) => (
              <AccountTile key={a.accountId} a={a} onOpen={() => openStatement(a.accountId)} onEdit={() => setEditing(a)}>
                <div className="num mt-2 text-2xl font-semibold tracking-tight"><Money v={a.balance} signed /></div>
                <div className="mt-1"><Badge variant={a.inFlow ? 'ok' : 'outline'}>{a.inFlow ? 'En el flujo' : 'Fuera del flujo'}</Badge></div>
              </AccountTile>
            ))}
            {!own.length && <Empty>No tienes bancos cargados.</Empty>}
          </Section>

          {boxes.length > 0 && (
            <Section title="Cajas y fondos" icon={<Wallet className="size-4" />}>
              {boxes.map((a) => (
                <AccountTile key={a.accountId} a={a} onOpen={() => openBox(a.accountId)} onEdit={() => setEditing(a)} label={`Abrir movimientos de ${a.name}`}>
                  <div className="num mt-2 text-2xl font-semibold tracking-tight"><Money v={a.balance} signed /></div>
                  <div className="mt-1 text-xs text-muted-foreground">Ver movimientos</div>
                </AccountTile>
              ))}
            </Section>
          )}
        </TabsContent>

        <TabsContent value="movimientos" className="space-y-4">
          {boxes.length ? (
            <>
              <Field label="Caja o fondo" className="w-64">
                <Combobox ariaLabel="Caja o fondo" value={boxId} onChange={setBoxId} options={boxes.map((a) => ({ value: a.accountId, label: a.name, hint: TYPE_LABEL[a.type] }))} />
              </Field>
              {boxId && <LedgerView key={boxId} accountId={boxId} labels={BOX_LABELS} onChanged={() => qc.invalidateQueries({ queryKey: ['accounts'] })} onError={toast.error} />}
            </>
          ) : <Empty>No tienes cajas ni fondos.</Empty>}
        </TabsContent>

        <TabsContent value="relatorio">
          <StatementView accounts={all} accountId={stmtId} onAccount={setStmtId} asOf={asOf} />
        </TabsContent>
      </Tabs>

      <TransferDialog open={transfer.open} onOpenChange={(o) => setTransfer({ open: o })} accounts={accounts.data ?? []} />
      <AccountForm open={creating} onOpenChange={setCreating} types={['bank', 'cash', 'cash_box', 'fund']} />
      <AccountForm open={!!editing} onOpenChange={(o) => !o && setEditing(null)} account={editing ?? undefined} />
    </>
  );
}

export function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2">{icon} {title}</h3>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

export const Empty = ({ children }: { children: React.ReactNode }) => <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">{children}</div>;

export function AccountTile({ a, children, onOpen, onEdit, label }: { a: Balance; children: React.ReactNode; onOpen: () => void; onEdit: () => void; label?: string }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      aria-label={label ?? `Abrir relatorio de ${a.name}`}
      className="group cursor-pointer rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {a.type === 'cash' ? <Banknote className="size-4 text-muted-foreground" /> : null}
            <span className="truncate">{a.name}</span>
            {a.isDefault && <Badge variant="ok">Predeterminada</Badge>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[a.institution && a.institution !== a.name ? a.institution : null, a.alias ? `alias ${a.alias}` : null].filter(Boolean).join(' · ') || TYPE_LABEL[a.type]}
          </div>
        </div>
        <button
          type="button"
          aria-label={`Editar ${a.name}`}
          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Pencil className="size-4" />
        </button>
      </div>
      {children}
    </div>
  );
}

// ── Relatorio ──
export function StatementView({ accounts, accountId, onAccount, asOf }: { accounts: Balance[]; accountId: string; onAccount: (id: string) => void; asOf: string }) {
  const [m0, m1] = monthRange(new Date().getFullYear(), new Date().getMonth() + 1);
  const [range, setRange] = useState<Range>({ from: m0, to: m1 < asOf ? m1 : asOf });
  const q = useQuery({
    queryKey: ['statement', accountId, range],
    enabled: !!accountId,
    queryFn: () => get<Statement>(`/api/accounts/${accountId}/statement` + qs({ from: range.from, to: range.to })),
  });
  const s = q.data;
  const acc = accounts.find((a) => a.accountId === accountId);

  function csv() {
    if (!s) return;
    const lines = [['Fecha', 'Concepto', 'Detalle', 'Objetivo', 'Entrada', 'Salida', 'Saldo'].join(';')];
    for (const r of s.rows) lines.push([r.date, r.concept, r.detail ?? '', r.bucket ?? '', r.delta > 0 ? r.delta : '', r.delta < 0 ? -r.delta : '', r.balance].join(';'));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-${s.account.name}-${range.from || 'inicio'}-${range.to || 'hoy'}.csv`.replace(/\s+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Cuenta" className="w-64">
          <Combobox ariaLabel="Cuenta del relatorio" value={accountId} onChange={onAccount} options={accounts.map((a) => ({ value: a.accountId, label: a.name, hint: TYPE_LABEL[a.type] }))} />
        </Field>
        <RangePicker value={range} onChange={setRange} />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={csv} disabled={!s}><Download /> CSV</Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!s}><Printer /> Imprimir</Button>
        </div>
      </div>

      {s && (
        <>
          <div className="hidden print:block">
            <h1>Relatorio de {s.account.name}</h1>
            <p>{range.from || 'inicio'} → {range.to || 'hoy'}</p>
          </div>
          <div className="grid-cards !mb-0">
            <Kpi label="Saldo inicial" value={<Money v={s.opening} signed />} sub={range.from ? `al ${range.from}` : undefined} />
            <Kpi label="Entradas" value={<Money v={s.totalIn} />} tone="pos" />
            <Kpi label="Salidas" value={<Money v={s.totalOut} />} tone="neg" />
            <Kpi label="Saldo final" value={<Money v={s.closing} signed />} sub={acc?.type === 'card' ? `Deuda: ${money((acc.creditLimit ?? 0) - s.closing)}` : undefined} />
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="simple">
              <thead>
                <tr><th>Fecha</th><th>Concepto</th><th>Detalle</th><th>Objetivo</th><th className="r">Entrada</th><th className="r">Salida</th><th className="r">Saldo</th></tr>
              </thead>
              <tbody>
                <tr className="bg-muted/50"><td colSpan={6} className="text-muted-foreground">Saldo inicial</td><td className="r num font-medium">{money(s.opening)}</td></tr>
                {s.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="num whitespace-nowrap">{r.date}</td>
                    <td>{r.concept}</td>
                    <td className="text-muted-foreground">{r.detail}</td>
                    <td>{r.bucket ? <Badge variant="info">{r.bucket}</Badge> : null}</td>
                    <td className="r num pos">{r.delta > 0 ? money(r.delta) : ''}</td>
                    <td className="r num neg">{r.delta < 0 ? money(-r.delta) : ''}</td>
                    <td className="r num">{money(r.balance)}</td>
                  </tr>
                ))}
                {!s.rows.length && <tr><td colSpan={7} className="empty">Sin movimientos en este rango.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Crear / editar cuenta ──
export function AccountForm({ open, onOpenChange, account, types = ['bank', 'cash', 'cash_box', 'fund'] }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Balance; types?: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState(types[0]);
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [institution, setInstitution] = useState('');
  const [limit, setLimit] = useState('');
  const [opening, setOpening] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [inFlow, setInFlow] = useState(false);
  const editing = !!account;

  useEffect(() => {
    if (!open) return;
    setType(account?.type ?? types[0]);
    setName(account?.name ?? '');
    setAlias(account?.alias ?? '');
    setInstitution(account?.institution ?? '');
    setLimit(account?.creditLimit ? String(account.creditLimit) : '');
    setOpening(account ? String(account.openingBalance) : '');
    setIsDefault(account?.isDefault ?? false);
    setInFlow(account?.inFlow ?? true);
  }, [open, account]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (v: string) => Number(v.replace(/[^\d-]/g, '')) || 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (editing) {
        await patch(`/api/accounts/${account!.accountId}`, {
          name, alias: alias || null, institution: institution || null, openingBalance: num(opening),
          ...(account!.type === 'card' ? { creditLimit: num(limit) } : {}),
          ...(isDefault && !account!.isDefault ? { isDefault: true } : {}),
          ...(account!.type === 'bank' || account!.type === 'cash' ? { inFlow } : {}),
        });
      } else {
        await post('/api/accounts', {
          type, name, alias: alias || null, institution: institution || null,
          ...(type === 'card' ? { creditLimit: num(limit) } : opening ? { openingBalance: num(opening) } : {}),
          isDefault: isDefault && (type === 'bank' || type === 'cash'),
          ...(type === 'bank' || type === 'cash' ? { inFlow } : {}),
        });
      }
      await Promise.all(['accounts', 'statement', 'transactions'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.ok(editing ? 'Cuenta actualizada' : 'Cuenta creada');
      onOpenChange(false);
    } catch (err) {
      toast.error(err);
    }
  }

  const t = account?.type ?? type;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? `Editar ${account!.name}` : 'Nueva cuenta'}</DialogTitle>
          <DialogDescription>{editing ? 'Cambia el nombre, el alias o el saldo con el que empezó la cuenta.' : 'Bancos, efectivo, tarjetas, ahorros o cajas. Solo las cuentas marcadas aparecen en el flujo de caja.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label={editing ? 'Editar cuenta' : 'Nueva cuenta'}>
          {!editing && (
            <Field label="Tipo">
              <NativeSelect value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo de cuenta">
                {types.map((k) => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nombre" /></Field>
          {t !== 'cash' && t !== 'receivable' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Alias / Nº de cuenta"><Input value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="Alias" /></Field>
              <Field label="Banco / institución"><Input value={institution} onChange={(e) => setInstitution(e.target.value)} aria-label="Institución" /></Field>
            </div>
          )}
          {t === 'card' ? (
            <Field label="Línea de crédito"><Input className="num" value={limit} onChange={(e) => setLimit(e.target.value)} required aria-label="Línea de crédito" /></Field>
          ) : t === 'receivable' ? null : (
            <Field label="Saldo inicial" hint="Con cuánto empezó la cuenta. Después se mueve solo con el flujo y las transferencias.">
              <Input className="num" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" aria-label="Saldo inicial" />
            </Field>
          )}
          {(t === 'bank' || t === 'cash') && (
            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={inFlow} onChange={(e) => { setInFlow(e.target.checked); if (!e.target.checked) setIsDefault(false); }} aria-label="Usar en el flujo de caja" />
                Usar en el flujo de caja
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={account?.isDefault || !inFlow} />
                Usar como cuenta predeterminada del flujo
              </label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit">{editing ? 'Guardar' : 'Crear'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
