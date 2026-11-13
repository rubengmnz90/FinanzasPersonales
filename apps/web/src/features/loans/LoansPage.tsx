import { FormalLoans } from './FormalLoans';

/** Préstamos con cuotas: Coomecipar, equipos de Vibra Lejana… (cada cuota se marca pagada y alimenta la proyección). */
export function LoansPage() {
  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="page-head !mb-0">
        <div className="max-w-2xl">
          <h1>Préstamos</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">Tus préstamos con cuotas. Marca cada cuota como pagada y los nuevos préstamos pueden sumarse a la proyección.</p>
        </div>
      </div>
      <FormalLoans />
    </div>
  );
}
