export function roundPyg(n: number): number {
  return Math.round(n);
}

const fmt = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
export function formatPyg(n: number): string {
  return fmt.format(roundPyg(n));
}
