/**
 * Profils applicatifs (`app_user`) — BR-24 / FR-54.
 * Pas de mot de passe (décision Phase 1) : le profil courant est persisté
 * dans `setting.current_profile_id` et sert à attribuer les actions dans
 * l'AuditLog (BR-20).
 *
 * `ensureProfiles` seede « Administrateur » (ADMIN) et « Gestionnaire »
 * (GESTIONNAIRE) si `app_user` est vide, puis garantit qu'un profil
 * courant valide existe.
 */
import { DatabaseSync } from 'node:sqlite';
import type { AppUser, ApiResult } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, countRows, get, run } from './connection';

const CURRENT_PROFILE_KEY = 'current_profile_id';

interface UserRow {
  id: number;
  display_name: string;
  role: 'ADMIN' | 'GESTIONNAIRE';
  is_active: number;
}

function toAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
  };
}

/** Seed idempotent : 2 profils par défaut si la table est vide + profil courant valide. */
export function ensureProfiles(db: DatabaseSync): void {
  if (countRows(db, 'app_user') === 0) {
    const ins = db.prepare(
      'INSERT INTO app_user (display_name, role, is_active) VALUES (?, ?, 1)',
    );
    ins.run('Administrateur', 'ADMIN');
    ins.run('Gestionnaire', 'GESTIONNAIRE');
  }

  // Garantit un profil courant valide (défaut : premier profil ADMIN, sinon premier actif).
  const stored = get<{ value: string }>(
    db,
    'SELECT value FROM setting WHERE key = ?',
    CURRENT_PROFILE_KEY,
  );
  const storedId = stored ? Number(stored.value) : NaN;
  const currentValid =
    Number.isInteger(storedId) &&
    get(db, 'SELECT id FROM app_user WHERE id = ? AND is_active = 1', storedId);
  if (currentValid) return;

  const fallback =
    get<{ id: number }>(
      db,
      "SELECT id FROM app_user WHERE role = 'ADMIN' AND is_active = 1 ORDER BY id LIMIT 1",
    ) ??
    get<{ id: number }>(
      db,
      'SELECT id FROM app_user WHERE is_active = 1 ORDER BY id LIMIT 1',
    );
  if (fallback) {
    run(
      db,
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      CURRENT_PROFILE_KEY,
      String(fallback.id),
    );
  }
}

export function listProfiles(db: DatabaseSync): AppUser[] {
  return all<UserRow>(
    db,
    'SELECT id, display_name, role, is_active FROM app_user ORDER BY id',
  ).map(toAppUser);
}

/** Profil courant (persisté dans `setting.current_profile_id`), null si absent. */
export function getCurrentProfile(db: DatabaseSync): AppUser | null {
  const stored = get<{ value: string }>(
    db,
    'SELECT value FROM setting WHERE key = ?',
    CURRENT_PROFILE_KEY,
  );
  if (!stored) return null;
  const id = Number(stored.value);
  if (!Number.isInteger(id)) return null;
  const row = get<UserRow>(
    db,
    'SELECT id, display_name, role, is_active FROM app_user WHERE id = ?',
    id,
  );
  return row ? toAppUser(row) : null;
}

/** Bascule le profil courant — pas d'audit requis (changement de contexte, pas mutation métier). */
export function setCurrentProfile(
  db: DatabaseSync,
  id: number,
): ApiResult<AppUser> {
  const row = get<UserRow>(
    db,
    'SELECT id, display_name, role, is_active FROM app_user WHERE id = ?',
    id,
  );
  if (!row || row.is_active !== 1) {
    return apiErr('Profil introuvable ou inactif.');
  }
  run(
    db,
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    CURRENT_PROFILE_KEY,
    String(row.id),
  );
  return apiOk(toAppUser(row));
}
