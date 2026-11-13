import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, BarChart3, CalendarRange, CreditCard, FileSpreadsheet, HandCoins, History, KeyRound, Landmark, PiggyBank, LogOut, Monitor, Moon, Plug, ReceiptText, Sun, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from './api';
import type { Me } from './types';
import { cn } from '../lib/utils';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { CardsPage, SavingsPage } from '../features/savings/CardsSavingsPage';
import { DebtsPage } from '../features/loans/DebtsPage';
import { HistoryPage } from '../features/history/HistoryPage';
import { ImportPage } from '../features/import/ImportPage';
import { AuthorizePage } from '../features/connect/AuthorizePage';
import { ConnectPage } from '../features/connect/ConnectPage';
import { FlowPage } from '../features/flow/FlowPage';
import { LoansPage } from '../features/loans/LoansPage';
import { LoginPage, ChangePasswordPage } from '../features/auth/AuthPages';
import { PlansPage } from '../features/plans/PlansPage';
import { SplitsPage } from '../features/splits/SplitsPage';
import { SummaryPage } from '../features/summary/SummaryPage';

const NAV = [
  ['/flujo', 'Flujo', Wallet],
  ['/planes', 'Planes', CalendarRange],
  ['/cuentas', 'Cuentas', Landmark],
  ['/tarjetas', 'Tarjetas', CreditCard],
  ['/ahorro', 'Ahorro', PiggyBank],
  ['/prestamos', 'Préstamos', Banknote],
  ['/deudas', 'Deudas personales', HandCoins],
  ['/distribucion', 'Distribución', ReceiptText],
  ['/resumenes', 'Resúmenes', BarChart3],
  ['/historial', 'Historial', History],
  ['/importar', 'Importar Excel', FileSpreadsheet],
  ['/conectar', 'Conectar IA', Plug],
] as const;

type Theme = 'auto' | 'light' | 'dark';

/** Aplica el tema resolviendo "automático" con la preferencia del sistema (Tailwind usa data-theme="dark"). */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) ?? 'auto');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.setAttribute('data-theme', theme === 'auto' ? (mq.matches ? 'dark' : 'light') : theme);
    apply();
    localStorage.setItem('theme', theme);
    if (theme === 'auto') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [theme, setTheme] = useTheme();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me | null> => {
      try {
        return await get<Me>('/api/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });

  if (me.isLoading) return <div className="center-page text-muted-foreground">Cargando…</div>;
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <Routes>
      <Route path="/login" element={me.data ? <Navigate to="/flujo" replace /> : <LoginPage />} />
      <Route
        path="*"
        element={
          !me.data ? (
            <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
          ) : me.data.mustChangePassword ? (
            <ChangePasswordPage forced />
          ) : (
            <div className="flex h-full flex-col md:grid md:grid-cols-[236px_1fr]">
              <aside className="flex shrink-0 gap-1 overflow-x-auto border-b bg-card p-2 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:p-3">
                <div className="hidden items-center gap-2.5 px-2 pb-4 pt-1 text-[15px] font-bold md:flex">
                  <span className="grid size-8 place-items-center rounded-lg bg-primary font-extrabold text-primary-foreground">$</span> Finanzas
                </div>
                {NAV.map(([to, label, Icon]) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      )
                    }
                  >
                    <Icon className="size-4" /> {label}
                  </NavLink>
                ))}
                <div className="hidden flex-1 md:block" />
                <div className="hidden flex-col gap-1 border-t pt-3 md:flex">
                  <button
                    className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark')}
                  >
                    <ThemeIcon className="size-4" /> Tema: {theme === 'auto' ? 'automático' : theme === 'dark' ? 'oscuro' : 'claro'}
                  </button>
                  <NavLink to="/cambiar-clave" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                    <KeyRound className="size-4" /> Cambiar contraseña
                  </NavLink>
                  <div className="break-all px-3 py-1 text-xs text-muted-foreground">{me.data.email}</div>
                  <button
                    className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    onClick={async () => {
                      await post('/api/auth/logout');
                      qc.clear();
                      nav('/login');
                      qc.setQueryData(['me'], null);
                    }}
                  >
                    <LogOut className="size-4" /> Salir
                  </button>
                </div>
              </aside>
              <main className="min-h-0 flex-1 overflow-auto px-4 py-5 md:px-8 md:py-7">
                <div className="mx-auto max-w-[1500px]">
                  <Routes>
                    <Route path="/" element={<Navigate to="/flujo" replace />} />
                    <Route path="/flujo" element={<FlowPage />} />
                    <Route path="/planes" element={<PlansPage />} />
                    <Route path="/cuentas" element={<AccountsPage />} />
                    <Route path="/tarjetas" element={<CardsPage />} />
                    <Route path="/ahorro" element={<SavingsPage />} />
                    <Route path="/deudas" element={<DebtsPage />} />
                    <Route path="/historial" element={<HistoryPage />} />
                    <Route path="/importar" element={<ImportPage />} />
                    <Route path="/prestamos" element={<LoansPage />} />
                    <Route path="/recuperacion" element={<Navigate to="/flujo" replace />} />
                    <Route path="/distribucion" element={<SplitsPage />} />
                    <Route path="/resumenes" element={<SummaryPage />} />
                    <Route path="/conectar" element={<ConnectPage />} />
                    <Route path="/authorize" element={<AuthorizePage />} />
                    <Route path="/cambiar-clave" element={<ChangePasswordPage />} />
                    <Route path="*" element={<div className="empty">Página no encontrada</div>} />
                  </Routes>
                </div>
              </main>
            </div>
          )
        }
      />
    </Routes>
  );
}
