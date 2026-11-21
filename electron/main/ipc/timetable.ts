/**
 * Handlers IPC Emplois du temps (P7a) — canaux `timetable:*` et
 * `sessions:get`. Lecture seule (aucune mutation de séance — P7b) :
 * pas de `requireRole`, ouvert aux profils ADMIN et GESTIONNAIRE.
 * Tous les handlers retournent `ApiResult<T>` via `guard`.
 */
import { ipcMain } from 'electron';
import type {
  AnnualFilter,
  ConflictFilter,
  MonthFilter,
  OccupancyFilter,
  WeekFilter,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  conflictSummary,
  detectConflicts,
} from '../db/conflict.service';
import {
  getSessionDetail,
  listAnnual,
  listOccupancyWeek,
  listSessionsMonth,
  listSessionsWeek,
} from '../db/session.service';
import { guard, isId, isObject, type DbGetter } from './helpers';

export function registerTimetableHandlers(getDb: DbGetter): void {
  ipcMain.handle('timetable:week', (_e, filter: unknown) =>
    !isObject(filter)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) => listSessionsWeek(db, filter as unknown as WeekFilter)),
  );

  ipcMain.handle('timetable:month', (_e, filter: unknown) =>
    !isObject(filter)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) => listSessionsMonth(db, filter as unknown as MonthFilter)),
  );

  ipcMain.handle('timetable:annual', (_e, filter: unknown) =>
    !isObject(filter) || !isId((filter as unknown as AnnualFilter).academicYearId)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) => listAnnual(db, filter as unknown as AnnualFilter)),
  );

  ipcMain.handle('timetable:occupancy', (_e, filter: unknown) =>
    !isObject(filter)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          listOccupancyWeek(db, filter as unknown as OccupancyFilter),
        ),
  );

  ipcMain.handle('timetable:conflicts', (_e, filter?: unknown) =>
    filter !== undefined && !isObject(filter)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => detectConflicts(db, filter as unknown as ConflictFilter)),
  );

  ipcMain.handle('timetable:summary', (_e) =>
    guard(getDb, (db) => conflictSummary(db)),
  );

  ipcMain.handle('sessions:get', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => getSessionDetail(db, id)),
  );
}
