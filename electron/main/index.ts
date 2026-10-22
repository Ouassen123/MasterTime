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
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  try {
    initDatabase();
  } catch (err) {
    // Erreur bloquante : l'app démarre quand même et l'UI affiche l'état.
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
