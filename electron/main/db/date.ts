/**
 * Helpers dates partagés entre les services DB (P6b extrait, P6c+).
 * Conventions AD-7 : dates `TEXT 'YYYY-MM-DD'`, heures `INTEGER` minutes.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' syntaxiquement ET calendairement valide (rejette 2026-02-30). */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Date du jour 'YYYY-MM-DD' en composants LOCAUX (fuseau de l'école —
 * `toISOString` en UTC décalerait les compteurs autour de minuit, AD-7).
 * Injectable pour les tests (param `today` des services).
 */
export function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
