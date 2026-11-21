/**
 * Handlers IPC du référentiel Masters — canaux `masters:*` (CRUD, fiche
 * de suivi, groupes d'étudiants, master-modules).
 * Toutes les mutations sont réservées ADMIN (BR-24) : create/update/
 * setStatus/remove/addGroup/renameGroup/removeGroup/attachModule/
 * updateModule/detachModule.
 */
import { ipcMain } from 'electron';
import type {
  GroupInput,
  MasterInput,
  MasterModuleInput,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  addGroup,
  attachModule,
  createMaster,
  deleteMaster,
  detachModule,
  getMasterDetail,
  listMasters,
  removeGroup,
  renameGroup,
  setMasterStatus,
  updateMaster,
  updateMasterModule,
} from '../db/master.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

export function registerMasterHandlers(getDb: DbGetter): void {
  ipcMain.handle('masters:list', (_e, filter?: unknown) =>
    filter !== undefined && !isObject(filter)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) =>
          listMasters(db, filter as Parameters<typeof listMasters>[1]),
        ),
  );

  ipcMain.handle('masters:get', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => getMasterDetail(db, id)),
  );

  ipcMain.handle('masters:create', (_e, input: MasterInput) =>
    !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) => createMaster(db, currentUserId(db), input), {
          requireRole: 'ADMIN',
        }),
  );

  ipcMain.handle('masters:update', (_e, id: number, input: MasterInput) =>
    !isId(id) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(
          getDb,
          (db) => updateMaster(db, currentUserId(db), id, input),
          { requireRole: 'ADMIN' },
        ),
  );

  ipcMain.handle('masters:setStatus', (_e, id: number, status: string) =>
    !isId(id) || (status !== 'ACTIF' && status !== 'ARCHIVE')
      ? apiErr('Paramètre invalide.')
      : guard(
          getDb,
          (db) => setMasterStatus(db, currentUserId(db), id, status),
          { requireRole: 'ADMIN' },
        ),
  );

  ipcMain.handle('masters:remove', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => deleteMaster(db, currentUserId(db), id), {
          requireRole: 'ADMIN',
        }),
  );

  // --- Groupes ---------------------------------------------------------------

  ipcMain.handle('masters:addGroup', (_e, masterId: number, input: GroupInput) =>
    !isId(masterId) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(
          getDb,
          (db) => addGroup(db, currentUserId(db), masterId, input),
          { requireRole: 'ADMIN' },
        ),
  );

  ipcMain.handle('masters:renameGroup', (_e, id: number, input: GroupInput) =>
    !isId(id) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(
          getDb,
          (db) => renameGroup(db, currentUserId(db), id, input),
          { requireRole: 'ADMIN' },
        ),
  );

  ipcMain.handle('masters:removeGroup', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => removeGroup(db, currentUserId(db), id), {
          requireRole: 'ADMIN',
        }),
  );

  // --- Master-modules ---------------------------------------------------------

  ipcMain.handle(
    'masters:attachModule',
    (_e, masterId: number, input: MasterModuleInput) =>
      !isId(masterId) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(
            getDb,
            (db) => attachModule(db, currentUserId(db), masterId, input),
            { requireRole: 'ADMIN' },
          ),
  );

  ipcMain.handle(
    'masters:updateModule',
    (_e, id: number, input: MasterModuleInput) =>
      !isId(id) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(
            getDb,
            (db) => updateMasterModule(db, currentUserId(db), id, input),
            { requireRole: 'ADMIN' },
          ),
  );

  ipcMain.handle('masters:detachModule', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => detachModule(db, currentUserId(db), id), {
          requireRole: 'ADMIN',
        }),
  );
}
