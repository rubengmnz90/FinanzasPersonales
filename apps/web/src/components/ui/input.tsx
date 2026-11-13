import * as React from 'react';
import { cn } from '../../lib/utils';

const base =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(({ className, type, ...props }, ref) => (
  <input ref={ref} type={type} className={cn(base, className)} {...props} />
));
Input.displayName = 'Input';

/** <select> nativo con el estilo de shadcn: accesible, con teclado y móvil resueltos por el navegador. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(base, 'pr-8', className)} {...props}>
    {children}
  </select>
));
NativeSelect.displayName = 'NativeSelect';
