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

/** Premier profil de repli : ADMIN actif d'abord, sinon premier actif. */
function firstActiveProfile(db: DatabaseSync): UserRow | undefined {
  return (
    get<UserRow>(
      db,
      `SELECT id, display_name, role, is_active FROM app_user
        WHERE is_active = 1 AND role = 'ADMIN' ORDER BY id LIMIT 1`,
    ) ??
    get<UserRow>(
      db,
      `SELECT id, display_name, role, is_active FROM app_user
        WHERE is_active = 1 ORDER BY id LIMIT 1`,
    )
  );
}

function persistCurrentProfile(db: DatabaseSync, id: number): void {
  run(
    db,
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    CURRENT_PROFILE_KEY,
    String(id),
  );
}

/**
 * Seed idempotent et atomique : 2 profils par défaut si `app_user` est vide,
 * un Administrateur ajouté s'il n'en reste aucun actif (BR-24 : sinon les
 * entrées admin deviennent inaccessibles), puis profil courant valide.
 */
export function ensureProfiles(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const ins = db.prepare(
      'INSERT INTO app_user (display_name, role, is_active) VALUES (?, ?, 1)',
    );
    if (countRows(db, 'app_user') === 0) {
      ins.run('Administrateur', 'ADMIN');
      ins.run('Gestionnaire', 'GESTIONNAIRE');
    } else {
      const activeAdmin = get<{ id: number }>(
        db,
        "SELECT id FROM app_user WHERE role = 'ADMIN' AND is_active = 1 LIMIT 1",
      );
      if (!activeAdmin) ins.run('Administrateur', 'ADMIN');
    }

    // Garantit un profil courant valide (défaut : ADMIN actif, sinon actif quelconque).
    const stored = get<{ value: string }>(
      db,
      'SELECT value FROM setting WHERE key = ?',
      CURRENT_PROFILE_KEY,
    );
    const storedId = stored ? Number(stored.value) : NaN;
    const currentValid =
      Number.isInteger(storedId) &&
      get(
        db,
        'SELECT id FROM app_user WHERE id = ? AND is_active = 1',
        storedId,
      );
    if (!currentValid) {
      const fallback = firstActiveProfile(db);
      if (fallback) persistCurrentProfile(db, fallback.id);
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // connexion possiblement hors transaction — l'erreur d'origine prime
    }
    throw err;
  }
}

/** Profils actifs — utilisé par le sélecteur de la topbar. */
export function listProfiles(db: DatabaseSync): AppUser[] {
  return all<UserRow>(
    db,
    'SELECT id, display_name, role, is_active FROM app_user WHERE is_active = 1 ORDER BY id',
  ).map(toAppUser);
}

/** Tous les profils, actifs ou non (administration future). */
export function listAllProfiles(db: DatabaseSync): AppUser[] {
  return all<UserRow>(
    db,
    'SELECT id, display_name, role, is_active FROM app_user ORDER BY id',
  ).map(toAppUser);
}

/**
 * Profil courant (persisté dans `setting.current_profile_id`), null si aucun
 * profil actif. Si le profil stocké est absent ou désactivé, retombe sur le
 * premier profil actif et répare le paramètre.
 */
export function getCurrentProfile(db: DatabaseSync): AppUser | null {
  const stored = get<{ value: string }>(
    db,
    'SELECT value FROM setting WHERE key = ?',
    CURRENT_PROFILE_KEY,
  );
  const id = stored ? Number(stored.value) : NaN;
  let row = Number.isInteger(id)
    ? get<UserRow>(
        db,
        'SELECT id, display_name, role, is_active FROM app_user WHERE id = ? AND is_active = 1',
        id,
      )
    : undefined;
  if (!row) {
    row = firstActiveProfile(db);
    if (row) persistCurrentProfile(db, row.id);
  }
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
  persistCurrentProfile(db, row.id);
  return apiOk(toAppUser(row));
}
