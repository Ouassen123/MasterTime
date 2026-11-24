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
import { dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import type {
  ApiResult,
  Report,
  ReportExportFile,
  ReportFilter,
  ReportId,
  ReportPdfInput,
} from '../../../shared/types';
import { apiErr, apiOk, REPORT_IDS } from '../../../shared/types';
import { reportCsv, runReport, MAX_REPORT_ROWS } from '../db/report.service';
import { todayIso } from '../db/date';
import { guard, isObject, type DbGetter } from './helpers';
import { htmlToPdfFile } from './pdf';

/** Bornes anti-payload forgé : rapport « raisonnable » pour l'export. */
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
  // Pas de cap de refus sur rows.length : au-delà de MAX_REPORT_ROWS le
  // handler tronque plutôt qu'échouer (cohérent avec runReport).
  return Array.isArray(v.rows) && v.rows.every((r) => isObject(r));
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
        // Cap de lignes : tronqué plutôt qu'échec opaque (un payload
        // forgé ou un rapport non régénéré peut dépasser MAX_REPORT_ROWS).
        const out: Report =
          report.rows.length > MAX_REPORT_ROWS
            ? {
                ...report,
                rows: report.rows.slice(0, MAX_REPORT_ROWS),
                truncated: true,
              }
            : report;
        // BOM UTF-8 déjà inclus par reportCsv — writeFileSync 'utf8' le conserve.
        fs.writeFileSync(res.filePath, reportCsv(out), 'utf8');
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
      // Rendu PDF partagé (`ipc/pdf.ts`) : fenêtre hors écran sandboxée,
      // navigation bloquée (le HTML vient du renderer — non fiable),
      // fichier temporaire + save dialog. Paysage : tableaux larges.
      return htmlToPdfFile({
        html: input.html,
        dialogTitle: 'Exporter le rapport en PDF',
        defaultPath: `rapport-${input.report_id}-${todayIso()}.pdf`,
        landscape: true,
      });
    },
  );
}
