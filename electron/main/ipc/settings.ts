/**
 * Handlers IPC Paramètres (P12 — FR-51, BR-24) — canaux `settings:*`.
 * Tous les canaux sont réservés au profil ADMIN (`requireRole`,
 * mutations ET lectures : l'écran est `adminOnly` dans la sidebar).
 * Guards payload : id entier > 0 et corps objet requis avant tout
 * travail ; la validation métier reste dans le service (FieldError[]).
 */
import { ipcMain } from 'electron';
import type {
  ApiResult,
  CalendarExceptionInput,
  TimeSlotInput,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  createException,
  createTimeSlot,
  deleteException,
  deleteTimeSlot,
  getRetention,
  listExceptions,
  listTimeSlots,
  setRetention,
  updateException,
  updateTimeSlot,
} from '../db/settings.service';
import { rotateBackups } from '../db/backup.service';
import {
  currentUserId,
  guard,
  isId,
  isObject,
  type DbGetter,
} from './helpers';

const ADMIN = { requireRole: 'ADMIN' as const };

const INVALID = (): ApiResult<never> => apiErr('Paramètres invalides.');

/** Contexte injecté par `ipc/index.ts` (partagé avec `BackupsIpcContext`). */
export interface SettingsIpcContext {
  /**
   * `userData/backups` — la rotation BR-23 est relancée après chaque
   * `settings:retention:set` réussi (un abaissement supprime
   * immédiatement les sauvegardes excédentaires).
   */
  backupDir: string;
}

export function registerSettingsHandlers(
  getDb: DbGetter,
  ctx: SettingsIpcContext,
): void {
  // -- Créneaux horaires (time_slot) --

  ipcMain.handle('settings:slots:list', () =>
    guard(getDb, (db) => listTimeSlots(db), ADMIN),
  );

  ipcMain.handle('settings:slots:create', (_e, input: unknown) =>
    isObject(input)
      ? guard(
          getDb,
          (db) =>
            createTimeSlot(
              db,
              currentUserId(db),
              input as unknown as TimeSlotInput,
            ),
          ADMIN,
        )
      : INVALID(),
  );

  ipcMain.handle('settings:slots:update', (_e, id: unknown, input: unknown) =>
    isId(id) && isObject(input)
      ? guard(
          getDb,
          (db) =>
            updateTimeSlot(
              db,
              currentUserId(db),
              id,
              input as unknown as TimeSlotInput,
            ),
          ADMIN,
        )
      : INVALID(),
  );

  ipcMain.handle('settings:slots:delete', (_e, id: unknown) =>
    isId(id)
      ? guard(getDb, (db) => deleteTimeSlot(db, currentUserId(db), id), ADMIN)
      : INVALID(),
  );

  // -- Exceptions calendrier (calendar_exception) --

  ipcMain.handle('settings:exceptions:list', () =>
    guard(getDb, (db) => listExceptions(db), ADMIN),
  );

  ipcMain.handle('settings:exceptions:create', (_e, input: unknown) =>
    isObject(input)
      ? guard(
          getDb,
          (db) =>
            createException(
              db,
              currentUserId(db),
              input as unknown as CalendarExceptionInput,
            ),
          ADMIN,
        )
      : INVALID(),
  );

  ipcMain.handle(
    'settings:exceptions:update',
    (_e, id: unknown, input: unknown) =>
      isId(id) && isObject(input)
        ? guard(
            getDb,
            (db) =>
              updateException(
                db,
                currentUserId(db),
                id,
                input as unknown as CalendarExceptionInput,
              ),
            ADMIN,
          )
        : INVALID(),
  );

  ipcMain.handle('settings:exceptions:delete', (_e, id: unknown) =>
    isId(id)
      ? guard(getDb, (db) => deleteException(db, currentUserId(db), id), ADMIN)
      : INVALID(),
  );

  // -- Rétention des sauvegardes (setting.backup_retention) --

  ipcMain.handle('settings:retention:get', () =>
    guard(getDb, (db) => getRetention(db), ADMIN),
  );

  ipcMain.handle('settings:retention:set', (_e, n: unknown) =>
    guard(
      getDb,
      (db) => {
        const res = setRetention(db, currentUserId(db), n);
        if (res.ok) {
          // BR-23 : la nouvelle borne s'applique immédiatement.
          // Best-effort : un échec de rotation n'invalide pas
          // l'écriture déjà commitée.
          try {
            rotateBackups(db, ctx.backupDir);
          } catch (e) {
            console.error('[ipc] rotation après retention:set :', e);
          }
        }
        return res;
      },
      ADMIN,
    ),
  );
}
