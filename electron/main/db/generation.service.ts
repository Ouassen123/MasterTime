/**
 * Génération automatique de l'emploi du temps (P8 — FR-24→29, BR-7→15).
 *
 * - `generate` : moteur glouton heuristique v1 — occupation simulée EN
 *   MÉMOIRE (index Map<date, Map<ressource, intervalles>>), JAMAIS de
 *   requête SQL par candidat (NFR-7). Persiste une ligne
 *   `schedule_generation` PREVIEW (params_json + result_json) auditée —
 *   aucune séance n'est écrite à ce stade (BR-14).
 * - `applyGeneration` : re-vérifie chaque séance proposée via
 *   `checkSessionPlacement` (le monde a pu changer) puis, dans UNE
 *   transaction auditée : ANNULEE des remplacées (REGENERATE, motif +
 *   history), INSERT des nouvelles PREVUE (history NULL→PREVUE,
 *   session_group = groupe du mm), status APPLIED. Idempotent : un id
 *   APPLIED/ABANDONED est refusé.
 * - Modes : COMPLETE ne place que le manquant (planned − non-ANNULEE) ;
 *   REGENERATE ne remplace QUE les PREVUE futures (date >= today,
 *   injectable) — passées/REALISEE/REPORTEE/ANNULEE jamais touchées, le
 *   quota tient compte des conservées.
 *
 * Contraintes dures simulées (BR-7/8/9) : salle libre + is_active +
 * capacité ≥ effectif + hors external_occupancy (même règle année que
 * P7) ; prof libre + is_active + DISPO/INDISPO effectives + pas
 * d'absence ; master/groupe libres ; jours hors calendar_exception
 * (EXAMEN bloque en v1) et weekday doté d'un time_slot, découpé en
 * créneaux de session_duration_min + pause_min.
 *
 * Score souple minimisé par candidat : dépassement
 * max_sessions_per_day_per_master (+ distribution_rule.max_per_day),
 * écart à la position cible i × jours/n (BR-13), weekday hors
 * distribution_rule.weekday_prefs, gaspillage de capacité — tie-break
 * déterministe par `seed` (mulberry32).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  ApplyResult,
  FieldError,
  GenerateParams,
  GenerationApplyResult,
  GenerationCatalog,
  GenerationDetail,
  GenerationListFilter,
  GenerationModuleRef,
  GenerationMode,
  GenerationPayload,
  GenerationResult,
  GenerationRow,
  GenerationStatus,
  PlacementConflict,
  ProposedSession,
  UnplacedItem,
} from '../../../shared/types';
import {
  apiErr,
  apiOk,
  GENERATION_MODES,
  GENERATION_STATUSES,
} from '../../../shared/types';
import { all, get, run } from './connection';
import { isValidIsoDate, todayIso } from './date';
import { withAudit } from './audit.service';
import { checkSessionPlacement } from './conflict.service';

// --- Helpers temps / ids -----------------------------------------------------

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Jour de semaine AD-7 d'une date ISO : 0=lundi … 6=dimanche. */
function weekdayOf(iso: string): number {
  const dt = new Date(`${iso}T00:00:00Z`);
  return (dt.getUTCDay() + 6) % 7;
}

/** `date` + `days` jours en ISO (calcul UTC — pas de fuseau). */
function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(
    min % 60,
  ).padStart(2, '0')}`;
}

/** PRNG déterministe (mulberry32) — reproductibilité par `seed`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mélange Fisher-Yates en place avec le PRNG fourni. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Parse tolérant d'un JSON en colonne TEXT (null si absent/invalide). */
function parseJson<T>(raw: string | null | undefined): T | null {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --- Structures du moteur ----------------------------------------------------

interface Interval {
  s: number;
  e: number;
}

interface AvailRow {
  weekday: number;
  start_min: number;
  end_min: number;
  effective_from: string | null;
  effective_to: string | null;
}

interface ProfConstraints {
  isActive: boolean;
  dispo: AvailRow[];
  indispo: AvailRow[];
  absences: { start: string; end: string }[];
}

interface RoomInfo {
  id: number;
  name: string;
  capacity: number | null;
}

interface ExtOcc {
  roomId: number;
  weekday: number;
  s: number;
  e: number;
  yearId: number | null;
}

/** master-module chargé pour la génération. */
interface MmWork {
  id: number;
  masterId: number;
  masterLabel: string;
  moduleLabel: string;
  yearId: number;
  professorId: number;
  professorName: string;
  groupId: number | null;
  groupName: string | null;
  groupSize: number | null;
  durationMin: number;
  planned: number;
  /** Séances non-ANNULEE existantes (toutes dates). */
  existing: number;
  weekdayPrefs: number[] | null;
  maxPerDayRule: number | null;
  schedStart: string;
  schedEnd: string;
  /** À placer (quota net des conservées). */
  missing: number;
  /** REGENERATE : séances PREVUE futures remplacées. */
  replacedIds: number[];
  replacedLabels: Map<number, string>;
  /** Jours candidats ordonnés (index = position cible BR-13). */
  days: string[];
  /** Créneaux candidats par date (découpés des time_slot). */
  slotsByDay: Map<string, Interval[]>;
  /** Degré de contrainte : créneaux où le prof est disponible. */
  degree: number;
  /** Diagnostics BR-15 agrégés sur les tentatives échouées. */
  diag: {
    slotsExamined: number;
    profUnavailable: number;
    profBusy: number;
    masterBusy: number;
    groupBusy: number;
    roomFail: number;
    roomCapacityOnly: number;
  };
}

/** Occupation simulée : date → ressource → intervalles. */
type Occupancy = Map<string, Map<string, Interval[]>>;

function occAdd(occ: Occupancy, date: string, key: string, s: number, e: number): void {
  let day = occ.get(date);
  if (!day) {
    day = new Map();
    occ.set(date, day);
  }
  const list = day.get(key) ?? [];
  list.push({ s, e });
  day.set(key, list);
}

function occFree(occ: Occupancy, date: string, key: string, s: number, e: number): boolean {
  const list = occ.get(date)?.get(key);
  if (!list) return true;
  return !list.some((iv) => s < iv.e && iv.s < e);
}

/** Vrai si la plage est effective à `date` (bornes NULL = illimitées). */
function effective(row: AvailRow, date: string): boolean {
  return (
    (row.effective_from == null || date >= row.effective_from) &&
    (row.effective_to == null || date <= row.effective_to)
  );
}

type ProfBlock = 'absent' | 'indispo' | 'nodispo' | null;

/**
 * Disponibilité effective du prof sur [date, s, e) — sémantique P6b :
 * si le prof a des plages DISPO effectives à cette date (peu importe le
 * weekday), il n'est disponible QUE dans celles du weekday courant — un
 * jour sans plage DISPO effective est alors indisponible ; sans AUCUNE
 * DISPO (effective ou non) → toujours dispo. INDISPO effective et
 * absence déclarée interdisent le créneau/le jour.
 */
function profBlock(
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

// --- Chargement --------------------------------------------------------------

interface MmRow {
  id: number;
  master_id: number;
  master_code: string;
  master_name: string;
  master_status: string;
  academic_year_id: number;
  module_code: string;
  module_name: string;
  professor_id: number;
  professor_name: string;
  prof_active: number;
  student_group_id: number | null;
  group_name: string | null;
  group_size: number | null;
  session_duration_min: number;
  planned_sessions: number;
  sched_start: string;
  sched_end: string;
  distribution_rule: string | null;
}

function loadMmRows(
  db: DatabaseSync,
  semesterId: number,
  ids: number[] | null,
): MmRow[] {
  const clause =
    ids != null && ids.length > 0
      ? ` AND mm.id IN (${ids.map(() => '?').join(',')})`
      : '';
  return all<MmRow>(
    db,
    `SELECT mm.id, mm.master_id, ma.code AS master_code,
            ma.name AS master_name, ma.status AS master_status,
            ma.academic_year_id,
            mo.code AS module_code, mo.name AS module_name,
            mm.professor_id, p.full_name AS professor_name,
            p.is_active AS prof_active,
            mm.student_group_id, g.name AS group_name, g.size AS group_size,
            mm.session_duration_min, mm.planned_sessions,
            mm.sched_start, mm.sched_end, mm.distribution_rule
       FROM master_module mm
       JOIN master ma ON ma.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = mm.professor_id
       LEFT JOIN student_group g ON g.id = mm.student_group_id
      WHERE mm.semester_id = ?${clause}
      ORDER BY ma.code, mo.code, mm.id`,
    semesterId,
    ...(ids ?? []),
  );
}

// --- API ---------------------------------------------------------------------

/**
 * Lance une génération : simulation en mémoire + persistance PREVIEW
 * (aucune séance écrite, BR-14). `today` injectable (REGENERATE ne
 * remplace que les PREVUE avec date >= today).
 */
export function generate(
  db: DatabaseSync,
  userId: number | null,
  params: GenerateParams,
  today: string = todayIso(),
): ApiResult<GenerationResult> {
  // --- Validation stricte des paramètres (fields) --------------------------
  const errors: FieldError[] = [];
  const semesterId = isId(params?.semester_id) ? params.semester_id : 0;
  const semester =
    semesterId > 0
      ? get<{ id: number; academic_year_id: number }>(
          db,
          'SELECT id, academic_year_id FROM semester WHERE id = ?',
          semesterId,
        )
      : undefined;
  if (!semester) {
    errors.push({ field: 'semester_id', message: 'Semestre inexistant.' });
  }
  const mode = params?.mode;
  if (
    typeof mode !== 'string' ||
    !(GENERATION_MODES as readonly string[]).includes(mode)
  ) {
    errors.push({
      field: 'mode',
      message: "Mode invalide ('COMPLETE' ou 'REGENERATE').",
    });
  }
  const dateStart =
    typeof params?.date_start === 'string' ? params.date_start.trim() : '';
  const dateEnd =
    typeof params?.date_end === 'string' ? params.date_end.trim() : '';
  if (!isValidIsoDate(dateStart)) {
    errors.push({
      field: 'date_start',
      message: 'Date de début invalide (AAAA-MM-JJ).',
    });
  }
  if (!isValidIsoDate(dateEnd)) {
    errors.push({
      field: 'date_end',
      message: 'Date de fin invalide (AAAA-MM-JJ).',
    });
  }
  if (errors.length === 0 && dateStart > dateEnd) {
    errors.push({
      field: 'date_end',
      message: 'La fin doit être postérieure au début.',
    });
  }
  let mmIds: number[] | null = null;
  if (params?.master_module_ids != null) {
    if (
      Array.isArray(params.master_module_ids) &&
      params.master_module_ids.every(isId)
    ) {
      mmIds = [...new Set(params.master_module_ids)];
    } else {
      errors.push({
        field: 'master_module_ids',
        message: 'Master-modules invalides.',
      });
    }
  }
  const pauseMin = params?.pause_min ?? 0;
  if (!Number.isInteger(pauseMin) || pauseMin < 0 || pauseMin > 240) {
    errors.push({
      field: 'pause_min',
      message: 'Pause invalide (entier 0–240 min).',
    });
  }
  const maxPerDayParam = params?.max_sessions_per_day_per_master ?? 2;
  if (!Number.isInteger(maxPerDayParam) || maxPerDayParam < 1 || maxPerDayParam > 12) {
    errors.push({
      field: 'max_sessions_per_day_per_master',
      message: 'Maximum par jour invalide (entier 1–12).',
    });
  }
  const seed =
    params?.seed != null && Number.isInteger(params.seed)
      ? (params.seed as number)
      : Math.floor(Math.random() * 2 ** 31);
  if (errors.length > 0) {
    return apiErr('Paramètres de génération invalides.', errors);
  }

  // --- Chargement des master-modules ciblés ---------------------------------
  const warnings: string[] = [];
  const rows = loadMmRows(db, semesterId, mmIds);
  const works: MmWork[] = [];
  for (const r of rows) {
    const label = `${r.module_code} — ${r.module_name}`;
    if (r.master_status === 'ARCHIVE') {
      warnings.push(
        `${r.master_code} — ${r.master_name} : master archivé, « ${label} » ignoré.`,
      );
      continue;
    }
    if (r.prof_active !== 1) {
      warnings.push(
        `${label} (${r.master_code}) : professeur « ${r.professor_name} » désactivé, ignoré.`,
      );
      continue;
    }
    const rule = parseJson<{ weekday_prefs?: unknown; max_per_day?: unknown }>(
      r.distribution_rule,
    );
    works.push({
      id: r.id,
      masterId: r.master_id,
      masterLabel: `${r.master_code} — ${r.master_name}`,
      moduleLabel: label,
      yearId: r.academic_year_id,
      professorId: r.professor_id,
      professorName: r.professor_name,
      groupId: r.student_group_id,
      groupName: r.group_name,
      groupSize: r.group_size,
      // Durée ≥ 1 : pas de CHECK en base — un mm à 0 ferait boucler la
      // découpe des fenêtres indéfiniment.
      durationMin: Math.max(1, r.session_duration_min),
      planned: r.planned_sessions,
      existing: 0,
      weekdayPrefs:
        rule != null &&
        Array.isArray(rule.weekday_prefs) &&
        rule.weekday_prefs.every(
          (w) => Number.isInteger(w) && (w as number) >= 0 && (w as number) <= 6,
        )
          ? (rule.weekday_prefs as number[])
          : null,
      maxPerDayRule:
        rule != null && Number.isInteger(rule.max_per_day) && (rule.max_per_day as number) >= 1
          ? (rule.max_per_day as number)
          : null,
      schedStart: r.sched_start,
      schedEnd: r.sched_end,
      missing: 0,
      replacedIds: [],
      replacedLabels: new Map(),
      days: [],
      slotsByDay: new Map(),
      degree: 0,
      diag: {
        slotsExamined: 0,
        profUnavailable: 0,
        profBusy: 0,
        masterBusy: 0,
        groupBusy: 0,
        roomFail: 0,
        roomCapacityOnly: 0,
      },
    });
  }
  if (works.length === 0) {
    return apiErr(
      'Aucun master-module éligible pour ce semestre ' +
        '(master archivé ou professeur désactivé).',
    );
  }

  // --- Référentiels temps & contraintes --------------------------------------
  const slotsByWeekday = new Map<number, Interval[]>();
  for (const ts of all<{ weekday: number; start_min: number; end_min: number }>(
    db,
    'SELECT weekday, start_min, end_min FROM time_slot ORDER BY weekday, start_min',
  )) {
    const list = slotsByWeekday.get(ts.weekday) ?? [];
    list.push({ s: ts.start_min, e: ts.end_min });
    slotsByWeekday.set(ts.weekday, list);
  }
  const exceptions = new Set<string>();
  for (const ex of all<{ start_date: string; end_date: string }>(
    db,
    "SELECT start_date, end_date FROM calendar_exception",
  )) {
    for (let d = ex.start_date; d <= ex.end_date; d = addDays(d, 1)) {
      exceptions.add(d);
    }
  }
  const profIds = [...new Set(works.map((w) => w.professorId))];
  const profCons = new Map<number, ProfConstraints>();
  for (const pid of profIds) {
    profCons.set(pid, { isActive: true, dispo: [], indispo: [], absences: [] });
  }
  const ph = profIds.map(() => '?').join(',');
  for (const r of all<AvailRow & { professor_id: number; kind: string }>(
    db,
    `SELECT professor_id, weekday, start_min, end_min, kind,
            effective_from, effective_to
       FROM professor_availability WHERE professor_id IN (${ph})`,
    ...profIds,
  )) {
    const c = profCons.get(r.professor_id);
    if (!c) continue;
    (r.kind === 'DISPO' ? c.dispo : c.indispo).push(r);
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
    profCons.get(r.professor_id)?.absences.push({
      start: r.start_date,
      end: r.end_date,
    });
  }
  const rooms = all<RoomInfo>(
    db,
    'SELECT id, name, capacity FROM room WHERE is_active = 1 ORDER BY id',
  );
  const extOcc = all<ExtOcc>(
    db,
    `SELECT room_id AS roomId, weekday, start_min AS s, end_min AS e,
            academic_year_id AS yearId
       FROM external_occupancy`,
  );

  // --- Quotas : existantes (toutes dates) + remplacées (REGENERATE) ----------
  const workById = new Map(works.map((w) => [w.id, w]));
  for (const r of all<{ master_module_id: number; c: number }>(
    db,
    `SELECT master_module_id, count(*) AS c FROM session
      WHERE status != 'ANNULEE' GROUP BY master_module_id`,
  )) {
    const w = workById.get(r.master_module_id);
    if (w) w.existing = r.c;
  }
  if (mode === 'REGENERATE') {
    // Remplacées = PREVUE futures des mm ciblés — libèrent leur créneau
    // (annulées à l'apply) et comptent dans le quota comme NON conservées.
    for (const r of all<{
      id: number;
      master_module_id: number;
      date: string;
      start_min: number;
      end_min: number;
      room_name: string;
    }>(
      db,
      `SELECT s.id, s.master_module_id, s.date, s.start_min, s.end_min,
              ro.name AS room_name
         FROM session s
         JOIN room ro ON ro.id = s.room_id
        WHERE s.status = 'PREVUE' AND s.date >= ?
          AND s.master_module_id IN (${works.map(() => '?').join(',')})
        ORDER BY s.date, s.start_min, s.id`,
      today,
      ...works.map((w) => w.id),
    )) {
      const w = workById.get(r.master_module_id);
      if (!w) continue;
      w.replacedIds.push(r.id);
      w.replacedLabels.set(
        r.id,
        `${r.date} ${minToHHMM(r.start_min)}–${minToHHMM(r.end_min)} · ${r.room_name}`,
      );
    }
  }
  for (const w of works) {
    const kept = w.existing - (mode === 'REGENERATE' ? w.replacedIds.length : 0);
    w.missing = Math.max(0, w.planned - kept);
  }
  const alreadyDone = works.filter((w) => w.missing === 0).length;
  if (alreadyDone > 0) {
    warnings.push(
      `${alreadyDone} master-module(s) déjà complet(s) : rien à placer.`,
    );
  }
  if (works.every((w) => w.missing === 0)) {
    warnings.push('Tous les master-modules ciblés sont déjà complets.');
  }

  // --- Occupation simulée ----------------------------------------------------
  const occ: Occupancy = new Map();
  const masterDayCount = new Map<number, Map<string, number>>();
  const bumpMasterDay = (masterId: number, date: string, delta: number): void => {
    let m = masterDayCount.get(masterId);
    if (!m) {
      m = new Map();
      masterDayCount.set(masterId, m);
    }
    m.set(date, (m.get(date) ?? 0) + delta);
  };
  const replacedSet = new Set(works.flatMap((w) => w.replacedIds));
  // Séances existantes dans la fenêtre (hors ANNULEE, hors remplacées).
  interface OccSession {
    id: number;
    master_module_id: number;
    professor_id: number;
    room_id: number;
    date: string;
    start_min: number;
    end_min: number;
    master_id: number;
  }
  const occSessions = all<OccSession>(
    db,
    `SELECT s.id, s.master_module_id, s.professor_id, s.room_id,
            s.date, s.start_min, s.end_min, mm.master_id
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
      WHERE s.status != 'ANNULEE' AND s.date >= ? AND s.date <= ?`,
    dateStart,
    dateEnd,
  ).filter((s) => !replacedSet.has(s.id));
  const sessionGroups = new Map<number, number[]>();
  for (const r of all<{ session_id: number; student_group_id: number }>(
    db,
    'SELECT session_id, student_group_id FROM session_group',
  )) {
    const list = sessionGroups.get(r.session_id) ?? [];
    list.push(r.student_group_id);
    sessionGroups.set(r.session_id, list);
  }
  const mmGroupOf = new Map<number, number | null>(
    rows.map((r) => [r.id, r.student_group_id]),
  );
  for (const s of occSessions) {
    occAdd(occ, s.date, `room:${s.room_id}`, s.start_min, s.end_min);
    occAdd(occ, s.date, `prof:${s.professor_id}`, s.start_min, s.end_min);
    occAdd(occ, s.date, `master:${s.master_id}`, s.start_min, s.end_min);
    bumpMasterDay(s.master_id, s.date, 1);
    const g = new Set<number>(sessionGroups.get(s.id) ?? []);
    const mmG = mmGroupOf.get(s.master_module_id);
    if (mmG != null) g.add(mmG);
    for (const gid of g) {
      occAdd(occ, s.date, `group:${gid}`, s.start_min, s.end_min);
    }
  }

  // --- Grille candidate par mm ----------------------------------------------
  const allDays = new Set<string>();
  let truncated = false;
  for (const w of works) {
    const gStart = max3(dateStart, w.schedStart, mode === 'REGENERATE' ? today : '');
    const gEnd = w.schedEnd < dateEnd ? w.schedEnd : dateEnd;
    for (let d = gStart; d <= gEnd; d = addDays(d, 1)) {
      const wd = weekdayOf(d);
      const windows = slotsByWeekday.get(wd);
      if (!windows || exceptions.has(d)) continue;
      const slots: Interval[] = [];
      for (const win of windows) {
        for (let pos = win.s; pos < win.e; pos += w.durationMin + pauseMin) {
          const e = Math.min(pos + w.durationMin, win.e);
          if (e - pos < w.durationMin) truncated = true;
          slots.push({ s: pos, e });
        }
      }
      if (slots.length === 0) continue;
      w.days.push(d);
      w.slotsByDay.set(d, slots);
      allDays.add(d);
    }
    // Degré de contrainte : nb de créneaux où le prof est disponible
    // (le plus restreint passe en premier — BR-13 tri glouton).
    const cons = profCons.get(w.professorId)!;
    let deg = 0;
    for (const d of w.days) {
      const wd = weekdayOf(d);
      for (const sl of w.slotsByDay.get(d)!) {
        if (profBlock(cons, d, wd, sl.s, sl.e) == null) deg++;
      }
    }
    w.degree = deg;
  }
  if (truncated) {
    warnings.push(
      'Fenêtres non multiples de la durée de séance : dernier créneau ' +
        'tronqué à la fin de la fenêtre horaire.',
    );
  }

  // --- Placement glouton -----------------------------------------------------
  const rng = mulberry32(seed);
  const ordered = works
    .filter((w) => w.missing > 0)
    .sort(
      (a, b) =>
        a.degree - b.degree ||
        b.missing - a.missing ||
        a.id - b.id,
    );
  const placed: ProposedSession[] = [];
  const unplaced = new Map<number, UnplacedItem>();
  // Cache des salles libres par créneau (indépendant du mm — capacité et
  // règle d'année external_occupancy évaluées ensuite par mm).
  // Cache des salles libres par créneau (indépendant du mm — capacité et
  // règle d'année external_occupancy évaluées ensuite par mm). Vidé à
  // chaque placement : l'occupation simulée évolue.
  const freeRoomsCache = new Map<string, RoomInfo[]>();
  const freeRooms = (date: string, s: number, e: number): RoomInfo[] => {
    const key = `${date}|${s}|${e}`;
    let cached = freeRoomsCache.get(key);
    if (!cached) {
      cached = rooms.filter((r) => occFree(occ, date, `room:${r.id}`, s, e));
      freeRoomsCache.set(key, cached);
    }
    return cached;
  };
  const extBlocked = (
    w: MmWork,
    roomId: number,
    weekday: number,
    s: number,
    e: number,
  ): boolean =>
    extOcc.some(
      (o) =>
        o.roomId === roomId &&
        o.weekday === weekday &&
        (o.yearId == null || o.yearId === w.yearId) &&
        s < o.e &&
        o.s < e,
    );

  for (const w of ordered) {
    const cons = profCons.get(w.professorId)!;
    const limit = Math.min(
      maxPerDayParam,
      w.maxPerDayRule ?? Number.MAX_SAFE_INTEGER,
    );
    const n = w.missing;
    const D = w.days.length;
    for (let i = 0; i < n; i++) {
      // Position cible BR-13 : i × jours/n (répartition régulière).
      const target = n > 1 ? Math.floor((i * D) / n) : Math.floor(D / 2);
      interface Cand {
        date: string;
        dayIndex: number;
        s: number;
        e: number;
        room: RoomInfo;
        score: number;
      }
      const candidates: Cand[] = [];
      const stats = {
        profUnavail: 0,
        profBusy: 0,
        masterBusy: 0,
        groupBusy: 0,
        roomFail: 0,
        roomCapacityOnly: 0,
        slots: 0,
      };
      w.days.forEach((d, dayIndex) => {
        const wd = weekdayOf(d);
        for (const sl of w.slotsByDay.get(d)!) {
          stats.slots++;
          const block = profBlock(cons, d, wd, sl.s, sl.e);
          if (block != null) {
            stats.profUnavail++;
            continue;
          }
          if (!occFree(occ, d, `prof:${w.professorId}`, sl.s, sl.e)) {
            stats.profBusy++;
            continue;
          }
          if (!occFree(occ, d, `master:${w.masterId}`, sl.s, sl.e)) {
            stats.masterBusy++;
            continue;
          }
          if (
            w.groupId != null &&
            !occFree(occ, d, `group:${w.groupId}`, sl.s, sl.e)
          ) {
            stats.groupBusy++;
            continue;
          }
          const dayCount = masterDayCount.get(w.masterId)?.get(d) ?? 0;
          const okRooms: { room: RoomInfo; waste: number }[] = [];
          let anyCapacity = false;
          for (const r of freeRooms(d, sl.s, sl.e)) {
            const capFits =
              r.capacity == null || w.groupSize == null || r.capacity >= w.groupSize;
            if (!capFits) continue;
            anyCapacity = true;
            if (extBlocked(w, r.id, wd, sl.s, sl.e)) continue;
            okRooms.push({
              room: r,
              waste:
                r.capacity != null && w.groupSize != null
                  ? r.capacity - w.groupSize
                  : 0,
            });
          }
          if (okRooms.length === 0) {
            stats.roomFail++;
            if (!anyCapacity) stats.roomCapacityOnly++;
            continue;
          }
          for (const { room, waste } of okRooms) {
            let score = waste;
            // Dépassement max/jour (souple) + étalement sous la limite.
            const over = dayCount + 1 - limit;
            if (over > 0) score += 1000 * over;
            score += 5 * dayCount;
            // Écart à la position cible (répartition régulière).
            score += 8 * Math.abs(dayIndex - target);
            // Préférence weekday de distribution_rule.
            if (w.weekdayPrefs != null && !w.weekdayPrefs.includes(wd)) {
              score += 100;
            }
            candidates.push({
              date: d,
              dayIndex,
              s: sl.s,
              e: sl.e,
              room,
              score,
            });
          }
        }
      });
      if (candidates.length === 0) {
        // Diagnostic BR-15 agrégé sur cette tentative.
        const dg = w.diag;
        dg.slotsExamined += stats.slots;
        dg.profUnavailable += stats.profUnavail;
        dg.profBusy += stats.profBusy;
        dg.masterBusy += stats.masterBusy;
        dg.groupBusy += stats.groupBusy;
        dg.roomFail += stats.roomFail;
        dg.roomCapacityOnly += stats.roomCapacityOnly;
        continue;
      }
      // Score minimal ; tie-break déterministe par seed (ordre mélangé).
      const best = shuffle(candidates, rng).reduce((a, b) =>
        b.score < a.score ? b : a,
      );
      freeRoomsCache.clear();
      occAdd(occ, best.date, `room:${best.room.id}`, best.s, best.e);
      occAdd(occ, best.date, `prof:${w.professorId}`, best.s, best.e);
      occAdd(occ, best.date, `master:${w.masterId}`, best.s, best.e);
      if (w.groupId != null) {
        occAdd(occ, best.date, `group:${w.groupId}`, best.s, best.e);
      }
      bumpMasterDay(w.masterId, best.date, 1);
      const dayCountAfter = masterDayCount.get(w.masterId)!.get(best.date)!;
      if (dayCountAfter > limit) {
        warnings.push(
          `${w.masterLabel} : ${dayCountAfter} séances le ${best.date} ` +
            `(maximum souple ${limit} dépassé).`,
        );
      }
      const replacesId =
        i < w.replacedIds.length ? w.replacedIds[i] : null;
      placed.push({
        master_module_id: w.id,
        module_label: w.moduleLabel,
        master_id: w.masterId,
        master_label: w.masterLabel,
        professor_id: w.professorId,
        professor_name: w.professorName,
        room_id: best.room.id,
        room_name: best.room.name,
        group_id: w.groupId,
        group_name: w.groupName,
        date: best.date,
        start_min: best.s,
        end_min: best.e,
        replaces_session_id: replacesId,
        replaces_label:
          replacesId != null ? (w.replacedLabels.get(replacesId) ?? null) : null,
      });
    }
  }

  // Rapport d'échec BR-15 (raisons agrégées + suggestions).
  for (const w of ordered) {
    const placedCount = placed.filter((p) => p.master_module_id === w.id).length;
    const missing = w.missing - placedCount;
    if (missing <= 0) continue;
    const dg = w.diag;
    const reasons: string[] = [];
    const suggestions: string[] = [];
    if (w.days.length === 0) {
      reasons.push(
        'Aucun jour candidat : la plage demandée ∩ sched_start/sched_end ' +
          'ne contient aucun jour doté d’un créneau horaire hors exception.',
      );
      suggestions.push(
        'Élargir la plage de dates ou vérifier sched_start/sched_end du module.',
      );
      suggestions.push(
        'Vérifier les exceptions calendrier et les créneaux horaires (time_slot).',
      );
    } else {
      if (dg.profUnavailable > 0) {
        reasons.push(
          `Professeur indisponible (absence, INDISPO ou hors plages DISPO) ` +
            `sur ${dg.profUnavailable} créneau(x) examiné(s).`,
        );
        suggestions.push(
          'Ajouter des DISPO au professeur ou lever ses INDISPO/absences.',
        );
      }
      if (dg.profBusy > 0) {
        reasons.push(
          `Professeur déjà en séance sur ${dg.profBusy} créneau(x).`,
        );
      }
      if (dg.masterBusy > 0) {
        reasons.push(
          `Master déjà occupé (autre séance) sur ${dg.masterBusy} créneau(x).`,
        );
        suggestions.push(
          'Élargir la fenêtre de dates ou réduire le volume à placer.',
        );
      }
      if (dg.groupBusy > 0) {
        reasons.push(
          `Groupe déjà occupé sur ${dg.groupBusy} créneau(x).`,
        );
      }
      if (dg.roomFail > 0) {
        reasons.push(
          `Aucune salle libre compatible sur ${dg.roomFail} créneau(x) ` +
            `(occupation ou blocage externe Licence).`,
        );
        suggestions.push(
          'Activer une salle supplémentaire ou élargir les créneaux horaires.',
        );
      }
      if (dg.roomCapacityOnly > 0) {
        reasons.push(
          `Capacité insuffisante : aucune salle active n’accueille ` +
            `l’effectif sur ${dg.roomCapacityOnly} créneau(x).`,
        );
        suggestions.push(
          'Ajouter ou activer une salle de capacité suffisante.',
        );
      }
    }
    if (suggestions.length === 0) {
      suggestions.push(
        'Réduire le nombre de séances prévues (planned_sessions).',
      );
    }
    unplaced.set(w.id, {
      master_module_id: w.id,
      module_label: w.moduleLabel,
      master_label: w.masterLabel,
      professor_name: w.professorName,
      missing,
      reasons,
      suggestions,
    });
  }

  const unplacedList = [...unplaced.values()];
  const replacedIds = works.flatMap((w) => w.replacedIds);
  const payload: GenerationPayload = {
    placed: [...placed].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start_min - b.start_min ||
        a.master_module_id - b.master_module_id,
    ),
    unplaced: unplacedList,
    warnings,
    summary: {
      placed: placed.length,
      unplaced: unplacedList.reduce((acc, u) => acc + u.missing, 0),
      replaced: replacedIds.length,
      days: allDays.size,
    },
    replaced_ids: replacedIds,
  };
  const normalized: GenerateParams = {
    semester_id: semesterId,
    master_module_ids: mmIds ?? undefined,
    mode: mode as GenerationMode,
    date_start: dateStart,
    date_end: dateEnd,
    pause_min: pauseMin,
    max_sessions_per_day_per_master: maxPerDayParam,
    seed,
  };

  // --- Persistance PREVIEW (BR-14 : aucune séance écrite) --------------------
  const generationId = withAudit(
    db,
    userId,
    'CREATE',
    'schedule_generation',
    null,
    () =>
      Number(
        run(
          db,
          `INSERT INTO schedule_generation
             (created_by, academic_year_id, semester_id,
              params_json, result_json, placed_count, status)
           VALUES (?, ?, ?, ?, ?, ?, 'PREVIEW')`,
          userId,
          semester!.academic_year_id,
          semesterId,
          JSON.stringify(normalized),
          JSON.stringify(payload),
          payload.summary.placed,
        ).lastInsertRowid,
      ),
  );
  return apiOk({ generation_id: generationId!, ...payload });
}

/** max de trois bornes (chaîne vide = sans effet). */
function max3(a: string, b: string, c: string): string {
  let m = a > b ? a : b;
  if (c !== '' && c > m) m = c;
  return m;
}

/**
 * Application d'une preview : re-vérification monde réel de chaque
 * candidate (`checkSessionPlacement`, les remplacées exclues), puis
 * transaction unique auditée — REGENERATE → ANNULEE des remplacées
 * (history + motif), INSERT des nouvelles PREVUE (history NULL→PREVUE,
 * session_group = groupe du mm), status APPLIED. Refus détaillé si un
 * conflit est apparu : rien n'est écrit. Idempotent : APPLIED/ABANDONED
 * → refus.
 */
export function applyGeneration(
  db: DatabaseSync,
  userId: number | null,
  generationId: number,
  today: string = todayIso(),
): GenerationApplyResult {
  const fail = (
    error: string,
    conflicts?: PlacementConflict[],
  ): GenerationApplyResult => ({ ok: false, error, conflicts });
  const row = get<{ id: number; status: GenerationStatus; result_json: string | null }>(
    db,
    'SELECT id, status, result_json FROM schedule_generation WHERE id = ?',
    generationId,
  );
  if (!row) return fail('Génération introuvable.');
  if (row.status !== 'PREVIEW') {
    return fail(
      row.status === 'APPLIED'
        ? 'Cette génération a déjà été appliquée.'
        : 'Cette génération a été abandonnée.',
    );
  }
  const payload = parseJson<GenerationPayload>(row.result_json);
  if (payload == null || !Array.isArray(payload.placed)) {
    return fail('Résultat de génération illisible.');
  }
  const placed = payload.placed;
  const replacedIds = (payload.replaced_ids ?? []).filter(isId);

  // Les remplacées doivent être encore PREVUE futures — une séance passée
  // ou changée de statut depuis la preview invalide l'application.
  const stale: string[] = [];
  for (const sid of replacedIds) {
    const s = get<{ status: string; date: string }>(
      db,
      'SELECT status, date FROM session WHERE id = ?',
      sid,
    );
    if (!s) stale.push(`#${sid} (supprimée)`);
    else if (s.status !== 'PREVUE') stale.push(`#${sid} (${s.status})`);
    else if (s.date < today) stale.push(`#${sid} (passée)`);
  }
  if (stale.length > 0) {
    return fail(
      `Application refusée : ${stale.length} séance(s) à remplacer ont ` +
        `changé depuis la preview (${stale.slice(0, 5).join(', ')}). ` +
        'Régénérez le planning.',
    );
  }

  // Re-vérification BR-10 de chaque candidate (monde réel). Les remplacées
  // seront annulées dans la même transaction : exclues de la garde.
  const conflicts: PlacementConflict[] = [];
  for (const p of placed) {
    const groupIds = p.group_id != null ? [p.group_id] : [];
    const res = checkSessionPlacement(db, {
      date: p.date,
      startMin: p.start_min,
      endMin: p.end_min,
      roomId: p.room_id,
      professorId: p.professor_id,
      masterId: p.master_id,
      groupIds,
      excludeSessionIds: replacedIds,
    });
    if (!res.ok) return fail(res.error);
    conflicts.push(...res.data);
  }
  // Les candidates ne sont pas encore en base : le moteur garantit leur
  // non-chevauchement, mais on re-vérifie en mémoire par défense.
  const byRes = new Map<string, { date: string; s: number; e: number }[]>();
  const pushOcc = (key: string, date: string, s: number, e: number): void => {
    const l = byRes.get(key) ?? [];
    l.push({ date, s, e });
    byRes.set(key, l);
  };
  for (const p of placed) {
    const resKeys = [
      `room:${p.room_id}`,
      `prof:${p.professor_id}`,
      `master:${p.master_id}`,
      ...(p.group_id != null ? [`group:${p.group_id}`] : []),
    ];
    for (const key of resKeys) {
      for (const o of byRes.get(key) ?? []) {
        if (o.date === p.date && p.start_min < o.e && o.s < p.end_min) {
          return fail(
            'Application refusée : le résultat stocké contient des ' +
              'séances proposées qui se chevauchent — régénérez.',
          );
        }
      }
      pushOcc(key, p.date, p.start_min, p.end_min);
    }
  }
  if (conflicts.length > 0) {
    return fail(
      'Application refusée : des conflits sont apparus depuis la preview.',
      conflicts,
    );
  }

  const cancelReason = `Remplacé par génération #${generationId}`;
  const createReason = `Génération #${generationId}`;
  withAudit(
    db,
    userId,
    'UPDATE',
    'schedule_generation',
    generationId,
    () => {
      // Remplacées → ANNULEE (motif + historique, même format que P7b).
      for (const sid of replacedIds) {
        const s = get<{ date: string; start_min: number; end_min: number }>(
          db,
          'SELECT date, start_min, end_min FROM session WHERE id = ?',
          sid,
        )!;
        run(
          db,
          `UPDATE session SET status = 'ANNULEE', updated_at = datetime('now')
            WHERE id = ?`,
          sid,
        );
        run(
          db,
          `INSERT INTO session_status_history
             (session_id, old_status, new_status, changed_by, reason,
              old_date, old_start_min, old_end_min,
              new_date, new_start_min, new_end_min)
           VALUES (?, 'PREVUE', 'ANNULEE', ?, ?, ?, ?, ?, ?, ?, ?)`,
          sid,
          userId,
          cancelReason,
          s.date,
          s.start_min,
          s.end_min,
          s.date,
          s.start_min,
          s.end_min,
        );
      }
      // Nouvelles séances PREVUE (history NULL→PREVUE + session_group =
      // groupe du mm s'il existe + rattachement generation_id).
      for (const p of placed) {
        const sid = Number(
          run(
            db,
            `INSERT INTO session
               (master_module_id, professor_id, room_id, date, start_min,
                end_min, status, generation_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'PREVUE', ?, datetime('now'))`,
            p.master_module_id,
            p.professor_id,
            p.room_id,
            p.date,
            p.start_min,
            p.end_min,
            generationId,
          ).lastInsertRowid,
        );
        run(
          db,
          `INSERT INTO session_status_history
             (session_id, old_status, new_status, changed_by, reason)
           VALUES (?, NULL, 'PREVUE', ?, ?)`,
          sid,
          userId,
          createReason,
        );
        if (p.group_id != null) {
          run(
            db,
            `INSERT INTO session_group (session_id, student_group_id)
             VALUES (?, ?)`,
            sid,
            p.group_id,
          );
        }
      }
      run(
        db,
        `UPDATE schedule_generation SET status = 'APPLIED' WHERE id = ?`,
        generationId,
      );
    },
  );
  return {
    ok: true,
    data: {
      generationId,
      inserted: placed.length,
      cancelled: replacedIds.length,
    } satisfies ApplyResult,
  };
}

/** Historique des générations (plus récentes d'abord), filtrable. */
export function listGenerations(
  db: DatabaseSync,
  filter?: GenerationListFilter,
): ApiResult<GenerationRow[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const status = filter?.status;
  if (
    typeof status === 'string' &&
    (GENERATION_STATUSES as readonly string[]).includes(status)
  ) {
    clauses.push('g.status = ?');
    params.push(status);
  }
  if (isId(filter?.semesterId)) {
    clauses.push('g.semester_id = ?');
    params.push(filter.semesterId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = all<
    Omit<GenerationRow, 'mode' | 'unplaced_count'> & {
      params_json: string | null;
      result_json: string | null;
    }
  >(
    db,
    `SELECT g.id, g.created_at, g.created_by, u.display_name AS user_name,
            g.academic_year_id, g.semester_id, s.label AS semester_label,
            g.placed_count, g.status, g.params_json, g.result_json
       FROM schedule_generation g
       LEFT JOIN app_user u ON u.id = g.created_by
       LEFT JOIN semester s ON s.id = g.semester_id${where}
      ORDER BY g.id DESC`,
    ...params,
  );
  return apiOk(rows.map(toGenerationRow));
}

interface GenerationRowSql {
  params_json: string | null;
  result_json: string | null;
}

function toGenerationRow(
  r: Omit<GenerationRow, 'mode' | 'unplaced_count'> & GenerationRowSql,
): GenerationRow {
  const params = parseJson<GenerateParams>(r.params_json);
  const result = parseJson<GenerationPayload>(r.result_json);
  return {
    id: r.id,
    created_at: r.created_at,
    created_by: r.created_by,
    user_name: r.user_name,
    academic_year_id: r.academic_year_id,
    semester_id: r.semester_id,
    semester_label: r.semester_label,
    mode:
      params?.mode != null &&
      (GENERATION_MODES as readonly string[]).includes(params.mode)
        ? params.mode
        : null,
    placed_count: r.placed_count,
    unplaced_count: result?.summary?.unplaced ?? 0,
    status: r.status,
  };
}

/** Détail d'une génération : row + params_json + result_json parsés. */
export function getGeneration(
  db: DatabaseSync,
  id: number,
): ApiResult<GenerationDetail> {
  if (!isId(id)) return apiErr('Identifiant invalide.');
  const r = get<
    Omit<GenerationRow, 'mode' | 'unplaced_count'> & GenerationRowSql
  >(
    db,
    `SELECT g.id, g.created_at, g.created_by, u.display_name AS user_name,
            g.academic_year_id, g.semester_id, s.label AS semester_label,
            g.placed_count, g.status, g.params_json, g.result_json
       FROM schedule_generation g
       LEFT JOIN app_user u ON u.id = g.created_by
       LEFT JOIN semester s ON s.id = g.semester_id
      WHERE g.id = ?`,
    id,
  );
  if (!r) return apiErr('Génération introuvable.');
  return apiOk({
    row: toGenerationRow(r),
    params: parseJson<GenerateParams>(r.params_json),
    result: parseJson<GenerationPayload>(r.result_json),
  });
}

/** Abandon d'une preview (status → ABANDONED, audité). Idempotent : refus sinon. */
export function abandonGeneration(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  if (!isId(id)) return apiErr('Identifiant invalide.');
  const row = get<{ status: GenerationStatus }>(
    db,
    'SELECT status FROM schedule_generation WHERE id = ?',
    id,
  );
  if (!row) return apiErr('Génération introuvable.');
  if (row.status !== 'PREVIEW') {
    return apiErr(
      'Seule une génération en prévisualisation peut être abandonnée.',
    );
  }
  withAudit(db, userId, 'UPDATE', 'schedule_generation', id, () => {
    run(
      db,
      `UPDATE schedule_generation SET status = 'ABANDONED' WHERE id = ?`,
      id,
    );
  });
  return apiOk(null);
}

/**
 * Catalogue du sélecteur UI : master-modules éligibles d'un semestre
 * (master ACTIF + professeur actif — refus silencieux identique au
 * moteur) + fenêtre globale sched (plage de dates par défaut).
 */
export function generationCatalog(
  db: DatabaseSync,
  semesterId: number,
): ApiResult<GenerationCatalog> {
  if (!isId(semesterId)) return apiErr('Semestre invalide.');
  if (!get(db, 'SELECT id FROM semester WHERE id = ?', semesterId)) {
    return apiErr('Semestre inexistant.');
  }
  const rows = all<MmRow>(
    db,
    `SELECT mm.id, mm.master_id, ma.code AS master_code,
            ma.name AS master_name, ma.status AS master_status,
            ma.academic_year_id,
            mo.code AS module_code, mo.name AS module_name,
            mm.professor_id, p.full_name AS professor_name,
            p.is_active AS prof_active,
            mm.student_group_id, g.name AS group_name, g.size AS group_size,
            mm.session_duration_min, mm.planned_sessions,
            mm.sched_start, mm.sched_end, mm.distribution_rule
       FROM master_module mm
       JOIN master ma ON ma.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN professor p ON p.id = mm.professor_id
       LEFT JOIN student_group g ON g.id = mm.student_group_id
      WHERE mm.semester_id = ?
        AND ma.status = 'ACTIF' AND p.is_active = 1
      ORDER BY ma.code, mo.code, mm.id`,
    semesterId,
  );
  const modules: GenerationModuleRef[] = rows.map((r) => ({
    id: r.id,
    master_id: r.master_id,
    master_code: r.master_code,
    master_name: r.master_name,
    module_label: `${r.module_code} — ${r.module_name}`,
    professor_name: r.professor_name,
    group_name: r.group_name,
    planned_sessions: r.planned_sessions,
    sched_start: r.sched_start,
    sched_end: r.sched_end,
  }));
  return apiOk({
    modules,
    sched_start: rows.length > 0 ? rows.map((r) => r.sched_start).sort()[0] : null,
    sched_end:
      rows.length > 0 ? rows.map((r) => r.sched_end).sort().at(-1)! : null,
  });
}
