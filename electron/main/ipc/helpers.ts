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
 */
export function guard<T>(
  getDb: DbGetter,
  fn: (db: DatabaseSync) => ApiResult<T> | T,
): ApiResult<T> {
  const db = getDb();
  if (!db) {
    return apiErr('Base de données non initialisée.');
  }
  try {
    const result = fn(db);
    if (isApiResult(result)) return result as ApiResult<T>;
    return { ok: true, data: result };
  } catch (err) {
    return apiErr(err instanceof Error ? err.message : String(err));
  }
}

/** Identifiant du profil courant pour l'attribution de l'audit (BR-20). */
export function currentUserId(db: DatabaseSync): number | null {
  return getCurrentProfile(db)?.id ?? null;
}
