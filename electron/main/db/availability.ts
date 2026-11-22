/**
 * Disponibilité effective des professeurs — prédicats PARTAGÉS entre le
 * générateur (P8, `generation.service.ts`) et les décisions d'absence
 * (P9a, `absence.service.ts`). Extraits du moteur P8 pour ne pas
 * dupliquer la sémantique DISPO/INDISPO/absence.
 *
 * Sémantique P6b : si le prof a des plages DISPO effectives à une date
 * (peu importe le weekday), il n'est disponible QUE dans celles du
 * weekday courant — un jour sans plage DISPO effective est alors
 * indisponible ; sans AUCUNE DISPO (effective ou non) → toujours dispo.
 * INDISPO effective et absence déclarée interdisent le créneau/le jour.
 */
import { DatabaseSync } from 'node:sqlite';
import { all } from './connection';
import { isValidIsoDate } from './date';

/** Jour de semaine AD-7 d'une date ISO : 0=lundi … 6=dimanche. */
export function weekdayOf(iso: string): number {
  const dt = new Date(`${iso}T00:00:00Z`);
  return (dt.getUTCDay() + 6) % 7;
}

export interface AvailRow {
  weekday: number;
  start_min: number;
  end_min: number;
  effective_from: string | null;
  effective_to: string | null;
}

export interface ProfConstraints {
  isActive: boolean;
  dispo: AvailRow[];
  indispo: AvailRow[];
  absences: { start: string; end: string }[];
}

/** Vrai si la plage est effective à `date` (bornes NULL = illimitées). */
function effective(row: AvailRow, date: string): boolean {
  return (
    (row.effective_from == null || date >= row.effective_from) &&
    (row.effective_to == null || date <= row.effective_to)
  );
}

export type ProfBlock = 'absent' | 'indispo' | 'nodispo' | null;

/**
 * Disponibilité effective du prof sur [date, s, e) : 'absent' si une
 * absence déclarée couvre la date ; 'nodispo' si des DISPO effectives
 * existent sans couvrir le créneau ce weekday ; 'indispo' si une INDISPO
 * effective chevauche ; null = disponible.
 */
export function profBlock(
  c: ProfConstraints,
  date: string,
  weekday: number,
  s: number,
  e: number,
): ProfBlock {
  if (c.absences.some((a) => a.start <= date && date <= a.end)) {
    return 'absent';
  }
  const dispoEff = c.dispo.filter((r) => effective(r, date));
  if (dispoEff.length > 0) {
    const dayDispo = dispoEff.filter((r) => r.weekday === weekday);
    if (!dayDispo.some((r) => r.start_min <= s && e <= r.end_min)) {
      return 'nodispo';
    }
  }
  const indispo = c.indispo.filter(
    (r) => r.weekday === weekday && effective(r, date),
  );
  if (indispo.some((r) => s < r.end_min && r.start_min < e)) {
    return 'indispo';
  }
  return null;
}

/**
 * Contraintes professeurs : `is_active` + DISPO/INDISPO + absences.
 * Les disponibilités à `effective_*` non-ISO sont ignorées + warning.
 */
export function loadProfConstraints(
  db: DatabaseSync,
  profIds: number[],
  warnings: string[],
): Map<number, ProfConstraints> {
  const cons = new Map<number, ProfConstraints>();
  for (const pid of profIds) {
    cons.set(pid, { isActive: true, dispo: [], indispo: [], absences: [] });
  }
  if (profIds.length === 0) return cons;
  const ph = profIds.map(() => '?').join(',');
  for (const r of all<{ id: number; is_active: number }>(
    db,
    `SELECT id, is_active FROM professor WHERE id IN (${ph})`,
    ...profIds,
  )) {
    const c = cons.get(r.id);
    if (c) c.isActive = r.is_active === 1;
  }
  let droppedAvail = 0;
  for (const r of all<AvailRow & { professor_id: number; kind: string }>(
    db,
    `SELECT professor_id, weekday, start_min, end_min, kind,
            effective_from, effective_to
       FROM professor_availability WHERE professor_id IN (${ph})`,
    ...profIds,
  )) {
    const c = cons.get(r.professor_id);
    if (!c) continue;
    if (
      (r.effective_from != null && !isValidIsoDate(r.effective_from)) ||
      (r.effective_to != null && !isValidIsoDate(r.effective_to))
    ) {
      droppedAvail++;
      continue;
    }
    (r.kind === 'DISPO' ? c.dispo : c.indispo).push(r);
  }
  if (droppedAvail > 0) {
    warnings.push(
      `${droppedAvail} disponibilité(s) professeur à dates d'effet ` +
        'invalides ignorée(s).',
    );
  }
  for (const r of all<{
    professor_id: number;
    start_date: string;
    end_date: string;
  }>(
    db,
    `SELECT professor_id, start_date, end_date
       FROM professor_absence WHERE professor_id IN (${ph})`,
    ...profIds,
  )) {
    cons.get(r.professor_id)?.absences.push({
      start: r.start_date,
      end: r.end_date,
    });
  }
  return cons;
}
