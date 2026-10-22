/**
 * Processus principal Electron — propriétaire unique de la base (AD-1/AD-2).
 * Au démarrage : ouverture/création de `userData/mastertime.db`, application
 * des migrations puis seed DÉMO. Toute erreur DB est conservée et remontée
 * au renderer via `api.dbStatus()` (état bloquant affiché par l'UI).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb } from './db/connection';
import { bundledMigrations, runMigrations } from './db/migrate';
import { seedDemo } from './db/seed-demo';
import { collectDbStatus } from './db/status';
import { ensureProfiles } from './db/profile.service';
import { registerIpcHandlers } from './ipc';
import type { AppInfo } from '../../shared/types';

let db: DatabaseSync | null = null;
let dbPath = '';
let startupError: string | null = null;

function initDatabase(): void {
  const userData = app.getPath('userData');
  dbPath = path.join(userData, 'mastertime.db');
  const handle = getDb(dbPath);
  db = handle.db;
  runMigrations(db, {
    migrations: bundledMigrations(),
    backupDir: path.join(userData, 'backups'),
    dbPath,
  });
  ensureProfiles(db); // profils par défaut + profil courant (avant tout usage)
  seedDemo(db);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'MasterTime Tanger',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, // AD-1
      nodeIntegration: false, // AD-1
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL).catch((err) => {
      console.error('[window] Échec loadURL :', err);
    });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('[window] Échec loadFile :', err);
    });
  }
}

app.whenReady().then(() => {
  try {
    initDatabase();
  } catch (err) {
    // Erreur bloquante : l'app démarre quand même et l'UI affiche l'état.
    // db = null : les handlers IPC (guard) refusent proprement toute mutation
    // sur un schéma potentiellement incomplet.
    db = null;
    startupError = err instanceof Error ? err.message : String(err);
    console.error('[db] Échec d’initialisation :', err);
  }

  ipcMain.handle('app:info', (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node ?? '',
    dbPath,
  }));

  ipcMain.handle('db:status', () => collectDbStatus(db, dbPath, startupError));

  // Handlers métier typés (rooms/modules/profile/audit/context) — retournent
  // toujours ApiResult<T> ; fonctionnent même si la DB a échoué (erreur propre).
  registerIpcHandlers(() => db);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeDb();
});
