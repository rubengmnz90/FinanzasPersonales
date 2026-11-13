import { roundPyg } from './money';

export class InvalidAmountError extends Error {
  constructor(input: unknown) {
    super('INVALID_AMOUNT');
    this.name = 'InvalidAmountError';
    this.cause = input;
  }
}

type Tok = { t: 'num'; v: number } | { t: 'op'; v: string };

function normalizeNumber(raw: string): number {
  let s = raw;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new InvalidAmountError(raw);
  return n;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.,]/.test(src[j])) j++;
      out.push({ t: 'num', v: normalizeNumber(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new InvalidAmountError(src);
  }
  return out;
}

/** Parser aritmético seguro (sin eval). Soporta + - * / y paréntesis. */
export function parseAmount(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new InvalidAmountError(input);
    return roundPyg(input);
  }
  let src = input.trim();
  if (src === '') return 0;
  if (src.startsWith('=')) src = src.slice(1);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];

  function expr(): number {
    let v = term();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        p++;
        const r = term();
        v = t.v === '+' ? v + r : v - r;
      } else return v;
    }
  }
  function term(): number {
    let v = factor();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        p++;
        const r = factor();
        if (t.v === '/' && r === 0) throw new InvalidAmountError(src);
        v = t.v === '*' ? v * r : v / r;
      } else return v;
    }
  }
  function factor(): number {
    const t = peek();
    if (!t) throw new InvalidAmountError(src);
    if (t.t === 'op' && t.v === '-') { p++; return -factor(); }
    if (t.t === 'op' && t.v === '+') { p++; return factor(); }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const v = expr();
      const c = peek();
      if (!c || c.t !== 'op' || c.v !== ')') throw new InvalidAmountError(src);
      p++;
      return v;
    }
    if (t.t === 'num') { p++; return t.v; }
    throw new InvalidAmountError(src);
  }

  const result = expr();
  if (p !== toks.length || !Number.isFinite(result) || Math.abs(result) > 1e15) {
    throw new InvalidAmountError(src);
  }
  return roundPyg(result);
}
