import { AsyncLocalStorage } from 'node:async_hooks';

/** Quién está haciendo la operación en curso; se copia a la sesión de Postgres para que los triggers del historial lo registren. */
export interface AuditCtx {
  actor: string;
  userId?: string;
}

export const auditCtx = new AsyncLocalStorage<AuditCtx>();
