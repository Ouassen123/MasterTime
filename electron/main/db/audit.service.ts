/**
 * Audit transactionnel (AD-6) — `withAudit` exécute une mutation métier
 * dans une `BEGIN IMMEDIATE` et insère la ligne `audit_log` dans la même
 * transaction : `old_values`/`new_values` sont relus avant/après la
 * mutation et sérialisés en JSON. En cas d'erreur : ROLLBACK intégral
 * (ni mutation ni trace ne survivent) et l'erreur se propage.
 *
 *   BEGIN IMMEDIATE → old = SELECT → fn() → new = SELECT → INSERT audit_log → COMMIT
 *
 * `entityId` est `null` pour une création : `fn` doit alors retourner
 * l'identifiant de la ligne insérée (ex. `Number(lastInsertRowid)`).
 */
import { DatabaseSync } from 'node:sqlite';
import { all, get, run } from './connection';
import type { AuditEntry } from '../../../shared/types';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertTableName(entity: string): void {
  if (!TABLE_NAME_RE.test(entity)) {
    throw new Error(`Nom d'entité invalide pour l'audit : '${entity}'`);
  }
}

function readRow(
  db: DatabaseSync,
  entity: string,
  id: number,
): Record<string, unknown> | undefined {
  return get<Record<string, unknown>>(
    db,
    `SELECT * FROM "${entity}" WHERE id = ?`,
    id,
  );
}

/**
 * Exécute `fn` dans une transaction et journalise la mutation.
 * @returns l'identifiant de l'entité concernée (existant ou retourné par `fn`).
 */
export function withAudit(
  db: DatabaseSync,
  userId: number | null,
  action: AuditAction,
  entity: string,
  entityId: number | null,
  fn: () => number | void,
): number | null {
  assertTableName(entity);
  if (db.isTransaction) {
    // BEGIN IMMEDIATE imbriqué échouerait ; et un rollback externe
    // laisserait la trace sans la mutation (inverse d'AD-6).
    throw new Error(
      `withAudit(${entity}) refusé : transaction déjà ouverte — ` +
        'l\'audit doit piloter sa propre transaction.',
    );
  }
  let id = entityId;
  db.exec('BEGIN IMMEDIATE;');
  try {
    const before = id != null ? readRow(db, entity, id) : undefined;
    const produced = fn();
    if (id == null && typeof produced === 'number') id = produced;
    if (id == null) {
      throw new Error(
        `withAudit(${action} ${entity}) : fn() n'a retourné aucun ` +
          'identifiant — pour un CREATE, fn doit retourner le rowid inséré.',
      );
    }
    const after = readRow(db, entity, id);
    const oldJson = before === undefined ? null : JSON.stringify(before);
    const newJson = after === undefined ? null : JSON.stringify(after);
    // UPDATE sans effet (old == new) : pas de trace superflue.
    if (oldJson !== newJson) {
      run(
        db,
        `INSERT INTO audit_log (user_id, action, entity, entity_id, old_values, new_values)
         VALUES (?, ?, ?, ?, ?, ?)`,
        userId,
        action,
        entity,
        id,
        oldJson,
        newJson,
      );
    }
    db.exec('COMMIT;');
    return id;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // connexion possiblement hors transaction — l'erreur d'origine prime
    }
    throw err;
  }
}

/** Lecture seule du journal d'audit (plus récent d'abord), joint au profil. */
export function listAuditLog(db: DatabaseSync, limit = 200): AuditEntry[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(1000, Math.floor(limit)))
    : 200;
  return all<AuditEntry>(
    db,
    `SELECT a.id, a.at, a.user_id, u.display_name AS user_name,
            a.action, a.entity, a.entity_id, a.old_values, a.new_values
       FROM audit_log a
       LEFT JOIN app_user u ON u.id = a.user_id
      ORDER BY a.id DESC
      LIMIT ?`,
    safeLimit,
  );
}
