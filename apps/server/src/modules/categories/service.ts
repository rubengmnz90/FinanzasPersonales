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
