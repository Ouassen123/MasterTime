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
  profile: {
    list(): Promise<ApiResult<AppUser[]>>;
    current(): Promise<ApiResult<AppUser | null>>;
    set(id: number): Promise<ApiResult<AppUser>>;
  };
  audit: {
    list(limit?: number): Promise<ApiResult<AuditEntry[]>>;
  };
}
