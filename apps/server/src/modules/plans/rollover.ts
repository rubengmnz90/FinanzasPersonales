import { ValidationError, type Db } from '../../db/client';
import { balanceAt } from '../transactions/service';
import { clonePlan, getPlanView, type Plan } from './service';

/**
 * Prepara un año nuevo: clona el plan base (sin gastos puntuales ni banderas de "realizado")
 * y devuelve el saldo de cierre del año anterior para el movimiento "Saldo inicial".
 */
export async function rolloverYear(
  db: Db,
  userId: string,
  input: { fromPlanId: string; toYear: number; name?: string },
): Promise<{ plan: Plan; openingBalance: number }> {
  const src = await getPlanView(db, userId, input.fromPlanId); // 404 si no es del usuario
  const exists = await db.query(
    `SELECT 1 FROM plans WHERE user_id=$1 AND year=$2 AND NOT archived AND name = $3`,
    [userId, input.toYear, input.name ?? `Proyección ${input.toYear}`],
  );
  if (exists.rowCount) throw new ValidationError('YEAR_EXISTS', `Ya existe un plan "${input.name ?? `Proyección ${input.toYear}`}" para ${input.toYear}`);
  const plan = await clonePlan(db, userId, input.fromPlanId, {
    name: input.name ?? `Proyección ${input.toYear}`,
    year: input.toYear,
  });
  const openingBalance = await balanceAt(db, userId, `${src.plan.year}-12-31`);
  return { plan, openingBalance };
}
