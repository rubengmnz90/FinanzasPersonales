import { describe, expect, it } from 'vitest';
import { parseAmount } from './expr';
import { computeSplit } from './split';

describe('parseAmount', () => {
  it.each([
    ['=45814+4581', 50395],
    ['1.050.000', 1050000],
    ['=(883114-223313)', 659801],
    ['=1500000/2', 750000],
    ['-87400', -87400],
    ['=-275000/2', -137500],
    ['=7100*4', 28400],
    ['1.050.000+50.000', 1100000],
    ['', 0],
  ])('%s -> %d', (inp, out) => expect(parseAmount(inp)).toBe(out));

  it('acepta números', () => expect(parseAmount(750000)).toBe(750000));
  it.each(['=process.exit()', '1;2', '=2**9999', '=1/0', '=(1+2', 'abc', '=1e400'])(
    'rechaza %s',
    (inp) => expect(() => parseAmount(inp)).toThrow('INVALID_AMOUNT'),
  );
});

describe('computeSplit', () => {
  it('replica filas de Plantilla', () => {
    const r = computeSplit({
      people: ['Emma', 'Ali', 'Yo'],
      items: [
        { total: 51726, discountPct: 0.2, shares: { Emma: 0.2, Ali: 0.4, Yo: 0.4 } },
        { total: 28400, discountPct: 0.2, shares: { Yo: 1 } },
      ],
    });
    expect(r.items[0].net).toBeCloseTo(41380.8);
    expect(r.items[0].byPerson).toEqual({ Emma: 8276, Ali: 16552, Yo: 16552 });
    expect(r.items[1].byPerson.Yo).toBe(22720);
    expect(r.roundingDiff).toBeCloseTo(0.8, 5);
  });
});
