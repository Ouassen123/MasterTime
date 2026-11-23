/**
 * Handlers IPC Rapports (P10 — FR-40→44) — canaux `reports:*`.
 * Lecture seule : `reports:run` délègue à `report.service` (tout calculé
 * en SQL, aucune écriture). Exports :
 *  - `reports:exportCsv` : `dialog.showSaveDialog` (.csv) + BOM UTF-8
 *    via `reportCsv` — le renderer renvoie le `Report` déjà calculé ;
 *  - `reports:exportPdf` : le renderer envoie `{report_id, html}` — un
 *    document HTML autonome généré depuis les mêmes `columns/rows`
 *    (`dir="auto"` conserve le RTL des noms arabes). Le main charge ce
 *    HTML dans une `BrowserWindow` hors écran (`show:false`),
 *    `webContents.printToPDF({printBackground:true})`, save dialog,
 *    écrit le buffer puis ferme la fenêtre — aucune dépendance.
 * Pas de `requireRole` (BR-24) : ouvert aux profils ADMIN et GESTIONNAIRE.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApiResult,
  Report,
  ReportExportFile,
  ReportFilter,
  ReportId,
  ReportPdfInput,
} from '../../../shared/types';
import { apiErr, apiOk, REPORT_IDS } from '../../../shared/types';
import { reportCsv, runReport } from '../db/report.service';
import { todayIso } from '../db/date';
import { guard, isObject, type DbGetter } from './helpers';

/** Bornes anti-payload forgé : rapport « raisonnable » pour l'export. */
const MAX_ROWS = 50_000;
const MAX_COLS = 50;
const MAX_HTML_LEN = 16_000_000;

function isReportId(v: unknown): v is ReportId {
  return typeof v === 'string' && (REPORT_IDS as readonly string[]).includes(v);
}

/** Shape minimale d'un `Report` pour l'export CSV (payload IPC non fiable). */
function isReportShape(v: unknown): v is Report {
  if (!isObject(v) || !isReportId(v.id) || typeof v.title !== 'string') {
    return false;
  }
  if (
    !Array.isArray(v.columns) ||
    v.columns.length === 0 ||
    v.columns.length > MAX_COLS ||
    !v.columns.every(
      (c) => isObject(c) && typeof c.key === 'string' && typeof c.label === 'string',
    )
  ) {
    return false;
  }
  return (
    Array.isArray(v.rows) &&
    v.rows.length <= MAX_ROWS &&
    v.rows.every((r) => isObject(r))
  );
}

function exportErr(err: unknown, label: string): ApiResult<never> {
  console.error(`[ipc] ${label} :`, err);
  return apiErr("Échec de l'export.");
}

export function registerReportHandlers(getDb: DbGetter): void {
  ipcMain.handle('reports:run', (_e, id: unknown, filter: unknown) =>
    !isReportId(id) || (filter !== undefined && !isObject(filter))
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          runReport(db, id, filter as unknown as ReportFilter | undefined),
        ),
  );

  ipcMain.handle(
    'reports:exportCsv',
    async (_e, report: unknown): Promise<ApiResult<ReportExportFile>> => {
      if (!isReportShape(report)) {
        return apiErr('Rapport invalide.');
      }
      try {
        const res = await dialog.showSaveDialog({
          title: 'Exporter le rapport en CSV',
          defaultPath: `rapport-${report.id}-${todayIso()}.csv`,
          filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }],
        });
        if (res.canceled || !res.filePath) {
          return apiOk({ path: null, cancelled: true });
        }
        // BOM UTF-8 déjà inclus par reportCsv — writeFileSync 'utf8' le conserve.
        fs.writeFileSync(res.filePath, reportCsv(report), 'utf8');
        return apiOk({ path: res.filePath, cancelled: false });
      } catch (err) {
        return exportErr(err, 'exportCsv');
      }
    },
  );

  ipcMain.handle(
    'reports:exportPdf',
    async (_e, payload: unknown): Promise<ApiResult<ReportExportFile>> => {
      if (
        !isObject(payload) ||
        !isReportId(payload.report_id) ||
        typeof payload.html !== 'string' ||
        payload.html.length === 0 ||
        payload.html.length > MAX_HTML_LEN
      ) {
        return apiErr('Paramètres invalides.');
      }
      const input = payload as unknown as ReportPdfInput;
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
      // Le HTML transite par un fichier temporaire : plus robuste qu'une
      // data URL (les gros rapports dépassent les limites pratiques des
      // URLs `data:`) et supprimé dans le finally.
      const tmp = path.join(
        app.getPath('temp'),
        `mastertime-rapport-${process.pid}-${Date.now()}.html`,
      );
      try {
        fs.writeFileSync(tmp, input.html, 'utf8');
        await win.loadFile(tmp);
        const pdf = await win.webContents.printToPDF({
          printBackground: true,
          landscape: true, // les tableaux de rapports sont larges
          pageSize: 'A4',
        });
        const res = await dialog.showSaveDialog({
          title: 'Exporter le rapport en PDF',
          defaultPath: `rapport-${input.report_id}-${todayIso()}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (res.canceled || !res.filePath) {
          return apiOk({ path: null, cancelled: true });
        }
        fs.writeFileSync(res.filePath, pdf);
        return apiOk({ path: res.filePath, cancelled: false });
      } catch (err) {
        return exportErr(err, 'exportPdf');
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
    },
  );
}
