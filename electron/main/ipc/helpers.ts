/**
 * Helpers IPC (AD-1) — chaque handler retourne un `ApiResult<T>` typé.
 * `guard` résout la connexion, attrape les erreurs inattendues et les
 * convertit en `{ ok:false, error }` ; les validations métier remontent
 * déjà sous forme `ApiResult` depuis les services.
 */
import { DatabaseSync } from 'node:sqlite';
import type { ApiResult } from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import { getCurrentProfile } from '../db/profile.service';

export type DbGetter = () => DatabaseSync | null;

export interface GuardOptions {
  /**
   * BR-24 — seam pour les handlers réservés : `requireRole: 'ADMIN'`
   * refuse l'appel si le profil courant n'est pas administrateur.
   * (Aucun handler ne l'exige encore — P6a ne couvre que des actions
   * ouvertes aux deux profils.)
   */
  requireRole?: 'ADMIN';
}

function isApiResult(value: unknown): value is ApiResult<unknown> {
  return (
    typeof value === 'object' && value !== null && 'ok' in value &&
    typeof (value as { ok: unknown }).ok === 'boolean'
  );
}

/**
 * Exécute `fn` avec la connexion courante ; retourne toujours un ApiResult.
 * `fn` peut retourner soit un `ApiResult` (passé tel quel), soit une donnée
 * brute (enveloppée `{ ok:true, data }`).
 * Les erreurs inattendues sont journalisées côté main mais jamais transmises
 * brutes au renderer (pas de fuite d'erreurs SQLite vers l'UI).
 */
export function guard<T>(
  getDb: DbGetter,
  fn: (db: DatabaseSync) => ApiResult<T> | T,
  opts?: GuardOptions,
): ApiResult<T> {
  const db = getDb();
  if (!db) {
    return apiErr('Base de données non initialisée.');
  }
  try {
    if (opts?.requireRole === 'ADMIN') {
      const profile = getCurrentProfile(db);
      if (profile?.role !== 'ADMIN') {
        return apiErr('Action réservée au profil Administrateur.');
      }
    }
    const result = fn(db);
    if (isApiResult(result)) return result as ApiResult<T>;
    return { ok: true, data: result };
  } catch (err) {
    console.error('[ipc] Erreur dans un handler :', err);
    return apiErr('Une erreur interne est survenue.');
  }
}

/** Identifiant du profil courant pour l'attribution de l'audit (BR-20). */
export function currentUserId(db: DatabaseSync): number | null {
  return getCurrentProfile(db)?.id ?? null;
}

/** Garde de payload IPC : objet sérialisé (pas tableau, pas null). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Garde de payload IPC : identifiant entier strictement positif. */
export function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
