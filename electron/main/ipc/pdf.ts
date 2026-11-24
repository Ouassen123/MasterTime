/**
 * Rendu PDF partagé (P10 rapports — `reports:exportPdf`, P14 feuille
 * de présence — `sessions:attendanceSheet`) : un document HTML
 * autonome est chargé dans une `BrowserWindow` hors écran dédiée
 * (`show:false`), jamais interactive et sandboxée (pas de preload,
 * pas d'accès Node), `will-navigate` et `setWindowOpenHandler` sont
 * bloqués (le HTML n'est pas fiable), puis
 * `webContents.printToPDF({printBackground:true, pageSize:'A4'})` +
 * save dialog. Le HTML transite par un fichier temporaire — plus
 * robuste qu'une data URL pour les gros documents — supprimé dans le
 * `finally`.
 */
import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiResult, ReportExportFile } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';

export interface HtmlToPdfOptions {
  /** Document HTML complet et autonome (styles inline). */
  html: string;
  /** Titre de la boîte d'enregistrement. */
  dialogTitle: string;
  /** Nom de fichier proposé (ex. `rapport-x-2026-01-01.pdf`). */
  defaultPath: string;
  /** true = paysage (rapports larges) ; défaut : portrait A4. */
  landscape?: boolean;
}

export async function htmlToPdfFile(
  opts: HtmlToPdfOptions,
): Promise<ApiResult<ReportExportFile>> {
  // Fenêtre hors écran dédiée au rendu print — jamais montrée ni
  // interactive ; sandboxée (pas de preload, pas d'accès Node).
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Aucune navigation hors du document ni ouverture de fenêtre.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const tmp = path.join(
    app.getPath('temp'),
    `mastertime-pdf-${process.pid}-${Date.now()}.html`,
  );
  try {
    fs.writeFileSync(tmp, opts.html, 'utf8');
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: opts.landscape === true,
      pageSize: 'A4',
    });
    const res = await dialog.showSaveDialog({
      title: opts.dialogTitle,
      defaultPath: opts.defaultPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) {
      return apiOk({ path: null, cancelled: true });
    }
    fs.writeFileSync(res.filePath, pdf);
    return apiOk({ path: res.filePath, cancelled: false });
  } catch (err) {
    console.error('[ipc] export PDF :', err);
    return apiErr("Échec de l'export PDF.");
  } finally {
    try {
      win.destroy();
    } catch {
      // fenêtre déjà détruite
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // fichier temporaire déjà absent — non bloquant
    }
  }
}
