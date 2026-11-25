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

// ---------------------------------------------------------------------------
// P17 — Feuille de présence hebdomadaire par Master (A4 paysage)
// ---------------------------------------------------------------------------

/** Nombre maximum de colonnes « séance » sur la feuille hebdo. */
const MAX_WEEK_COLUMNS = 8;

/** 'YYYY-MM-DD' (un jour quelconque) → lundi ISO de sa semaine. */
export function mondayOfWeek(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + n jours → 'YYYY-MM-DD' (calcul UTC, pas de fuseau). */
function addDaysIso(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Numéro de semaine ISO du lundi donné (semaine du jeudi, ISO-8601). */
function isoWeekNumber(mondayIso: string): number {
  const thursday = addDaysIso(mondayIso, 3);
  const ty = Number(thursday.slice(0, 4));
  const th = Date.UTC(
    ty,
    Number(thursday.slice(5, 7)) - 1,
    Number(thursday.slice(8, 10)),
  );
  return Math.floor((th - Date.UTC(ty, 0, 1)) / 604800000) + 1;
}

/** Séance de la feuille hebdo (colonne compacte + ligne d'attestation). */
export interface WeekSheetSession {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  module_code: string;
  module_name: string;
  professor_name: string;
  room_name: string;
}

/**
 * Séances non ANNULEE du master sur la semaine de `weekStart`
 * (un jour quelconque — normalisé au lundi) : [lundi, lundi+6],
 * triées date puis heure de début.
 */
export function weekSheetSessions(
  db: DatabaseSync,
  masterId: number,
  weekStart: string,
): { monday: string; sessions: WeekSheetSession[] } {
  const monday = mondayOfWeek(weekStart);
  const sunday = addDaysIso(monday, 6);
  const sessions = all<WeekSheetSession>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min,
            mo.code AS module_code, mo.name AS module_name,
            p.full_name AS professor_name, r.name AS room_name
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = s.professor_id
       JOIN room r ON r.id = s.room_id
      WHERE mm.master_id = ? AND s.status != 'ANNULEE'
        AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.start_min, s.id`,
    masterId,
    monday,
    sunday,
  );
  return { monday, sessions };
}

/**
 * Roster hebdo : étudiants de l'union des groupes impliqués par les
 * séances de la semaine (mm.student_group_id ∪ session_group),
 * dédoublonnés et triés — vide si aucune séance ne vise de groupe
 * (la feuille imprime alors 25 lignes vides numérotées).
 */
function resolveWeekRoster(
  db: DatabaseSync,
  masterId: number,
  monday: string,
  sunday: string,
): string[] {
  return all<{ full_name: string }>(
    db,
    `SELECT st.full_name
       FROM student st
      WHERE st.student_group_id IN (
        SELECT mm.student_group_id
          FROM session s
          JOIN master_module mm ON mm.id = s.master_module_id
         WHERE mm.master_id = ? AND s.status != 'ANNULEE'
           AND s.date BETWEEN ? AND ?
           AND mm.student_group_id IS NOT NULL
        UNION
        SELECT sg.student_group_id
          FROM session_group sg
          JOIN session s2 ON s2.id = sg.session_id
          JOIN master_module mm2 ON mm2.id = s2.master_module_id
         WHERE mm2.master_id = ? AND s2.status != 'ANNULEE'
           AND s2.date BETWEEN ? AND ?
      )
      ORDER BY st.full_name COLLATE NOCASE`,
    masterId,
    monday,
    sunday,
    masterId,
    monday,
    sunday,
  ).map((r) => r.full_name);
}

/** 'dd/MM' compact pour l'en-tête de colonne. */
function ddMM(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * Feuille de présence hebdomadaire d'un master (P17) — document A4
 * paysage : une colonne par séance de la semaine (cap 8 — au-delà,
 * note visible « suite sur une 2e feuille »), une ligne par étudiant
 * du roster union (+ Observation). Le pied liste chaque séance avec
 * « ☐ Oui ☐ Non » (« Séances assurées par l'enseignant »), le cadre
 * signature du Responsable et « Fait à Tanger ».
 * `weekStart` = un jour quelconque, normalisé au lundi.
 */
export function buildWeekSheetHtml(
  db: DatabaseSync,
  masterId: number,
  weekStart: string,
): ApiResult<AttendanceSheetDoc> {
  const master = get<{ code: string; name: string }>(
    db,
    'SELECT code, name FROM master WHERE id = ?',
    masterId,
  );
  if (!master) {
    return apiErr('Master introuvable.');
  }
  const { monday, sessions } = weekSheetSessions(db, masterId, weekStart);
  const sunday = addDaysIso(monday, 6);
  const students = resolveWeekRoster(db, masterId, monday, sunday);

  // Cap de colonnes : les séances au-delà sont annoncées (note) et
  // restent listées dans le bloc d'attestation du pied.
  const shown = sessions.slice(0, MAX_WEEK_COLUMNS);
  const truncated = sessions.length - shown.length;

  const headCells = shown
    .map(
      (s) =>
        `      <th><div class="d">${ddMM(s.date)}</div>` +
        `<div class="h">${minToHHMM(s.start_min)}</div>` +
        `<div dir="auto">${esc(s.module_code)}</div>` +
        `<div class="r" dir="auto">${esc(s.room_name)}</div></th>`,
    )
    .join('\n');

  const rosterRows = students
    .map(
      (name, i) =>
        `      <tr><td class="num">${i + 1}</td>` +
        `<td dir="auto">${esc(name)}</td>` +
        shown.map(() => '<td></td>').join('') +
        '<td dir="auto"></td></tr>',
    )
    .join('\n');
  const blankRows = Array.from(
    { length: BLANK_ROWS },
    (_, i) =>
      `      <tr><td class="num">${i + 1}</td>` +
      '<td dir="auto"></td>' +
      shown.map(() => '<td></td>').join('') +
      '<td dir="auto"></td></tr>',
  ).join('\n');

  const assuredLines = sessions
    .map(
      (s) =>
        `      <tr><td>${esc(dateFr(s.date))}</td>` +
        `<td>${minToHHMM(s.start_min)} – ${minToHHMM(s.end_min)}</td>` +
        `<td dir="auto">${esc(`${s.module_code} — ${s.module_name}`)}</td>` +
        `<td dir="auto">${esc(s.professor_name)}</td>` +
        '<td class="mark">☐ Oui&nbsp;&nbsp;☐ Non</td></tr>',
    )
    .join('\n');

  const truncatedNote =
    truncated > 0
      ? `    <p class="warn">${truncated} séance(s) supplémentaire(s) ` +
        'cette semaine : suite sur une 2e feuille.</p>\n'
      : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Feuille de présence — ${esc(
    `${master.code} semaine du ${ddMM(monday)}`,
  )}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body {
    font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 9pt;
    margin: 0;
  }
  .fac { text-align: center; font-weight: 600; font-size: 11pt; }
  h1 { text-align: center; font-size: 13pt; margin: 2mm 0 4mm; }
  table.info { width: 100%; border-collapse: collapse; margin-bottom: 4mm; }
  table.info td { padding: 1mm 2mm; vertical-align: top; }
  table.info td.k { font-weight: 600; width: 40mm; }
  table.presence { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.presence th, table.presence td {
    border: 1px solid #333;
    padding: 1.2mm 1.5mm;
  }
  table.presence th { background: #eee; font-size: 7.5pt; text-align: center; }
  table.presence th .d { font-weight: 700; }
  table.presence th .h, table.presence th .r { font-weight: 400; color: #333; }
  .num { width: 8mm; text-align: center; }
  th.name { width: 62mm; }
  th.obs { width: 30mm; }
  td.mark { text-align: center; white-space: nowrap; }
  .warn { font-weight: 600; margin: 2mm 0 0; }
  table.assured { width: 100%; border-collapse: collapse; margin-top: 5mm; }
  table.assured th, table.assured td {
    border: 1px solid #333;
    padding: 1.2mm 2mm;
    font-size: 8.5pt;
  }
  table.assured th { background: #eee; }
  footer { margin-top: 5mm; }
  .footrow { display: flex; justify-content: space-between; gap: 10mm; }
  .resp { flex: 1; }
  .sig { border: 1px solid #333; height: 22mm; margin-top: 2mm; }
  .made { padding-top: 1mm; }
</style>
</head>
<body>
  <header>
    <div class="fac">Faculté des Sciences Juridiques et Politiques — Tanger</div>
    <h1>Feuille de présence — Master ${esc(master.code)}, semaine du ${ddMM(
      monday,
    )}/${monday.slice(0, 4)}</h1>
  </header>
  <table class="info">
    <tr><td class="k">Master</td><td dir="auto">${esc(
      `${master.code} — ${master.name}`,
    )}</td>
    <td class="k">Semaine</td><td>du ${ddMM(monday)} au ${ddMM(sunday)}/${
      sunday.slice(0, 4)
    }</td></tr>
  </table>
  <table class="presence">
    <thead>
      <tr><th class="num">N°</th><th class="name">Nom et prénom</th>
${headCells}
      <th class="obs">Observation</th></tr>
    </thead>
    <tbody>
${students.length > 0 ? rosterRows : blankRows}
    </tbody>
  </table>
${truncatedNote}  <footer>
    <table class="assured">
      <thead>
        <tr><th colspan="5">Séances assurées par l'enseignant</th></tr>
        <tr><th>Date</th><th>Horaire</th><th>Module</th><th>Enseignant</th><th>Assurée</th></tr>
      </thead>
      <tbody>
${assuredLines || '      <tr><td colspan="5">Aucune séance cette semaine.</td></tr>'}
      </tbody>
    </table>
    <div class="footrow" style="margin-top:4mm">
      <div class="resp">
        <span>Le Responsable du Master :</span>
        <div class="sig"></div>
      </div>
      <div class="made">Fait à Tanger, le ……/……/………</div>
    </div>
  </footer>
</body>
</html>`;

  const safeCode = master.code.replace(/[^A-Za-z0-9_-]+/g, '-');
  const week = String(isoWeekNumber(monday)).padStart(2, '0');
  return apiOk({
    html,
    suggestedName: `feuille-presence-${safeCode}-S${week}.pdf`,
  });
}
