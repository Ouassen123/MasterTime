/**
 * Feuille de présence imprimable (P14) — document A4 portrait généré
 * côté main, rendu en PDF par le canal `sessions:attendanceSheet`
 * (hidden BrowserWindow + `printToPDF`, même mécanisme de sécurité que
 * `reports:exportPdf`). La feuille est disponible sur TOUTES les
 * séances : elle sert *pendant* le cours, le responsable coche à la
 * main et la saisie se fait ensuite dans l'onglet Présences.
 *
 * Deux fonctions testables sans Electron :
 *  - `resolveSheetRoster` : noms des étudiants de l'union
 *    `mm.student_group_id ∪ session_group` (dédoublonnés, triés) —
 *    liste vide si la séance ne vise aucun groupe (feuille blanche
 *    remplie à la main : 25 lignes vides numérotées) ;
 *  - `buildAttendanceSheetHtml` : document HTML autonome complet —
 *    échappement systématique, `dir="auto"` sur les contenus saisis
 *    (noms arabes possibles).
 */
import { DatabaseSync } from 'node:sqlite';
import type { ApiResult } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get } from './connection';

/** Nombre de lignes vides numérotées quand aucun étudiant n'est enregistré. */
const BLANK_ROWS = 25;

const WEEKDAYS_FR = [
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
];

/** Échappement HTML systématique (texte ET attributs) — données saisies. */
function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 'HH:MM' depuis des minutes depuis minuit. */
function minToHHMM(min: number): string {
  const capped = Math.max(0, Math.min(min, 1440));
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(
    capped % 60,
  ).padStart(2, '0')}`;
}

/** '2026-10-15' → « jeudi 15/10/2026 » (jour de semaine français, AD-7). */
function dateFr(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS_FR[wd]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

interface SheetSession {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  master_module_id: number;
  mm_group_id: number | null;
  master_code: string;
  master_name: string;
  module_code: string;
  module_name: string;
  professor_name: string;
  room_name: string;
}

function getSheetSession(
  db: DatabaseSync,
  sessionId: number,
): SheetSession | undefined {
  return get<SheetSession>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min,
            s.master_module_id, mm.student_group_id AS mm_group_id,
            m.code AS master_code, m.name AS master_name,
            mo.code AS module_code, mo.name AS module_name,
            p.full_name AS professor_name, r.name AS room_name
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master m ON m.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = s.professor_id
       JOIN room r ON r.id = s.room_id
      WHERE s.id = ?`,
    sessionId,
  );
}

/**
 * Roster de la feuille : étudiants de l'union des groupes de la séance
 * (`mm.student_group_id ∪ session_group`), dédoublonnés (un étudiant
 * n'appartient qu'à un groupe ; l'UNION couvre un session_group qui
 * répèterait le groupe du mm) et triés par `full_name`.
 * Séance « master entier » sans session_group → liste vide (la feuille
 * imprime alors 25 lignes blanches numérotées).
 */
export function resolveSheetRoster(
  db: DatabaseSync,
  sessionId: number,
): { students: string[] } {
  const rows = all<{ full_name: string }>(
    db,
    `SELECT st.full_name
       FROM student st
      WHERE st.student_group_id IN (
        SELECT mm.student_group_id
          FROM session s
          JOIN master_module mm ON mm.id = s.master_module_id
         WHERE s.id = ? AND mm.student_group_id IS NOT NULL
        UNION
        SELECT sg.student_group_id
          FROM session_group sg
         WHERE sg.session_id = ?
      )
      ORDER BY st.full_name COLLATE NOCASE`,
    sessionId,
    sessionId,
  );
  return { students: rows.map((r) => r.full_name) };
}

/** Document prêt à imprimer + nom de fichier proposé au save-dialog. */
export interface AttendanceSheetDoc {
  html: string;
  /** `feuille-presence-<date>-<code-master>.pdf` (caractères sûrs). */
  suggestedName: string;
}

/**
 * Construit le document HTML complet de la feuille de présence d'une
 * séance : en-tête FSJP, bloc séance (master, module, enseignant,
 * salle, date, horaire, groupes), tableau
 * N° | Nom et prénom | Présent | Absent | Observation (roster, ou
 * 25 lignes vides numérotées) et pied de signature réglementaire.
 */
export function buildAttendanceSheetHtml(
  db: DatabaseSync,
  sessionId: number,
): ApiResult<AttendanceSheetDoc> {
  const s = getSheetSession(db, sessionId);
  if (!s) {
    return apiErr('Séance introuvable.');
  }
  const { students } = resolveSheetRoster(db, sessionId);

  const groups = all<{ name: string }>(
    db,
    `SELECT name FROM (
        SELECT g.name FROM student_group g WHERE g.id = ?
        UNION
        SELECT g2.name FROM session_group sg
          JOIN student_group g2 ON g2.id = sg.student_group_id
         WHERE sg.session_id = ?
     ) ORDER BY name COLLATE NOCASE`,
    s.mm_group_id ?? -1,
    sessionId,
  ).map((r) => r.name);
  const groupsLabel =
    groups.length > 0 ? esc(groups.join(', ')) : 'Master entier';

  const rosterRows = students
    .map(
      (name, i) =>
        `      <tr><td class="num">${i + 1}</td>` +
        `<td dir="auto">${esc(name)}</td>` +
        '<td></td><td></td><td dir="auto"></td></tr>',
    )
    .join('\n');
  const blankRows = Array.from(
    { length: BLANK_ROWS },
    (_, i) =>
      `      <tr><td class="num">${i + 1}</td>` +
      '<td dir="auto"></td><td></td><td></td><td dir="auto"></td></tr>',
  ).join('\n');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Feuille de présence — ${esc(`${s.master_code} ${s.date}`)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  body {
    font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 11pt;
    margin: 0;
  }
  .fac { text-align: center; font-weight: 600; font-size: 12pt; }
  h1 { text-align: center; font-size: 15pt; margin: 3mm 0 6mm; }
  table.info { width: 100%; border-collapse: collapse; margin-bottom: 6mm; }
  table.info td { padding: 1.2mm 2mm; vertical-align: top; }
  table.info td.k { font-weight: 600; width: 40mm; }
  table.presence { width: 100%; border-collapse: collapse; }
  table.presence th, table.presence td {
    border: 1px solid #333;
    padding: 1.8mm 2mm;
  }
  table.presence th { background: #eee; }
  .num { width: 10mm; text-align: center; }
  th.mark { width: 17mm; text-align: center; }
  footer { margin-top: 8mm; }
  .assured { margin: 0 0 6mm; }
  .footrow { display: flex; justify-content: space-between; gap: 10mm; }
  .resp { flex: 1; }
  .sig { border: 1px solid #333; height: 28mm; margin-top: 2mm; }
  .made { padding-top: 1mm; }
</style>
</head>
<body>
  <header>
    <div class="fac">Faculté des Sciences Juridiques et Politiques — Tanger</div>
    <h1>Feuille de présence</h1>
  </header>
  <table class="info">
    <tr><td class="k">Master</td><td dir="auto">${esc(
      `${s.master_code} — ${s.master_name}`,
    )}</td></tr>
    <tr><td class="k">Module</td><td dir="auto">${esc(
      `${s.module_code} — ${s.module_name}`,
    )}</td></tr>
    <tr><td class="k">Enseignant</td><td dir="auto">${esc(
      s.professor_name,
    )}</td></tr>
    <tr><td class="k">Salle</td><td dir="auto">${esc(s.room_name)}</td></tr>
    <tr><td class="k">Date</td><td>${esc(dateFr(s.date))}</td></tr>
    <tr><td class="k">Horaire</td><td>${minToHHMM(s.start_min)} – ${minToHHMM(
      s.end_min,
    )}</td></tr>
    <tr><td class="k">Groupe(s)</td><td dir="auto">${groupsLabel}</td></tr>
  </table>
  <table class="presence">
    <thead>
      <tr><th class="num">N°</th><th>Nom et prénom</th><th class="mark">Présent</th><th class="mark">Absent</th><th>Observation</th></tr>
    </thead>
    <tbody>
${students.length > 0 ? rosterRows : blankRows}
    </tbody>
  </table>
  <footer>
    <p class="assured">Séance assurée par l'enseignant : ☐ Oui&nbsp;&nbsp;&nbsp;☐ Non</p>
    <div class="footrow">
      <div class="resp">
        <span>Le Responsable du Master :</span>
        <div class="sig"></div>
      </div>
      <div class="made">Fait à Tanger, le ……/……/………</div>
    </div>
  </footer>
</body>
</html>`;

  const safeCode = s.master_code.replace(/[^A-Za-z0-9_-]+/g, '-');
  return apiOk({
    html,
    suggestedName: `feuille-presence-${s.date}-${safeCode}.pdf`,
  });
}
