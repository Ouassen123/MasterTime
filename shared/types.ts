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
  /** Nombre de tables utilisateur (attendu : 23 après 0001). */
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
  profile: {
    list(): Promise<ApiResult<AppUser[]>>;
    current(): Promise<ApiResult<AppUser | null>>;
    set(id: number): Promise<ApiResult<AppUser>>;
  };
  audit: {
    list(limit?: number): Promise<ApiResult<AuditEntry[]>>;
  };
}
