/**
 * Types partagés main ↔ renderer (contrats IPC — AD-1).
 * Le renderer ne voit que ces types ; jamais d'accès DB direct.
 */

/** Statut stocké en base (AD-5 / AD-7). */
export const SESSION_STATUSES = ['PREVUE', 'REALISEE', 'ANNULEE', 'REPORTEE'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Statut effectif à l'affichage : 'NON_ENCORE_REALISEE' est DÉRIVÉ à la lecture
 * (PREVUE dont la date est passée) — jamais stocké en base (AD-7).
 */
export const EFFECTIVE_SESSION_STATUSES = [...SESSION_STATUSES, 'NON_ENCORE_REALISEE'] as const;
export type EffectiveSessionStatus = (typeof EFFECTIVE_SESSION_STATUSES)[number];

/** Calcule le statut effectif d'une séance (AD-7). */
export function effectiveSessionStatus(
  status: SessionStatus,
  date: string, // 'YYYY-MM-DD'
  today: string, // 'YYYY-MM-DD'
): EffectiveSessionStatus {
  if (status === 'PREVUE' && date < today) return 'NON_ENCORE_REALISEE';
  return status;
}

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  dbPath: string;
}

/** Compteurs de lignes du jeu de démonstration (et référentiel). */
export interface DbStatusCounts {
  academicYear: number;
  semester: number;
  timeSlot: number;
  room: number;
  master: number;
  professor: number;
  module: number;
  masterModule: number;
  session: number;
  /** Total de lignes `is_demo=1` — > 0 ⇒ bandeau DÉMO (AD-11). */
  demo: number;
}

export interface DbStatus {
  ok: boolean;
  /** Message d'erreur bloquant si l'initialisation DB a échoué. */
  error: string | null;
  dbPath: string;
  /** Nombre de tables utilisateur (attendu : 26 après 0007 — ALTER, pas de table). */
  tableCount: number;
  /** Versions de migrations appliquées (ex. ['0001']). */
  appliedMigrations: string[];
  counts: DbStatusCounts;
}

// ---------------------------------------------------------------------------
// P6a — Socle applicatif + référentiels (salles, modules, profils, audit)
// ---------------------------------------------------------------------------

/** Erreur de validation côté service, mappée sur un champ du formulaire. */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Enveloppe de réponse IPC : soit `data`, soit `error` (+ `fields` pour
 * les erreurs de validation à remonter dans le formulaire).
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fields?: FieldError[] };

export function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function apiErr<T = never>(error: string, fields?: FieldError[]): ApiResult<T> {
  return fields && fields.length > 0
    ? { ok: false, error, fields }
    : { ok: false, error };
}

/** Salle (référentiel) + nombre de séances liées (protection BR-22). */
export interface Room {
  id: number;
  name: string;
  capacity: number | null;
  is_active: number; // 1 actif, 0 désactivé
  /** Séances référençant la salle — suppression refusée si > 0 (BR-22). */
  sessionCount: number;
}

export interface RoomInput {
  name: string;
  capacity?: number | null;
}

/** Module (référentiel) + nombre de master-modules liés (protection BR-22). */
export interface Module {
  id: number;
  code: string;
  name: string;
  is_demo: number;
  /** Associations master_module référençant le module — blocage suppression. */
  masterModuleCount: number;
}

export interface ModuleInput {
  code: string;
  name: string;
}

// ---------------------------------------------------------------------------
// P6b — Professeurs (CRUD, compteurs, disponibilités, absences)
// ---------------------------------------------------------------------------

/** Compteurs de suivi calculés par professeur (AD-7 : statuts dérivés). */
export interface ProfessorCounters {
  /** Séances REALISEE. */
  nb_realisees: number;
  /** Séances PREVUE à venir (date >= aujourd'hui). */
  nb_restantes: number;
  /** Séances PREVUE passées — 'NON_ENCORE_REALISEE' dérivé, jamais stocké. */
  nb_non_realisees: number;
  nb_annulees: number;
  nb_reportees: number;
  /** Σ minutes enseignées : actual_end-actual_start, fallback end-start. */
  heures_enseignees_min: number;
  /** Lignes professor_absence déclarées. */
  nb_absences: number;
}

/** Ligne de la liste Professeurs : référentiel + compteurs + masters. */
export interface ProfessorRow extends ProfessorCounters {
  id: number;
  full_name: string;
  internal_ref: string | null;
  email: string | null;
  phone: string | null;
  is_active: number; // 1 actif, 0 désactivé
  is_demo: number;
  /** Noms des masters enseignés (distincts, via master_module + session). */
  masters: string[];
  /** Liens bloquant la suppression (mm + session + absence + dispo, BR-22). */
  linkedCount: number;
}

export interface ProfessorInput {
  full_name: string;
  internal_ref?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean;
}

/** Couple master/module enseigné (distinct, via master_module + session). */
export interface ProfessorTeaching {
  master_code: string;
  master_name: string;
  module_name: string;
}

export type AvailabilityKind = 'DISPO' | 'INDISPO';

/** Disponibilité/indisponibilité hebdomadaire d'un professeur (0=lun, AD-7). */
export interface AvailabilityRow {
  id: number;
  professor_id: number;
  weekday: number;
  start_min: number;
  end_min: number;
  kind: AvailabilityKind;
  effective_from: string | null;
  effective_to: string | null;
}

export interface AvailabilityInput {
  weekday: number;
  start_min: number;
  end_min: number;
  kind: AvailabilityKind;
  effective_from?: string | null;
  effective_to?: string | null;
}

export type AbsenceResolution = 'A_TRAITER' | 'PARTIELLE' | 'RESOLUE';

/** Absence déclarée — BR-17 : jamais d'annulation automatique de séance. */
export interface AbsenceRow {
  id: number;
  professor_id: number;
  start_date: string;
  end_date: string;
  reason: string | null;
  resolution: AbsenceResolution;
}

export interface AbsenceInput {
  start_date: string;
  end_date: string;
  reason?: string | null;
}

/** Séance d'un professeur enrichie (impactée par une absence, ou à venir). */
export interface ImpactedSession {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  status: SessionStatus;
  module_name: string;
  master_name: string;
  room_name: string;
}

/** Fiche de suivi individuelle (drawer à onglets). */
export interface ProfessorDetail {
  professor: ProfessorRow;
  teachings: ProfessorTeaching[];
  availabilities: AvailabilityRow[];
  absences: AbsenceRow[];
  /** 20 prochaines séances (date >= aujourd'hui, toutes statuts). */
  upcoming: ImpactedSession[];
}

// ---------------------------------------------------------------------------
// P6c — Masters, groupes d'étudiants et master-modules
// ---------------------------------------------------------------------------

/** Statut d'un master (CHECK en base). */
export const MASTER_STATUSES = ['ACTIF', 'ARCHIVE'] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];

/** Filtre de la liste Masters (`status` omis ou 'TOUS' = tous les statuts). */
export interface MasterListFilter {
  search?: string;
  status?: MasterStatus | 'TOUS';
}

/** Ligne de la liste Masters : référentiel + compteurs + protection BR-22. */
export interface MasterRow {
  id: number;
  code: string;
  name: string;
  filiere: string | null;
  department: string | null;
  responsible_name: string | null;
  academic_year_id: number;
  academic_year_label: string;
  semester_id: number | null;
  semester_label: string | null;
  status: MasterStatus;
  is_demo: number;
  /**
   * 1 = master « temps aménagé » (payant) — migration 0008. Prépare le
   * filtrage du traitement service économique / paiement (rapport dédié
   * en phase ultérieure ; aucun traitement en v1).
   */
  temps_amenage: number;
  /** master_module distincts rattachés. */
  nb_modules: number;
  nb_groupes: number;
  /** Séances via master_module, toutes statuts sauf ANNULEE. */
  nb_seances: number;
  /** Σ volume_min des master-modules. */
  volume_prevu_min: number;
  /** Liens bloquant la suppression (BR-22 : groupes + mm + séances + étudiants). */
  linkedCount: number;
}

export interface MasterInput {
  code: string;
  name: string;
  filiere?: string | null;
  department?: string | null;
  responsible_name?: string | null;
  academic_year_id: number;
  semester_id?: number | null;
  status?: MasterStatus;
  /** Master « temps aménagé » (payant) — omis = conservé (update) / 0. */
  temps_amenage?: boolean;
}

/** Compteurs de suivi par master — mêmes règles AD-7 que les professeurs. */
export interface MasterCounters {
  nb_realisees: number;
  nb_restantes: number;
  nb_non_realisees: number;
  nb_annulees: number;
  nb_reportees: number;
  heures_enseignees_min: number;
}

/** Groupe d'étudiants rattaché à un master + protection BR-22. */
export interface StudentGroupRow {
  id: number;
  master_id: number;
  name: string;
  size: number | null;
  /** mm.student_group_id + students + session_group liés. */
  linkedCount: number;
}

export interface GroupInput {
  name: string;
  size?: number | null;
}

/** master_module enrichi des libellés joints (module/prof/semestre/groupe). */
export interface MasterModuleRow {
  id: number;
  master_id: number;
  module_id: number;
  module_code: string;
  module_name: string;
  semester_id: number;
  semester_label: string;
  professor_id: number;
  professor_name: string;
  student_group_id: number | null;
  group_name: string | null;
  volume_min: number;
  session_duration_min: number;
  planned_sessions: number;
  sched_start: string;
  sched_end: string;
  distribution_rule: string | null;
  /** 1 = module fixé : REGENERATE l'ignore, COMPLETE le traite (migration 0007). */
  is_fixed: number;
  /** Séances réelles non annulées rattachées. */
  nb_seances: number;
  /** Toutes les séances référençant le master-module (blocage BR-22). */
  session_count: number;
}

export interface MasterModuleInput {
  module_id: number;
  semester_id: number;
  professor_id: number;
  student_group_id?: number | null;
  volume_min: number;
  session_duration_min: number;
  planned_sessions: number;
  sched_start: string;
  sched_end: string;
  /** JSON libre (règles de répartition), null si absent. */
  distribution_rule?: string | null;
  /** Module fixé (gèle les séances face à REGENERATE) — omis = conservé. */
  is_fixed?: boolean;
}

/**
 * Lien séance ↔ groupe (migration 0005) : séances partagées multi-groupes.
 * Rempli par la génération/édition (Phase 7+) — exposé pour les contrats
 * futurs (édition de séance, comptage d'occupation).
 */
export interface SessionGroup {
  session_id: number;
  student_group_id: number;
}

/** Séance d'un master (onglet « Séances » de la fiche). */
export interface MasterSession extends ImpactedSession {
  professor_name: string;
  group_name: string | null;
}

/** Fiche master : master + compteurs, groupes, master-modules, 20 prochaines. */
export interface MasterDetail {
  master: MasterRow & MasterCounters;
  groups: StudentGroupRow[];
  modules: MasterModuleRow[];
  upcoming: MasterSession[];
}

/**
 * Refus de suppression enrichi (BR-22) — le `linkedCount` chiffre les
 * données liées et `suggest` propose l'alternative ('ARCHIVE' pour un
 * master ; absent pour groupe/master-module qui n'ont pas de statut).
 */
export type DeleteResult =
  | { ok: true; data: null }
  | {
      ok: false;
      error: string;
      fields?: FieldError[];
      linkedCount?: number;
      suggest?: 'ARCHIVE';
    };

/** Référence année universitaire (Select du renderer). */
export interface AcademicYearRef {
  id: number;
  label: string;
  is_current: number;
}

/** Référence semestre (Select du renderer). */
export interface SemesterRef {
  id: number;
  academic_year_id: number;
  label: string;
  ordinal: number;
}

/** Années + semestres exposés via `context:semesters` (formulaires P6c). */
export interface ContextSemesters {
  academicYears: AcademicYearRef[];
  semesters: SemesterRef[];
}

// ---------------------------------------------------------------------------
// P7a — Emplois du temps : vues calendrier + détection de conflits (BR-11)
// ---------------------------------------------------------------------------

/** Filtres communs des vues semaine/mois (ids uniquement — jamais de LIKE). */
export interface SessionFilter {
  masterId?: number;
  professorId?: number;
  roomId?: number;
  moduleId?: number;
  /** Statuts EFFECTIFS (NON_ENCORE_REALISEE dérivé accepté, AD-7). */
  statuses?: EffectiveSessionStatus[];
}

/** Filtre de la vue semaine — `weekStart` est le lundi ISO de la semaine. */
export interface WeekFilter extends SessionFilter {
  weekStart: string; // 'YYYY-MM-DD' (lundi)
}

/** Filtre de la vue mois — `month` dans 1..12. */
export interface MonthFilter extends SessionFilter {
  year: number;
  month: number;
}

/** Filtre de la vue année. */
export interface AnnualFilter {
  academicYearId: number;
}

/** Filtre de la détection de conflits — plage de dates optionnelle. */
export interface ConflictFilter {
  dateFrom?: string;
  dateTo?: string;
}

/** Filtre des blocages externes (occupation Licence, récurrents par weekday). */
export interface OccupancyFilter {
  weekStart: string; // lundi ISO — détermine la date affichée par weekday
  roomId?: number;
  /** Restreint aux blocages de cette année (NULL inclus = toutes années). */
  academicYearId?: number;
}

/** Séance enrichie pour les vues calendrier (jointures + statut dérivé). */
export interface SessionRow {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  status: SessionStatus;
  /** AD-7 : PREVUE + date < aujourd'hui → 'NON_ENCORE_REALISEE'. */
  effective_status: EffectiveSessionStatus;
  comment: string | null;
  master: { id: number; code: string; name: string };
  module: { id: number; code: string; name: string };
  professor: { id: number; full_name: string };
  room: { id: number; name: string; capacity: number | null };
  /** Groupe mm.student_group + groupes session_group (', '-joinés). */
  group_name: string | null;
}

/** Entrée d'historique de statut (session_status_history + nom du profil). */
export interface SessionHistoryEntry {
  id: number;
  old_status: string | null;
  new_status: string;
  changed_at: string;
  changed_by: number | null;
  user_name: string | null;
  reason: string | null;
  old_date: string | null;
  old_start_min: number | null;
  old_end_min: number | null;
  new_date: string | null;
  new_start_min: number | null;
  new_end_min: number | null;
}

/** Fiche séance complète (drawer) : séance + groupes + historique statuts. */
export interface SessionDetail {
  session: SessionRow & {
    master_module_id: number;
    actual_date: string | null;
    actual_start_min: number | null;
    actual_end_min: number | null;
    generation_id: number | null;
    is_demo: number;
    updated_at: string | null;
  };
  /** Groupes liés : mm.student_group + session_group (id + nom). */
  groups: { id: number; name: string }[];
  /** Historique trié du plus récent au plus ancien. */
  history: SessionHistoryEntry[];
}

/** Blocage externe récurrent (Licence) affiché en gris dans la vue salle. */
export interface OccupancyRow {
  id: number;
  program: string;
  groupe: string | null;
  module: string | null;
  professor: string | null;
  weekday: number; // 0=lun..5=sam (AD-7)
  /** Date concrète dans la semaine demandée (weekStart + weekday jours). */
  date: string;
  start_min: number;
  end_min: number;
  room_id: number;
  room_name: string;
  /** Libellé affiché : « Licence — <programme> » (+ groupe si présent). */
  label: string;
}

export type ConflictKind = 'ROOM' | 'PROFESSOR' | 'MASTER' | 'GROUP' | 'EXTERNAL';

/** Séance impliquée dans un conflit (référence compacte pour le panneau). */
export interface ConflictSessionRef {
  id: number;
  /** Libellé court : « <module> — <master> ». */
  label: string;
  masterName: string;
  moduleName: string;
}

/**
 * Conflit détecté (BR-11) : une paire de séances (ou séance ↔ blocage
 * externe) en chevauchement strict sur la même ressource et le même jour.
 * `startMin`/`endMin` = fenêtre de chevauchement.
 */
export interface ConflictItem {
  kind: ConflictKind;
  date: string;
  startMin: number;
  endMin: number;
  /** Entité partagée : salle, professeur, master, groupe ou « Licence — … ». */
  entityLabel: string;
  sessions: ConflictSessionRef[];
  detail: string;
}

/** Compteur global pour la carte « Conflits à résoudre » du dashboard. */
export interface ConflictSummary {
  total: number;
  byKind: Record<ConflictKind, number>;
}

// ---------------------------------------------------------------------------
// P7b — Édition des séances : garde d'écriture + mutations historisées
// ---------------------------------------------------------------------------

/** Conflit de placement d'un candidat — même shape que ConflictItem :
 * `sessions` contient la ou les séances adverses déjà en base (vide pour
 * EXTERNAL : le blocage externe n'est pas une séance). */
export type PlacementConflict = ConflictItem;

/**
 * Candidat de placement à vérifier (BR-10). `groupIds` = ensemble COMPLET
 * des groupes du candidat (mm.student_group_id + groupes session_group).
 */
export interface PlacementQuery {
  date: string; // 'YYYY-MM-DD' calendairement valide
  startMin: number;
  endMin: number; // 0 ≤ startMin < endMin ≤ 1440
  roomId: number;
  professorId: number;
  /** Master du candidat (conflits MASTER + année pour EXTERNAL). */
  masterId: number;
  /** Séance déplacée — exclue de la comparaison (évite le self-conflit). */
  excludeSessionId?: number;
  /**
   * Séances exclues de la comparaison (P8 — REGENERATE : les séances qui
   * seront annulées à l'application ne bloquent pas les candidates).
   * Cumulatif avec `excludeSessionId`.
   */
  excludeSessionIds?: number[];
  groupIds?: number[];
  /**
   * Restreint la garde à certains kinds (anti-wedging : une retouche
   * partielle ne re-check que les kinds affectés — un conflit
   * pré-existant orthogonal ne bloque plus l'écriture). Absent = tous.
   */
  kinds?: ConflictKind[];
}

/** Création manuelle d'une séance (`sessions:create`). */
export interface SessionCreateInput {
  master_module_id: number;
  /** Défaut : professor_id du master-module. */
  professor_id?: number | null;
  room_id: number;
  date: string;
  start_min: number;
  end_min: number;
  /** Groupes supplémentaires (session_group) — master du mm uniquement. */
  group_ids?: number[];
  comment?: string | null;
}

/** Déplacement d'une séance — statut inchangé, historise l'ancien créneau. */
export interface SessionMoveInput {
  date?: string;
  start_min?: number;
  end_min?: number;
  room_id?: number;
  professor_id?: number;
  reason?: string | null;
}

/** Changement de statut via `changeSessionStatus` (AD-7, point d'entrée unique). */
export interface SessionStatusInput {
  status: SessionStatus;
  /** Obligatoire pour ANNULEE/REPORTEE et pour toute correction REALISEE. */
  reason?: string | null;
  /** Nouveau créneau — obligatoire pour REPORTEE (la séance bascule dessus). */
  date?: string;
  start_min?: number;
  end_min?: number;
  /** Réalisation effective — défaut = créneau planifié (REALISEE). */
  actual_date?: string;
  actual_start_min?: number;
  actual_end_min?: number;
  /** Correction admin : autorise la sortie du statut REALISEE (reason requis). */
  corrective?: boolean;
}

/**
 * Résultat d'une mutation de séance : succès → id de la séance ; échec →
 * message (+ `fields` de validation, + `conflicts` détaillés si refus BR-10).
 */
export type SessionEditResult =
  | { ok: true; data: { sessionId: number } }
  | {
      ok: false;
      error: string;
      fields?: FieldError[];
      conflicts?: PlacementConflict[];
    };

/** Ligne de la vue année : master × semaine ISO (lundi) → compteurs statuts. */
export interface AnnualRow {
  masterId: number;
  masterCode: string;
  masterName: string;
  weekStart: string; // lundi ISO de la semaine
  count: number;
  parStatut: {
    prevue: number;
    realisee: number;
    annulee: number;
    reportee: number;
  };
}

// ---------------------------------------------------------------------------
// P8 — Génération automatique de l'emploi du temps (FR-24→29, BR-7→15)
// ---------------------------------------------------------------------------

export const GENERATION_MODES = ['COMPLETE', 'REGENERATE'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const GENERATION_STATUSES = ['PREVIEW', 'APPLIED', 'ABANDONED'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** Paramètres d'une génération (`generation:run`, stockés en params_json). */
export interface GenerateParams {
  semester_id: number;
  /** Absent/vide = tous les master-modules éligibles du semestre. */
  master_module_ids?: number[];
  mode: GenerationMode;
  date_start: string; // 'YYYY-MM-DD' — intersecté avec sched_start/end
  date_end: string;
  /** Pause entre créneaux générés (découpe des time_slot). */
  pause_min?: number;
  /** Défaut 2 — pénalité souple au-delà (distribution_rule.max_per_day aussi). */
  max_sessions_per_day_per_master?: number;
  /** Reproductibilité — défaut : aléatoire. */
  seed?: number;
}

/** Séance proposée par le moteur (jamais écrite avant l'apply — BR-14). */
export interface ProposedSession {
  master_module_id: number;
  module_label: string; // « code — nom »
  master_id: number;
  master_label: string; // « code — nom »
  professor_id: number;
  professor_name: string;
  room_id: number;
  room_name: string;
  group_id: number | null;
  group_name: string | null;
  date: string;
  start_min: number;
  end_min: number;
  /** REGENERATE : séance existante remplacée (ANNULEE à l'apply). */
  replaces_session_id: number | null;
  /** Libellé lisible de la séance remplacée (diff en regard). */
  replaces_label: string | null;
}

/** Échec partiel BR-15 : séances non plaçées d'un master-module. */
export interface UnplacedItem {
  master_module_id: number;
  module_label: string;
  master_label: string;
  professor_name: string;
  /** Nombre de séances restées non placées. */
  missing: number;
  /** Raisons agrégées sur les créneaux examinés (BR-15). */
  reasons: string[];
  /** Pistes d'action (BR-15). */
  suggestions: string[];
}

/** Résumé chiffré d'une génération (persisté dans result_json). */
export interface GenerationSummary {
  /** Séances proposées. */
  placed: number;
  /** Séances demandées non placées (Σ UnplacedItem.missing). */
  unplaced: number;
  /** Séances existantes marquées REMPLACE (REGENERATE). */
  replaced: number;
  /** Jours candidats examinés (union des mm). */
  days: number;
}

/**
 * Séance existante remplacée par une REGENERATE (diff complet) : chaque
 * remplacée figure — appariée à une proposition (`replaced_by_index`)
 * ou non (null → ligne « REMPLACÉE — non replacée » côté UI).
 */
export interface ReplacedSession {
  session_id: number;
  master_module_id: number;
  module_label: string;
  master_label: string;
  professor_name: string;
  date: string;
  start_min: number;
  end_min: number;
  room_name: string;
  /** Index dans `placed[]` de la proposition qui la remplace — null si
   *  non replacée (échec partiel ou quota inférieur). */
  replaced_by_index: number | null;
}

/** Contenu de `result_json` — diff + rapport d'échec. */
export interface GenerationPayload {
  placed: ProposedSession[];
  unplaced: UnplacedItem[];
  warnings: string[];
  summary: GenerationSummary;
  /** Ids des séances existantes remplacées (REGENERATE, à l'apply). */
  replaced_ids: number[];
  /** Détail des remplacées + appariement explicite (diff complet). */
  replaced?: ReplacedSession[];
}

/** Résultat de `generation:run` = payload + id de la preview persistée. */
export interface GenerationResult extends GenerationPayload {
  generation_id: number;
}

/** Ligne de l'historique des générations (`generation:list`). */
export interface GenerationRow {
  id: number;
  created_at: string;
  created_by: number | null;
  user_name: string | null;
  academic_year_id: number | null;
  semester_id: number | null;
  semester_label: string | null;
  mode: GenerationMode | null;
  placed_count: number | null;
  /** Σ séances non placées du résultat (0 si absent). */
  unplaced_count: number;
  status: GenerationStatus;
}

/** Filtre optionnel de `generation:list`. */
export interface GenerationListFilter {
  status?: GenerationStatus;
  semesterId?: number;
}

/** Détail d'une génération (`generation:get`) : row + params + résultat. */
export interface GenerationDetail {
  row: GenerationRow;
  params: GenerateParams | null;
  result: GenerationPayload | null;
}

/** Résultat de `generation:apply`. */
export interface ApplyResult {
  generationId: number;
  /** Nouvelles séances insérées (PREVUE). */
  inserted: number;
  /** Séances existantes passées ANNULEE (REGENERATE). */
  cancelled: number;
}

/**
 * Résultat d'application — comme `SessionEditResult` : succès → compteurs ;
 * refus BR-10 (monde changé depuis la preview) → `conflicts` détaillés.
 */
export type GenerationApplyResult =
  | { ok: true; data: ApplyResult }
  | {
      ok: false;
      error: string;
      fields?: FieldError[];
      conflicts?: PlacementConflict[];
    };

/** Master-module éligible à la génération (sélecteur UI, `generation:catalog`). */
export interface GenerationModuleRef {
  id: number;
  master_id: number;
  master_code: string;
  master_name: string;
  module_label: string;
  professor_name: string;
  group_name: string | null;
  planned_sessions: number;
  sched_start: string;
  sched_end: string;
  /** 1 = module fixé (REGENERATE l'ignore) — badge « Fixé » dans l'UI. */
  is_fixed: number;
}

/** Catalogue du sélecteur : mm du semestre + fenêtre globale sched. */
export interface GenerationCatalog {
  modules: GenerationModuleRef[];
  /** min(sched_start) / max(sched_end) des mm — plage de dates par défaut. */
  sched_start: string | null;
  sched_end: string | null;
}

// ---------------------------------------------------------------------------
// P9a — Registre des séances + décisions d'absence (BR-17/18, FR-30/35→38)
// ---------------------------------------------------------------------------

/** Décision prise sur une séance impactée par une absence (migration 0006). */
export const ABSENCE_DECISIONS = [
  'REMPLACEMENT',
  'REPORT',
  'ANNULATION',
] as const;
export type AbsenceDecisionKind = (typeof ABSENCE_DECISIONS)[number];

/** Ligne `absence_decision` enrichie (noms du remplaçant et de l'auteur). */
export interface AbsenceDecisionRow {
  id: number;
  absence_id: number;
  session_id: number;
  decision: AbsenceDecisionKind;
  substitute_professor_id: number | null;
  /** Nom du remplaçant (jointure professor), null hors REMPLACEMENT. */
  substitute_name: string | null;
  decided_at: string;
  decided_by: number | null;
  decided_by_name: string | null;
  note: string | null;
}

/** Absence + compteurs de suivi (liste `absences:list`). */
export interface AbsenceListRow extends AbsenceRow {
  professor_name: string;
  /** Séances encore ouvertes (PREVUE/REPORTEE) dans la fenêtre. */
  nb_impacted: number;
  /** Décisions enregistrées pour cette absence. */
  nb_decisions: number;
}

/** Séance impactée + décision éventuelle (fiche `absences:get`). */
export interface AbsenceDetailSession extends ImpactedSession {
  decision: AbsenceDecisionRow | null;
}

/** Détail d'une absence : absence + séances impactées et leurs décisions. */
export interface AbsenceDetail {
  absence: AbsenceListRow;
  impacted: AbsenceDetailSession[];
}

/** Entrée de `absences:decide` — payload de décision sur une séance. */
export interface AbsenceDecisionInput {
  decision: AbsenceDecisionKind;
  /** Obligatoire pour REMPLACEMENT (actif, ≠ titulaire). */
  substitute_professor_id?: number | null;
  /** Nouveau créneau — obligatoire pour REPORT (AD-7 : ISO + minutes). */
  new_date?: string;
  new_start?: number;
  new_end?: number;
  /** Note/motif tracé (défaut « Absence du titulaire »). */
  note?: string | null;
}

/** Filtres du registre central `/seances` (`registry:list`, FR-30). */
export interface RegistryFilter {
  date_from?: string;
  date_to?: string;
  master_id?: number;
  professor_id?: number;
  room_id?: number;
  module_id?: number;
  /** Statut EFFECTIF (PREVUE = future ; NON_ENCORE_REALISEE dérivée, AD-7). */
  status_effectif?: EffectiveSessionStatus;
  /** Sous-chaîne sur module/master/professeur (LIKE échappé). */
  search?: string;
}

/** Pagination serveur du registre (page 1-based). */
export interface RegistryPage {
  page?: number;
  pageSize?: number;
}

/** Ligne du registre : séance enrichie + retard en jours (AD-7). */
export interface RegistryRow extends SessionRow {
  /** max(0, today − date) pour une PREVUE passée ; 0 sinon. */
  retard_jours: number;
}

/** Compteurs d'en-tête du registre (calculés sur l'ensemble filtré). */
export interface RegistryStats {
  total: number;
  realisee: number;
  /** NON_ENCORE_REALISEE dérivé : PREVUE avec date < today. */
  non_realisee: number;
  /** Séances dont retard_jours > 0 (= PREVUE passée non réalisée). */
  en_retard: number;
}

export interface RegistryResult {
  rows: RegistryRow[];
  total: number;
  page: number;
  pageSize: number;
  stats: RegistryStats;
}

/** Reste à effectuer d'un master-module (`registry:remaining`, FR-35). */
export interface RemainingResult {
  master_module_id: number;
  /** planned_sessions du master-module. */
  planned: number;
  /** Séances non ANNULEE rattachées. */
  scheduled_non_cancelled: number;
  /** max(0, planned − scheduled_non_cancelled). */
  remaining: number;
}

// ---------------------------------------------------------------------------
// P9b — Présences étudiants (Module G : FR-39, BR-19) + registre minimal
// ---------------------------------------------------------------------------

/** Statut de présence nominatif (CHECK `student_attendance.status`). */
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'JUSTIFIE'] as const;
export type StudentAttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Compteurs du mode « comptage » (`session_attendance`). */
export interface AttendanceCounts {
  present_count: number;
  absent_count: number;
  note: string | null;
}

/** Entrée du mode « comptage » (`attendance:setCounts`). */
export interface AttendanceCountsInput {
  present_count: number;
  absent_count: number;
  note?: string | null;
}

/** Ligne nominative enregistrée (student_attendance + étudiant + groupe). */
export interface AttendanceNominativeRow {
  student_id: number;
  full_name: string;
  status: StudentAttendanceStatus;
  group_name: string;
}

/**
 * Étudiant éligible à la saisie nominative : groupes candidats de la
 * séance ∪ étudiants ayant déjà une ligne `student_attendance` —
 * ces derniers sont « orphelins » (`out_of_roster = 1`, tag UI « hors
 * groupe ») : leur groupe n'est plus candidat mais leur ligne ne doit
 * pas être effacée silencieusement.
 */
export interface AttendanceRosterRow {
  student_id: number;
  full_name: string;
  group_name: string;
  /** 1 = ligne nominative existante hors groupes candidats (orpheline). */
  out_of_roster: number;
}

/** Mode de saisie déduit de l'état stocké. */
export type AttendanceMode = 'COUNT' | 'NOMINATIVE' | 'NONE';

/** Payload de `attendance:get` : compteurs, nominatif, roster et mode. */
export interface AttendanceDetail {
  counts: AttendanceCounts | null;
  nominative: AttendanceNominativeRow[];
  roster: AttendanceRosterRow[];
  mode: AttendanceMode;
}

/** Entrée nominative de `attendance:setNominative` (remplace l'ensemble). */
export interface NominativeItem {
  student_id: number;
  status: StudentAttendanceStatus;
}

/** Étudiant du registre (`students:list`) + protection BR-22. */
export interface StudentRow {
  id: number;
  student_group_id: number;
  full_name: string;
  external_id: string | null;
  /** student_attendance référençant l'étudiant — blocage suppression (BR-22). */
  linkedCount: number;
}

export interface StudentInput {
  full_name: string;
  external_id?: string | null;
}

// ---------------------------------------------------------------------------
// P10 — Rapports & statistiques (Module H : FR-40→44)
// ---------------------------------------------------------------------------

/** Les 10 rapports obligatoires (FR-40). */
export const REPORT_IDS = [
  'edt_hebdo',
  'salles_planning',
  'prof_programme',
  'bilan_heures',
  'non_realisees',
  'annulees_reportees',
  'absences',
  'avancement',
  'occupation_salles',
  'conflits_restes',
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

/**
 * Filtres communs des rapports (FR-43) — tous optionnels ; seul `week`
 * (lundi ISO) est exigé par `edt_hebdo`. Les bornes dates sont inclusives.
 */
export interface ReportFilter {
  date_from?: string;
  date_to?: string;
  master_id?: number;
  professor_id?: number;
  room_id?: number;
  semester_id?: number;
  /** Lundi ISO de la semaine demandée (`edt_hebdo` uniquement). */
  week?: string;
}

/** Colonne d'un rapport — `label` est l'en-tête français (CSV/PDF inclus). */
export interface ReportColumn {
  key: string;
  label: string;
}

/** Valeur de cellule : primitives sérialisables (jamais d'objet imbriqué). */
export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

/** Carte récapitulative affichée au-dessus du tableau (optionnel). */
export interface ReportSummaryItem {
  key: string;
  label: string;
  value: string | number;
}

/**
 * Rapport générique (FR-44 : tout est calculé en SQL côté main, aucune
 * valeur saisie ni stockée) — la même shape alimente la table UI, le CSV
 * et le HTML du PDF sans duplication.
 */
export interface Report {
  id: ReportId;
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  summary?: ReportSummaryItem[];
  /**
   * `true` si le résultat dépassait le cap de lignes (50 000) et a été
   * tronqué — l'UI affiche un avertissement « précisez les filtres ».
   */
  truncated?: boolean;
}

/** Payload de `reports:exportPdf` — HTML autonome généré côté renderer. */
export interface ReportPdfInput {
  report_id: ReportId;
  /** Document HTML complet (table print + en-tête, `dir="auto"`). */
  html: string;
}

/** Résultat d'un export : `path` du fichier écrit, ou `cancelled`. */
export interface ReportExportFile {
  path: string | null;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// P11 — Import / Export CSV (Module I : FR-45→49, BR-21)
// ---------------------------------------------------------------------------

/** Types importables (FR-45) — les entités référentielles + étudiants. */
export const IMPORT_TYPES = [
  'salles',
  'professeurs',
  'modules',
  'masters',
  'etudiants',
] as const;
export type ImportEntityType = (typeof IMPORT_TYPES)[number];

/** Types exportables (FR-48) — import + master_modules + séances (dump). */
export const EXPORT_TYPES = [
  ...IMPORT_TYPES,
  'master_modules',
  'seances',
] as const;
export type ExportEntityType = (typeof EXPORT_TYPES)[number];

/** Stratégie de conflit par lot (BR-21) — explicite, pas de mixte en v1. */
export const IMPORT_STRATEGIES = [
  'IGNORER',
  'FUSIONNER',
  'REMPLACER',
] as const;
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];

/** Statut d'une ligne en aperçu (`import:preview`, FR-46). */
export type ImportRowStatus = 'OK' | 'DOUBLON' | 'ERREUR';

/**
 * Ligne d'aperçu : `n` = rang de la ligne parmi les lignes de données
 * NON VIDES (1-based, hors en-tête — les lignes vides du fichier ne
 * décalent pas la numérotation), `raw` = cellules brutes, `parsed` =
 * valeurs par colonne reconnue, `match_id` = id de l'entité existante
 * en cas de doublon (unicité Unicode-complete, fold `toLowerCase`).
 */
export interface ImportRow {
  n: number;
  raw: string[];
  parsed: Record<string, string>;
  status: ImportRowStatus;
  errors: FieldError[];
  match_id?: number;
}

/** Résultat de `import:preview`. */
export interface ImportPreview {
  /** En-têtes FR reconnues (dans l'ordre du fichier). */
  columns: string[];
  /** En-têtes présentes mais inconnues — warning non bloquant. */
  unknownColumns: string[];
  rows: ImportRow[];
}

/** Résultat de `import:apply` (FR-47, BR-21 — transactionnel par lot). */
export interface ImportApplyResult {
  inserted: number;
  merged: number;
  ignored: number;
  errors: { n: number; message: string }[];
}

/** Dump d'une entité exportée (FR-48) — colonnes FR + lignes lisibles. */
export interface EntityExport {
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
}

// ---------------------------------------------------------------------------
// P12 — Paramètres & Sauvegardes (FR-51/52/53, BR-23/24)
// ---------------------------------------------------------------------------

/** Types d'exception calendrier (CHECK `calendar_exception.type`). */
export const CALENDAR_EXCEPTION_TYPES = [
  'FERIE',
  'EXAMEN',
  'FERMETURE',
  'VACANCES',
] as const;
export type CalendarExceptionType = (typeof CALENDAR_EXCEPTION_TYPES)[number];

/**
 * Créneau horaire autorisé (`time_slot`, weekday 0=lun..6=dim).
 * `overlaps` : un autre créneau du même weekday le chevauche —
 * informatif, jamais bloquant (la génération gère les fenêtres
 * qui se recouvrent).
 */
export interface TimeSlotRow {
  id: number;
  weekday: number;
  start_min: number;
  end_min: number;
  label: string | null;
  overlaps: boolean;
}

export interface TimeSlotInput {
  weekday: number;
  start_min: number;
  end_min: number;
  label?: string | null;
}

/** Exception calendrier (`calendar_exception`) — chevauchements permis. */
export interface CalendarExceptionRow {
  id: number;
  start_date: string;
  end_date: string;
  type: CalendarExceptionType;
  label: string;
}

export interface CalendarExceptionInput {
  start_date: string;
  end_date: string;
  type: CalendarExceptionType;
  label: string;
}

/** Kinds de `backup_history` (CHECK en base). */
export const BACKUP_KINDS = ['MANUEL', 'AUTO', 'PRE_MIGRATION'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/**
 * Ligne `backup_history` enrichie : `exists` = fichier présent sur disque
 * (sauvegarde déplacée/supprimée manuellement → ligne grisée,
 * restauration impossible). `restored` = 1 si cette sauvegarde a été
 * utilisée pour une restauration.
 */
export interface BackupRow {
  id: number;
  at: string;
  path: string;
  size_bytes: number | null;
  kind: BackupKind;
  restored: number;
  exists: boolean;
}

export type ProfileRole = 'ADMIN' | 'GESTIONNAIRE';

/** Profil applicatif (`app_user`) — pas de mot de passe (décision Phase 1). */
export interface AppUser {
  id: number;
  display_name: string;
  role: ProfileRole;
  is_active: number;
}

/** Ligne du journal d'audit (`audit_log`) enrichie du nom du profil. */
export interface AuditEntry {
  id: number;
  at: string;
  user_id: number | null;
  user_name: string | null;
  action: string;
  entity: string;
  /** rowid numérique, ou clé textuelle (ex. `setting.key` — P12). */
  entity_id: number | string | null;
  old_values: string | null;
  new_values: string | null;
}

/** Contexte global affiché dans la topbar (année + semestre courants). */
export interface AppContext {
  academicYear: string | null;
  semester: string | null;
}

/** API exposée au renderer via contextBridge (`window.api`). */
export interface WindowApi {
  appInfo(): Promise<AppInfo>;
  dbStatus(): Promise<DbStatus>;
  appContext(): Promise<ApiResult<AppContext>>;
  contextSemesters(): Promise<ApiResult<ContextSemesters>>;
  masters: {
    list(filter?: MasterListFilter): Promise<ApiResult<MasterRow[]>>;
    get(id: number): Promise<ApiResult<MasterDetail>>;
    create(input: MasterInput): Promise<ApiResult<MasterRow>>;
    update(id: number, input: MasterInput): Promise<ApiResult<MasterRow>>;
    setStatus(id: number, status: MasterStatus): Promise<ApiResult<MasterRow>>;
    remove(id: number): Promise<DeleteResult>;
    addGroup(
      masterId: number,
      input: GroupInput,
    ): Promise<ApiResult<StudentGroupRow>>;
    renameGroup(
      id: number,
      input: GroupInput,
    ): Promise<ApiResult<StudentGroupRow>>;
    removeGroup(id: number): Promise<DeleteResult>;
    attachModule(
      masterId: number,
      input: MasterModuleInput,
    ): Promise<ApiResult<MasterModuleRow>>;
    updateModule(
      id: number,
      input: MasterModuleInput,
    ): Promise<ApiResult<MasterModuleRow>>;
    detachModule(id: number): Promise<DeleteResult>;
  };
  rooms: {
    list(): Promise<ApiResult<Room[]>>;
    create(input: RoomInput): Promise<ApiResult<Room>>;
    update(id: number, input: RoomInput): Promise<ApiResult<Room>>;
    remove(id: number): Promise<ApiResult<null>>;
    setActive(id: number, active: boolean): Promise<ApiResult<Room>>;
  };
  modules: {
    list(): Promise<ApiResult<Module[]>>;
    create(input: ModuleInput): Promise<ApiResult<Module>>;
    update(id: number, input: ModuleInput): Promise<ApiResult<Module>>;
    remove(id: number): Promise<ApiResult<null>>;
  };
  professors: {
    list(search?: string): Promise<ApiResult<ProfessorRow[]>>;
    get(id: number): Promise<ApiResult<ProfessorDetail>>;
    create(input: ProfessorInput): Promise<ApiResult<ProfessorRow>>;
    update(id: number, input: ProfessorInput): Promise<ApiResult<ProfessorRow>>;
    remove(id: number): Promise<ApiResult<null>>;
    setActive(id: number, active: boolean): Promise<ApiResult<ProfessorRow>>;
    availability: {
      list(professorId: number): Promise<ApiResult<AvailabilityRow[]>>;
      add(
        professorId: number,
        input: AvailabilityInput,
      ): Promise<ApiResult<AvailabilityRow>>;
      remove(id: number): Promise<ApiResult<null>>;
    };
    absence: {
      list(professorId: number): Promise<ApiResult<AbsenceRow[]>>;
      add(
        professorId: number,
        input: AbsenceInput,
      ): Promise<ApiResult<{ absence: AbsenceRow; impacted: ImpactedSession[] }>>;
      remove(id: number): Promise<ApiResult<null>>;
    };
  };
  timetable: {
    week(filter: WeekFilter): Promise<ApiResult<SessionRow[]>>;
    month(filter: MonthFilter): Promise<ApiResult<SessionRow[]>>;
    annual(filter: AnnualFilter): Promise<ApiResult<AnnualRow[]>>;
    conflicts(filter?: ConflictFilter): Promise<ApiResult<ConflictItem[]>>;
    summary(): Promise<ApiResult<ConflictSummary>>;
    occupancy(filter: OccupancyFilter): Promise<ApiResult<OccupancyRow[]>>;
  };
  sessions: {
    get(id: number): Promise<ApiResult<SessionDetail>>;
    checkPlacement(q: PlacementQuery): Promise<ApiResult<PlacementConflict[]>>;
    create(input: SessionCreateInput): Promise<SessionEditResult>;
    move(id: number, input: SessionMoveInput): Promise<SessionEditResult>;
    setStatus(
      id: number,
      input: SessionStatusInput,
    ): Promise<SessionEditResult>;
    setGroups(id: number, groupIds: number[]): Promise<SessionEditResult>;
    remove(id: number): Promise<SessionEditResult>;
    /**
     * Feuille de présence imprimable (P14) — le main génère le HTML,
     * le rend en PDF (`printToPDF`) et ouvre la boîte d'enregistrement.
     * Disponible sur TOUTES les séances (la feuille sert pendant le cours).
     */
    attendanceSheet(id: number): Promise<ApiResult<ReportExportFile>>;
  };
  generation: {
    run(params: GenerateParams): Promise<ApiResult<GenerationResult>>;
    list(
      filter?: GenerationListFilter,
    ): Promise<ApiResult<GenerationRow[]>>;
    get(id: number): Promise<ApiResult<GenerationDetail>>;
    apply(id: number): Promise<GenerationApplyResult>;
    abandon(id: number): Promise<ApiResult<null>>;
    catalog(semesterId: number): Promise<ApiResult<GenerationCatalog>>;
  };
  registry: {
    list(
      filter?: RegistryFilter,
      page?: RegistryPage,
    ): Promise<ApiResult<RegistryResult>>;
    remaining(masterModuleId: number): Promise<ApiResult<RemainingResult>>;
  };
  absences: {
    list(professorId?: number): Promise<ApiResult<AbsenceListRow[]>>;
    get(id: number): Promise<ApiResult<AbsenceDetail>>;
    decide(
      absenceId: number,
      sessionId: number,
      input: AbsenceDecisionInput,
    ): Promise<SessionEditResult>;
  };
  attendance: {
    get(sessionId: number): Promise<ApiResult<AttendanceDetail>>;
    setCounts(
      sessionId: number,
      input: AttendanceCountsInput,
    ): Promise<ApiResult<null>>;
    setNominative(
      sessionId: number,
      items: NominativeItem[],
    ): Promise<ApiResult<null>>;
    clear(sessionId: number): Promise<ApiResult<null>>;
  };
  students: {
    list(groupId: number): Promise<ApiResult<StudentRow[]>>;
    add(groupId: number, input: StudentInput): Promise<ApiResult<StudentRow>>;
    remove(id: number): Promise<DeleteResult>;
  };
  profile: {
    list(): Promise<ApiResult<AppUser[]>>;
    current(): Promise<ApiResult<AppUser | null>>;
    set(id: number): Promise<ApiResult<AppUser>>;
  };
  reports: {
    run(id: ReportId, filter?: ReportFilter): Promise<ApiResult<Report>>;
    exportCsv(report: Report): Promise<ApiResult<ReportExportFile>>;
    exportPdf(input: ReportPdfInput): Promise<ApiResult<ReportExportFile>>;
  };
  audit: {
    list(limit?: number): Promise<ApiResult<AuditEntry[]>>;
  };
  importExport: {
    preview(
      type: ImportEntityType,
      csvText: string,
    ): Promise<ApiResult<ImportPreview>>;
    /** Réservé ADMIN côté main (BR-24 — import massif = administration). */
    apply(
      type: ImportEntityType,
      csvText: string,
      strategy: ImportStrategy,
    ): Promise<ApiResult<ImportApplyResult>>;
    /** Gabarit CSV (en-têtes + exemple) via save dialog (FR-49). */
    template(type: ImportEntityType): Promise<ApiResult<ReportExportFile>>;
    /** Dump CSV d'une entité via save dialog (FR-48). */
    exportEntity(
      type: ExportEntityType,
    ): Promise<ApiResult<ReportExportFile>>;
  };
  /** P12 — tout est réservé ADMIN côté main (BR-24). */
  settings: {
    slots: {
      list(): Promise<ApiResult<TimeSlotRow[]>>;
      create(input: TimeSlotInput): Promise<ApiResult<TimeSlotRow>>;
      update(id: number, input: TimeSlotInput): Promise<ApiResult<TimeSlotRow>>;
      remove(id: number): Promise<ApiResult<null>>;
    };
    exceptions: {
      list(): Promise<ApiResult<CalendarExceptionRow[]>>;
      create(
        input: CalendarExceptionInput,
      ): Promise<ApiResult<CalendarExceptionRow>>;
      update(
        id: number,
        input: CalendarExceptionInput,
      ): Promise<ApiResult<CalendarExceptionRow>>;
      remove(id: number): Promise<ApiResult<null>>;
    };
    retention: {
      get(): Promise<ApiResult<number>>;
      set(n: number): Promise<ApiResult<number>>;
    };
  };
  /** P12 — sauvegardes + restauration (réservé ADMIN, BR-24). */
  backups: {
    list(): Promise<ApiResult<BackupRow[]>>;
    create(): Promise<ApiResult<BackupRow>>;
    /** Redémarre l'application en cas de succès — la promesse peut ne
     *  jamais se résoudre côté renderer (processus terminé). */
    restore(id: number): Promise<ApiResult<null>>;
    remove(id: number): Promise<ApiResult<null>>;
    openFolder(): Promise<ApiResult<null>>;
  };
}
