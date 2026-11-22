/**
 * Handlers IPC Registre des séances (P9a — FR-30/35) — canaux
 * `registry:*`. Lecture seule : pas de `requireRole`, ouvert aux profils
 * ADMIN et GESTIONNAIRE. Guards stricts (`isId`/`isObject`) ; la
 * validation métier vit dans `session.service`.
 */
import { ipcMain } from 'electron';
import type {
  RegistryFilter,
  RegistryPage,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  listSessionsRegistry,
  remainingSessions,
} from '../db/session.service';
import { guard, isId, isObject, type DbGetter } from './helpers';

export function registerRegistryHandlers(getDb: DbGetter): void {
  ipcMain.handle('registry:list', (_e, filter: unknown, page: unknown) =>
    (filter !== undefined && !isObject(filter)) ||
    (page !== undefined && !isObject(page))
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          listSessionsRegistry(
            db,
            filter as unknown as RegistryFilter | undefined,
            page as unknown as RegistryPage | undefined,
          ),
        ),
  );

  ipcMain.handle('registry:remaining', (_e, masterModuleId: unknown) =>
    !isId(masterModuleId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => remainingSessions(db, masterModuleId)),
  );
}
