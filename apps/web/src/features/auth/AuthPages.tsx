import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { friendly, post } from '../../app/api';
import type { Me } from '../../app/types';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

export function LoginPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const me = await post<Me>('/api/auth/login', { email, password });
      qc.setQueryData(['me'], me);
      const next = params.get('next');
      // Solo rutas internas (evita open redirect). /oauth/* debe pasar por el servidor, no por el router.
      if (next && next.startsWith('/') && !next.startsWith('//')) {
        if (next.startsWith('/oauth/')) window.location.assign(next);
        else nav(next, { replace: true });
      } else nav('/flujo', { replace: true });
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <form className="auth-card rounded-xl border bg-card p-7 shadow-lg" onSubmit={submit}>
        <div className="flex items-center gap-2.5 text-[15px] font-bold">
          <span className="grid size-8 place-items-center rounded-lg bg-primary font-extrabold text-primary-foreground">$</span> Finanzas Personales
        </div>
        <h1>Iniciar sesión</h1>
        <label>
          Email
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label>
          Contraseña
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="err-text" role="alert">{error}</div>}
        <Button type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const qc = useQueryClient();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== again) return setError('Las contraseñas nuevas no coinciden');
    try {
      await post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      setDone(true);
      setCur(''); setNext(''); setAgain('');
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(friendly(err));
    }
  }

  const form = (
    <form className="auth-card rounded-xl border bg-card p-7 shadow-lg" onSubmit={submit}>
      <h1>{forced ? 'Elige tu contraseña' : 'Cambiar contraseña'}</h1>
      {forced && <p className="muted">Entraste con la contraseña inicial. Define una nueva (mínimo 8 caracteres) para continuar.</p>}
      <label>
        Contraseña actual
        <Input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />
      </label>
      <label>
        Contraseña nueva
        <Input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label>
        Repetir contraseña nueva
        <Input type="password" autoComplete="new-password" required minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {error && <div className="err-text" role="alert">{error}</div>}
      {done && !forced && <div className="pos" role="status">Contraseña actualizada</div>}
      <Button type="submit">Guardar contraseña</Button>
    </form>
  );
  return forced ? <div className="center-page">{form}</div> : <div style={{ maxWidth: 420 }}>{form}</div>;
}
