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

export function registerIpcHandlers(getDb: DbGetter): void {
  registerRoomHandlers(getDb);
  registerModuleHandlers(getDb);
  registerProfessorHandlers(getDb);
  registerMasterHandlers(getDb);
  registerProfileHandlers(getDb);

  ipcMain.handle('app:context', () =>
    guard(getDb, (db) => collectAppContext(db)),
  );

  ipcMain.handle('context:semesters', () =>
    guard(getDb, (db) => collectContextSemesters(db)),
  );
}
