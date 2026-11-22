/**
 * Handlers IPC Édition des séances (P7b) — canaux `sessions:*`
 * (mutations) + `sessions:checkPlacement` (pré-validation UI, lecture).
 *
 * BR-24 : AUCUN `requireRole` — ADMIN et GESTIONNAIRE écrivent tous les
 * deux (le gestionnaire administre l'EDT au quotidien). Guards stricts
 * (`isId`/`isObject`) sur chaque payload sérialisé ; la validation métier
 * et la garde BR-10 vivent dans `session-edit.service`.
 */
import { ipcMain } from 'electron';
import type {
  PlacementQuery,
  SessionCreateInput,
  SessionMoveInput,
  SessionStatusInput,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import { checkSessionPlacement } from '../db/conflict.service';
import {
  changeSessionStatus,
  createSession,
  deleteSession,
  moveSession,
  setSessionGroups,
} from '../db/session-edit.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

/** group_ids : tableau d'ids (ou absent). */
function isIdArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isId);
}

export function registerSessionHandlers(getDb: DbGetter): void {
  ipcMain.handle('sessions:checkPlacement', (_e, query: unknown) =>
    !isObject(query) ||
    (query.groupIds !== undefined && !Array.isArray(query.groupIds))
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          checkSessionPlacement(db, query as unknown as PlacementQuery),
        ),
  );

  ipcMain.handle('sessions:create', (_e, input: unknown) =>
    !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          createSession(
            db,
            currentUserId(db),
            input as unknown as SessionCreateInput,
          ),
        ),
  );

  ipcMain.handle('sessions:move', (_e, id: unknown, input: unknown) =>
    !isId(id) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          moveSession(
            db,
            currentUserId(db),
            id,
            input as unknown as SessionMoveInput,
          ),
        ),
  );

  ipcMain.handle('sessions:setStatus', (_e, id: unknown, input: unknown) =>
    !isId(id) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          changeSessionStatus(
            db,
            currentUserId(db),
            id,
            input as unknown as SessionStatusInput,
          ),
        ),
  );

  ipcMain.handle('sessions:setGroups', (_e, id: unknown, groupIds: unknown) =>
    !isId(id) || !isIdArray(groupIds)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          setSessionGroups(db, currentUserId(db), id, groupIds),
        ),
  );

  ipcMain.handle('sessions:remove', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => deleteSession(db, currentUserId(db), id)),
  );
}
