/**
 * Handlers IPC Présences étudiants (P9b) — canaux `attendance:*`.
 * Lecture et écritures ouvertes aux deux profils (BR-24 : pas de
 * `requireRole`). Guards stricts (`isId`/`isObject`, tableau strict pour
 * le nominatif) ; la validation métier vit dans `attendance.service`.
 */
import { ipcMain } from 'electron';
import type {
  AttendanceCountsInput,
  NominativeItem,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  clearAttendance,
  getAttendance,
  setCounts,
  setNominative,
} from '../db/attendance.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

/**
 * items : tableau strict de lignes nominatives — chaque entrée doit être
 * un objet avec `student_id` (id) et `status` (chaîne ; les valeurs
 * PRESENT/ABSENT/JUSTIFIE sont vérifiées côté service pour une erreur
 * de champ propre).
 */
function isNominativeItems(v: unknown): v is NominativeItem[] {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        isObject(item) &&
        isId(item.student_id) &&
        typeof item.status === 'string',
    )
  );
}

export function registerAttendanceHandlers(getDb: DbGetter): void {
  ipcMain.handle('attendance:get', (_e, sessionId: unknown) =>
    !isId(sessionId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => getAttendance(db, sessionId)),
  );

  ipcMain.handle('attendance:setCounts', (_e, sessionId: unknown, input: unknown) =>
    !isId(sessionId) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          setCounts(
            db,
            currentUserId(db),
            sessionId,
            input as unknown as AttendanceCountsInput,
          ),
        ),
  );

  ipcMain.handle(
    'attendance:setNominative',
    (_e, sessionId: unknown, items: unknown) =>
      !isId(sessionId) || !isNominativeItems(items)
        ? apiErr('Paramètres invalides.')
        : guard(getDb, (db) =>
            setNominative(db, currentUserId(db), sessionId, items),
          ),
  );

  ipcMain.handle('attendance:clear', (_e, sessionId: unknown) =>
    !isId(sessionId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => clearAttendance(db, currentUserId(db), sessionId)),
  );
}
