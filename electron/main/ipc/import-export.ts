/**
 * Handlers IPC Import / Export (P11 — FR-45→49, BR-21) — canaux
 * `import:*` et `export:*`.
 *
 * - `import:preview` / `import:apply` : l'import se fait en UNE requête
 *   IPC avec le texte CSV lu par le renderer (≤ 5 Mo côté UI,
 *   10 000 lignes / ~16 Mio côté service) ; `import:apply` est réservé
 *   au profil ADMIN (`requireRole`, BR-24 — import massif =
 *   administration ; preview, gabarits et exports restent ouverts aux
 *   deux profils — décision documentée §5 du spec).
 * - `import:template` / `export:entity` : `dialog.showSaveDialog` +
 *   écriture du CSV produit côté main (BOM UTF-8 + `;`, même format
 *   que `reportCsv` via `./csv`) — même pattern que les rapports.
 *
 * Guards stricts : type d'import/export inconnu, stratégie inconnue et
 * texte non-string sont refusés avant tout travail (payload forgé).
 */
import { dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import type {
  ApiResult,
  ExportEntityType,
  ImportEntityType,
  ReportExportFile,
} from '../../../shared/types';
import {
  apiErr,
  apiOk,
  EXPORT_TYPES,
  IMPORT_TYPES,
} from '../../../shared/types';
import {
  applyImport,
  entityCsv,
  exportEntity,
  previewImport,
  templateCsv,
} from '../db/import.service';
import { todayIso } from '../db/date';
import { currentUserId, guard, type DbGetter } from './helpers';

function isImportType(v: unknown): v is ImportEntityType {
  return (
    typeof v === 'string' && (IMPORT_TYPES as readonly string[]).includes(v)
  );
}

function isExportType(v: unknown): v is ExportEntityType {
  return (
    typeof v === 'string' && (EXPORT_TYPES as readonly string[]).includes(v)
  );
}

function exportErr(err: unknown, label: string): ApiResult<never> {
  console.error(`[ipc] ${label} :`, err);
  return apiErr("Échec de l'export.");
}

export function registerImportExportHandlers(getDb: DbGetter): void {
  ipcMain.handle('import:preview', (_e, type: unknown, csvText: unknown) =>
    guard(getDb, (db) => previewImport(db, type, csvText)),
  );

  // BR-24 : l'écriture massive est réservée à l'ADMINISTRATEUR.
  ipcMain.handle(
    'import:apply',
    (_e, type: unknown, csvText: unknown, strategy: unknown) =>
      guard(
        getDb,
        (db) => applyImport(db, currentUserId(db), type, csvText, strategy),
        { requireRole: 'ADMIN' },
      ),
  );

  ipcMain.handle(
    'import:template',
    async (_e, type: unknown): Promise<ApiResult<ReportExportFile>> => {
      if (!isImportType(type)) {
        return apiErr('Type de gabarit inconnu.');
      }
      try {
        const res = await dialog.showSaveDialog({
          title: 'Télécharger le gabarit CSV',
          defaultPath: `gabarit-${type}.csv`,
          filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }],
        });
        if (res.canceled || !res.filePath) {
          return apiOk({ path: null, cancelled: true });
        }
        fs.writeFileSync(res.filePath, templateCsv(type), 'utf8');
        return apiOk({ path: res.filePath, cancelled: false });
      } catch (err) {
        return exportErr(err, 'import:template');
      }
    },
  );

  ipcMain.handle(
    'export:entity',
    async (_e, type: unknown): Promise<ApiResult<ReportExportFile>> => {
      if (!isExportType(type)) {
        return apiErr("Type d'export inconnu.");
      }
      const data = guard(getDb, (db) => exportEntity(db, type));
      if (!data.ok) return data;
      try {
        const res = await dialog.showSaveDialog({
          title: 'Exporter en CSV',
          defaultPath: `export-${type}-${todayIso()}.csv`,
          filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }],
        });
        if (res.canceled || !res.filePath) {
          return apiOk({ path: null, cancelled: true });
        }
        fs.writeFileSync(res.filePath, entityCsv(data.data), 'utf8');
        return apiOk({ path: res.filePath, cancelled: false });
      } catch (err) {
        return exportErr(err, 'export:entity');
      }
    },
  );
}
