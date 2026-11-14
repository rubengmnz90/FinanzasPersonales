import { useEffect, useState, type FormEvent } from 'react';
import { post } from '../../app/api';
import { Combobox } from '../../components/Combobox';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/label';
import { today, useToast } from '../../components/ui';

export type SavingsAction = 'deposit' | 'withdrawal' | 'loan' | 'return';

const ACTIONS: Record<SavingsAction, { title: string; help: string; sign: 1 | -1; tag?: string; needsBucket: boolean; needsPerson: boolean; concept: string }> = {
  deposit: { title: 'Depositar', help: 'Plata que entra directo a tu ahorro (por ejemplo, un depósito en Coomecipar). Elige a qué objetivo va.', sign: 1, needsBucket: true, needsPerson: false, concept: 'Depósito' },
  withdrawal: { title: 'Extraer de mi ahorro', help: 'Sacas tu ahorro porque llegaste a una meta o por otro motivo. No hay que devolverlo.', sign: -1, needsBucket: true, needsPerson: false, concept: 'Extracción' },
  loan: { title: 'Prestar del ahorro', help: 'Sale de tu ahorro pero hay que devolverlo. Indica a quién (déjalo vacío si es un préstamo normal).', sign: -1, tag: 'temp_withdrawal', needsBucket: false, needsPerson: true, concept: '' },
  return: { title: 'Devolver al ahorro', help: 'Alguien te devolvió plata y entra a tu ahorro. Indica quién para descontarlo de lo que debe.', sign: 1, tag: 'return', needsBucket: false, needsPerson: true, concept: 'Devolución' },
};

/** Alta de un movimiento del ahorro: depósito, extracción, préstamo o devolución. */
export function SavingsActionDialog({ accountId, action, onClose, onDone, buckets, people }: {
  accountId: string; action: SavingsAction | null; onClose: () => void; onDone: () => unknown; buckets: string[]; people: string[];
}) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [concept, setConcept] = useState('');
  const [bucket, setBucket] = useState('');
  const [person, setPerson] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!action) return;
    setAmount(''); setConcept(ACTIONS[action].concept); setPerson(''); setDate(today());
    setBucket(ACTIONS[action].needsBucket ? (buckets.includes('Ahorro') ? 'Ahorro' : buckets[0] ?? '') : '');
  }, [action]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!action) return null;
  const A = ACTIONS[action];
  const bucketOpts = [...new Set([...buckets, bucket].filter(Boolean))].map((b) => ({ value: b, label: b }));
  const personOpts = [...new Set([...people, person].filter(Boolean))].map((p) => ({ value: p, label: p }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (A.needsBucket && !bucket) return toast.error(new Error('Elige el objetivo'));
    setBusy(true);
    try {
      const raw = amount.trim();
      const label = concept.trim() || (person ? `${A.title.split(' ')[0]} ${person}` : A.title);
      await post(`/api/accounts/${accountId}/entries`, {
        date, concept: label,
        rawAmount: A.sign < 0 ? `=-(${raw.replace(/^=/, '')})` : raw,
        ...(A.tag ? { tag: A.tag } : {}),
        ...(bucket && A.needsBucket ? { bucket } : {}),
        ...(person && A.needsPerson ? { person } : {}),
      });
      await onDone();
      toast.ok(`${A.title}: registrado`);
      onClose();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{A.title}</DialogTitle>
          <DialogDescription>{A.help}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3" aria-label={A.title}>
          <Field label="Monto"><Input className="num text-right" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus placeholder="0 o =fórmula" aria-label="Monto" /></Field>
          <Field label="Concepto"><Input value={concept} onChange={(e) => setConcept(e.target.value)} placeholder={action === 'loan' ? '¿Para qué fue?' : undefined} aria-label="Concepto" /></Field>
          {A.needsBucket && (
            <Field label="Objetivo">
              <Combobox ariaLabel="Objetivo" value={bucket} onChange={setBucket} options={bucketOpts} placeholder="Elegir objetivo…" onCreate={(n) => setBucket(n)} />
            </Field>
          )}
          {A.needsPerson && (
            <Field label="Persona">
              <Combobox ariaLabel="Persona" value={person} onChange={setPerson} options={personOpts} allowClear placeholder="Préstamo normal (sin persona)" searchPlaceholder="Escribe para buscar o crear…" onCreate={(n) => setPerson(n)} />
            </Field>
          )}
          <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="Fecha" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
