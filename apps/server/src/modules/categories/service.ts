import type { Queryable } from '../../db/client';
import { NotFoundError } from '../../db/client';

export const GROUPS = ['Ingresos', 'Egresos', 'Gasto', 'Inversion', 'Otros'] as const;
export type GroupName = (typeof GROUPS)[number];

export interface Category {
  id: string;
  name: string;
  groupName: GroupName;
  archived: boolean;
}

const map = (r: any): Category => ({ id: r.id, name: r.name, groupName: r.group_name, archived: r.archived });

export async function listCategories(db: Queryable, userId: string): Promise<Category[]> {
  const r = await db.query('SELECT * FROM categories WHERE user_id=$1 ORDER BY group_name, name', [userId]);
  return r.rows.map(map);
}

export async function upsertCategory(
  db: Queryable,
  userId: string,
  input: { id?: string; name: string; groupName: GroupName; archived?: boolean },
): Promise<Category> {
  if (input.id) {
    const r = await db.query(
      'UPDATE categories SET name=$3, group_name=$4, archived=COALESCE($5, archived) WHERE id=$1 AND user_id=$2 RETURNING *',
      [input.id, userId, input.name, input.groupName, input.archived ?? null],
    );
    if (!r.rowCount) throw new NotFoundError('categoría');
    return map(r.rows[0]);
  }
  const r = await db.query(
    `INSERT INTO categories(user_id,name,group_name) VALUES ($1,$2,$3)
     ON CONFLICT (user_id,name) DO UPDATE SET group_name=EXCLUDED.group_name RETURNING *`,
    [userId, input.name, input.groupName],
  );
  return map(r.rows[0]);
}

export async function categoryIdByName(db: Queryable, userId: string, name: string): Promise<string | null> {
  const r = await db.query('SELECT id FROM categories WHERE user_id=$1 AND lower(name)=lower($2)', [userId, name]);
  return r.rows[0]?.id ?? null;
}

/** Devuelve (creando si hace falta) una categoría por nombre. */
export async function ensureCategory(
  db: Queryable,
  userId: string,
  name: string,
  groupName: GroupName,
): Promise<string> {
  const id = await categoryIdByName(db, userId, name);
  if (id) return id;
  return (await upsertCategory(db, userId, { name, groupName })).id;
}

/** Los 5 grupos y 32 subgrupos de la hoja `Grupos` del Excel. */
export const DEFAULT_CATEGORIES: [string, GroupName][] = [
  ['Entretenimiento', 'Gasto'], ['Comida', 'Gasto'], ['Caprichos', 'Gasto'], ['Saldo', 'Gasto'],
  ['Honorarios', 'Ingresos'], ['Fijos', 'Egresos'], ['Prestamos', 'Egresos'], ['Salidas', 'Gasto'],
  ['Servicios recibidos', 'Egresos'], ['Otros gastos', 'Gasto'], ['Servicios basicos', 'Egresos'],
  ['Vida, Higiene y Aseo', 'Egresos'], ['Vestimenta', 'Inversion'], ['Combustible', 'Egresos'],
  ['Egresos de Emma', 'Egresos'], ['Transporte de Emma', 'Egresos'], ['Reintegos', 'Otros'],
  ['Bebidas', 'Gasto'], ['Comida casera', 'Egresos'], ['Acontecimientos especiales', 'Egresos'],
  ['Salud', 'Egresos'], ['Hardware', 'Inversion'], ['Gastos Impersonales', 'Otros'],
  ['Equipos musicales', 'Inversion'], ['Rockband', 'Gasto'], ['Educacion', 'Inversion'],
  ['Fijos de Emma', 'Egresos'], ['Prestadores de servicio', 'Egresos'], ['Vestimenta de emma', 'Egresos'],
  ['Alimentacion de emma', 'Egresos'], ['Supermercado', 'Egresos'], ['Ahorro', 'Inversion'],
  ['Vacaciones', 'Inversion'], ['Viajes', 'Inversion'], ['Grupo Musical', 'Gasto'], ['Automovil', 'Gasto'],
];

export async function seedCategories(db: Queryable, userId: string): Promise<void> {
  for (const [name, g] of DEFAULT_CATEGORIES) await ensureCategory(db, userId, name, g);
}

export interface CategoryUsage extends Category {
  /** Cuántos movimientos (flujo y compras de tarjeta) usan este rubro. */
  uses: number;
  lastUsed: string | null;
  /** Conceptos recientes distintos, para reconocer de qué trata el rubro. */
  examples: string[];
}

interface HistoryRow { item: string; category_id: string; date: string }

/** Historial de conceptos con rubro: movimientos del flujo y compras de tarjeta. */
async function categorizedHistory(db: Queryable, userId: string): Promise<HistoryRow[]> {
  return (await db.query(
    `SELECT t.item, t.category_id, t.date::text AS date FROM transactions t WHERE t.user_id=$1 AND t.category_id IS NOT NULL
     UNION ALL
     SELECT e.concept, e.category_id, e.date::text FROM ledger_entries e JOIN accounts a ON a.id=e.account_id
       WHERE a.user_id=$1 AND a.type='card' AND e.category_id IS NOT NULL
     ORDER BY date DESC`,
    [userId],
  )).rows;
}

/** Rubros agrupados por tipo (Gasto, Egresos, Ingresos…) con cuánto se usan y ejemplos; los más usados primero dentro de cada tipo. */
export async function listCategoriesWithUsage(
  db: Queryable,
  userId: string,
  opts: { group?: string; includeArchived?: boolean } = {},
): Promise<CategoryUsage[]> {
  const [cats, hist] = await Promise.all([listCategories(db, userId), categorizedHistory(db, userId)]);
  const out: CategoryUsage[] = cats
    .filter((c) => (opts.includeArchived || !c.archived) && (!opts.group || c.groupName.toLowerCase() === opts.group.toLowerCase()))
    .map((c) => {
      const rows = hist.filter((h) => h.category_id === c.id); // ya viene del más reciente al más viejo
      const examples = [...new Set(rows.map((r) => r.item.trim()).filter(Boolean))].slice(0, 5);
      return { ...c, uses: rows.length, lastUsed: rows[0]?.date ?? null, examples };
    });
  const order = new Map(GROUPS.map((g, i) => [g as string, i]));
  return out.sort((a, b) => (order.get(a.groupName) ?? 99) - (order.get(b.groupName) ?? 99) || b.uses - a.uses || a.name.localeCompare(b.name));
}

const stem = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ');

export interface CategorySuggestion {
  category: string;
  group: string;
  /** Puntaje relativo (mayor = más probable). */
  score: number;
  because: string[];
}

/**
 * Sugiere rubros para un concepto según tu historial: mismo concepto (peso alto), palabras en común con conceptos
 * anteriores y palabras del propio nombre del rubro. Devuelve los 5 mejores.
 */
export async function suggestCategories(db: Queryable, userId: string, text: string, opts: { income?: boolean } = {}): Promise<CategorySuggestion[]> {
  const words = [...new Set(stem(text).split(/\s+/).filter((w) => w.length >= 3))];
  if (!words.length) return [];
  const [cats, hist] = await Promise.all([listCategories(db, userId), categorizedHistory(db, userId)]);
  const byId = new Map(cats.filter((c) => !c.archived && (opts.income ? c.groupName === 'Ingresos' : c.groupName !== 'Ingresos')).map((c) => [c.id, c]));
  const whole = stem(text).trim();
  const scores = new Map<string, { score: number; because: Set<string> }>();
  const bump = (id: string, pts: number, why: string) => {
    const e = scores.get(id) ?? { score: 0, because: new Set<string>() };
    e.score += pts;
    if (e.because.size < 3) e.because.add(why);
    scores.set(id, e);
  };
  for (const h of hist) {
    if (!byId.has(h.category_id)) continue;
    const item = stem(h.item).trim();
    if (item === whole) bump(h.category_id, 5, `"${h.item}" ya estaba en este rubro`);
    else {
      const shared = words.filter((w) => item.split(/\s+/).includes(w));
      if (shared.length) bump(h.category_id, shared.length, `"${h.item}" comparte "${shared.join(', ')}"`);
    }
  }
  for (const [id, c] of byId) {
    const nameWords = stem(c.name).split(/\s+/);
    const hit = words.filter((w) => nameWords.some((n) => n.startsWith(w) || w.startsWith(n)));
    if (hit.length) bump(id, 4 * hit.length, `el rubro se llama "${c.name}"`);
  }
  return [...scores.entries()]
    .map(([id, e]) => ({ category: byId.get(id)!.name, group: byId.get(id)!.groupName, score: e.score, because: [...e.because] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
