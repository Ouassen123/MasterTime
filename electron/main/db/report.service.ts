/**
 * Service Rapports & statistiques (P10 — Module H : FR-40→44).
 *
 * 10 rapports calculés ENTIÈREMENT en SQL (jointures master/module/
 * professeur/salle, agrégats, dérivation NON_ENCORE_REALISEE via `today`
 * injectable — AD-7) — aucune écriture, aucune valeur stockée (FR-44).
 * Chaque rapport retourne la shape générique `Report` ({id,title,
 * columns,rows,summary?}) : la table UI, le CSV et le HTML du PDF sont
 * rendus depuis ces mêmes données sans duplication.
 *
 * `conflits_restes` réutilise `detectConflicts` (conflict.service) —
 * pas de nouvelle logique de détection (BR-11/FR-35).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  ConflictItem,
  ConflictKind,
  Report,
  ReportColumn,
  ReportFilter,
  ReportId,
  ReportRow,
  ReportSummaryItem,
  SessionStatus,
} from '../../../shared/types';
import { apiErr, apiOk, REPORT_IDS } from '../../../shared/types';
import { all, get } from './connection';
import { isValidIsoDate, todayIso } from './date';
import { detectConflicts } from './conflict.service';
import { csvText } from './csv';

// --- Libellés français (les rapports alimentent CSV/PDF sans i18n renderer) ---

const WEEKDAYS_FR = [
  'Lundi',
  'Mardi',
  'Mercredi',
  'Jeudi',
  'Vendredi',
  'Samedi',
  'Dimanche',
];

const STATUS_FR: Record<SessionStatus, string> = {
  PREVUE: 'Prévue',
  REALISEE: 'Réalisée',
  ANNULEE: 'Annulée',
  REPORTEE: 'Reportée',
};

const NON_REALISEE_FR = 'Non réalisée';

const KIND_FR: Record<ConflictKind, string> = {
  ROOM: 'Salle',
  PROFESSOR: 'Professeur',
  MASTER: 'Master',
  GROUP: 'Groupe',
  EXTERNAL: 'Externe (Licence)',
};

const KIND_ORDER: ConflictKind[] = [
  'ROOM',
  'PROFESSOR',
  'MASTER',
  'GROUP',
  'EXTERNAL',
];

const RESOLUTION_FR: Record<string, string> = {
  A_TRAITER: 'À traiter',
  PARTIELLE: 'Partielle',
  RESOLUE: 'Résolue',
};

const REPORT_TITLES: Record<ReportId, string> = {
  edt_hebdo: 'Emploi du temps hebdomadaire',
  salles_planning: "Planning d'occupation des salles",
  prof_programme: 'Programme des professeurs',
  bilan_heures: 'Bilan des heures (prévu / effectué)',
  non_realisees: 'Séances non réalisées',
  annulees_reportees: 'Séances annulées et reportées',
  absences: 'Absences des professeurs',
  avancement: 'Avancement par master',
  occupation_salles: "Taux d'occupation des salles",
  conflits_restes: 'Conflits restants et reste à placer',
};

// --- Helpers -----------------------------------------------------------------

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 'HH:MM' depuis des minutes depuis minuit — affichage cappé à '24:00'. */
function minToHHMM(min: number): string {
  const capped = Math.max(0, Math.min(min, 1440));
  const h = Math.floor(capped / 60);
  const m = capped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function horaire(startMin: number, endMin: number): string {
  return `${minToHHMM(startMin)}–${minToHHMM(endMin)}`;
}

/** Statut affiché : 'Non réalisée' dérivée (PREVUE passée — AD-7). */
function statusLabel(status: SessionStatus, date: string, today: string): string {
  if (status === 'PREVUE' && date < today) return NON_REALISEE_FR;
  return STATUS_FR[status];
}

/** Jour de semaine AD-7 d'une date ISO : 0=lundi … 6=dimanche. */
function weekdayOf(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** `date` + `days` jours en ISO 'YYYY-MM-DD' (calcul UTC). */
function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Nombre d'occurrences d'un jour de semaine (0=lun) dans [from, to]
 * inclus, HORS jours `calendar_exception` — utilisé pour matérialiser
 * les blocages Licence récurrents et les heures ouvrables `time_slot`
 * (un férié n'est ni ouvrable ni une occurrence Licence).
 */
function weekdayOccurrences(
  weekday: number,
  from: string,
  to: string,
  exceptions: Set<string>,
): number {
  let n = 0;
  const offset = (weekday - weekdayOf(from) + 7) % 7;
  for (let d = addDays(from, offset); d <= to; d = addDays(d, 7)) {
    if (!exceptions.has(d)) n++;
  }
  return n;
}

/**
 * Jours `calendar_exception` (fériés, examens, fermetures, vacances)
 * sous forme de Set de dates ISO — chargé UNE fois par rapport. Les
 * lignes à bornes invalides sont ignorées (cohérent avec
 * `generation.service` — sinon la boucle d'expansion divergerait).
 */
function loadExceptionDays(db: DatabaseSync): Set<string> {
  const set = new Set<string>();
  for (const ex of all<{ start_date: string; end_date: string }>(
    db,
    'SELECT start_date, end_date FROM calendar_exception ORDER BY start_date, id',
  )) {
    if (
      !isValidIsoDate(ex.start_date) ||
      !isValidIsoDate(ex.end_date) ||
      ex.start_date > ex.end_date
    ) {
      continue;
    }
    for (let d = ex.start_date; d <= ex.end_date; d = addDays(d, 1)) {
      set.add(d);
    }
  }
  return set;
}

/** Libellé salle : suffixe « (désactivée) » pour `is_active = 0`. */
function roomLabel(name: string, isActive: number): string {
  return isActive ? name : `${name} (désactivée)`;
}

// --- Filtre normalisé ----------------------------------------------------------

interface NormFilter {
  from: string | null;
  to: string | null;
  masterId: number | null;
  professorId: number | null;
  roomId: number | null;
  semesterId: number | null;
  week: string | null;
}

/**
 * Valide le filtre : dates ISO valides + `from ≤ to` (erreur explicite) ;
 * les ids non entiers positifs sont IGNORÉS (payload forgé — convention
 * des autres services). `week` est validée ici mais exigée seulement par
 * `edt_hebdo`.
 */
function normFilter(
  filter: ReportFilter | undefined,
): ApiResult<NormFilter> {
  const from =
    typeof filter?.date_from === 'string' ? filter.date_from.trim() : '';
  const to =
    typeof filter?.date_to === 'string' ? filter.date_to.trim() : '';
  if (filter?.date_from != null && !isValidIsoDate(from)) {
    return apiErr('Date de début invalide (AAAA-MM-JJ attendu).');
  }
  if (filter?.date_to != null && !isValidIsoDate(to)) {
    return apiErr('Date de fin invalide (AAAA-MM-JJ attendu).');
  }
  if (from && to && from > to) {
    return apiErr('La date de fin doit être postérieure à la date de début.');
  }
  const week = typeof filter?.week === 'string' ? filter.week.trim() : '';
  return apiOk({
    from: from || null,
    to: to || null,
    masterId: isId(filter?.master_id) ? filter.master_id : null,
    professorId: isId(filter?.professor_id) ? filter.professor_id : null,
    roomId: isId(filter?.room_id) ? filter.room_id : null,
    semesterId: isId(filter?.semester_id) ? filter.semester_id : null,
    week: week || null,
  });
}

/**
 * Période effective des rapports à base de jours (salles_planning,
 * occupation_salles) : bornes explicites sinon celles de l'année
 * universitaire contenant `today` (fallback : année courante). Requise —
 * les heures ouvrables et occurrences Licence sont indénombrables sans
 * période.
 */
function resolvePeriod(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<{ from: string; to: string }> {
  let from = f.from;
  let to = f.to;
  if (from == null || to == null) {
    const year =
      get<{ start_date: string; end_date: string }>(
        db,
        'SELECT start_date, end_date FROM academic_year WHERE ? BETWEEN start_date AND end_date ORDER BY id LIMIT 1',
        today,
      ) ??
      get<{ start_date: string; end_date: string }>(
        db,
        'SELECT start_date, end_date FROM academic_year WHERE is_current = 1 ORDER BY id LIMIT 1',
      );
    if (from == null) from = year?.start_date ?? null;
    if (to == null) to = year?.end_date ?? null;
  }
  if (from == null || to == null) {
    return apiErr('Période requise : indiquez une plage de dates.');
  }
  // Re-validation après le fallback année : une borne fournie hors de
  // l'année peut inverser la période (ex. date_from > fin d'année).
  if (from > to) {
    return apiErr('La date de fin doit être postérieure à la date de début.');
  }
  return apiOk({ from, to });
}

/** Année universitaire couvrant `date` (règle external_occupancy). */
function yearIdAt(db: DatabaseSync, date: string): number | null {
  return (
    get<{ id: number }>(
      db,
      'SELECT id FROM academic_year WHERE ? BETWEEN start_date AND end_date ORDER BY id LIMIT 1',
      date,
    )?.id ?? null
  );
}

/**
 * Clauses WHERE communes sur `session` jointe (alias s/mm) : période
 * inclusive + entités. Retourne ` AND …` et les params associés.
 */
function sessionWhere(
  f: NormFilter,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (f.from) {
    clauses.push('s.date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    clauses.push('s.date <= ?');
    params.push(f.to);
  }
  if (f.masterId != null) {
    clauses.push('mm.master_id = ?');
    params.push(f.masterId);
  }
  if (f.professorId != null) {
    clauses.push('s.professor_id = ?');
    params.push(f.professorId);
  }
  if (f.roomId != null) {
    clauses.push('s.room_id = ?');
    params.push(f.roomId);
  }
  if (f.semesterId != null) {
    clauses.push('mm.semester_id = ?');
    params.push(f.semesterId);
  }
  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

const SESSION_JOINS = `
  FROM session s
  JOIN master_module mm ON mm.id = s.master_module_id
  JOIN master m ON m.id = mm.master_id
  JOIN module mo ON mo.id = mm.module_id
  JOIN professor p ON p.id = s.professor_id
  JOIN room r ON r.id = s.room_id`;

interface SessionLite {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  status: SessionStatus;
  master_code: string;
  master_name: string;
  module_name: string;
  professor_name: string;
  room_name: string;
}

const SESSION_LITE_COLS = `
  s.id, s.date, s.start_min, s.end_min, s.status,
  m.code AS master_code, m.name AS master_name,
  mo.name AS module_name, p.full_name AS professor_name,
  r.name AS room_name`;

// --- 1. edt_hebdo ---------------------------------------------------------------

function reportEdtHebdo(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  if (f.week == null || !isValidIsoDate(f.week) || weekdayOf(f.week) !== 0) {
    return apiErr('Semaine invalide : indiquez un lundi (AAAA-MM-JJ).');
  }
  const weekEnd = addDays(f.week, 6);
  const extra = f.masterId != null ? ' AND mm.master_id = ?' : '';
  const params: (string | number)[] = [f.week, weekEnd];
  if (f.masterId != null) params.push(f.masterId);
  // Sans master → tous les masters groupés (tri par master puis date).
  const order =
    f.masterId != null
      ? 'ORDER BY s.date, s.start_min, s.id'
      : 'ORDER BY m.code COLLATE NOCASE, s.date, s.start_min, s.id';
  const rows = all<SessionLite>(
    db,
    `SELECT${SESSION_LITE_COLS}${SESSION_JOINS}
      WHERE s.date >= ? AND s.date <= ?${extra} ${order}`,
    ...params,
  );
  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date' },
    { key: 'horaire', label: 'Horaire' },
    { key: 'master', label: 'Master' },
    { key: 'module', label: 'Module' },
    { key: 'professeur', label: 'Professeur' },
    { key: 'salle', label: 'Salle' },
    { key: 'statut', label: 'Statut' },
  ];
  return apiOk({
    id: 'edt_hebdo',
    title: REPORT_TITLES.edt_hebdo,
    columns,
    rows: rows.map((r) => ({
      date: r.date,
      horaire: horaire(r.start_min, r.end_min),
      master: `${r.master_code} — ${r.master_name}`,
      module: r.module_name,
      professeur: r.professor_name,
      salle: r.room_name,
      statut: statusLabel(r.status, r.date, today),
    })),
    summary: [
      { key: 'seances', label: 'Séances', value: rows.length },
      {
        key: 'periode',
        label: 'Période',
        value: `${f.week} → ${weekEnd}`,
      },
    ],
  });
}

// --- 2. salles_planning ----------------------------------------------------------

/**
 * Occupation par salle × jour de semaine sur la période : créneaux
 * occupés (séances Masters non annulées + blocages Licence récurrents)
 * vs créneaux ouvrables `time_slot`. Chaque fenêtre est dédoublonnée
 * avec son nombre d'occurrences (« 08:00–10:00 ×3 »).
 */
function reportSallesPlanning(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  const period = resolvePeriod(db, f, today);
  if (!period.ok) return period;
  const { from, to } = period.data;
  const yearId = yearIdAt(db, from);
  const exceptions = loadExceptionDays(db);

  const roomCond = f.roomId != null ? ' AND r.id = ?' : '';
  const rooms = all<{ id: number; name: string; is_active: number }>(
    db,
    `SELECT r.id, r.name, r.is_active FROM room r WHERE 1 = 1${roomCond}
      ORDER BY r.name COLLATE NOCASE`,
    ...(f.roomId != null ? [f.roomId] : []),
  );

  const slots = all<{ weekday: number; start_min: number; end_min: number }>(
    db,
    'SELECT weekday, start_min, end_min FROM time_slot ORDER BY weekday, start_min',
  );
  const slotsByDay = new Map<number, { start_min: number; end_min: number }[]>();
  for (const s of slots) {
    const arr = slotsByDay.get(s.weekday) ?? [];
    arr.push(s);
    slotsByDay.set(s.weekday, arr);
  }

  interface WinRow {
    room_id: number;
    weekday: number;
    start_min: number;
    end_min: number;
    n: number;
  }
  // Séances Masters non annulées : fenêtre × nb d'occurrences.
  const sessRows = all<WinRow>(
    db,
    `SELECT s.room_id,
            (CAST(strftime('%w', s.date) AS integer) + 6) % 7 AS weekday,
            s.start_min, s.end_min, count(*) AS n
       FROM session s
      WHERE s.status != 'ANNULEE' AND s.date >= ? AND s.date <= ?
       ${f.roomId != null ? ' AND s.room_id = ?' : ''}
      GROUP BY s.room_id, weekday, s.start_min, s.end_min`,
    ...(f.roomId != null ? [from, to, f.roomId] : [from, to]),
  );
  // Blocages Licence récurrents : occurrences = jours de ce weekday
  // dans la période (année couvrant `from` — NULL = toutes années).
  const licRows = all<{ room_id: number; weekday: number; start_min: number; end_min: number }>(
    db,
    `SELECT eo.room_id, eo.weekday, eo.start_min, eo.end_min
       FROM external_occupancy eo
      WHERE (eo.academic_year_id IS NULL OR eo.academic_year_id = ?)
       ${f.roomId != null ? ' AND eo.room_id = ?' : ''}
      ORDER BY eo.weekday, eo.start_min`,
    ...(f.roomId != null ? [yearId ?? -1, f.roomId] : [yearId ?? -1]),
  );

  const fmtWins = (wins: WinRow[]): string =>
    wins
      .map((w) => `${horaire(w.start_min, w.end_min)} ×${w.n}`)
      .join(' ; ');

  const rows: ReportRow[] = [];
  // Jours itérés : weekdays des time_slot ∪ weekdays présents dans les
  // séances/blocages de la période — un jour sans créneau déclaré (ex.
  // dimanche) reste visible avec `creneaux_ouverts` vide.
  const weekdaysPresent = [
    ...new Set<number>([
      ...slotsByDay.keys(),
      ...sessRows.map((r) => r.weekday),
      ...licRows.map((r) => r.weekday),
    ]),
  ].sort((a, b) => a - b);
  for (const room of rooms) {
    for (const wd of weekdaysPresent) {
      const sess = sessRows
        .filter((r) => r.room_id === room.id && r.weekday === wd)
        .sort((a, b) => a.start_min - b.start_min);
      const lic: WinRow[] = licRows
        .filter((r) => r.room_id === room.id && r.weekday === wd)
        .map((r) => ({
          ...r,
          n: weekdayOccurrences(wd, from, to, exceptions),
        }))
        .filter((r) => r.n > 0);
      const nbSessions = sess.reduce((acc, r) => acc + r.n, 0);
      const nbLic = lic.reduce((acc, r) => acc + r.n, 0);
      if (nbSessions === 0 && nbLic === 0) continue; // jour sans occupation
      rows.push({
        salle: roomLabel(room.name, room.is_active),
        jour: WEEKDAYS_FR[wd],
        creneaux_ouverts: (slotsByDay.get(wd) ?? [])
          .map((s) => horaire(s.start_min, s.end_min))
          .join(' ; '),
        seances_masters: fmtWins(sess),
        blocages_licence: fmtWins(lic),
        nb_seances: nbSessions,
        nb_blocages: nbLic,
      });
    }
  }
  const columns: ReportColumn[] = [
    { key: 'salle', label: 'Salle' },
    { key: 'jour', label: 'Jour' },
    { key: 'creneaux_ouverts', label: 'Créneaux ouverts' },
    { key: 'seances_masters', label: 'Séances Masters (×occurrences)' },
    { key: 'blocages_licence', label: 'Blocages Licence (×occurrences)' },
    { key: 'nb_seances', label: 'Nb séances' },
    { key: 'nb_blocages', label: 'Nb blocages' },
  ];
  return apiOk({
    id: 'salles_planning',
    title: REPORT_TITLES.salles_planning,
    columns,
    rows,
    summary: [
      { key: 'periode', label: 'Période', value: `${from} → ${to}` },
      { key: 'lignes', label: 'Salle × jour occupés', value: rows.length },
    ],
  });
}

// --- 3. prof_programme ------------------------------------------------------------

function reportProfProgramme(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  const { where, params } = sessionWhere(f);
  const rows = all<SessionLite>(
    db,
    `SELECT${SESSION_LITE_COLS}${SESSION_JOINS}
      WHERE 1 = 1${where}
      ORDER BY p.full_name COLLATE NOCASE, s.date, s.start_min, s.id`,
    ...params,
  );
  const columns: ReportColumn[] = [
    { key: 'professeur', label: 'Professeur' },
    { key: 'date', label: 'Date' },
    { key: 'horaire', label: 'Horaire' },
    { key: 'master', label: 'Master' },
    { key: 'module', label: 'Module' },
    { key: 'salle', label: 'Salle' },
    { key: 'statut', label: 'Statut' },
  ];
  return apiOk({
    id: 'prof_programme',
    title: REPORT_TITLES.prof_programme,
    columns,
    rows: rows.map((r) => ({
      professeur: r.professor_name,
      date: r.date,
      horaire: horaire(r.start_min, r.end_min),
      master: `${r.master_code} — ${r.master_name}`,
      module: r.module_name,
      salle: r.room_name,
      statut: statusLabel(r.status, r.date, today),
    })),
    summary: [{ key: 'seances', label: 'Séances', value: rows.length }],
  });
}

// --- 4. bilan_heures ----------------------------------------------------------------

/**
 * Prévu vs effectué par master-module : `prevu_min` = Σ(end−start) des
 * séances non ANNULEE ; `realise_min` = Σ(actual_end−actual_start) des
 * REALISEE dont la paire actual_* est COMPLÈTE — fallback sur le créneau
 * planifié si l'un des deux est NULL (règle P7b : une durée réelle à
 * moitié saisie n'est pas fiable). `ecart_min` = réalisé − prévu
 * (négatif = reste à effectuer). Les bornes de dates s'appliquent aux
 * séances (dans le LEFT JOIN pour conserver les mm sans séance sur la
 * période). Filtre `professor_id` = intervenant RÉEL (`s.professor_id`)
 * ; la colonne « Professeur » affichée reste le titulaire déclaré
 * (`mm.professor_id`) — un remplaçant ne change pas le titulaire.
 */
function reportBilanHeures(
  db: DatabaseSync,
  f: NormFilter,
): ApiResult<Report> {
  const onClauses: string[] = [];
  const onParams: (string | number)[] = [];
  if (f.from) {
    onClauses.push('s.date >= ?');
    onParams.push(f.from);
  }
  if (f.to) {
    onClauses.push('s.date <= ?');
    onParams.push(f.to);
  }
  if (f.roomId != null) {
    onClauses.push('s.room_id = ?');
    onParams.push(f.roomId);
  }
  const on = onClauses.length > 0 ? ` AND ${onClauses.join(' AND ')}` : '';
  const mmClauses: string[] = [];
  const mmParams: (string | number)[] = [];
  if (f.masterId != null) {
    mmClauses.push('mm.master_id = ?');
    mmParams.push(f.masterId);
  }
  if (f.semesterId != null) {
    mmClauses.push('mm.semester_id = ?');
    mmParams.push(f.semesterId);
  }
  if (f.professorId != null) {
    // Intervenant réel (s.professor_id) — le WHERE réduit aussi aux mm
    // où ce prof a effectivement assuré ≥ 1 séance (s.* NULL exclus).
    mmClauses.push('s.professor_id = ?');
    mmParams.push(f.professorId);
  }
  const mmWhere = mmClauses.length > 0 ? ` WHERE ${mmClauses.join(' AND ')}` : '';
  const rows = all<{
    master_code: string;
    master_name: string;
    module_name: string;
    professor_name: string;
    volume_min: number;
    nb_prevues: number;
    nb_realisees: number;
    prevu_min: number;
    realise_min: number;
  }>(
    db,
    `SELECT m.code AS master_code, m.name AS master_name,
            mo.name AS module_name,
            p.full_name AS professor_name, mm.volume_min,
            COALESCE(sum(s.status != 'ANNULEE'), 0) AS nb_prevues,
            COALESCE(sum(s.status = 'REALISEE'), 0) AS nb_realisees,
            COALESCE(sum(CASE WHEN s.status != 'ANNULEE'
                         THEN s.end_min - s.start_min END), 0) AS prevu_min,
            COALESCE(sum(CASE WHEN s.status = 'REALISEE'
                         THEN CASE WHEN s.actual_start_min IS NOT NULL
                                    AND s.actual_end_min IS NOT NULL
                                   THEN s.actual_end_min - s.actual_start_min
                                   ELSE s.end_min - s.start_min END
                         END), 0) AS realise_min
       FROM master_module mm
       JOIN master m ON m.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = mm.professor_id
       LEFT JOIN session s ON s.master_module_id = mm.id${on}
       ${mmWhere}
      GROUP BY mm.id
      ORDER BY m.code COLLATE NOCASE, mo.code COLLATE NOCASE`,
    ...onParams,
    ...mmParams,
  );
  const columns: ReportColumn[] = [
    { key: 'master', label: 'Master' },
    { key: 'module', label: 'Module' },
    { key: 'professeur', label: 'Professeur' },
    { key: 'prevu_min', label: 'Prévu (min)' },
    { key: 'realise_min', label: 'Réalisé (min)' },
    { key: 'ecart_min', label: 'Écart (min)' },
    { key: 'nb_prevues', label: 'Séances prévues' },
    { key: 'nb_realisees', label: 'Séances réalisées' },
    { key: 'volume_min', label: 'Volume prévu (min)' },
  ];
  const totPrevu = rows.reduce((a, r) => a + r.prevu_min, 0);
  const totReal = rows.reduce((a, r) => a + r.realise_min, 0);
  return apiOk({
    id: 'bilan_heures',
    title: REPORT_TITLES.bilan_heures,
    columns,
    rows: rows.map((r) => ({
      master: `${r.master_code} — ${r.master_name}`,
      module: r.module_name,
      professeur: r.professor_name,
      prevu_min: r.prevu_min,
      realise_min: r.realise_min,
      ecart_min: r.realise_min - r.prevu_min,
      nb_prevues: r.nb_prevues,
      nb_realisees: r.nb_realisees,
      volume_min: r.volume_min,
    })),
    summary: [
      { key: 'prevu', label: 'Total prévu (min)', value: totPrevu },
      { key: 'realise', label: 'Total réalisé (min)', value: totReal },
      { key: 'ecart', label: 'Écart (min)', value: totReal - totPrevu },
    ],
  });
}

// --- 5. non_realisees ------------------------------------------------------------------

/**
 * Séances PREVUE ou REPORTEE passées — statut 'NON_ENCORE_REALISEE'
 * DÉRIVÉ via `today` injectable (jamais stocké, AD-7 ; REPORTEE reste
 * une séance ouverte — même définition que absence.service) : retard en
 * jours depuis la date prévue, triées de la plus ancienne (plus grand
 * retard).
 */
function reportNonRealisees(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  const { where, params } = sessionWhere(f);
  const rows = all<SessionLite & { retard_jours: number }>(
    db,
    `SELECT${SESSION_LITE_COLS},
            CAST(julianday(?) - julianday(s.date) AS INTEGER) AS retard_jours
       ${SESSION_JOINS}
      WHERE s.status IN ('PREVUE', 'REPORTEE') AND s.date < ?${where}
      ORDER BY s.date, s.start_min, s.id`,
    today,
    today,
    ...params,
  );
  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date' },
    { key: 'retard_jours', label: 'Retard (jours)' },
    { key: 'horaire', label: 'Horaire' },
    { key: 'master', label: 'Master' },
    { key: 'module', label: 'Module' },
    { key: 'professeur', label: 'Professeur' },
    { key: 'salle', label: 'Salle' },
  ];
  return apiOk({
    id: 'non_realisees',
    title: REPORT_TITLES.non_realisees,
    columns,
    rows: rows.map((r) => ({
      date: r.date,
      retard_jours: r.retard_jours,
      horaire: horaire(r.start_min, r.end_min),
      master: `${r.master_code} — ${r.master_name}`,
      module: r.module_name,
      professeur: r.professor_name,
      salle: r.room_name,
    })),
    summary: [
      { key: 'total', label: 'Séances non réalisées', value: rows.length },
      {
        key: 'retard_max',
        label: 'Retard max (jours)',
        value: rows.reduce((a, r) => Math.max(a, r.retard_jours), 0),
      },
    ],
  });
}

// --- 6. annulees_reportees --------------------------------------------------------------

/**
 * Séances ANNULEE + REPORTEE avec motif (dernière entrée
 * `session_status_history`) ; pour REPORTEE, la date d'origine vient
 * des `old_*` de l'historique.
 */
function reportAnnuleesReportees(
  db: DatabaseSync,
  f: NormFilter,
): ApiResult<Report> {
  const { where, params } = sessionWhere(f);
  const rows = all<
    SessionLite & {
      reason: string | null;
      old_date: string | null;
      old_start_min: number | null;
      old_end_min: number | null;
    }
  >(
    db,
    `SELECT${SESSION_LITE_COLS},
            h.reason, h.old_date, h.old_start_min, h.old_end_min
       ${SESSION_JOINS}
       LEFT JOIN session_status_history h ON h.id = (
         SELECT h2.id FROM session_status_history h2
          WHERE h2.session_id = s.id
          ORDER BY h2.changed_at DESC, h2.id DESC LIMIT 1)
      WHERE s.status IN ('ANNULEE', 'REPORTEE')${where}
      ORDER BY s.date, s.start_min, s.id`,
    ...params,
  );
  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date' },
    { key: 'statut', label: 'Statut' },
    { key: 'origine', label: 'Créneau précédent' },
    { key: 'horaire', label: 'Horaire' },
    { key: 'master', label: 'Master' },
    { key: 'module', label: 'Module' },
    { key: 'professeur', label: 'Professeur' },
    { key: 'salle', label: 'Salle' },
    { key: 'motif', label: 'Motif' },
  ];
  return apiOk({
    id: 'annulees_reportees',
    title: REPORT_TITLES.annulees_reportees,
    columns,
    rows: rows.map((r) => ({
      date: r.date,
      statut: STATUS_FR[r.status],
      origine:
        r.status === 'REPORTEE' && r.old_date != null
          ? `${r.old_date}${
              r.old_start_min != null && r.old_end_min != null
                ? ` ${horaire(r.old_start_min, r.old_end_min)}`
                : ''
            }`
          : null,
      horaire: horaire(r.start_min, r.end_min),
      master: `${r.master_code} — ${r.master_name}`,
      module: r.module_name,
      professeur: r.professor_name,
      salle: r.room_name,
      motif: r.reason,
    })),
    summary: [
      {
        key: 'annulees',
        label: 'Annulées',
        value: rows.filter((r) => r.status === 'ANNULEE').length,
      },
      {
        key: 'reportees',
        label: 'Reportées',
        value: rows.filter((r) => r.status === 'REPORTEE').length,
      },
    ],
  });
}

// --- 7. absences ----------------------------------------------------------------------

/**
 * Absences professeurs : fenêtre intersectée avec la période demandée,
 * motif, résolution stockée, nb de séances encore ouvertes impactées
 * (PREVUE/REPORTEE — même définition que absence.service) et nb de
 * décisions enregistrées (`absence_decision`). Les deux compteurs sont
 * mesurés sur l'intersection fenêtre d'absence ∩ période du filtre.
 */
function reportAbsences(db: DatabaseSync, f: NormFilter): ApiResult<Report> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (f.professorId != null) {
    clauses.push('a.professor_id = ?');
    params.push(f.professorId);
  }
  if (f.from) {
    clauses.push('a.end_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    clauses.push('a.start_date <= ?');
    params.push(f.to);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  // Bornes de l'intersection fenêtre ∩ filtre (compteurs ci-dessous).
  const lo = f.from ?? '0000-01-01';
  const hi = f.to ?? '9999-12-31';
  const rows = all<{
    professor_name: string;
    start_date: string;
    end_date: string;
    reason: string | null;
    resolution: string;
    nb_impactees: number;
    nb_decisions: number;
  }>(
    db,
    `SELECT p.full_name AS professor_name, a.start_date, a.end_date,
            a.reason, a.resolution,
            (SELECT count(*) FROM session s
              WHERE s.professor_id = a.professor_id
                AND s.status IN ('PREVUE','REPORTEE')
                AND s.date BETWEEN max(a.start_date, ?)
                                AND min(a.end_date, ?)) AS nb_impactees,
            (SELECT count(*) FROM absence_decision d
              JOIN session ds ON ds.id = d.session_id
              WHERE d.absence_id = a.id
                AND ds.date BETWEEN max(a.start_date, ?)
                                 AND min(a.end_date, ?)) AS nb_decisions
       FROM professor_absence a
       JOIN professor p ON p.id = a.professor_id${where}
      ORDER BY a.start_date DESC, a.id DESC`,
    lo,
    hi,
    lo,
    hi,
    ...params,
  );
  const columns: ReportColumn[] = [
    { key: 'professeur', label: 'Professeur' },
    { key: 'debut', label: 'Début' },
    { key: 'fin', label: 'Fin' },
    { key: 'motif', label: 'Motif' },
    { key: 'resolution', label: 'Résolution' },
    { key: 'nb_impactees', label: 'Séances impactées' },
    { key: 'nb_decisions', label: 'Décisions' },
  ];
  return apiOk({
    id: 'absences',
    title: REPORT_TITLES.absences,
    columns,
    rows: rows.map((r) => ({
      professeur: r.professor_name,
      // Période intersectée avec les bornes du filtre.
      debut: f.from != null && r.start_date < f.from ? f.from : r.start_date,
      fin: f.to != null && r.end_date > f.to ? f.to : r.end_date,
      motif: r.reason,
      resolution: RESOLUTION_FR[r.resolution] ?? r.resolution,
      nb_impactees: r.nb_impactees,
      nb_decisions: r.nb_decisions,
    })),
    summary: [
      { key: 'total', label: 'Absences', value: rows.length },
      {
        key: 'impactees',
        label: 'Séances impactées',
        value: rows.reduce((a, r) => a + r.nb_impactees, 0),
      },
    ],
  });
}

// --- 8. avancement ----------------------------------------------------------------------

/**
 * Avancement par master : séances réalisées / prévues (non ANNULEE),
 * taux %, restant à effectuer, modules « à l'heure » vs « en retard »
 * (un master-module est en retard dès qu'il a ≥ 1 séance PREVUE ou
 * REPORTEE passée — séances encore ouvertes, même définition que
 * absence.service ; NON_ENCORE_REALISEE dérivée via `today`).
 */
function reportAvancement(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  const onClauses: string[] = [];
  const onParams: (string | number)[] = [];
  if (f.from) {
    onClauses.push('s.date >= ?');
    onParams.push(f.from);
  }
  if (f.to) {
    onClauses.push('s.date <= ?');
    onParams.push(f.to);
  }
  if (f.roomId != null) {
    onClauses.push('s.room_id = ?');
    onParams.push(f.roomId);
  }
  if (f.professorId != null) {
    onClauses.push('s.professor_id = ?');
    onParams.push(f.professorId);
  }
  const on = onClauses.length > 0 ? ` AND ${onClauses.join(' AND ')}` : '';
  const mClauses: string[] = [];
  const mParams: (string | number)[] = [];
  if (f.masterId != null) {
    mClauses.push('m.id = ?');
    mParams.push(f.masterId);
  }
  const mWhere = mClauses.length > 0 ? ` WHERE ${mClauses.join(' AND ')}` : '';
  const mmCond = f.semesterId != null ? ' AND mm.semester_id = ?' : '';
  const rows = all<{
    master_code: string;
    master_name: string;
    realisees: number;
    prevues: number;
    nb_modules: number;
    modules_en_retard: number;
  }>(
    db,
    `SELECT m.code AS master_code, m.name AS master_name,
            COALESCE(sum(s.status = 'REALISEE'), 0) AS realisees,
            COALESCE(sum(s.id IS NOT NULL AND s.status != 'ANNULEE'), 0)
              AS prevues,
            count(DISTINCT mm.id) AS nb_modules,
            count(DISTINCT CASE
                      WHEN s.status IN ('PREVUE','REPORTEE') AND s.date < ?
                        THEN mm.id
                    END) AS modules_en_retard
       FROM master m
       LEFT JOIN master_module mm ON mm.master_id = m.id${mmCond}
       LEFT JOIN session s ON s.master_module_id = mm.id${on}
       ${mWhere}
      GROUP BY m.id
      ORDER BY m.code COLLATE NOCASE`,
    today,
    ...(f.semesterId != null ? [f.semesterId] : []),
    ...onParams,
    ...mParams,
  );
  const pct = (done: number, total: number): number | null =>
    total > 0 ? Math.round((done / total) * 1000) / 10 : null;
  const columns: ReportColumn[] = [
    { key: 'master', label: 'Master' },
    { key: 'realisees', label: 'Réalisées' },
    { key: 'prevues', label: 'Prévues (non annulées)' },
    { key: 'taux', label: 'Taux réalisé (%)' },
    { key: 'restant', label: 'Restant' },
    { key: 'modules_a_l_heure', label: "Modules à l'heure" },
    { key: 'modules_en_retard', label: 'Modules en retard' },
  ];
  const totReal = rows.reduce((a, r) => a + r.realisees, 0);
  const totPrev = rows.reduce((a, r) => a + r.prevues, 0);
  return apiOk({
    id: 'avancement',
    title: REPORT_TITLES.avancement,
    columns,
    rows: rows.map((r) => ({
      master: `${r.master_code} — ${r.master_name}`,
      realisees: r.realisees,
      prevues: r.prevues,
      taux: pct(r.realisees, r.prevues),
      restant: r.prevues - r.realisees,
      modules_a_l_heure: r.nb_modules - r.modules_en_retard,
      modules_en_retard: r.modules_en_retard,
    })),
    summary: [
      { key: 'masters', label: 'Masters', value: rows.length },
      {
        key: 'taux_global',
        label: 'Taux global (%)',
        value: pct(totReal, totPrev) ?? '—',
      },
    ],
  });
}

// --- 9. occupation_salles ---------------------------------------------------------------

/**
 * Taux d'occupation par salle sur la période : heures réservées
 * (séances Masters non annulées) + heures Licence (blocages récurrents
 * matérialisés par weekday) vs heures ouvrables = Σ `time_slot` ∩ jours
 * de la période (08–18 sur les jours déclarés), jours
 * `calendar_exception` déduits (ni ouvrables ni occurrences Licence).
 * Les deux indicateurs Master/Licence sont séparés ; un éventuel
 * recouvrement des deux est compté dans les deux (indicateur, pas une
 * mesure disjointe — le taux peut dépasser 100 %, non plafonné).
 */
function reportOccupationSalles(
  db: DatabaseSync,
  f: NormFilter,
  today: string,
): ApiResult<Report> {
  const period = resolvePeriod(db, f, today);
  if (!period.ok) return period;
  const { from, to } = period.data;
  const yearId = yearIdAt(db, from);
  const exceptions = loadExceptionDays(db);

  // Heures ouvrables par jour de semaine (time_slot, AD-7), jours
  // d'exception déduits — un weekday sans time_slot ne gonfle PAS les
  // ouvrables même si des séances y sont placées.
  const slotMin = new Map<number, number>();
  for (const r of all<{ weekday: number; m: number }>(
    db,
    'SELECT weekday, sum(end_min - start_min) AS m FROM time_slot GROUP BY weekday',
  )) {
    slotMin.set(r.weekday, r.m);
  }
  let ouvrables = 0;
  for (const [wd, m] of slotMin) {
    ouvrables += m * weekdayOccurrences(wd, from, to, exceptions);
  }

  // Heures Masters réservées par salle (non ANNULEE sur la période).
  const masterByRoom = new Map<number, { min: number; n: number }>();
  for (const r of all<{ room_id: number; m: number; n: number }>(
    db,
    `SELECT s.room_id, sum(s.end_min - s.start_min) AS m, count(*) AS n
       FROM session s
      WHERE s.status != 'ANNULEE' AND s.date >= ? AND s.date <= ?
      GROUP BY s.room_id`,
    from,
    to,
  )) {
    masterByRoom.set(r.room_id, { min: r.m, n: r.n });
  }

  // Heures Licence : durée × occurrences du weekday dans la période.
  const licByRoom = new Map<number, { min: number; n: number }>();
  for (const r of all<{
    room_id: number;
    weekday: number;
    dur: number;
  }>(
    db,
    `SELECT eo.room_id, eo.weekday, eo.end_min - eo.start_min AS dur
       FROM external_occupancy eo
      WHERE eo.academic_year_id IS NULL OR eo.academic_year_id = ?`,
    yearId ?? -1,
  )) {
    const occ = weekdayOccurrences(r.weekday, from, to, exceptions);
    if (occ <= 0) continue;
    const cur = licByRoom.get(r.room_id) ?? { min: 0, n: 0 };
    cur.min += r.dur * occ;
    cur.n += occ;
    licByRoom.set(r.room_id, cur);
  }

  const rooms = all<{ id: number; name: string; is_active: number }>(
    db,
    `SELECT r.id, r.name, r.is_active FROM room r WHERE 1 = 1
       ${f.roomId != null ? ' AND r.id = ?' : ''}
      ORDER BY r.name COLLATE NOCASE`,
    ...(f.roomId != null ? [f.roomId] : []),
  );

  const pct = (used: number): number | null =>
    ouvrables > 0 ? Math.round((used / ouvrables) * 1000) / 10 : null;

  const rows: ReportRow[] = rooms.map((room) => {
    const masterMin = masterByRoom.get(room.id)?.min ?? 0;
    const licMin = licByRoom.get(room.id)?.min ?? 0;
    return {
      salle: roomLabel(room.name, room.is_active),
      heures_master_min: masterMin,
      heures_licence_min: licMin,
      heures_ouvrables_min: ouvrables,
      taux_occupation: pct(masterMin + licMin),
    };
  });
  const columns: ReportColumn[] = [
    { key: 'salle', label: 'Salle' },
    { key: 'heures_master_min', label: 'Heures Masters (min)' },
    { key: 'heures_licence_min', label: 'Heures Licence (min)' },
    { key: 'heures_ouvrables_min', label: 'Heures ouvrables (min)' },
    {
      key: 'taux_occupation',
      label: "Taux d'occupation (%) — heures réservées, recouvrements inclus",
    },
  ];
  const totMaster = rows.reduce((a, r) => a + (r.heures_master_min as number), 0);
  const totLic = rows.reduce((a, r) => a + (r.heures_licence_min as number), 0);
  const summary: ReportSummaryItem[] = [
    { key: 'periode', label: 'Période', value: `${from} → ${to}` },
    { key: 'salles', label: 'Salles', value: rooms.length },
    { key: 'heures_master', label: 'Heures Masters (min)', value: totMaster },
    { key: 'heures_licence', label: 'Heures Licence (min)', value: totLic },
    {
      // Σ heures utilisées / (ouvrables × nb salles) — jamais la
      // capacité d'une seule salle ; non plafonné (les collisions sont
      // de l'information).
      key: 'taux_moyen',
      label:
        "Taux moyen (%) — heures réservées, recouvrements inclus",
      value:
        ouvrables > 0 && rooms.length > 0
          ? Math.round(
              ((totMaster + totLic) / (ouvrables * rooms.length)) * 1000,
            ) / 10
          : '—',
    },
  ];
  return apiOk({
    id: 'occupation_salles',
    title: REPORT_TITLES.occupation_salles,
    columns,
    rows,
    summary,
  });
}

// --- 10. conflits_restes -------------------------------------------------------------------

/**
 * Conflits restés à résoudre (`detectConflicts` réutilisé — aucune
 * nouvelle logique, BR-11) groupés par kind + reste à placer par
 * master-module (FR-35 : max(0, planned − non ANNULEE)). Les compteurs
 * par kind et le reste total sont exposés en `summary`.
 */
function reportConflitsRestes(
  db: DatabaseSync,
  f: NormFilter,
): ApiResult<Report> {
  const res = detectConflicts(db, {
    dateFrom: f.from ?? undefined,
    dateTo: f.to ?? undefined,
  });
  if (!res.ok) return res;
  let items: ConflictItem[] = res.data;
  // Filtre entité : conflits dont ≥ 1 séance appartient au master
  // demandé — résolution PAR ID (session.master_module_id →
  // mm.master_id) en une requête, jamais par nom (homonymes possibles).
  if (f.masterId != null) {
    const master = get<{ id: number }>(
      db,
      'SELECT id FROM master WHERE id = ?',
      f.masterId,
    );
    if (master == null) return apiErr('Master inexistant.');
    const sessionIds = new Set<number>();
    for (const c of items) for (const s of c.sessions) sessionIds.add(s.id);
    const ofMaster = new Set<number>();
    if (sessionIds.size > 0) {
      const ph = [...sessionIds].map(() => '?').join(', ');
      for (const r of all<{ id: number }>(
        db,
        `SELECT s.id FROM session s
          JOIN master_module mm ON mm.id = s.master_module_id
         WHERE mm.master_id = ? AND s.id IN (${ph})`,
        f.masterId,
        ...sessionIds,
      )) {
        ofMaster.add(r.id);
      }
    }
    items = items.filter((c) =>
      c.sessions.some((s) => ofMaster.has(s.id)),
    );
  }
  // Groupé par kind (ordre métier) puis date.
  items = [...items].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.date.localeCompare(b.date) ||
      a.entityLabel.localeCompare(b.entityLabel) ||
      a.startMin - b.startMin,
  );

  // Reste à placer par master-module (FR-35).
  interface MmRest {
    master_code: string;
    master_name: string;
    module_name: string;
    planned: number;
    scheduled: number;
    remaining: number;
  }
  const rests = all<MmRest>(
    db,
    `SELECT m.code AS master_code, m.name AS master_name,
            mo.name AS module_name, mm.planned_sessions AS planned,
            (SELECT count(*) FROM session s
              WHERE s.master_module_id = mm.id
                AND s.status != 'ANNULEE') AS scheduled,
            max(0, mm.planned_sessions -
                (SELECT count(*) FROM session s
                  WHERE s.master_module_id = mm.id
                    AND s.status != 'ANNULEE')) AS remaining
       FROM master_module mm
       JOIN master m ON m.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
      ${f.masterId != null ? ' WHERE mm.master_id = ?' : ''}
      ORDER BY remaining DESC, m.code COLLATE NOCASE, mo.code COLLATE NOCASE`,
    ...(f.masterId != null ? [f.masterId] : []),
  );

  const columns: ReportColumn[] = [
    { key: 'kind', label: 'Type' },
    { key: 'date', label: 'Date' },
    { key: 'horaire', label: 'Chevauchement' },
    { key: 'entite', label: 'Entité' },
    { key: 'detail', label: 'Détail' },
  ];
  const byKind = new Map<ConflictKind, number>();
  for (const c of items) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  const totReste = rests.reduce((a, r) => a + r.remaining, 0);
  const summary: ReportSummaryItem[] = [
    { key: 'total', label: 'Conflits', value: items.length },
    ...KIND_ORDER.map(
      (k): ReportSummaryItem => ({
        key: `kind_${k}`,
        label: `Conflits ${KIND_FR[k]}`,
        value: byKind.get(k) ?? 0,
      }),
    ),
    { key: 'reste', label: 'Séances restant à placer', value: totReste },
    {
      key: 'modules_incomplets',
      label: 'Modules incomplets',
      value: rests.filter((r) => r.remaining > 0).length,
    },
  ];
  // Les lignes « reste à placer » sont jointes après les conflits via
  // une colonne kind distincte — détectable à `kind = 'Reste à placer'`.
  const conflictRows: ReportRow[] = items.map((c) => ({
    kind: KIND_FR[c.kind],
    date: c.date,
    horaire: horaire(c.startMin, c.endMin),
    entite: c.entityLabel,
    detail: c.detail,
  }));
  const restRows: ReportRow[] = rests
    .filter((r) => r.remaining > 0)
    .map((r) => ({
      kind: 'Reste à placer',
      date: null,
      horaire: `${r.scheduled}/${r.planned}`,
      entite: `${r.master_code} — ${r.master_name}`,
      detail: `${r.module_name} : ${r.remaining} séance(s) restante(s)`,
    }));
  return apiOk({
    id: 'conflits_restes',
    title: REPORT_TITLES.conflits_restes,
    columns,
    rows: [...conflictRows, ...restRows],
    summary,
  });
}

// --- Dispatch -----------------------------------------------------------------------------

/** Cap de lignes d'un rapport — au-delà, tronqué + `truncated: true`. */
export const MAX_REPORT_ROWS = 50_000;

/**
 * Exécute un rapport par id — lecture seule (FR-44). `today` injectable
 * pour la dérivation NON_ENCORE_REALISEE et les défauts de période.
 * Au-delà de `MAX_REPORT_ROWS` lignes produites le résultat est tronqué
 * (`truncated: true` + item de summary explicite) plutôt qu'un échec
 * opaque à l'export.
 */
export function runReport(
  db: DatabaseSync,
  id: ReportId,
  filter?: ReportFilter,
  today: string = todayIso(),
): ApiResult<Report> {
  if (!(REPORT_IDS as readonly string[]).includes(id)) {
    return apiErr('Rapport inconnu.');
  }
  const nf = normFilter(filter);
  if (!nf.ok) return nf;
  const f = nf.data;
  let res: ApiResult<Report>;
  switch (id) {
    case 'edt_hebdo':
      res = reportEdtHebdo(db, f, today);
      break;
    case 'salles_planning':
      res = reportSallesPlanning(db, f, today);
      break;
    case 'prof_programme':
      res = reportProfProgramme(db, f, today);
      break;
    case 'bilan_heures':
      res = reportBilanHeures(db, f);
      break;
    case 'non_realisees':
      res = reportNonRealisees(db, f, today);
      break;
    case 'annulees_reportees':
      res = reportAnnuleesReportees(db, f);
      break;
    case 'absences':
      res = reportAbsences(db, f);
      break;
    case 'avancement':
      res = reportAvancement(db, f, today);
      break;
    case 'occupation_salles':
      res = reportOccupationSalles(db, f, today);
      break;
    case 'conflits_restes':
      res = reportConflitsRestes(db, f);
      break;
  }
  if (res.ok && res.data.rows.length > MAX_REPORT_ROWS) {
    res.data.rows = res.data.rows.slice(0, MAX_REPORT_ROWS);
    res.data.truncated = true;
    res.data.summary = [
      ...(res.data.summary ?? []),
      {
        key: 'truncated',
        label: 'Rapport tronqué — précisez les filtres',
        value: MAX_REPORT_ROWS,
      },
    ];
  }
  return res;
}

// --- Export CSV -------------------------------------------------------------------------

/**
 * CSV compatible Excel (FR-41) — délégué à `csvText` (`./csv`, format
 * « Excel FR » unique : BOM UTF-8, `;`, quoting, anti-injection).
 */
export function reportCsv(report: Report): string {
  return csvText(report.columns, report.rows);
}
