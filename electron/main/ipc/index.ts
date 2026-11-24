/**
 * Enregistrement des handlers IPC typés (AD-1) — un fichier par domaine.
 * Tous les canaux retournent `ApiResult<T>` ; jamais d'exception brute
 * propagée au renderer.
 */
import { ipcMain } from 'electron';
import { collectAppContext, collectContextSemesters } from '../db/status';
import { guard, type DbGetter } from './helpers';
import { registerRoomHandlers } from './rooms';
import { registerModuleHandlers } from './modules';
import { registerProfessorHandlers } from './professors';
import { registerMasterHandlers } from './masters';
import { registerProfileHandlers } from './profile';
import { registerTimetableHandlers } from './timetable';
import { registerSessionHandlers } from './sessions';
import { registerGenerationHandlers } from './generation';
import { registerRegistryHandlers } from './registry';
import { registerAbsenceHandlers } from './absences';
import { registerAttendanceHandlers } from './attendance';
import { registerStudentHandlers } from './students';
import { registerReportHandlers } from './reports';
import { registerImportExportHandlers } from './import-export';
import { registerSettingsHandlers } from './settings';
import {
  registerBackupHandlers,
  type BackupsIpcContext,
} from './backups';

/** Dépendances résolues côté `main/index.ts` (chemins + redémarrage). */
export interface IpcDeps {
  backups: BackupsIpcContext;
}

export function registerIpcHandlers(getDb: DbGetter, deps: IpcDeps): void {
  registerRoomHandlers(getDb);
  registerModuleHandlers(getDb);
  registerProfessorHandlers(getDb);
  registerMasterHandlers(getDb);
  registerProfileHandlers(getDb);
  registerTimetableHandlers(getDb);
  registerSessionHandlers(getDb);
  registerGenerationHandlers(getDb);
  registerRegistryHandlers(getDb);
  registerAbsenceHandlers(getDb);
  registerAttendanceHandlers(getDb);
  registerStudentHandlers(getDb);
  registerReportHandlers(getDb);
  registerImportExportHandlers(getDb);
  registerSettingsHandlers(getDb);
  registerBackupHandlers(getDb, deps.backups);

  ipcMain.handle('app:context', () =>
    guard(getDb, (db) => collectAppContext(db)),
  );

  ipcMain.handle('context:semesters', () =>
    guard(getDb, (db) => collectContextSemesters(db)),
  );
}
