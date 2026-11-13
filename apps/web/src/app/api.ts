export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail: string) {
    super(detail || code);
  }
}

const MESSAGES: Record<string, string> = {
  INVALID_AMOUNT: 'Monto inválido. Usa números o una fórmula como =45814+4581',
  INVALID_CREDENTIALS: 'Email o contraseña incorrectos',
  TOO_MANY_ATTEMPTS: 'Demasiados intentos. Espera un minuto.',
  PERIOD_HAS_DATA: 'Ese cobro tiene montos: muévelos a otro cobro o confirma descartarlos.',
  YEAR_EXISTS: 'Ya existe un plan con ese nombre para ese año.',
  NEGATIVE_AMOUNT: 'El monto no puede ser negativo; elige ingreso o egreso.',
  ALREADY_DONE: 'Ese gasto ya estaba marcado como realizado.',
  BUCKET_UNTOUCHABLE: 'Ese objetivo es intocable: confirma que quieres usarlo.',
  ACCOUNT_NOT_ALLOWED: 'El flujo solo usa cuentas propias marcadas para el flujo.',
  ALREADY_PAID: 'La cuota ya está pagada.',
};

export const friendly = (e: unknown): string => {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? (e.detail || e.code);
  return e instanceof Error ? e.message : 'Error inesperado';
};

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'ERROR', data?.detail ?? '');
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T = any>(url: string, body?: unknown) => api<T>('DELETE', url, body);

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
