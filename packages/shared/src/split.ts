export interface SplitItemInput {
  total: number;
  discountPct: number; // 0..1
  shares: Record<string, number>; // persona -> fracción
}
export interface SplitResult {
  items: { net: number; byPerson: Record<string, number> }[];
  totals: Record<string, number>;
  roundingDiff: number;
}

/** Réplica de la hoja "Plantilla distribucion": ROUND(net*share) por persona. */
export function computeSplit(input: { items: SplitItemInput[]; people: string[] }): SplitResult {
  const totals: Record<string, number> = Object.fromEntries(input.people.map((p) => [p, 0]));
  let netSum = 0;
  const items = input.items.map((it) => {
    const net = it.total - it.total * it.discountPct;
    netSum += net;
    const byPerson: Record<string, number> = {};
    for (const p of input.people) {
      const v = Math.round(net * (it.shares[p] ?? 0));
      byPerson[p] = v;
      totals[p] += v;
    }
    return { net, byPerson };
  });
  const sumTotals = Object.values(totals).reduce((a, b) => a + b, 0);
  return { items, totals, roundingDiff: Math.round((netSum - sumTotals) * 100) / 100 };
}
