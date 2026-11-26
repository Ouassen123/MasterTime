/**
 * IPC Portail web (P19) — pilotage du serveur embarqué et console admin :
 * demandes profs, comptes, réclamations, avis, présence en ligne.
 */
import { ipcMain, app } from 'electron';
import { apiErr, apiOk, type ApiResult } from '../../../shared/types';
import { guard, type DbGetter } from './helpers';
import {
  approvePortalRequest,
  createPortalAccount,
  listPortalAccounts,
  listPortalAnnouncements,
  listPortalComplaints,
  listPortalRequests,
  portalOnlineCount,
  rejectPortalRequest,
  resetPortalPassword,
  setAnnouncementActive,
  setComplaintStatus,
  setPortalAccountActive,
} from '../db/web-portal.service';
import {
  startWebServer,
  stopWebServer,
  webServerStatus,
} from '../webserver.service';

/** Chemin du fichier DB — injecté par `main/index.ts`. */
export interface WebPortalDeps {
  getDbPath: () => string;
}

export function registerWebPortalHandlers(
  getDb: DbGetter,
  deps: WebPortalDeps,
): void {
  ipcMain.handle('webportal:status', () => apiOk(webServerStatus()));

  ipcMain.handle(
    'webportal:start',
    async (_e, port: unknown): Promise<ApiResult<null>> => {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) {
        return apiErr('Port invalide (1024–65535).');
      }
      try {
        // Packagé : server/ + web/ sont copiés dans resources/ (extraResources).
        const appRoot = app.isPackaged
          ? process.resourcesPath
          : app.getAppPath();
        await startWebServer(appRoot, deps.getDbPath(), p);
        return apiOk(null);
      } catch (err) {
        return apiErr(
          `Démarrage impossible : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  ipcMain.handle('webportal:stop', async (): Promise<ApiResult<null>> => {
    await stopWebServer();
    return apiOk(null);
  });

  ipcMain.handle('webportal:online', () =>
    guard(getDb, (db) => portalOnlineCount(db)),
  );

  ipcMain.handle('webportal:requests', (_e, status: unknown) =>
    guard(getDb, (db) =>
      listPortalRequests(db, typeof status === 'string' ? status : 'pending'),
    ),
  );

  ipcMain.handle(
    'webportal:approve',
    (_e, payload: { id?: unknown; note?: unknown }) =>
      guard(getDb, (db) =>
        approvePortalRequest(
          db,
          null,
          Number(payload?.id),
          typeof payload?.note === 'string' ? payload.note : '',
        ),
      ),
  );

  ipcMain.handle(
    'webportal:reject',
    (_e, payload: { id?: unknown; note?: unknown }) =>
      guard(getDb, (db) =>
        rejectPortalRequest(
          db,
          Number(payload?.id),
          typeof payload?.note === 'string' ? payload.note : '',
        ),
      ),
  );

  ipcMain.handle('webportal:complaints', () =>
    guard(getDb, (db) => listPortalComplaints(db)),
  );

  ipcMain.handle(
    'webportal:complaintStatus',
    (_e, payload: { id?: unknown; status?: unknown }) =>
      guard(getDb, (db) =>
        setComplaintStatus(
          db,
          Number(payload?.id),
          payload?.status === 'handled' ? 'handled' : 'read',
        ),
      ),
  );

  ipcMain.handle('webportal:accounts', () =>
    guard(getDb, (db) => listPortalAccounts(db)),
  );

  ipcMain.handle(
    'webportal:createAccount',
    (_e, payload: { professorId?: unknown; login?: unknown; password?: unknown }) =>
      guard(getDb, (db) =>
        createPortalAccount(
          db,
          Number(payload?.professorId),
          String(payload?.login ?? ''),
          String(payload?.password ?? ''),
        ),
      ),
  );

  ipcMain.handle(
    'webportal:resetPassword',
    (_e, payload: { id?: unknown; password?: unknown }) =>
      guard(getDb, (db) =>
        resetPortalPassword(db, Number(payload?.id), String(payload?.password ?? '')),
      ),
  );

  ipcMain.handle(
    'webportal:toggleAccount',
    (_e, payload: { id?: unknown; active?: unknown }) =>
      guard(getDb, (db) =>
        setPortalAccountActive(db, Number(payload?.id), payload?.active !== false),
      ),
  );

  ipcMain.handle('webportal:announcements', () =>
    guard(getDb, (db) => listPortalAnnouncements(db)),
  );

  ipcMain.handle(
    'webportal:announcementActive',
    (_e, payload: { id?: unknown; active?: unknown }) =>
      guard(getDb, (db) =>
        setAnnouncementActive(db, Number(payload?.id), payload?.active !== false),
      ),
  );
}
