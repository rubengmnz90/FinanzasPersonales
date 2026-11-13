import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right';
  kind?: 'text' | 'money' | 'date' | 'select' | 'search' | 'number';
  /** ¿Se puede editar la celda de esta fila? */
  editable?: boolean | ((row: T) => boolean);
  options?: { value: string; label: string }[];
  /** Valor crudo que se muestra al editar. */
  value: (row: T) => string | number | null;
  /** Contenido mostrado cuando no se edita. */
  display?: (row: T) => ReactNode;
  cellClass?: (row: T) => string;
  /** Texto inicial del editor (por defecto `value`). En `search` es la etiqueta visible. */
  editText?: (row: T) => string;
  /** Convierte lo escrito en el valor a guardar (en `search`: etiqueta → id). */
  parse?: (draft: string) => string;
}

export interface DataGridProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T) => string;
  onCommit: (rowId: string, colKey: string, raw: string) => Promise<void>;
  onError?: (e: unknown) => void;
  rowClass?: (row: T) => string;
  footer?: ReactNode;
  height?: number | string;
  rowHeight?: number;
  /** Fila fija al final para alta rápida. */
  extraRow?: ReactNode;
  ariaLabel?: string;
  /** Al cambiar este número, la grilla baja hasta la última fila (p. ej. tras agregar un registro). */
  scrollToEndSignal?: number;
  /** Igual que scrollToEndSignal pero hacia la primera fila (listas de más nuevo a más viejo). */
  scrollToTopSignal?: number;
}

type Pos = { r: number; c: number };

const isEditable = <T,>(col: Column<T>, row: T) =>
  typeof col.editable === 'function' ? col.editable(row) : !!col.editable;

export function DataGrid<T>({
  columns, rows, rowId, onCommit, onError, rowClass, footer, height = 520, rowHeight = 34, extraRow, ariaLabel, scrollToEndSignal = 0, scrollToTopSignal = 0,
}: DataGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ draft: string } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const editRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const committing = useRef(false);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    initialRect: { width: 1000, height: typeof height === 'number' ? height : 520 },
  });

  const handledSignal = useRef(scrollToEndSignal);
  useEffect(() => {
    if (scrollToEndSignal !== handledSignal.current && rows.length > 0) {
      handledSignal.current = scrollToEndSignal;
      virt.scrollToIndex(rows.length - 1, { align: 'end' });
    }
  }, [scrollToEndSignal, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handledTop = useRef(scrollToTopSignal);
  useEffect(() => {
    if (scrollToTopSignal !== handledTop.current) {
      handledTop.current = scrollToTopSignal;
      virt.scrollToIndex(0, { align: 'start' });
      scrollRef.current?.scrollTo({ top: 0 });
    }
  }, [scrollToTopSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalWidth = useMemo(() => columns.reduce((s, c) => s + c.width, 0), [columns]);

  const commit = useCallback(
    async (pos: Pos, raw: string) => {
      const row = rows[pos.r];
      const col = columns[pos.c];
      if (!row || !col) return;
      const id = rowId(row);
      if (String(col.value(row) ?? '') === raw) return; // sin cambios
      const k = `${id}:${col.key}`;
      setPending((p) => ({ ...p, [k]: raw }));
      try {
        await onCommit(id, col.key, raw);
      } catch (e) {
        onError?.(e);
      } finally {
        setPending((p) => {
          const { [k]: _drop, ...rest } = p;
          return rest;
        });
      }
    },
    [rows, columns, rowId, onCommit, onError],
  );

  const move = useCallback(
    (dr: number, dc: number, from: Pos | null = active) => {
      if (!from) return;
      const r = Math.max(0, Math.min(rows.length - 1, from.r + dr));
      const c = Math.max(0, Math.min(columns.length - 1, from.c + dc));
      setActive({ r, c });
      virt.scrollToIndex(r);
    },
    [active, rows.length, columns.length, virt],
  );

  const startEdit = (initial?: string) => {
    if (!active) return;
    const row = rows[active.r];
    const col = columns[active.c];
    if (!row || !isEditable(col, row)) return;
    setEditing({ draft: initial ?? (col.editText ? col.editText(row) : String(col.value(row) ?? '')) });
  };

  const finishEdit = async (dr: number, dc: number, save: boolean) => {
    if (!editing || !active || committing.current) return;
    const pos = active;
    const col = columns[pos.c];
    let draft = editing.draft;
    if (save && col?.parse) {
      try {
        draft = col.parse(editing.draft);
      } catch (e) {
        onError?.(e); // se queda editando para corregir
        return;
      }
    }
    committing.current = true;
    setEditing(null);
    move(dr, dc, pos);
    scrollRef.current?.focus();
    try {
      if (save) await commit(pos, draft);
    } finally {
      committing.current = false;
    }
  };

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      if (editRef.current instanceof HTMLInputElement) editRef.current.select();
    }
  }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !active) return;
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); return move(1, 0);
      case 'ArrowUp': e.preventDefault(); return move(-1, 0);
      case 'ArrowLeft': e.preventDefault(); return move(0, -1);
      case 'ArrowRight': e.preventDefault(); return move(0, 1);
      case 'Tab': e.preventDefault(); return move(0, e.shiftKey ? -1 : 1);
      case 'Enter':
      case 'F2': e.preventDefault(); return startEdit();
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        const row = rows[active.r];
        if (row && isEditable(columns[active.c], row)) void commit(active, '');
        return;
      }
      case 'Escape': return setActive(null);
    }
    if (mod && e.key.toLowerCase() === 'd') {
      // Rellenar hacia abajo con el valor de la celda activa.
      e.preventDefault();
      const row = rows[active.r];
      const below = rows[active.r + 1];
      const col = columns[active.c];
      if (row && below && isEditable(col, below)) {
        void commit({ r: active.r + 1, c: active.c }, String(col.value(row) ?? ''));
        move(1, 0);
      }
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1) startEdit(e.key); // teclear sobrescribe
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    if (editing || !active) return;
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split('\t');
      for (let j = 0; j < cells.length; j++) {
        const pos = { r: active.r + i, c: active.c + j };
        const row = rows[pos.r];
        const col = columns[pos.c];
        if (!row || !col || !isEditable(col, row)) continue;
        await commit(pos, cells[j].trim());
      }
    }
  };

  const items = virt.getVirtualItems();

  return (
    <div className="dg" role="grid" aria-label={ariaLabel}>
      <div className="dg-scroll" ref={scrollRef} tabIndex={0} style={{ height }} onKeyDown={onKeyDown} onPaste={onPaste}>
        <div style={{ minWidth: totalWidth }}>
          <div className="dg-head" style={{ position: 'sticky', top: 0, zIndex: 4 }}>
            {columns.map((c) => (
              <div key={c.key} className={`dg-cell ${c.align === 'right' ? 'r' : ''}`} style={{ width: c.width }}>
                {c.label}
              </div>
            ))}
          </div>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const row = rows[vi.index];
              const id = rowId(row);
              return (
                <div
                  key={id}
                  className={`dg-row ${rowClass?.(row) ?? ''}`}
                  role="row"
                  style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${vi.start}px)`, height: rowHeight }}
                >
                  {columns.map((col, ci) => {
                    const sel = active?.r === vi.index && active.c === ci;
                    const editable = isEditable(col, row);
                    const pk = `${id}:${col.key}`;
                    const isPending = pk in pending;
                    const isEditing = sel && editing;
                    return (
                      <div
                        key={col.key}
                        role="gridcell"
                        aria-selected={sel}
                        data-col={col.key}
                        className={`dg-cell ${col.align === 'right' ? 'r' : ''} ${editable ? '' : 'ro'} ${sel ? 'sel' : ''} ${isPending ? 'pending' : ''} ${col.cellClass?.(row) ?? ''}`}
                        style={{ width: col.width, height: rowHeight, lineHeight: `${rowHeight}px` }}
                        onMouseDown={() => {
                          if (editing) void finishEdit(0, 0, true);
                          setActive({ r: vi.index, c: ci });
                        }}
                        onDoubleClick={() => {
                          setActive({ r: vi.index, c: ci });
                          setTimeout(() => startEdit(), 0);
                        }}
                      >
                        {isEditing ? (
                          col.kind === 'select' ? (
                            <select
                              ref={editRef as React.RefObject<HTMLSelectElement>}
                              className="dg-edit"
                              value={editing.draft}
                              onChange={(e) => setEditing({ draft: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); void finishEdit(1, 0, true); }
                                if (e.key === 'Escape') { e.preventDefault(); void finishEdit(0, 0, false); }
                                if (e.key === 'Tab') { e.preventDefault(); void finishEdit(0, e.shiftKey ? -1 : 1, true); }
                              }}
                              onBlur={() => void finishEdit(0, 0, true)}
                            >
                              <option value="">—</option>
                              {col.options?.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              ref={editRef as React.RefObject<HTMLInputElement>}
                              className={`dg-edit ${col.align === 'right' ? 'r' : ''}`}
                              type="text"
                              list={col.kind === 'search' ? `dl-${col.key}` : undefined}
                              inputMode={col.kind === 'money' || col.kind === 'number' ? 'text' : undefined}
                              value={editing.draft}
                              placeholder={col.kind === 'date' ? 'AAAA-MM-DD' : undefined}
                              onChange={(e) => setEditing({ draft: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); void finishEdit(1, 0, true); }
                                else if (e.key === 'Escape') { e.preventDefault(); void finishEdit(0, 0, false); }
                                else if (e.key === 'Tab') { e.preventDefault(); void finishEdit(0, e.shiftKey ? -1 : 1, true); }
                                e.stopPropagation();
                              }}
                              onBlur={() => void finishEdit(0, 0, true)}
                            />
                          )
                        ) : isPending ? (
                          pending[pk]
                        ) : col.display ? (
                          col.display(row)
                        ) : (
                          String(col.value(row) ?? '')
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {columns.filter((c) => c.kind === 'search').map((c) => (
            <datalist key={c.key} id={`dl-${c.key}`}>
              {c.options?.map((o) => <option key={o.value} value={o.label} />)}
            </datalist>
          ))}
          {rows.length === 0 && <div className="empty">Sin datos para mostrar</div>}
          {extraRow}
        </div>
      </div>
      {footer && <div className="dg-foot">{footer}</div>}
    </div>
  );
}
