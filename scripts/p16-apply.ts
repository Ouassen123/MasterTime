/**
 * P16 — Application ponctuelle de la résolution assistée des conflits de
 * salle sur la base réelle (`%APPDATA%/mastertime-tanger/mastertime.db`).
 *
 * Séquence : sauvegarde MANUEL préalable (mécanisme backup existant,
 * VACUUM INTO + rotation BR-23) → aperçu `previewReassignment` →
 * `applyReassignment` (transaction auditée, motif en historique) →
 * compte-rendu des conflits restants par kind.
 *
 * Exécution (esbuild + node, sans Electron) :
 *   npx esbuild scripts/p16-apply.ts --bundle --platform=node \
 *     --format=cjs --external:node:* --outfile=out/p16-apply.cjs
 *   node out/p16-apply.cjs
 */
import path from 'node:path';
import { openDatabase } from '../electron/main/db/connection';
import { getCurrentProfile } from '../electron/main/db/profile.service';
import { createBackup } from '../electron/main/db/backup.service';
import {
  applyReassignment,
  previewReassignment,
} from '../electron/main/db/conflict-resolve.service';
import { detectConflicts } from '../electron/main/db/conflict.service';

const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA non défini.');
const dbPath = path.join(appData, 'mastertime-tanger', 'mastertime.db');
const backupDir = path.join(appData, 'mastertime-tanger', 'backups');

const db = openDatabase(dbPath);
try {
  const uid = getCurrentProfile(db)?.id ?? null;

  const before = detectConflicts(db);
  if (before.ok) {
    const by: Record<string, number> = {};
    for (const c of before.data) by[c.kind] = (by[c.kind] ?? 0) + 1;
    console.log(`Conflits AVANT : ${before.data.length}`, by);
  } else {
    throw new Error(`detectConflicts : ${before.error}`);
  }

  console.log('--- Sauvegarde préalable (MANUEL, VACUUM INTO) ---');
  const backup = createBackup(db, uid, backupDir);
  if (!backup.ok) throw new Error(`Sauvegarde échouée : ${backup.error}`);
  console.log(`Sauvegarde écrite : ${backup.data.path}`);

  const prev = previewReassignment(db);
  if (!prev.ok) throw new Error(`previewReassignment : ${prev.error}`);
  console.log(
    `Aperçu : ${prev.data.proposals.length} proposition(s), ` +
      `${prev.data.skipped.length} non résoluble(s).`,
  );

  const res = applyReassignment(db, uid);
  if (!res.ok) throw new Error(`applyReassignment : ${res.error}`);
  console.log(`Appliqué : ${res.data.moved} séance(s) réaffectée(s).`);
  for (const s of res.data.skipped) {
    console.log(`  non résolue #${s.session_id} ${s.label} — ${s.reason}`);
  }

  const after = detectConflicts(db);
  if (after.ok) {
    const by: Record<string, number> = {};
    for (const c of after.data) by[c.kind] = (by[c.kind] ?? 0) + 1;
    console.log(`Conflits APRÈS : ${after.data.length}`, by);
  }
} finally {
  db.close();
}
