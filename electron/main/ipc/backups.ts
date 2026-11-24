/**
 * Handlers IPC Sauvegardes (P12 — FR-51/52/53, BR-23/24) — canaux
 * `backups:*`, tous réservés au profil ADMIN (`requireRole`).
 *
 * `backups:restore` ne reçoit que `{ id }` du renderer : `dbPath`,
 * `backupDir` et le `restart` (`app.relaunch(); app.exit(0)` en prod)
 * sont résolus côté main via `BackupsIpcContext` injecté par `index.ts`
 * — le service ne connaît jamais `app`.
 *
 * `backups:openFolder` ouvre le dossier `userData/backups` via
 * `shell.openPath` (asynchrone — le rôle est vérifié à la main, le
 * `guard` synchrone ne pouvant pas envelopper la promesse).
 */
import { ipcMain, shell } from 'electron';
import fs from 'node:fs';
import type { ApiResult } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
} from '../db/backup.service';
import { getCurrentProfile } from '../db/profile.service';
import {
  currentUserId,
  guard,
  isId,
  isObject,
  type DbGetter,
} from './helpers';

const ADMIN = { requireRole: 'ADMIN' as const };

const INVALID = (): ApiResult<never> => apiErr('Paramètres invalides.');

/** Contexte injecté par `ipc/index.ts` (résolu dans `main/index.ts`). */
export interface BackupsIpcContext {
  /** `userData/backups` — même répertoire que `runMigrations`. */
  backupDir: string;
  /** Fichier DB live (`userData/mastertime.db`) écrasé à la restauration. */
  dbPath: string;
  /** Redémarrage prod : `app.relaunch(); app.exit(0)`. */
  restart: () => void;
}

export function registerBackupHandlers(
  getDb: DbGetter,
  ctx: BackupsIpcContext,
): void {
  ipcMain.handle('backups:list', () =>
    guard(getDb, (db) => listBackups(db, ctx.backupDir), ADMIN),
  );

  ipcMain.handle('backups:create', () =>
    guard(
      getDb,
      (db) => createBackup(db, currentUserId(db), ctx.backupDir),
      ADMIN,
    ),
  );

  ipcMain.handle('backups:restore', (_e, payload: unknown) => {
    const id = isObject(payload) ? payload.id : undefined;
    return isId(id)
      ? guard(
          getDb,
          (db) =>
            restoreBackup(db, currentUserId(db), ctx.backupDir, id, {
              dbPath: ctx.dbPath,
              restart: ctx.restart,
            }),
          ADMIN,
        )
      : INVALID();
  });

  ipcMain.handle('backups:delete', (_e, id: unknown) =>
    isId(id)
      ? guard(
          getDb,
          (db) => deleteBackup(db, currentUserId(db), ctx.backupDir, id),
          ADMIN,
        )
      : INVALID(),
  );

  ipcMain.handle('backups:openFolder', async (): Promise<ApiResult<null>> => {
    // Tout dans le try : getDb/getCurrentProfile peuvent lever —
    // le contrat est ApiResult quoi qu'il arrive.
    try {
      const db = getDb();
      if (!db) {
        return apiErr('Base de données non initialisée.');
      }
      if (getCurrentProfile(db)?.role !== 'ADMIN') {
        return apiErr('Action réservée au profil Administrateur.');
      }
      fs.mkdirSync(ctx.backupDir, { recursive: true });
      const err = await shell.openPath(ctx.backupDir);
      return err
        ? apiErr(`Impossible d'ouvrir le dossier : ${err}`)
        : apiOk(null);
    } catch (e) {
      console.error('[ipc] backups:openFolder :', e);
      return apiErr('Une erreur interne est survenue.');
    }
  });
}
