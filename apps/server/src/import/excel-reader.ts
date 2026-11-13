import ExcelJS from 'exceljs';

export type Sheet = ExcelJS.Worksheet;

export async function openWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

/** Valor "calculado" de una celda (resultado si es fórmula). */
export function val(ws: Sheet, row: number, col: number): unknown {
  const v = ws.getCell(row, col).value as any;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('error' in v) return null;
    if ('result' in v) {
      const r = v.result;
      return r && typeof r === 'object' && 'error' in r ? null : (r ?? null);
    }
    if ('richText' in v) return (v.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('formula' in v || 'sharedFormula' in v) return null;
  }
  return v;
}

export function num(ws: Sheet, row: number, col: number): number {
  const v = val(ws, row, col);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

export function text(ws: Sheet, row: number, col: number): string {
  const v = val(ws, row, col);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

export function date(ws: Sheet, row: number, col: number): string | null {
  const v = val(ws, row, col);
  if (v instanceof Date && v.getUTCFullYear() > 1990) return v.toISOString().slice(0, 10);
  return null;
}

/** Si la celda era una fórmula aritmética simple (p. ej. =45814+4581) devuelve "=45814+4581". */
export function simpleExpr(ws: Sheet, row: number, col: number): string | null {
  const v = ws.getCell(row, col).value as any;
  if (v && typeof v === 'object' && typeof v.formula === 'string' && /^[0-9+\-*/().\s]+$/.test(v.formula)) {
    return '=' + v.formula.replace(/\s+/g, '');
  }
  return null;
}

/** Última fila con contenido real (exceljs devuelve filas "fantasma" por formato). */
export function lastRow(ws: Sheet): number {
  return ws.actualRowCount > 0 ? ws.rowCount : 0;
}
