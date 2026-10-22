/**
 * Handlers IPC du référentiel Modules — canaux `modules:*`.
 */
import { ipcMain } from 'electron';
import type { ModuleInput } from '../../../shared/types';
import {
  createModule,
  deleteModule,
  listModules,
  updateModule,
} from '../db/module.service';
import { currentUserId, guard, type DbGetter } from './helpers';

export function registerModuleHandlers(getDb: DbGetter): void {
  ipcMain.handle('modules:list', () => guard(getDb, (db) => listModules(db)));

  ipcMain.handle('modules:create', (_e, input: ModuleInput) =>
    guard(getDb, (db) => createModule(db, currentUserId(db), input)),
  );

  ipcMain.handle('modules:update', (_e, id: number, input: ModuleInput) =>
    guard(getDb, (db) => updateModule(db, currentUserId(db), id, input)),
  );

  ipcMain.handle('modules:remove', (_e, id: number) =>
    guard(getDb, (db) => deleteModule(db, currentUserId(db), id)),
  );
}
