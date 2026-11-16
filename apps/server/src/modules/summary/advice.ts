import { formatPyg } from '@finanzas/shared';
import type { Queryable } from '../../db/client';
import { listBalances } from '../ledgers/service';
import { listLoans } from '../loans/service';
import { getPlanView, listPlans } from '../plans/service';
import { listPlannedExpenses } from '../planned-expenses/service';
import { listPendingRegularization } from '../regularize/service';
import { healthReport, type HealthReport } from './health';
import { projectedBalance, rangeSummary } from './service';

export type Priority = 'urgent' | 'important' | 'improve' | 'good';

export interface Recommendation {
  key: string;
  priority: Priority;
  title: string;
  /** Por qué se recomienda, con las cifras reales. */
  why: string;
  /** Pasos concretos, en orden. */
  steps: string[];
  /** Monto (Gs.) central de la recomendación, si lo hay. */
  amount?: number;
  /** Pantalla de la app donde se resuelve. */
  link?: { label: string; to: string };
}

export interface Advice {
  asOf: string;
  headline: string;
  recommendations: Recommendation[];
}

/** Datos ya reunidos; `buildAdvice` es una función pura sobre esto (fácil de probar). */
export interface AdviceInput {
  asOf: string;
  health: Pick<HealthReport, 'scorePct' | 'summary' | 'avgMonthlyIncome' | 'avgMonthlyExpense' | 'checks'>;
  accounts: { name: string; type: string; balance: number; owed: number; creditLimit: number | null; inFlow: boolean; archived: boolean; buckets: { bucket: string; balance: number }[]; counterparty?: string | null }[];
  pendingRegularize: { total: number; count: number; byCard: { card: string; total: number }[] };
  /** Gasto por rubro del mes pasado vs. promedio mensual de los 3 meses anteriores a ese. */
  categories: { name: string; group: string; last: number; avg: number }[];
  /** Gasto del mes en curso hasta hoy (sin contar ingresos). */
  monthToDateExpense: number;
  /** Saldo proyectado cobro a cobro (de hoy en adelante). */
  projection: { date: string; period: string; balance: number }[];
  planNegativeMonths: { month: number; net: number }[];
  plannedDue: { concept: string; amount: number; dueDate: string }[];
  loans: { name: string; amount: number; dueDate: string }[];
}

const g = (n: number) => `${formatPyg(n)} Gs`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const dmy = (iso: string) => `${Number(iso.slice(8, 10))} de ${MESES[Number(iso.slice(5, 7)) - 1]}`;
/** Redondea hacia arriba a miles para que los montos sugeridos sean "redondos". */
const up = (n: number, step = 10000) => Math.ceil(n / step) * step;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const ORDER: Record<Priority, number> = { urgent: 0, important: 1, improve: 2, good: 3 };

export function buildAdvice(inp: AdviceInput): Advice {
  const out: Recommendation[] = [];
  const add = (r: Recommendation) => out.push(r);
  const { asOf, health } = inp;
  const inc = health.avgMonthlyIncome;
  const exp = health.avgMonthlyExpense;
  const surplus = inc - exp;
  const live = inp.accounts.filter((a) => !a.archived);
  const check = (k: string) => health.checks.find((c) => c.key === k);

  // ── 1. Cuentas en negativo ──
  const negatives = live.filter((a) => a.inFlow && a.balance < 0);
  if (negatives.length) {
    const deficit = -negatives.reduce((s, a) => s + a.balance, 0);
    const savings = live.filter((a) => a.type === 'savings').reduce((s, a) => s + a.balance, 0);
    add({
      key: 'negative_accounts', priority: 'urgent', amount: deficit,
      title: `Cubrir ${negatives.length === 1 ? 'la cuenta en negativo' : 'las cuentas en negativo'}`,
      why: `${negatives.map((a) => `${a.name} está en ${g(a.balance)}`).join('; ')}. Un saldo negativo casi siempre es una transferencia o un ingreso sin registrar.`,
      steps: [
        'Revisa los últimos movimientos de esa cuenta: ¿falta registrar un ingreso o una transferencia entre cuentas?',
        savings >= deficit
          ? `Si es un descubierto real, cúbrelo con una transferencia de ${g(up(deficit, 1000))} desde Ahorro (queda registrada como préstamo y la repones después).`
          : `Si es un descubierto real, necesitas ${g(up(deficit, 1000))}: el ahorro no alcanza, así que prioriza el próximo cobro para taparlo.`,
        'No gastes de esa cuenta hasta que vuelva a positivo.',
      ],
      link: { label: 'Ver cuentas', to: '/cuentas' },
    });
  }

  // ── 2. Saldo proyectado: el primer momento en que el flujo se queda sin plata ──
  const horizon = inp.projection.filter((p) => dayDiff(asOf, p.date) <= 60 && dayDiff(asOf, p.date) >= 0);
  const firstNeg = horizon.find((p) => p.balance < 0);
  if (firstNeg) {
    const low = horizon.reduce((m, p) => (p.balance < m.balance ? p : m), firstNeg);
    const days = dayDiff(asOf, firstNeg.date);
    add({
      key: 'projected_shortfall', priority: days <= 30 ? 'urgent' : 'important', amount: -low.balance,
      title: 'El plan deja el flujo en negativo',
      why: `Según el plan, el ${dmy(firstNeg.date)} (en ${plural(days, 'día', 'días')}, cobro «${firstNeg.period}») el saldo proyectado cae a ${g(firstNeg.balance)}${low !== firstNeg ? ` y llega a su punto más bajo (${g(low.balance)}) el ${dmy(low.date)}` : ''}.`,
      steps: [
        `Mueve o recorta al menos ${g(up(-low.balance, 1000))} de egresos planificados antes de esa fecha, o consigue ese ingreso extra.`,
        'En Planes, revisa las filas más grandes de ese cobro y decide cuáles se pueden pasar al siguiente.',
        'Evita sumar compras no planificadas hasta superar ese punto.',
      ],
      link: { label: 'Abrir Planes', to: '/planes' },
    });
  } else if (inp.planNegativeMonths.length) {
    const worst = inp.planNegativeMonths.reduce((m, x) => (x.net < m.net ? x : m));
    add({
      key: 'plan_negative_months', priority: inp.planNegativeMonths.length > 2 ? 'important' : 'improve', amount: -worst.net,
      title: `${plural(inp.planNegativeMonths.length, 'mes del plan gasta', 'meses del plan gastan')} más de lo que ingresa`,
      why: `Meses con neto negativo: ${inp.planNegativeMonths.map((m) => `${MESES[m.month - 1]} (${g(m.net)})`).join(', ')}. El saldo aguanta por ahora, pero se va consumiendo.`,
      steps: [
        `Para ${MESES[worst.month - 1]}, el peor mes, busca reducir ${g(up(-worst.net, 1000))} o adelantar ingresos.`,
        'Revisa en Planes qué gastos puntuales se pueden repartir en otros meses.',
      ],
      link: { label: 'Abrir Planes', to: '/planes' },
    });
  }

  // ── 3. Cuotas de préstamos vencidas o próximas ──
  const overdue = inp.loans.filter((l) => l.dueDate < asOf);
  const soon = inp.loans.filter((l) => l.dueDate >= asOf && dayDiff(asOf, l.dueDate) <= 14);
  if (overdue.length) {
    add({
      key: 'loans_overdue', priority: 'urgent', amount: overdue.reduce((s, l) => s + l.amount, 0),
      title: `${plural(overdue.length, 'cuota vencida', 'cuotas vencidas')}`,
      why: overdue.map((l) => `${l.name}: ${g(l.amount)} (venció el ${dmy(l.dueDate)})`).join('; ') + '. Pagar tarde puede traer intereses o recargos.',
      steps: ['Págala hoy si hay saldo (si ya la pagaste, márcala como pagada para que no quede pendiente).', 'Si no alcanza, contacta al acreedor para acordar una fecha antes de que corran intereses.'],
      link: { label: 'Ver préstamos', to: '/prestamos' },
    });
  }
  if (soon.length) {
    const total = soon.reduce((s, l) => s + l.amount, 0);
    const liquid = health.summary.liquid;
    add({
      key: 'loans_soon', priority: liquid < total ? 'urgent' : 'improve', amount: total,
      title: `Cuotas por pagar en los próximos 14 días`,
      why: `${soon.map((l) => `${l.name} ${g(l.amount)} (${dmy(l.dueDate)})`).join('; ')}. Disponible hoy: ${g(liquid)}${liquid < total ? ', no alcanza para todas' : ''}.`,
      steps: liquid < total
        ? [`Reserva ${g(up(total, 1000))} del próximo ingreso exclusivamente para estas cuotas.`, 'Si hay una que puedas postergar sin costo, paga primero la de fecha más cercana.']
        : ['Sepáralas mentalmente del saldo disponible: ya están comprometidas.', 'Pásalas por Préstamos apenas las pagues para que el flujo quede al día.'],
      link: { label: 'Ver préstamos', to: '/prestamos' },
    });
  }

  // ── 4. Gastos planificados que vencen pronto o ya vencieron ──
  const pOver = inp.plannedDue.filter((p) => p.dueDate < asOf);
  const pSoon = inp.plannedDue.filter((p) => p.dueDate >= asOf && dayDiff(asOf, p.dueDate) <= 14);
  if (pOver.length) {
    add({
      key: 'planned_overdue', priority: 'important', amount: pOver.reduce((s, p) => s + p.amount, 0),
      title: `${plural(pOver.length, 'gasto planificado sin marcar', 'gastos planificados sin marcar')}`,
      why: `Pasó su fecha: ${pOver.slice(0, 4).map((p) => `${p.concept} (${g(p.amount)})`).join(', ')}${pOver.length > 4 ? '…' : ''}. Si ya lo pagaste, falta registrarlo; si no, es una deuda pendiente.`,
      steps: ['Marca como realizado lo que ya pagaste (crea el movimiento en el flujo con la fecha correcta).', 'Lo que no pagaste, reprograma la fecha o pásalo al siguiente cobro.'],
      link: { label: 'Ver gastos planificados', to: '/planes' },
    });
  }
  if (pSoon.length) {
    add({
      key: 'planned_soon', priority: 'improve', amount: pSoon.reduce((s, p) => s + p.amount, 0),
      title: 'Gastos planificados en los próximos 14 días',
      why: pSoon.slice(0, 5).map((p) => `${p.concept} ${g(p.amount)} (${dmy(p.dueDate)})`).join('; ') + '.',
      steps: ['Verifica que haya saldo en la cuenta con la que los vas a pagar.'],
      link: { label: 'Ver gastos planificados', to: '/planes' },
    });
  }

  // ── 5. Tarjetas ──
  const cards = live.filter((a) => a.type === 'card');
  const limit = cards.reduce((s, a) => s + (a.creditLimit ?? 0), 0);
  const owed = cards.reduce((s, a) => s + a.owed, 0);
  const util = limit > 0 ? (owed / limit) * 100 : 0;
  if (limit > 0 && util > 30) {
    const toPay = owed - limit * 0.3;
    const heavy = [...cards].sort((a, b) => b.owed - a.owed)[0];
    add({
      key: 'card_use', priority: util > 60 ? 'important' : 'improve', amount: toPay,
      title: `Bajar el uso de tarjetas (${Math.round(util)}% del límite)`,
      why: `Debes ${g(owed)} sobre un límite de ${g(limit)}. Pasar del 30% encarece el crédito y te deja sin margen para imprevistos.`,
      steps: [
        `Paga ${g(up(toPay, 1000))} para dejar el uso en 30%, empezando por ${heavy.name} (${g(heavy.owed)}).`,
        surplus > 0 ? `Con tu sobrante mensual (${g(surplus)}) lo cubres en ${Math.max(1, Math.ceil(toPay / surplus))} ${Math.ceil(toPay / surplus) <= 1 ? 'mes' : 'meses'}.` : 'Mientras tanto, evita nuevas compras con tarjeta: cada una suma a lo que ya debes.',
        'Paga el total (no el mínimo) cuando puedas, para no acumular intereses.',
      ],
      link: { label: 'Ver tarjetas', to: '/tarjetas' },
    });
  }
  if (inp.pendingRegularize.count > 0) {
    const top = [...inp.pendingRegularize.byCard].sort((a, b) => b.total - a.total)[0];
    add({
      key: 'pending_regularize', priority: 'improve', amount: inp.pendingRegularize.total,
      title: 'Regularizar compras de tarjeta',
      why: `${plural(inp.pendingRegularize.count, 'compra marcada', 'compras marcadas')} «por regularizar» suman ${g(inp.pendingRegularize.total)}${top ? ` (la mayor parte en ${top.card})` : ''}: ya se gastó, pero aún no salió de tu cuenta.`,
      steps: ['Cuando pagues la tarjeta, usa Regularizar para registrar la transferencia desde la cuenta que corresponda.', 'Hasta entonces, trata ese monto como no disponible aunque el saldo del banco lo muestre.'],
      link: { label: 'Ver tarjetas', to: '/tarjetas' },
    });
  }

  // ── 6. Liquidez ──
  const liq = check('liquidity');
  if (liq && liq.status !== 'info' && liq.status !== 'ok' && !negatives.length) {
    const need = Math.max(0, exp - health.summary.liquid);
    add({
      key: 'liquidity', priority: liq.status === 'bad' ? 'important' : 'improve', amount: need,
      title: 'Aumentar el dinero disponible',
      why: `Tienes ${g(health.summary.liquid)} disponibles, que cubren ${liq.value.toFixed(1)} meses de tu gasto promedio (${g(exp)}). Lo sano es al menos 1 mes.`,
      steps: [
        `Apunta a tener ${g(up(exp, 10000))} disponibles: te faltan ${g(up(need, 1000))}.`,
        'Antes de cualquier compra grande, espera a superar ese nivel.',
      ],
      link: { label: 'Ver flujo', to: '/flujo' },
    });
  }

  // ── 7. Tasa de ahorro y a dónde recortar ──
  const rate = check('saving_rate');
  const expCats = inp.categories.filter((c) => c.group !== 'Ingresos' && c.name !== 'Sin categoría');
  const heavyCats = [...expCats].sort((a, b) => b.last - a.last).filter((c) => c.last > 0).slice(0, 3);
  if (rate && rate.status !== 'info' && rate.value < 10) {
    const target = inc * 0.1;
    const cut = target - surplus; // cuánto recortar (o ahorrar más) para llegar al 10%
    const discretionary = expCats.filter((c) => c.group === 'Gasto' || c.group === 'Otros').sort((a, b) => b.last - a.last).filter((c) => c.last > 0).slice(0, 3);
    add({
      key: 'saving_rate', priority: surplus < 0 ? 'important' : 'improve', amount: Math.max(0, cut),
      title: surplus < 0 ? 'Estás gastando más de lo que ingresas' : 'Ahorras muy poco de lo que ingresas',
      why: `En promedio ingresas ${g(inc)} y gastas ${g(exp)} por mes: ${surplus < 0 ? `faltan ${g(-surplus)} cada mes` : `sobran ${g(surplus)} (${Math.round(rate.value)}%)`}. La meta mínima es 10% (${g(target)}).`,
      steps: [
        `Necesitas liberar unos ${g(up(cut, 1000))} al mes (${exp > 0 ? Math.round((cut / exp) * 100) : 0}% de tu gasto).`,
        discretionary.length
          ? `Los rubros discrecionales más pesados el mes pasado: ${discretionary.map((c) => `${c.name} (${g(c.last)})`).join(', ')}. Recortar 20% ahí libera ~${g(up(discretionary.reduce((s, c) => s + c.last, 0) * 0.2, 1000))}.`
          : heavyCats.length ? `Los rubros más pesados el mes pasado: ${heavyCats.map((c) => `${c.name} (${g(c.last)})`).join(', ')}. Empieza revisando esos.` : 'Revisa tus rubros más grandes en Resúmenes → Por rango.',
        'Fija el ahorro como un egreso del plan (apenas cobras), en lugar de ahorrar «lo que sobre».',
      ],
      link: { label: 'Ver gasto por rubro', to: '/resumenes' },
    });
  }

  // ── 8. Rubros que se dispararon ──
  const spikes = expCats
    .filter((c) => c.avg > 0 && c.last >= c.avg * 1.3 && c.last - c.avg >= Math.max(exp * 0.03, 1))
    .sort((a, b) => (b.last - b.avg) - (a.last - a.avg)).slice(0, 3);
  if (spikes.length) {
    add({
      key: 'category_spikes', priority: 'improve', amount: spikes.reduce((s, c) => s + (c.last - c.avg), 0),
      title: `${spikes.length === 1 ? 'Un rubro se disparó' : 'Rubros que se dispararon'} el mes pasado`,
      why: spikes.map((c) => `${c.name}: ${g(c.last)} vs. ${g(c.avg)} de promedio (+${Math.round(((c.last - c.avg) / c.avg) * 100)}%)`).join('; ') + '.',
      steps: ['Mira el detalle de esos rubros: ¿fue algo puntual (no se repite) o un hábito nuevo?', 'Si es un hábito, ponle un tope mensual en el plan para que no crezca sin que lo notes.'],
      link: { label: 'Ver el mes', to: '/resumenes' },
    });
  }

  // ── 9. Ritmo del mes en curso ──
  const dom = Number(asOf.slice(8, 10));
  const dim = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 0)).getUTCDate();
  if (dom >= 7 && exp > 0 && inp.monthToDateExpense > 0) {
    const pace = (inp.monthToDateExpense / dom) * dim;
    if (pace >= exp * 1.15) {
      add({
        key: 'month_pace', priority: pace >= exp * 1.3 ? 'important' : 'improve', amount: pace - exp,
        title: 'Este mes vas más gastador que tu promedio',
        why: `Llevas ${g(inp.monthToDateExpense)} gastados al día ${dom}; a este ritmo cerrarías el mes en ~${g(pace)}, ${Math.round(((pace - exp) / exp) * 100)}% más que tu promedio (${g(exp)}).`,
        steps: [`Para cerrar en tu promedio, limita lo que queda del mes a ~${g(Math.max(0, exp - inp.monthToDateExpense))}.`, 'Pospón las compras no urgentes al mes siguiente.'],
        link: { label: 'Ver flujo', to: '/flujo' },
      });
    }
  }

  // ── 10. Prestado del ahorro sin reponer ──
  const lent = health.summary.loansFromSavings;
  if (lent > 0) {
    const monthly = surplus > 0 ? Math.min(lent, up(surplus * 0.5, 10000)) : 0;
    add({
      key: 'loans_from_savings', priority: health.summary.savings > 0 && lent > health.summary.savings ? 'important' : 'improve', amount: lent,
      title: 'Reponer lo prestado del ahorro',
      why: `Sacaste ${g(lent)} del ahorro para el flujo o las tarjetas y falta devolverlos. Mientras tanto, tu colchón real es menor al que ves.`,
      steps: [
        monthly > 0 ? `Devuelve ${g(monthly)} al mes (la mitad de tu sobrante): lo repones en ${Math.ceil(lent / monthly)} ${Math.ceil(lent / monthly) === 1 ? 'mes' : 'meses'}.` : 'Primero hay que generar sobrante mensual; mientras tanto no saques más del ahorro.',
        'Registra cada devolución como transferencia de tipo «devolución» para que el pendiente baje.',
      ],
      link: { label: 'Ver ahorro', to: '/ahorro' },
    });
  }

  // ── 11. Colchón de emergencia ──
  const ef = check('emergency');
  if (ef && ef.status !== 'info' && ef.status !== 'ok') {
    const savingsBal = live.filter((a) => a.type === 'savings').flatMap((a) => a.buckets).filter((k) => /colch|emergen/i.test(k.bucket)).reduce((s, k) => s + k.balance, 0) || health.summary.savings;
    const gap = Math.max(0, exp * 3 - savingsBal);
    const monthly = inc > 0 ? up(inc * 0.1, 10000) : 0;
    add({
      key: 'emergency', priority: ef.status === 'bad' ? 'important' : 'improve', amount: gap,
      title: 'Construir el colchón de emergencia',
      why: `Tu colchón cubre ${ef.value.toFixed(1)} meses de gasto; la meta es 3 (${g(exp * 3)}). Faltan ${g(gap)}.`,
      steps: [
        monthly > 0 ? `Aparta ${g(monthly)} al mes (10% de tus ingresos): llegas a la meta en ${Math.ceil(gap / monthly)} meses.` : 'Registra tus ingresos para poder calcular un aporte mensual.',
        surplus < monthly && inc > 0 ? `Hoy tu sobrante es ${g(Math.max(0, surplus))}, menos que ese aporte: combina esto con el recorte de gastos de arriba.` : 'Hazlo con una transferencia automática el día del cobro.',
        'Ponlo en un objetivo «Colchón» marcado como intocable en Ahorro.',
      ],
      link: { label: 'Ver ahorro', to: '/ahorro' },
    });
  }

  // ── 12. Deudas externas ──
  const ext = check('external_debt');
  if (ext && ext.status !== 'info' && ext.status !== 'ok') {
    add({
      key: 'external_debt', priority: ext.status === 'bad' ? 'important' : 'improve', amount: health.summary.externalDebt,
      title: 'Plan para bajar las deudas externas',
      why: `Debes ${g(health.summary.externalDebt)}, ${Math.round(ext.value)}% de tu ingreso anual.`,
      steps: ['Ordena las deudas por costo: ataca primero la de mayor interés, pagando el mínimo en las demás.', 'Destina cada sobrante o ingreso extra a esa deuda hasta saldarla; luego pasa a la siguiente.', 'Evita nuevas deudas hasta que el porcentaje baje de 50%.'],
      link: { label: 'Ver deudas', to: '/deudas' },
    });
  }

  // ── 13. Dinero que te deben ──
  const receivables = live.filter((a) => a.type === 'debt' && a.balance > 0);
  if (receivables.length) {
    const total = receivables.reduce((s, a) => s + a.balance, 0);
    add({
      key: 'receivables', priority: 'improve', amount: total,
      title: 'Cobrar lo que te deben',
      why: `${receivables.map((a) => `${a.counterparty ?? a.name}: ${g(a.balance)}`).join('; ')}. Es dinero tuyo que hoy no está disponible.`,
      steps: ['Pide una fecha concreta de pago a cada persona (mejor en cuotas pequeñas si no puede todo junto).', 'Cuando te paguen, regístralo para que el saldo se actualice y vuelva a tu flujo.'],
      link: { label: 'Ver deudas personales', to: '/deudas' },
    });
  }

  // ── 14. Orden de los datos ──
  const unc = check('uncategorized');
  if (unc && unc.value > 0) {
    add({
      key: 'uncategorized', priority: 'improve', amount: unc.value,
      title: `Categorizar ${plural(unc.value, 'movimiento', 'movimientos')}`,
      why: 'Los movimientos sin categoría no aparecen en los resúmenes por rubro: tus porcentajes y comparaciones quedan incompletos.',
      steps: ['En Flujo, filtra por «Sin categoría» y asigna el rubro (puedes crear uno nuevo desde ahí o en Categorías).', 'Con rubros al día, estas recomendaciones se vuelven más precisas.'],
      link: { label: 'Ir al flujo', to: '/flujo' },
    });
  }
  if (inc === 0 && exp > 0) {
    add({
      key: 'no_income', priority: 'improve', title: 'No hay ingresos registrados en los últimos 3 meses',
      why: 'Sin ingresos, no puedo calcular tu ahorro mensual ni la cobertura de deudas.',
      steps: ['Registra tus cobros en Flujo (con categoría de tipo Ingresos).'], link: { label: 'Ir al flujo', to: '/flujo' },
    });
  }

  // ── 15. Si todo está bien: qué hacer con el sobrante ──
  const urgentOrImportant = out.filter((r) => r.priority === 'urgent' || r.priority === 'important');
  if (!urgentOrImportant.length && surplus > 0) {
    add({
      key: 'put_surplus_to_work', priority: 'good', amount: surplus,
      title: 'Poner el sobrante a trabajar',
      why: `Cada mes te sobran ~${g(surplus)} (${Math.round((surplus / inc) * 100)}% de tus ingresos) y no hay alertas graves.`,
      steps: [
        'Orden sugerido: 1) completar el colchón de 3 meses, 2) pagar deudas caras, 3) objetivos (vacaciones, equipo, inversión).',
        `Automatiza: separa ${g(up(surplus * 0.7, 10000))} al mes el día del cobro y gasta libremente el resto.`,
      ],
      link: { label: 'Ver ahorro', to: '/ahorro' },
    });
  }

  out.sort((a, b) => ORDER[a.priority] - ORDER[b.priority]);

  const nUrgent = out.filter((r) => r.priority === 'urgent').length;
  const nImportant = out.filter((r) => r.priority === 'important').length;
  const headline = nUrgent
    ? `${plural(nUrgent, 'cosa urgente', 'cosas urgentes')} para resolver ya${nImportant ? ` y ${plural(nImportant, 'importante', 'importantes')}` : ''}. Empieza por la primera.`
    : nImportant
      ? `Nada urgente, pero hay ${plural(nImportant, 'punto importante', 'puntos importantes')} para mejorar tu situación.`
      : out.length
        ? 'Vas bien. Estos son ajustes para afinar tus finanzas.'
        : 'Todo en orden: no hay recomendaciones por ahora.';
  return { asOf, headline, recommendations: out };
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthBounds = (iso: string, offset: number): [string, string] => {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + offset, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const ym = d.toISOString().slice(0, 7);
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
};

/** Reúne los datos de la cuenta y arma las recomendaciones a una fecha. */
export async function adviceReport(db: Queryable, userId: string, asOf?: string): Promise<Advice> {
  const at = asOf ?? new Date().toISOString().slice(0, 10);
  const [health, balances, pending, loans] = await Promise.all([
    healthReport(db, userId, at),
    listBalances(db, userId, { asOf: at }),
    listPendingRegularization(db, userId),
    listLoans(db, userId),
  ]);

  // Gasto por rubro: mes pasado vs. promedio de los 3 meses anteriores a ese.
  const [lastFrom, lastTo] = monthBounds(at, -1);
  const [avgFrom] = monthBounds(at, -4);
  const [, avgTo] = monthBounds(at, -2);
  const [lastSum, avgSum, mtd] = await Promise.all([
    rangeSummary(db, userId, lastFrom, lastTo),
    rangeSummary(db, userId, avgFrom, avgTo),
    rangeSummary(db, userId, monthBounds(at, 0)[0], at),
  ]);
  const flat = (s: typeof lastSum) => new Map(s.groups.flatMap((gr) => gr.categories.map((c) => [`${gr.group}|${c.name}`, c.total] as const)));
  const lastMap = flat(lastSum);
  const avgMap = flat(avgSum);
  const categories = [...new Set([...lastMap.keys(), ...avgMap.keys()])].map((k) => {
    const [group, name] = k.split('|');
    return { name, group, last: lastMap.get(k) ?? 0, avg: (avgMap.get(k) ?? 0) / 3 };
  });

  // Plan del año: meses negativos y saldo proyectado.
  let projection: AdviceInput['projection'] = [];
  let planNegativeMonths: AdviceInput['planNegativeMonths'] = [];
  const plan = (await listPlans(db, userId, Number(at.slice(0, 4))))[0];
  if (plan) {
    const cur = Number(at.slice(5, 7));
    const v = await getPlanView(db, userId, plan.id);
    planNegativeMonths = v.grandByMonth.net.map((net, i) => ({ month: i + 1, net })).filter((m) => m.month >= cur && m.net < 0);
    projection = await projectedBalance(db, userId, plan.id, at);
  }

  const planned = await listPlannedExpenses(db, userId, { done: false, to: addDays(at, 14) });
  const loanDue = loans.flatMap((l) => {
    const next = l.installments.filter((i) => !i.paid && i.dueDate <= addDays(at, 14));
    return next.map((i) => ({ name: l.name, amount: i.amount, dueDate: i.dueDate }));
  });

  return buildAdvice({
    asOf: at,
    health,
    accounts: balances,
    pendingRegularize: pending,
    categories,
    monthToDateExpense: mtd.expense,
    projection,
    planNegativeMonths,
    plannedDue: planned.map((p) => ({ concept: p.concept, amount: p.amount, dueDate: p.dueDate })),
    loans: loanDue,
  });
}
