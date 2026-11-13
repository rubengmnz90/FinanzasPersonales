import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get } from '../../app/api';
import { useToast } from '../../components/ui';

interface Conn { client_id: string; name: string; since: string; expires: string; scopes: string[] }

export function ConnectPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['connections'], queryFn: () => get<Conn[]>('/api/connections') });
  const origin = window.location.origin;
  const cmd = `claude mcp add --transport http finanzas ${origin}/mcp`;

  return (
    <>
      <div className="page-head"><h1>Conectar una IA</h1></div>
      <div className="card" style={{ marginBottom: 16, maxWidth: 760 }}>
        <h2>1. Agrega el servidor MCP</h2>
        <p className="muted">En Claude Code ejecuta este comando. Después, dentro de Claude Code, escribe <code>/mcp</code> y elige <b>finanzas</b> para autenticar.</p>
        <pre style={{ background: 'var(--muted)', padding: 12, borderRadius: 8, overflow: 'auto', userSelect: 'all' }}>{cmd}</pre>
        <button className="btn" onClick={async () => { await navigator.clipboard?.writeText(cmd); toast.ok('Comando copiado'); }}>Copiar comando</button>
        <h2 style={{ marginTop: 18 }}>2. Autoriza en el navegador</h2>
        <p className="muted">Se abrirá esta página, te pedirá iniciar sesión y mostrará qué permisos otorgas (lectura y/o escritura). Puedes revocar la conexión cuando quieras.</p>
        <h2 style={{ marginTop: 18 }}>3. Pídele cosas</h2>
        <ul className="muted">
          <li>"Resumen de octubre por categoría"</li>
          <li>"Carga un gasto de 45.000 en Comida"</li>
          <li>"¿Cuánto me queda libre después del cobro de fin de mes?"</li>
          <li>"Agrega un gasto puntual de 250.000 en la quincena del 15 de marzo"</li>
        </ul>
      </div>

      <h2>Conexiones activas</h2>
      <table className="simple card" style={{ maxWidth: 760 }}>
        <thead><tr><th>Aplicación</th><th>Permisos</th><th>Desde</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((c) => (
            <tr key={c.client_id}>
              <td>{c.name}</td>
              <td>{c.scopes.map((s) => <span key={s} className="badge" style={{ marginRight: 4 }}>{s.replace('finanzas:', '')}</span>)}</td>
              <td className="muted">{new Date(c.since).toLocaleString('es-PY')}</td>
              <td className="r"><button className="btn sm danger" onClick={async () => { try { await del(`/api/connections/${c.client_id}`); await qc.invalidateQueries({ queryKey: ['connections'] }); toast.ok('Conexión revocada'); } catch (e) { toast.error(e); } }}>Revocar</button></td>
            </tr>
          ))}
          {!q.data?.length && <tr><td colSpan={4} className="empty">Ninguna conexión activa.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
