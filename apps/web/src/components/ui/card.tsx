import * as React from 'react';
import { cn } from '../../lib/utils';

export const Card = ({ className, ...p }: React.ComponentProps<'div'>) => (
  <div className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)} {...p} />
);
export const CardHeader = ({ className, ...p }: React.ComponentProps<'div'>) => (
  <div className={cn('flex flex-col gap-1 p-5 pb-2', className)} {...p} />
);
export const CardTitle = ({ className, ...p }: React.ComponentProps<'h3'>) => (
  <h3 className={cn('!text-sm !normal-case !tracking-normal font-semibold leading-none text-foreground', className)} {...p} />
);
export const CardDescription = ({ className, ...p }: React.ComponentProps<'p'>) => (
  <p className={cn('text-xs text-muted-foreground', className)} {...p} />
);
export const CardContent = ({ className, ...p }: React.ComponentProps<'div'>) => <div className={cn('p-5 pt-2', className)} {...p} />;
