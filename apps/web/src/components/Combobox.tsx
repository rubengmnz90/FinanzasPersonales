import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { cn } from '../lib/utils';

export interface ComboOption {
  value: string;
  label: string;
  /** Texto secundario (p. ej. el grupo de la categoría); también se busca. */
  hint?: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel: string;
  allowClear?: boolean;
  className?: string;
  /** Si se indica, permite crear una opción nueva con el texto buscado. */
  onCreate?: (name: string) => Promise<void> | void;
  disabled?: boolean;
}

/** Selector con buscador (sin tildes ni mayúsculas) para categorías, cuentas, etc. */
export function Combobox({ value, onChange, options, placeholder = 'Seleccionar…', searchPlaceholder = 'Buscar…', ariaLabel, allowClear, className, onCreate, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const id = useId();
  const current = options.find((o) => o.value === value);
  const exact = useMemo(() => options.some((o) => norm(o.label) === norm(q.trim())), [options, q]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-controls={id}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-sm shadow-xs transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !current && 'text-muted-foreground')}>{current ? current.label : placeholder}</span>
          <span className="flex items-center gap-1">
            {allowClear && current && (
              <X
                className="size-3.5 text-muted-foreground hover:text-foreground"
                aria-label="Quitar selección"
                onClick={(e) => { e.stopPropagation(); onChange(''); }}
              />
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[220px] rounded-md border bg-popover p-0 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <Command
            id={id}
            filter={(val, search, keywords) => (norm(`${val} ${(keywords ?? []).join(' ')}`).includes(norm(search)) ? 1 : 0)}
          >
            <Command.Input
              value={q}
              onValueChange={setQ}
              placeholder={searchPlaceholder}
              className="h-10 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-sm text-muted-foreground">Sin resultados</Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={o.label}
                  keywords={o.hint ? [o.hint] : []}
                  onSelect={() => { onChange(o.value); setOpen(false); }}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  <Check className={cn('size-4 shrink-0', o.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{o.hint}</span>}
                </Command.Item>
              ))}
              {onCreate && q.trim() && !exact && (
                <Command.Item
                  value={`__crear__ ${q}`}
                  forceMount
                  onSelect={async () => { await onCreate(q.trim()); setOpen(false); }}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-primary aria-selected:bg-accent"
                >
                  + Crear «{q.trim()}»
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
