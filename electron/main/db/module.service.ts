/**
 * Référentiel Modules — CRUD + protection de suppression (BR-22) +
 * audit transactionnel (AD-6, via `withAudit`).
 *
 * Validation serveur : `code` et `name` requis et uniques ; erreurs renvoyées
 * sous forme `{ field, message }`. Suppression refusée si le module est lié
 * à des master-modules (données pédagogiques existantes). La table `module`
 * n'a pas de colonne `is_active` : pas de désactivation — le refus est définitif.
 */
import { DatabaseSync } from 'node:sqlite';
import type { ApiResult, FieldError, Module, ModuleInput } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';

function getModule(db: DatabaseSync, id: number): Module | undefined {
  return get<Module>(
    db,
    `SELECT m.id, m.code, m.name, m.is_demo,
            (SELECT count(*) FROM master_module mm WHERE mm.module_id = m.id) AS masterModuleCount
       FROM module m WHERE m.id = ?`,
    id,
  );
}

export function listModules(db: DatabaseSync): Module[] {
  return all<Module>(
    db,
    `SELECT m.id, m.code, m.name, m.is_demo,
            (SELECT count(*) FROM master_module mm WHERE mm.module_id = m.id) AS masterModuleCount
       FROM module m ORDER BY m.code COLLATE NOCASE`,
  );
}

function validateModule(
  db: DatabaseSync,
  input: ModuleInput,
  excludeId: number | null,
): FieldError[] {
  const errors: FieldError[] = [];
  const code = (input.code ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!code) {
    errors.push({ field: 'code', message: 'Le code du module est obligatoire.' });
  } else {
    const dup = get<{ id: number }>(
      db,
      'SELECT id FROM module WHERE code = ? COLLATE NOCASE AND id != ?',
      code,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({ field: 'code', message: 'Un module porte déjà ce code.' });
    }
  }
  if (!name) {
    errors.push({ field: 'name', message: 'Le nom du module est obligatoire.' });
  } else {
    const dup = get<{ id: number }>(
      db,
      'SELECT id FROM module WHERE name = ? COLLATE NOCASE AND id != ?',
      name,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({ field: 'name', message: 'Un module porte déjà ce nom.' });
    }
  }
  return errors;
}

export function createModule(
  db: DatabaseSync,
  userId: number | null,
  input: ModuleInput,
): ApiResult<Module> {
  const errors = validateModule(db, input, null);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(db, userId, 'CREATE', 'module', null, () =>
    Number(
      run(
        db,
        'INSERT INTO module (code, name, is_demo) VALUES (?, ?, 0)',
        input.code.trim(),
        input.name.trim(),
      ).lastInsertRowid,
    ),
  );
  return apiOk(getModule(db, id!)!);
}

export function updateModule(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: ModuleInput,
): ApiResult<Module> {
  if (!getModule(db, id)) {
    return apiErr('Module introuvable.');
  }
  const errors = validateModule(db, input, id);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  withAudit(db, userId, 'UPDATE', 'module', id, () => {
    run(
      db,
      'UPDATE module SET code = ?, name = ? WHERE id = ?',
      input.code.trim(),
      input.name.trim(),
      id,
    );
  });
  return apiOk(getModule(db, id)!);
}

/**
 * Suppression (BR-22) : refusée si le module est référencé par des
 * master-modules — le message chiffre les données liées.
 */
export function deleteModule(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  const module = getModule(db, id);
  if (!module) {
    return apiErr('Module introuvable.');
  }
  if (module.masterModuleCount > 0) {
    return apiErr(
      `Ce module est utilisé par ${module.masterModuleCount} master-module(s) lié(s) : ` +
        'suppression impossible.',
    );
  }
  withAudit(db, userId, 'DELETE', 'module', id, () => {
    run(db, 'DELETE FROM module WHERE id = ?', id);
  });
  return apiOk(null);
}
