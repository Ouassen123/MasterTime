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
  /** Nombre de tables utilisateur (attendu : 25 après 0005). */
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
  entity_id: number | null;
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
  };
  profile: {
    list(): Promise<ApiResult<AppUser[]>>;
    current(): Promise<ApiResult<AppUser | null>>;
    set(id: number): Promise<ApiResult<AppUser>>;
  };
  audit: {
    list(limit?: number): Promise<ApiResult<AuditEntry[]>>;
  };
}
