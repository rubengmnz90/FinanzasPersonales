import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataGrid, type Column } from './DataGrid';

interface Row { id: string; item: string; amount: number }
const rows: Row[] = [
  { id: 'a', item: 'Alquiler', amount: 1050000 },
  { id: 'b', item: 'Internet', amount: 70000 },
  { id: 'c', item: 'Spotify', amount: 50000 },
];
const columns: Column<Row>[] = [
  { key: 'item', label: 'Item', width: 200, editable: true, value: (r) => r.item },
  { key: 'amount', label: 'Monto', width: 140, align: 'right', kind: 'money', editable: true, value: (r) => r.amount },
];

const setup = (onCommit = vi.fn().mockResolvedValue(undefined), onError = vi.fn()) => {
  render(<DataGrid columns={columns} rows={rows} rowId={(r) => r.id} onCommit={onCommit} onError={onError} />);
  return { onCommit, onError };
};
const cell = (rowText: string, col: string) =>
  screen.getByText(rowText).closest('[role=row]')!.querySelector(`[data-col=${col}]`) as HTMLElement;

describe('DataGrid', () => {
  it('teclear una fórmula y Enter envía el texto crudo', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(cell('Alquiler', 'amount'));
    await user.keyboard('=45814+4581{Enter}');
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('a', 'amount', '=45814+4581'));
  });

  it('Escape cancela sin guardar', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(cell('Internet', 'amount'));
    await user.keyboard('999{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('pegar 3 filas desde Excel (TSV) genera 3 commits', async () => {
    const { onCommit } = setup();
    const scroller = document.querySelector('.dg-scroll') as HTMLElement;
    fireEvent.mouseDown(cell('Alquiler', 'amount'));
    fireEvent.paste(scroller, { clipboardData: { getData: () => '111\n222\n333' } });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(3));
    expect(onCommit.mock.calls.map((c) => c[2])).toEqual(['111', '222', '333']);
    expect(onCommit.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('Ctrl+D rellena hacia abajo', async () => {
    const user = userEvent.setup();
    const { onCommit } = setup();
    await user.click(cell('Alquiler', 'amount'));
    await user.keyboard('{Control>}d{/Control}');
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('b', 'amount', '1050000'));
  });

  it('si el servidor falla, avisa y no deja la celda pendiente', async () => {
    const user = userEvent.setup();
    const err = new Error('INVALID_AMOUNT');
    const { onError } = setup(vi.fn().mockRejectedValue(err));
    await user.click(cell('Spotify', 'amount'));
    await user.keyboard('abc{Enter}');
    await waitFor(() => expect(onError).toHaveBeenCalledWith(err));
    await waitFor(() => expect(cell('Spotify', 'amount').className).not.toContain('pending'));
    expect(cell('Spotify', 'amount').textContent).toBe('50000');
  });

  it('las flechas mueven la selección', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(cell('Alquiler', 'item'));
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(cell('Internet', 'amount').getAttribute('aria-selected')).toBe('true');
  });
});
