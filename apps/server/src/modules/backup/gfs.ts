/**
 * Retención GFS (Grandfather-Father-Son) de los respaldos automáticos.
 *
 * Se hacen varias copias por día; con el tiempo se van adelgazando:
 *   - reciente: todas las copias de los últimos `recentDays` días (así no se pierde nada de las últimas horas),
 *   - diaria:   la última copia de cada día de los últimos `daily` días,
 *   - semanal:  la última copia de cada semana (lunes a domingo) de las últimas `weekly` semanas,
 *   - mensual:  la última copia de cada mes de los últimos `monthly` meses.
 * Una misma copia puede cumplir varios roles. Lo que no cumple ninguno se borra. La copia más nueva nunca se borra.
 * Los días, semanas y meses se cuentan en la zona horaria `tz`.
 */
export interface Copy {
  key: string;
  at: Date;
  size?: number;
}

export interface Policy {
  recentDays: number;
  daily: number;
  weekly: number;
  monthly: number;
  tz: string;
}

export type Tier = 'reciente' | 'diaria' | 'semanal' | 'mensual';

export const DEFAULT_POLICY: Policy = { recentDays: 2, daily: 7, weekly: 4, monthly: 12, tz: 'America/Asuncion' };

const NAME_RE = /(?:^|\/)finanzas-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/;

/** Nombre del archivo de una copia: finanzas-AAAAMMDD-HHMMSS.zip (hora UTC). */
export function copyName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `finanzas-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.zip`;
}

/** Fecha de una copia según su nombre, o null si el archivo no es una copia de esta app (esos nunca se tocan). */
export function parseCopyDate(key: string): Date | null {
  const m = NAME_RE.exec(key);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Día calendario (como número de días desde 1970) de un instante en la zona `tz`. */
export function localDayNumber(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
}

const weekIndex = (dayNumber: number) => Math.floor((dayNumber + 3) / 7); // semanas de lunes a domingo (1/1/1970 fue jueves)
const monthIndex = (dayNumber: number) => {
  const d = new Date(dayNumber * 86_400_000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/** Para cada copia que se conserva, por qué (uno o más roles). Las que no aparecen se pueden borrar. */
export function classify(copies: Copy[], now: Date, policy: Policy): Map<string, Tier[]> {
  const keep = new Map<string, Tier[]>();
  const add = (key: string, tier: Tier) => keep.set(key, [...new Set([...(keep.get(key) ?? []), tier])]);
  const sorted = [...copies].sort((a, b) => b.at.getTime() - a.at.getTime()); // la más nueva primero
  if (!sorted.length) return keep;

  const today = localDayNumber(now, policy.tz);
  const thisWeek = weekIndex(today);
  const thisMonth = monthIndex(today);
  const newestIn = { day: new Set<number>(), week: new Set<number>(), month: new Set<number>() };

  add(sorted[0].key, 'reciente'); // la última copia siempre se queda
  for (const c of sorted) {
    if (now.getTime() - c.at.getTime() < policy.recentDays * 86_400_000) add(c.key, 'reciente');
    const d = localDayNumber(c.at, policy.tz);
    // como van de la más nueva a la más vieja, la primera que se ve de cada día/semana/mes es la última de ese período
    if (d > today - policy.daily && !newestIn.day.has(d)) { newestIn.day.add(d); add(c.key, 'diaria'); }
    const w = weekIndex(d);
    if (w > thisWeek - policy.weekly && !newestIn.week.has(w)) { newestIn.week.add(w); add(c.key, 'semanal'); }
    const m = monthIndex(d);
    if (m > thisMonth - policy.monthly && !newestIn.month.has(m)) { newestIn.month.add(m); add(c.key, 'mensual'); }
  }
  return keep;
}

/** Copias que ya no hace falta conservar. */
export function selectToDelete(copies: Copy[], now: Date, policy: Policy): Copy[] {
  const keep = classify(copies, now, policy);
  return copies.filter((c) => !keep.has(c.key));
}

// ── Horarios ──

/** Diferencia (ms) entre la hora de pared de `tz` y UTC en ese instante. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instante UTC en que la hora de pared de `tz` es y-m-d h:00. */
function zonedToUtc(y: number, m: number, d: number, h: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

/** Última hora programada (en `tz`) que ya pasó: p. ej. con horas 0,6,12,18 y son las 14:20, devuelve las 12:00 de hoy. */
export function latestSlot(now: Date, hours: number[], tz: string): Date {
  const hs = [...new Set(hours)].filter((h) => Number.isInteger(h) && h >= 0 && h <= 23).sort((a, b) => b - a);
  if (!hs.length) throw new Error('BACKUP_HOURS necesita al menos una hora entre 0 y 23');
  const today = localDayNumber(now, tz);
  for (let back = 0; back <= 2; back++) {
    const date = new Date((today - back) * 86_400_000);
    for (const h of hs) {
      const slot = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, tz);
      if (slot.getTime() <= now.getTime()) return slot;
    }
  }
  throw new Error('No se pudo calcular el horario del respaldo');
}
