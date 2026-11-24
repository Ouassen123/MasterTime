/**
 * Service Sauvegardes (P12 — FR-51/52/53, BR-23) : sauvegardes
 * horodatées par `VACUUM INTO` (snapshot atomique cohérent, WAL inclus
 * — même pattern que la sauvegarde PRE_MIGRATION de `migrate.ts`),
 * rotation bornée par `backup_retention`, restauration contrôlée et
 * suppression avec protection PRE_MIGRATION.
 *
 * Le répertoire `dir` (= `userData/backups`, le même que celui passé à
 * `runMigrations`) est fourni à chaque appel : le service ne connaît ni
 * Electron ni `app` — `dbPath` et le `restart` de la restauration sont
 * injectés (`RestoreDeps`), ce qui rend le service testable sur des
 * bases temporaires.
 *
 * Convention d'écriture : la ligne `backup_history` est insérée AVANT
 * le `VACUUM INTO` (size_bytes complété juste après). Elle figure ainsi
 * dans le snapshot lui-même — une restauration ultérieure peut alors
 * y marquer `restored = 1` de façon DURABLE dans la base restaurée.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiResult, BackupKind, BackupRow } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';
import { getRetention } from './settings.service';

/** En-tête canonique des 16 premiers octets d'un fichier SQLite. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Kinds soumis à la rotation BR-23 (PRE_MIGRATION en est exclu). */
const ROTATED_KINDS = "('MANUEL','AUTO')";

/**
 * Préfixe du BASENAME des sauvegardes de sécurité écrites avant une
 * restauration — la plus récente d'entre elles est exemptée de la
 * rotation (dernier filet de secours).
 */
const SAFETY_PREFIX = 'avant-restauration-';

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

/** Supprime un fichier en ignorant ENOENT (déjà déplacé/supprimé). */
function unlinkIgnore(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * `unlinkIgnore` confiné aux chemins situés SOUS `dir` (résolution +
 * comparaison `root + sep`) : une ligne `backup_history` ne doit jamais
 * provoquer la suppression d'un fichier hors du dossier de sauvegardes.
 */
function unlinkInside(dir: string, p: string): void {
  const root = path.resolve(dir);
  const target = path.resolve(p);
  if (target !== root && target.startsWith(root + path.sep)) {
    unlinkIgnore(target);
  }
}

/**
 * Nettoie une sauvegarde orpheline après un `VACUUM INTO` en échec :
 * la ligne d'historique insérée en amont est supprimée (nettoyage
 * technique, non audité) et le fichier partiel éventuel est effacé —
 * best-effort, l'erreur d'origine prime.
 */
function cleanupOrphanBackup(
  db: DatabaseSync,
  id: number,
  target: string,
): void {
  try {
    run(db, 'DELETE FROM backup_history WHERE id = ?', id);
  } catch {
    // best-effort : la propagation de l'erreur VACUUM prime
  }
  unlinkIgnore(target);
}

/** Horodatage ISO sûr pour un nom de fichier (`:` et `.` → `-`). */
function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** `VACUUM INTO` avec échappement des apostrophes (pattern migrate.ts). */
function vacuumInto(db: DatabaseSync, target: string): void {
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);
}

/**
 * Chemin de sauvegarde libre dans `dir` — suffixe `-N` ajouté si deux
 * dumps tombent dans la même milliseconde (anti-collision).
 */
function freeBackupPath(dir: string, prefix: string): string {
  const stamp = isoStamp();
  let candidate = path.join(dir, `${prefix}-${stamp}.db`);
  for (let i = 2; fileExists(candidate); i++) {
    candidate = path.join(dir, `${prefix}-${stamp}-${i}.db`);
  }
  return candidate;
}

interface BackupDbRow {
  id: number;
  at: string;
  path: string;
  size_bytes: number | null;
  kind: BackupKind;
  restored: number;
}

const BACKUP_SELECT =
  'SELECT id, at, path, size_bytes, kind, restored FROM backup_history';

function toBackupRow(r: BackupDbRow): BackupRow {
  return { ...r, exists: fileExists(r.path) };
}

function getBackupRow(db: DatabaseSync, id: number): BackupRow | undefined {
  const r = get<BackupDbRow>(db, `${BACKUP_SELECT} WHERE id = ?`, id);
  return r ? toBackupRow(r) : undefined;
}

/**
 * Insère la ligne d'historique (audit CREATE) AVANT le snapshot —
 * size_bytes resté NULL est complété par `finishHistoryRow` après le
 * `VACUUM INTO` (non audité : complément technique de la même écriture).
 */
function insertHistoryRow(
  db: DatabaseSync,
  userId: number | null,
  target: string,
  kind: 'MANUEL' | 'AUTO',
): number {
  const id = withAudit(db, userId, 'CREATE', 'backup_history', null, () =>
    Number(
      run(
        db,
        'INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, NULL, ?)',
        target,
        kind,
      ).lastInsertRowid,
    ),
  );
  return id!;
}

function finishHistoryRow(db: DatabaseSync, id: number, target: string): void {
  run(
    db,
    'UPDATE backup_history SET size_bytes = ? WHERE id = ?',
    fs.statSync(target).size,
    id,
  );
}

/**
 * Liste `backup_history` (plus récent d'abord) — `exists` calculé par
 * ligne via `fs.existsSync(path)`. `dir` est créé si besoin : un dossier
 * encore jamais utilisé affiche une table vide plutôt qu'une erreur.
 */
export function listBackups(db: DatabaseSync, dir: string): BackupRow[] {
  fs.mkdirSync(dir, { recursive: true });
  return all<BackupDbRow>(
    db,
    `${BACKUP_SELECT} ORDER BY id DESC`,
  ).map(toBackupRow);
}

/**
 * Rotation BR-23 : conserve les `backup_retention` lignes les plus
 * récentes parmi MANUEL/AUTO ; les excédentaires perdent leur fichier
 * (suppression confinée à `dir`) et leur ligne d'historique.
 *
 * - PRE_MIGRATION est hors rotation — référence historique conservée.
 * - La plus récente ligne AUTO dont le basename commence par
 *   `avant-restauration-` est EXEMPTÉE : c'est le dernier filet de
 *   secours pris avant une restauration, il ne doit pas être roté.
 * - Une ligne dont le fichier n'existe plus est « morte » : elle ne
 *   consomme pas de slot de rétention et n'est pas touchée (l'UI la
 *   montre grisée via `exists=false`).
 *
 * Exportée pour l'IPC `settings:retention:set` : un abaissement de la
 * rétention applique la rotation immédiatement.
 */
export function rotateBackups(db: DatabaseSync, dir: string): void {
  const retention = getRetention(db);
  const rows = all<{ id: number; path: string; kind: BackupKind }>(
    db,
    `SELECT id, path, kind FROM backup_history
      WHERE kind IN ${ROTATED_KINDS} ORDER BY id DESC`,
  );
  const exempt = rows.find(
    (r) =>
      r.kind === 'AUTO' &&
      path.basename(r.path).startsWith(SAFETY_PREFIX),
  );
  let kept = 0;
  for (const r of rows) {
    if (exempt !== undefined && r.id === exempt.id) continue;
    if (!fileExists(r.path)) continue; // ligne morte : ni comptée ni effacée
    kept += 1;
    if (kept > retention) {
      unlinkInside(dir, r.path);
      run(db, 'DELETE FROM backup_history WHERE id = ?', r.id);
    }
  }
}

/** Crée une sauvegarde MANUEL (VACUUM INTO) + rotation BR-23. */
export function createBackup(
  db: DatabaseSync,
  userId: number | null,
  dir: string,
): ApiResult<BackupRow> {
  fs.mkdirSync(dir, { recursive: true });
  const target = freeBackupPath(dir, 'sauvegarde');
  const id = insertHistoryRow(db, userId, target, 'MANUEL');
  try {
    vacuumInto(db, target);
  } catch (err) {
    // Orpheline : la ligne insérée en amont + le fichier partiel sont
    // nettoyés avant de propager l'échec du VACUUM.
    cleanupOrphanBackup(db, id, target);
    throw err;
  }
  finishHistoryRow(db, id, target);
  rotateBackups(db, dir);
  return apiOk(getBackupRow(db, id)!);
}

/** Dépendances injectées de `restoreBackup` — aucune référence à `app`. */
export interface RestoreDeps {
  /** Fichier DB live qui sera écrasé par la copie. */
  dbPath: string;
  /**
   * Redémarrage injecté — prod : `app.relaunch(); app.exit(0)` ;
   * test : noop (la réouverture du fichier est alors laissée à
   * l'appelant).
   */
  restart: () => void;
}

/**
 * Restauration contrôlée (FR-52) :
 * 1. validation id + présence du fichier + en-tête `SQLite format 3`
 *    + refus d'une ligne pointant sur la base active (`dbPath`) ;
 * 2. sauvegarde de sécurité AUTO `avant-restauration-<ts>.db` de la base
 *    courante (orpheline nettoyée si le VACUUM échoue) ;
 * 3. `restored=1` tracé + audit UPDATE sur la ligne restaurée (base
 *    sortante — la marque durable est réécrite après la copie) ;
 * 4. fermeture de la connexion AVANT la copie ATOMIQUE
 *    (`dbPath + '.restore-tmp'` puis `renameSync` — jamais de fichier
 *    tronqué), suppression des `-wal`/`-shm` orphelins (un WAL de
 *    l'ancienne base rejoué sur la restaurée la corromprait),
 *    réinjection dans la base restaurée de `restored=1` et de la ligne
 *    de la sécurité (elle reste listable/restaurable).
 *
 * `restart()` est TOUJOURS invoqué une fois `db.close()` appelé —
 * choix assumé et documenté : la connexion injectée est morte de toute
 * façon (en prod `app.relaunch(); app.exit(0)` termine le processus,
 * aucune session zombie n'est possible ; en test c'est un noop et
 * l'appelant rouvre le fichier lui-même). Si la copie échoue AVANT le
 * rename, `dbPath` n'a jamais été touché : la base d'origine est
 * intacte et le redémarrage la recharge.
 */
export function restoreBackup(
  db: DatabaseSync,
  userId: number | null,
  dir: string,
  id: number,
  deps: RestoreDeps,
): ApiResult<null> {
  const row = get<BackupDbRow>(
    db,
    `${BACKUP_SELECT} WHERE id = ?`,
    id,
  );
  if (!row) {
    return apiErr('Sauvegarde introuvable.');
  }
  if (!fileExists(row.path)) {
    return apiErr(
      'Le fichier de cette sauvegarde est absent du disque : ' +
        'restauration impossible.',
    );
  }
  // Une ligne pointant sur la base active s'écraserait elle-même.
  if (path.resolve(row.path) === path.resolve(deps.dbPath)) {
    return apiErr('Restauration refusée : corrigez les champs signalés.', [
      {
        field: 'id',
        message:
          'Cette sauvegarde pointe sur la base active : ' +
          'restauration impossible.',
      },
    ]);
  }
  // Refuse un fichier renommé ou corrompu : en-tête SQLite obligatoire.
  let headerOk = false;
  const fd = fs.openSync(row.path, 'r');
  try {
    const header = Buffer.alloc(16);
    headerOk =
      fs.readSync(fd, header, 0, 16, 0) === 16 &&
      header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
  if (!headerOk) {
    return apiErr(
      "Le fichier sélectionné n'est pas une base SQLite valide.",
    );
  }

  // 2. Sauvegarde de sécurité de la base courante.
  fs.mkdirSync(dir, { recursive: true });
  const safetyPath = freeBackupPath(dir, 'avant-restauration');
  const safetyId = insertHistoryRow(db, userId, safetyPath, 'AUTO');
  try {
    vacuumInto(db, safetyPath);
  } catch (err) {
    cleanupOrphanBackup(db, safetyId, safetyPath);
    throw err;
  }
  finishHistoryRow(db, safetyId, safetyPath);

  // 3. `restored=1` + audit UPDATE (base sortante — la marque durable
  //    est réécrite dans la base restaurée à l'étape 4).
  withAudit(db, userId, 'UPDATE', 'backup_history', row.id, () => {
    run(db, 'UPDATE backup_history SET restored = 1 WHERE id = ?', row.id);
  });

  // 4. Fermeture AVANT la copie — le fichier live est alors libre.
  //    Copie via un fichier temporaire du MÊME volume + rename atomique :
  //    `dbPath` ne contient jamais un fichier partiellement copié.
  db.close();
  const tmp = deps.dbPath + '.restore-tmp';
  try {
    fs.copyFileSync(row.path, tmp);
    fs.renameSync(tmp, deps.dbPath);
    unlinkIgnore(deps.dbPath + '-wal');
    unlinkIgnore(deps.dbPath + '-shm');

    // Post-copie : réinjection dans la base RESTAURÉE.
    // - `restored=1` durable : la ligne de la sauvegarde figure dans son
    //   propre snapshot (insérée avant le VACUUM par ce service) —
    //   `WHERE id AND path` : best-effort si la ligne y est absente
    //   (fichier étranger, PRE_MIGRATION insérée post-snapshot).
    // - ligne de la sécurité `avant-restauration-*` : absente du snapshot
    //   (créée depuis la base sortante) — réinsérée pour rester
    //   listable et restaurable dans la base restaurée.
    const restoredDb = new DatabaseSync(deps.dbPath);
    try {
      const hasHistory =
        get<{ name: string }>(
          restoredDb,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_history'",
        ) !== undefined;
      if (hasHistory) {
        run(
          restoredDb,
          'UPDATE backup_history SET restored = 1 WHERE id = ? AND path = ?',
          row.id,
          row.path,
        );
        run(
          restoredDb,
          `INSERT INTO backup_history (path, size_bytes, kind)
           VALUES (?, ?, 'AUTO')`,
          safetyPath,
          fs.statSync(safetyPath).size,
        );
      }
    } finally {
      restoredDb.close();
    }
    return apiOk(null);
  } catch (err) {
    // Échec de copie AVANT le rename → `dbPath` intact (le tmp partiel
    // est effacé) ; échec après → la base restaurée est déjà en place.
    // Dans les deux cas `restart()` (finally) relance proprement.
    unlinkIgnore(tmp);
    console.error('[backups] Échec pendant la restauration :', err);
    return apiErr(
      "La restauration a échoué pendant le remplacement du fichier : " +
        "l'application va redémarrer.",
    );
  } finally {
    deps.restart();
  }
}

/**
 * Suppression (FR-53 — confirmation côté UI) : refuse PRE_MIGRATION
 * (référence historique — suppression refusée, FieldError `kind`),
 * sinon supprime le fichier (ENOENT toléré, confiné à `dir`) + la
 * ligne, audit DELETE.
 */
export function deleteBackup(
  db: DatabaseSync,
  userId: number | null,
  dir: string,
  id: number,
): ApiResult<null> {
  const row = get<{ id: number; path: string; kind: BackupKind }>(
    db,
    'SELECT id, path, kind FROM backup_history WHERE id = ?',
    id,
  );
  if (!row) {
    return apiErr('Sauvegarde introuvable.');
  }
  if (row.kind === 'PRE_MIGRATION') {
    return apiErr('Suppression refusée : corrigez les champs signalés.', [
      {
        field: 'kind',
        message:
          'Les sauvegardes PRE_MIGRATION sont des références ' +
          'historiques : suppression refusée.',
      },
    ]);
  }
  unlinkInside(dir, row.path);
  withAudit(db, userId, 'DELETE', 'backup_history', row.id, () => {
    run(db, 'DELETE FROM backup_history WHERE id = ?', row.id);
  });
  return apiOk(null);
}
