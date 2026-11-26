/**
 * Processus principal Electron — propriétaire unique de la base (AD-1/AD-2).
 * Au démarrage : ouverture/création de `userData/mastertime.db`, application
 * des migrations puis seed DÉMO. Toute erreur DB est conservée et remontée
 * au renderer via `api.dbStatus()` (état bloquant affiché par l'UI).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { closeDb, get, getDb } from './db/connection';
import { bundledMigrations, runMigrations } from './db/migrate';
import { seedReal } from './db/seed-real';
import { collectDbStatus } from './db/status';
import { ensureProfiles } from './db/profile.service';
import { registerIpcHandlers } from './ipc';
import { startWebServer } from './webserver.service';
import type { AppInfo } from '../../shared/types';

let db: DatabaseSync | null = null;
let dbPath = '';
let backupDir = '';
let startupError: string | null = null;

function initDatabase(): void {
  const userData = app.getPath('userData');
  dbPath = path.join(userData, 'mastertime.db');
  backupDir = path.join(userData, 'backups');
  const handle = getDb(dbPath);
  db = handle.db;
  runMigrations(db, {
    migrations: bundledMigrations(),
    backupDir,
    dbPath,
  });
  ensureProfiles(db); // profils par défaut + profil courant (avant tout usage)
  seedReal(db);
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

  // Mode capture d'écran (dev/docs) : `MT_CAPTURE_DIR=<dossier>` capture
  // chaque page listée puis quitte. Jamais actif en usage normal.
  const captureDir = process.env.MT_CAPTURE_DIR;
  if (captureDir) void runCapture(win, captureDir);
}

const CAPTURE_ROUTES: [string, string][] =
  process.env.MT_CAPTURE_ONLY === 'seances-rapports'
    ? [
        ['04-seances', '/seances'],
        ['05-rapports', '/rapports'],
      ]
    : [
        ['01-tableau-de-bord', '/'],
        ['02-emploi-du-temps', '/emplois-du-temps'],
        ['03-generation', '/generation'],
        ['04-seances', '/seances'],
        ['05-rapports', '/rapports'],
        ['06-masters', '/masters'],
        ['07-professeurs', '/professeurs'],
        ['08-import-export', '/import-export'],
        ['09-parametres', '/parametres'],
        ['10-sauvegardes', '/sauvegardes'],
      ];

async function runCapture(win: BrowserWindow, dir: string): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await new Promise<void>((r) =>
    win.webContents.once('did-finish-load', () => r()),
  );
  await sleep(3500); // rendu initial + chargement des données
  for (const [name, route] of CAPTURE_ROUTES) {
    await win.webContents.executeJavaScript(
      `location.hash = '#${route}';`,
    );
    // Attendre que le router ait réellement appliqué la route.
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const hash = await win.webContents.executeJavaScript(
        'location.hash',
      );
      if (hash === `#${route}` || (route === '/' && hash === '#/'))
        break;
    }
    await sleep(2000);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
    console.log(`[capture] ${name}.png`);
  }
  app.exit(0);
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
  // Le contexte backups est résolu ici : le service ne connaît pas `app`.
  registerIpcHandlers(() => db, {
    backups: {
      backupDir,
      dbPath,
      restart: () => {
        // Restauration (FR-52) : relance sur le fichier DB remplacé.
        app.relaunch();
        app.exit(0);
      },
    },
    getDbPath: () => dbPath,
  });

  // P19 — redémarrage automatique du portail web s'il était actif.
  if (db) {
    try {
      const en = get<{ value: string }>(
        db,
        "SELECT value FROM setting WHERE key = 'webportal_enabled'",
      );
      if (en?.value === '1') {
        const pr = get<{ value: string }>(
          db,
          "SELECT value FROM setting WHERE key = 'webportal_port'",
        );
        const appRoot = app.isPackaged
          ? process.resourcesPath
          : app.getAppPath();
        void startWebServer(
          appRoot,
          dbPath,
          Number(pr?.value) || 8080,
        ).catch((err) =>
          console.error('[web] Démarrage auto impossible :', err),
        );
      }
    } catch (err) {
      console.error('[web] Lecture réglage portail :', err);
    }
  }

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
