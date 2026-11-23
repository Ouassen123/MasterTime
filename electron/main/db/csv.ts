/**
 * Helpers CSV partagés (P10 extrait, P11) — format « Excel FR » unique :
 * séparateur `;`, quoting `"…"` quand la valeur contient `;`, `"` ou un
 * retour ligne (les `"` internes sont doublés), fins de ligne CRLF,
 * BOM UTF-8 explicite (Excel n'ouvre les accents correctement qu'avec).
 *
 * Anti-injection de formule : les CHAÎNES commençant par `=`, `+`, `-`,
 * `@` ou une tabulation sont préfixées d'une apostrophe (Excel les force
 * en texte) ; les nombres ne sont JAMAIS préfixés et leurs décimales sont
 * formatées avec `,` (Excel FR lit « 3,3 »).
 */

/** BOM UTF-8 explicite — Excel FR n'ouvre les accents correctement qu'avec. */
const CSV_BOM = String.fromCodePoint(0xfeff);

/** Échappe une valeur en cellule CSV (quoting + anti-injection). */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (typeof v === 'number') {
    s = Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  } else {
    s = String(v);
    if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  }
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Sérialise en texte CSV complet : `columns` donne les clés + en-têtes,
 * `rows` les valeurs par clé. BOM UTF-8 incluse, `;`, CRLF.
 */
export function csvText(
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(';')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c.key])).join(';'));
  }
  // BOM UTF-8 explicite — Excel n'ouvre les accents correctement qu'avec.
  return CSV_BOM + lines.join('\r\n');
}

/** Sérialise des lignes de cellules brutes (gabarits) — BOM + `;` + CRLF. */
export function csvRows(lines: unknown[][]): string {
  // BOM UTF-8 explicite (même règle que ci-dessus).
  return CSV_BOM + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
}
