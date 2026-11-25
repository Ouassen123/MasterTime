/**
 * Service Séances / Emplois du temps (P7a) — requêtes de lecture seule :
 * vues semaine et mois (séances enrichies des référentiels joints +
 * statut effectif AD-7), vue année (agrégat master × semaine ISO),
 * fiche séance (historique des statuts) et blocages externes récurrents
 * (`external_occupancy` — occupation Licence par jour de semaine).
 *
 * Aucune écriture ici : édition/déplacement/annulation = P7b.
 * `today` est injectable pour les tests (dérivation AD-7).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  AnnualFilter,
  AnnualRow,
  ApiResult,
  EffectiveSessionStatus,
  MonthFilter,
  OccupancyFilter,
  OccupancyRow,
  RegistryFilter,
  RegistryPage,
  RegistryResult,
  RemainingResult,
  SessionDetail,
  SessionFilter,
  SessionHistoryEntry,
  SessionRow,
  SessionStatus,
  WeekFilter,
} from '../../../shared/types';
import {
  apiErr,
  apiOk,
  EFFECTIVE_SESSION_STATUSES,
  effectiveSessionStatus,
  SESSION_STATUSES,
} from '../../../shared/types';
import { all, get } from './connection';
import { isValidIsoDate, todayIso } from './date';

/** Jour de semaine AD-7 d'une date ISO : 0=lundi … 6=dimanche. */
function weekdayOf(iso: string): number {
  const dt = new Date(`${iso}T00:00:00Z`);
  return (dt.getUTCDay() + 6) % 7;
}

/** `date` + `days` jours, en ISO 'YYYY-MM-DD' (calcul UTC — pas de fuseau). */
function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// --- Requête séances enrichies ----------------------------------------------

/**
 * group_name : nom du groupe mm.student_group_id UNION les groupes de
 * session_group (séance multi-groupes, migration 0005) — ', '-joinés.
 */
/**
 * SELECT partagé des séances enrichies — `extraCols` (liste de colonnes
 * `s.*` séparées par des virgules, sans virgule terminale) permet à
 * `getSessionDetail` de récupérer les colonnes brutes supplémentaires
 * sans dupliquer les jointures.
 */
function sessionSelectSql(extraCols = ''): string {
  return `
  SELECT s.id,${extraCols ? `\n         ${extraCols},` : ''}
         s.date, s.start_min, s.end_min, s.status, s.comment,
         m.id AS master_id, m.code AS master_code, m.name AS master_name,
         m.temps_amenage AS master_temps_amenage,
         CASE WHEN sem2.ordinal BETWEEN 1 AND 2 THEN 'M1'
              WHEN sem2.ordinal BETWEEN 3 AND 4 THEN 'M2' END AS master_level,
         mo.id AS module_id, mo.code AS module_code, mo.name AS module_name,
         p.id AS professor_id, p.full_name AS professor_name,
         r.id AS room_id, r.name AS room_name, r.capacity AS room_capacity,
         (SELECT group_concat(name, ', ') FROM (
            SELECT g.name AS name FROM student_group g
             WHERE g.id = mm.student_group_id
            UNION
            SELECT g2.name FROM session_group sg
              JOIN student_group g2 ON g2.id = sg.student_group_id
             WHERE sg.session_id = s.id
          )) AS group_name
    FROM session s
    JOIN master_module mm ON mm.id = s.master_module_id
    JOIN master m ON m.id = mm.master_id
    LEFT JOIN semester sem2 ON sem2.id = m.semester_id
    JOIN module mo ON mo.id = mm.module_id
    JOIN professor p ON p.id = s.professor_id
    JOIN room r ON r.id = s.room_id`;
}

const SESSION_SELECT = sessionSelectSql();

interface SessionSqlRow {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  status: SessionStatus;
  comment: string | null;
  master_id: number;
  master_code: string;
  master_name: string;
  master_temps_amenage: number;
  master_level: 'M1' | 'M2' | null;
  module_id: number;
  module_code: string;
  module_name: string;
  professor_id: number;
  professor_name: string;
  room_id: number;
  room_name: string;
  room_capacity: number | null;
  group_name: string | null;
}

function toSessionRow(r: SessionSqlRow, today: string): SessionRow {
  return {
    id: r.id,
    date: r.date,
    start_min: r.start_min,
    end_min: r.end_min,
    status: r.status,
    effective_status: effectiveSessionStatus(r.status, r.date, today),
    comment: r.comment,
    master: {
      id: r.master_id,
      code: r.master_code,
      name: r.master_name,
      temps_amenage: r.master_temps_amenage,
      level: r.master_level,
    },
    module: { id: r.module_id, code: r.module_code, name: r.module_name },
    professor: { id: r.professor_id, full_name: r.professor_name },
    room: { id: r.room_id, name: r.room_name, capacity: r.room_capacity },
    group_name: r.group_name,
  };
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Filtres ids + statuts EFFECTIFS (AD-7). 'PREVUE' affiché = prévue à
 * venir (`status='PREVUE' AND date >= today`) ; 'NON_ENCORE_REALISEE'
 * (dérivé, jamais stocké) = `status='PREVUE' AND date < today` ; les
 * deux ensemble = `status='PREVUE'` sans borne. Les autres statuts
 * (REALISEE/ANNULEE/REPORTEE) filtrent tels quels. Valeurs forgées hors
 * liste : ignorées (payload IPC non fiable).
 */
function buildFilter(
  filter: SessionFilter | undefined,
  today: string,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (isId(filter?.masterId)) {
    clauses.push('mm.master_id = ?');
    params.push(filter.masterId);
  }
  if (isId(filter?.professorId)) {
    clauses.push('s.professor_id = ?');
    params.push(filter.professorId);
  }
  if (isId(filter?.roomId)) {
    clauses.push('s.room_id = ?');
    params.push(filter.roomId);
  }
  if (isId(filter?.moduleId)) {
    clauses.push('mm.module_id = ?');
    params.push(filter.moduleId);
  }
  if (Array.isArray(filter?.statuses) && filter.statuses.length > 0) {
    const valid = filter.statuses.filter((st): st is EffectiveSessionStatus =>
      (EFFECTIVE_SESSION_STATUSES as readonly string[]).includes(st as string),
    );
    const hasPrevue = valid.includes('PREVUE');
    const hasNonReal = valid.includes('NON_ENCORE_REALISEE');
    const stored = valid.filter(
      (st) => st !== 'PREVUE' && st !== 'NON_ENCORE_REALISEE',
    );
    const ors: string[] = [];
    if (stored.length > 0) {
      ors.push(`s.status IN (${stored.map(() => '?').join(', ')})`);
      params.push(...stored);
    }
    if (hasPrevue && hasNonReal) {
      // PREVUE à venir + dérivée passée = toutes les PREVUE stockées.
      ors.push(`s.status = 'PREVUE'`);
    } else if (hasPrevue) {
      ors.push(`(s.status = 'PREVUE' AND s.date >= ?)`);
      params.push(today);
    } else if (hasNonReal) {
      ors.push(`(s.status = 'PREVUE' AND s.date < ?)`);
      params.push(today);
    }
    if (ors.length > 0) clauses.push(`(${ors.join(' OR ')})`);
  }
  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function listSessions(
  db: DatabaseSync,
  dateFrom: string,
  dateTo: string,
  filter: SessionFilter | undefined,
  today: string,
): SessionRow[] {
  const { where, params } = buildFilter(filter, today);
  const rows = all<SessionSqlRow>(
    db,
    `${SESSION_SELECT}
      WHERE s.date >= ? AND s.date <= ?${where}
      ORDER BY s.date, s.start_min, s.id`,
    dateFrom,
    dateTo,
    ...params,
  );
  return rows.map((r) => toSessionRow(r, today));
}

/**
 * Séances de la semaine [weekStart, weekStart+6] — `weekStart` doit être
 * un lundi ISO valide (AD-7 : 0=lundi). Tri (date, start_min).
 */
export function listSessionsWeek(
  db: DatabaseSync,
  filter: WeekFilter,
  today: string = todayIso(),
): ApiResult<SessionRow[]> {
  const weekStart =
    typeof filter?.weekStart === 'string' ? filter.weekStart.trim() : '';
  if (!isValidIsoDate(weekStart) || weekdayOf(weekStart) !== 0) {
    return apiErr('Le début de semaine doit être un lundi (AAAA-MM-JJ).');
  }
  return apiOk(
    listSessions(db, weekStart, addDays(weekStart, 6), filter, today),
  );
}

/**
 * Séances du mois [monthStart, monthEnd] — séances réelles (le renderer
 * agrège par jour). `year` 1900–2200, `month` 1–12.
 */
export function listSessionsMonth(
  db: DatabaseSync,
  filter: MonthFilter,
  today: string = todayIso(),
): ApiResult<SessionRow[]> {
  const year = filter?.year;
  const month = filter?.month;
  if (
    !Number.isInteger(year) ||
    (year as number) < 1900 ||
    (year as number) > 2200 ||
    !Number.isInteger(month) ||
    (month as number) < 1 ||
    (month as number) > 12
  ) {
    return apiErr('Mois ou année invalide.');
  }
  const y = year as number;
  const m = month as number;
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  // Dernier jour du mois : jour 0 du mois suivant (Date.UTC gère le passage).
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return apiOk(listSessions(db, monthStart, last, filter, today));
}

/**
 * Vue année : séances groupées par master × semaine ISO (semaine = date
 * du lundi). SQLite `%w` est 0=dimanche → le lundi de la date est
 * `date - ((%w + 6) % 7)` jours. Toutes les statuts comptées + détail.
 */
export function listAnnual(
  db: DatabaseSync,
  filter: AnnualFilter,
): ApiResult<AnnualRow[]> {
  if (!isId(filter?.academicYearId)) {
    return apiErr('Année universitaire invalide.');
  }
  const year = get<{ id: number }>(
    db,
    'SELECT id FROM academic_year WHERE id = ?',
    filter.academicYearId,
  );
  if (!year) {
    return apiErr('Année universitaire inexistante.');
  }
  const rows = all<{
    master_id: number;
    master_code: string;
    master_name: string;
    week_start: string;
    count: number;
    prevue: number;
    realisee: number;
    annulee: number;
    reportee: number;
  }>(
    db,
    `SELECT m.id AS master_id, m.code AS master_code, m.name AS master_name,
            date(s.date,
                 '-' || ((CAST(strftime('%w', s.date) AS integer) + 6) % 7)
                 || ' days') AS week_start,
            count(*) AS count,
            COALESCE(sum(s.status = 'PREVUE'), 0) AS prevue,
            COALESCE(sum(s.status = 'REALISEE'), 0) AS realisee,
            COALESCE(sum(s.status = 'ANNULEE'), 0) AS annulee,
            COALESCE(sum(s.status = 'REPORTEE'), 0) AS reportee
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master m ON m.id = mm.master_id
      WHERE m.academic_year_id = ?
      GROUP BY m.id, week_start
      ORDER BY m.code COLLATE NOCASE, week_start`,
    filter.academicYearId,
  );
  return apiOk(
    rows.map((r) => ({
      masterId: r.master_id,
      masterCode: r.master_code,
      masterName: r.master_name,
      weekStart: r.week_start,
      count: r.count,
      parStatut: {
        prevue: r.prevue,
        realisee: r.realisee,
        annulee: r.annulee,
        reportee: r.reportee,
      },
    })),
  );
}

/** Fiche séance : row complet + groupes + historique statuts (desc). */
export function getSessionDetail(
  db: DatabaseSync,
  id: number,
  today: string = todayIso(),
): ApiResult<SessionDetail> {
  const row = get<
    SessionSqlRow & {
      master_module_id: number;
      actual_date: string | null;
      actual_start_min: number | null;
      actual_end_min: number | null;
      generation_id: number | null;
      is_demo: number;
      updated_at: string | null;
    }
  >(
    db,
    sessionSelectSql(
      `s.master_module_id, s.actual_date, s.actual_start_min,
       s.actual_end_min, s.generation_id, s.is_demo, s.updated_at`,
    ) + ' WHERE s.id = ?',
    id,
  );
  if (!row) {
    return apiErr('Séance introuvable.');
  }
  const groups = all<{ id: number; name: string }>(
    db,
    `SELECT id, name FROM (
        SELECT g.id, g.name FROM student_group g
         WHERE g.id = (SELECT student_group_id FROM master_module
                        WHERE id = ?)
        UNION
        SELECT g2.id, g2.name FROM session_group sg
          JOIN student_group g2 ON g2.id = sg.student_group_id
         WHERE sg.session_id = ?
     ) ORDER BY name COLLATE NOCASE`,
    row.master_module_id,
    id,
  );
  const history = all<SessionHistoryEntry>(
    db,
    `SELECT h.id, h.old_status, h.new_status, h.changed_at, h.changed_by,
            u.display_name AS user_name, h.reason,
            h.old_date, h.old_start_min, h.old_end_min,
            h.new_date, h.new_start_min, h.new_end_min
       FROM session_status_history h
       LEFT JOIN app_user u ON u.id = h.changed_by
      WHERE h.session_id = ?
      ORDER BY h.changed_at DESC, h.id DESC`,
    id,
  );
  const {
    master_module_id,
    actual_date,
    actual_start_min,
    actual_end_min,
    generation_id,
    is_demo,
    updated_at,
    ...flat
  } = row;
  return apiOk({
    session: {
      ...toSessionRow(flat, today),
      master_module_id,
      actual_date,
      actual_start_min,
      actual_end_min,
      generation_id,
      is_demo,
      updated_at,
    },
    groups,
    history,
  });
}

/**
 * Blocages externes (occupation Licence) de la semaine — RÉCURRENTS par
 * jour de semaine (pas datés) : `weekStart` sert à matérialiser la date
 * affichée (`weekStart + weekday` jours) et à valider la plage demandée.
 * Filtrable par salle ; tri (weekday, start_min).
 */
export function listOccupancyWeek(
  db: DatabaseSync,
  filter: OccupancyFilter,
): ApiResult<OccupancyRow[]> {
  const weekStart =
    typeof filter?.weekStart === 'string' ? filter.weekStart.trim() : '';
  if (!isValidIsoDate(weekStart) || weekdayOf(weekStart) !== 0) {
    return apiErr('Le début de semaine doit être un lundi (AAAA-MM-JJ).');
  }
  if (filter.roomId != null && !isId(filter.roomId)) {
    return apiErr('Salle invalide.');
  }
  if (filter.academicYearId != null && !isId(filter.academicYearId)) {
    return apiErr('Année universitaire invalide.');
  }
  const clauses: string[] = [];
  const params: (string | number)[] = [weekStart];
  if (isId(filter.roomId)) {
    clauses.push(' AND eo.room_id = ?');
    params.push(filter.roomId);
  }
  // Année : param explicite, sinon celle qui contient weekStart (les
  // blocages NULL s'appliquent à toutes les années — BR-25).
  let yearId: number | null = isId(filter.academicYearId)
    ? filter.academicYearId
    : null;
  if (yearId == null) {
    yearId =
      get<{ id: number }>(
        db,
        'SELECT id FROM academic_year WHERE ? BETWEEN start_date AND end_date',
        weekStart,
      )?.id ?? null;
  }
  if (yearId != null) {
    clauses.push(
      ' AND (eo.academic_year_id IS NULL OR eo.academic_year_id = ?)',
    );
    params.push(yearId);
  }
  const rows = all<{
    id: number;
    program: string;
    groupe: string | null;
    module: string | null;
    professor: string | null;
    weekday: number;
    date: string;
    start_min: number;
    end_min: number;
    room_id: number;
    room_name: string;
  }>(
    db,
    `SELECT eo.id, eo.program, eo.groupe, eo.module, eo.professor,
            eo.weekday, date(?, '+' || eo.weekday || ' days') AS date,
            eo.start_min, eo.end_min, eo.room_id, r.name AS room_name
       FROM external_occupancy eo
       JOIN room r ON r.id = eo.room_id
      WHERE 1 = 1${clauses.join('')}
      ORDER BY eo.weekday, eo.start_min, eo.id`,
    ...params,
  );
  return apiOk(
    rows.map((r) => ({
      ...r,
      label: `Licence — ${r.program}${r.groupe ? ` · ${r.groupe}` : ''}`,
    })),
  );
}

// --- Registre central (P9a — FR-30, FR-35) ------------------------------------

/** Taille de page max du registre (borne anti-payload forgé). */
const REGISTRY_MAX_PAGE_SIZE = 200;
const REGISTRY_DEFAULT_PAGE_SIZE = 20;

/**
 * Registre central `/seances` : toutes les séances jointes aux
 * référentiels, filtres combinés, statut effectif AD-7 et
 * `retard_jours = max(0, today − date)` pour les PREVUE passées.
 *
 * `status_effectif` (valeur unique) est traduit en SQL via `today`
 * injectable : 'PREVUE' = réellement future (`date >= today`),
 * 'NON_ENCORE_REALISEE' (dérivé, jamais stocké) = `date < today`,
 * les autres statuts filtrent tels quels.
 * `search` est une sous-chaîne littérale sur module/master/professeur
 * (LIKE échappé `\`, `%`, `_` — pattern P6a).
 * Tri : plus récentes d'abord. `stats` = compteurs sur l'ensemble
 * filtré complet (pas la page).
 */
export function listSessionsRegistry(
  db: DatabaseSync,
  filter: RegistryFilter | undefined,
  page: RegistryPage | undefined,
  today: string = todayIso(),
): ApiResult<RegistryResult> {
  const dateFrom =
    typeof filter?.date_from === 'string' ? filter.date_from.trim() : '';
  const dateTo =
    typeof filter?.date_to === 'string' ? filter.date_to.trim() : '';
  if (filter?.date_from != null && !isValidIsoDate(dateFrom)) {
    return apiErr('Date de début invalide (AAAA-MM-JJ).');
  }
  if (filter?.date_to != null && !isValidIsoDate(dateTo)) {
    return apiErr('Date de fin invalide (AAAA-MM-JJ).');
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return apiErr('La date de fin doit être postérieure à la date de début.');
  }

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (dateFrom) {
    clauses.push('s.date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push('s.date <= ?');
    params.push(dateTo);
  }
  if (isId(filter?.master_id)) {
    clauses.push('mm.master_id = ?');
    params.push(filter.master_id);
  }
  if (isId(filter?.professor_id)) {
    clauses.push('s.professor_id = ?');
    params.push(filter.professor_id);
  }
  if (isId(filter?.room_id)) {
    clauses.push('s.room_id = ?');
    params.push(filter.room_id);
  }
  if (isId(filter?.module_id)) {
    clauses.push('mm.module_id = ?');
    params.push(filter.module_id);
  }
  // Statut effectif (AD-7) — PREVUE affichée = réellement future.
  const se = filter?.status_effectif;
  if (typeof se === 'string') {
    if (se === 'PREVUE') {
      clauses.push(`s.status = 'PREVUE' AND s.date >= ?`);
      params.push(today);
    } else if (se === 'NON_ENCORE_REALISEE') {
      clauses.push(`s.status = 'PREVUE' AND s.date < ?`);
      params.push(today);
    } else if (
      (SESSION_STATUSES as readonly string[]).includes(se)
    ) {
      clauses.push('s.status = ?');
      params.push(se);
    }
    // Valeur forgée hors liste : ignorée (payload IPC non fiable).
  }
  const q = typeof filter?.search === 'string' ? filter.search.trim() : '';
  if (q) {
    // Sous-chaîne littérale : `%`, `_` et `\` échappés (P6a).
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      `(mo.name LIKE ? ESCAPE '\\' OR mo.code LIKE ? ESCAPE '\\'` +
        ` OR m.name LIKE ? ESCAPE '\\' OR m.code LIKE ? ESCAPE '\\'` +
        ` OR p.full_name LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like);
  }
  const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';

  // Pagination serveur : bornes durcies contre un payload forgé.
  const pageNum =
    Number.isInteger(page?.page) && (page!.page as number) >= 1
      ? (page!.page as number)
      : 1;
  const pageSize =
    Number.isInteger(page?.pageSize) &&
    (page!.pageSize as number) >= 1 &&
    (page!.pageSize as number) <= REGISTRY_MAX_PAGE_SIZE
      ? (page!.pageSize as number)
      : REGISTRY_DEFAULT_PAGE_SIZE;

  const stats = get<{
    total: number;
    realisee: number;
    non_realisee: number;
  }>(
    db,
    `SELECT count(*) AS total,
            COALESCE(sum(s.status = 'REALISEE'), 0) AS realisee,
            COALESCE(sum(s.status = 'PREVUE' AND s.date < ?), 0)
              AS non_realisee
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master m ON m.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = s.professor_id
      WHERE 1 = 1${where}`,
    today,
    ...params,
  ) ?? { total: 0, realisee: 0, non_realisee: 0 };

  const rows = all<
    SessionSqlRow & { retard_jours: number }
  >(
    db,
    `${sessionSelectSql(`CASE WHEN s.status = 'PREVUE' AND s.date < ?
        THEN CAST(julianday(?) - julianday(s.date) AS INTEGER)
        ELSE 0 END AS retard_jours`)}
      WHERE 1 = 1${where}
      ORDER BY s.date DESC, s.start_min DESC, s.id DESC
      LIMIT ? OFFSET ?`,
    today,
    today,
    ...params,
    pageSize,
    (pageNum - 1) * pageSize,
  );
  return apiOk({
    rows: rows.map((r) => ({
      ...toSessionRow(r, today),
      retard_jours: r.retard_jours,
    })),
    total: stats.total,
    page: pageNum,
    pageSize,
    stats: {
      total: stats.total,
      realisee: stats.realisee,
      non_realisee: stats.non_realisee,
      // « En retard » = PREVUE passée non réalisée (retard_jours > 0).
      en_retard: stats.non_realisee,
    },
  });
}

/**
 * Reste à effectuer d'un master-module (FR-35) : `planned_sessions` vs
 * séances non ANNULEE — `remaining = max(0, planned − non annulées)`.
 */
export function remainingSessions(
  db: DatabaseSync,
  masterModuleId: number,
): ApiResult<RemainingResult> {
  if (!isId(masterModuleId)) {
    return apiErr('Master-module invalide.');
  }
  const mm = get<{ id: number; planned_sessions: number }>(
    db,
    'SELECT id, planned_sessions FROM master_module WHERE id = ?',
    masterModuleId,
  );
  if (!mm) {
    return apiErr('Master-module inexistant.');
  }
  const scheduled =
    get<{ c: number }>(
      db,
      `SELECT count(*) AS c FROM session
        WHERE master_module_id = ? AND status != 'ANNULEE'`,
      masterModuleId,
    )?.c ?? 0;
  return apiOk({
    master_module_id: mm.id,
    planned: mm.planned_sessions,
    scheduled_non_cancelled: scheduled,
    remaining: Math.max(0, mm.planned_sessions - scheduled),
  });
}
