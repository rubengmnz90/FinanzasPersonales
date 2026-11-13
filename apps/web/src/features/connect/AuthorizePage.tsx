import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, qs } from '../../app/api';
import { useToast } from '../../components/ui';

const DESCR: Record<string, string> = {
  'finanzas:read': 'Leer: movimientos, planes, cuentas, resúmenes y saldos',
  'finanzas:write': 'Escribir: cargar movimientos y gastos puntuales, marcar pagos',
};

/** Pantalla de consentimiento OAuth: el cliente MCP (p. ej. Claude Code) llega aquí desde /oauth/authorize. */
export function AuthorizePage() {
  const [p] = useSearchParams();
  const toast = useToast();
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const info = useQuery({
    queryKey: ['authorize-info', clientId, redirectUri],
    retry: false,
    queryFn: () => get<{ clientName: string; redirectHost: string; scopes: string[]; email: string }>('/api/oauth/authorize-info' + qs({ client_id: clientId, redirect_uri: redirectUri })),
  });
  const requested = (p.get('scope') ?? '').split(' ').filter((s) => s in DESCR);
  const [granted, setGranted] = useState<string[] | null>(null);
  const scopes = granted ?? (requested.length ? requested : Object.keys(DESCR));
  const [done, setDone] = useState(false);

  async function decide(approve: boolean) {
    try {
      const r = await post<{ redirectTo: string }>('/api/oauth/decision', {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: p.get('code_challenge'),
        code_challenge_method: p.get('code_challenge_method'),
        scope: p.get('scope') ?? undefined,
        state: p.get('state') ?? undefined,
        resource: p.get('resource') ?? undefined,
        approve,
        scopes: approve ? scopes : undefined,
      });
      setDone(true);
      window.location.assign(r.redirectTo);
    } catch (e) {
      toast.error(e);
    }
  }

  if (info.isError) return <div className="card" style={{ maxWidth: 520 }}><h1>Solicitud no válida</h1><p className="muted">El cliente o la dirección de retorno no están registrados. Vuelve a iniciar la conexión desde tu aplicación.</p></div>;
  if (!info.data) return <div className="empty">Cargando…</div>;

  return (
    <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
      <h1>¿Autorizar a «{info.data.clientName}»?</h1>
      <p className="muted">Esta aplicación pide acceso a tus finanzas como <b>{info.data.email}</b>. Volverá a <code>{info.data.redirectHost}</code> al terminar.</p>
      <div style={{ display: 'grid', gap: 8, margin: '14px 0' }}>
        {Object.entries(DESCR).map(([s, d]) => (
          <label key={s} className="toolbar card" style={{ padding: 10 }}>
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={(e) => setGranted(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
            />
            <span><b>{s.replace('finanzas:', '')}</b> — {d}</span>
          </label>
        ))}
      </div>
      <div className="toolbar">
        <button className="btn primary" disabled={done || !scopes.length} onClick={() => decide(true)}>Autorizar</button>
        <button className="btn" disabled={done} onClick={() => decide(false)}>Cancelar</button>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>Puedes revocar el acceso en cualquier momento desde «Conectar IA».</p>
    </div>
  );
}
