/**
 * Handlers IPC profils (`profile:*`) et journal d'audit (`audit:*`, lecture).
 */
import { ipcMain } from 'electron';
import {
  getCurrentProfile,
  listProfiles,
  setCurrentProfile,
} from '../db/profile.service';
import { listAuditLog } from '../db/audit.service';
import { guard, type DbGetter } from './helpers';

export function registerProfileHandlers(getDb: DbGetter): void {
  ipcMain.handle('profile:list', () => guard(getDb, (db) => listProfiles(db)));

  ipcMain.handle('profile:current', () =>
    guard(getDb, (db) => getCurrentProfile(db)),
  );

  ipcMain.handle('profile:set', (_e, id: number) =>
    guard(getDb, (db) => setCurrentProfile(db, id)),
  );

  ipcMain.handle('audit:list', (_e, limit?: number) =>
    guard(getDb, (db) => listAuditLog(db, limit ?? 200)),
  );
}
