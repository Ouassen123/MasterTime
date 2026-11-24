/**
 * Tests P12 — Sauvegardes (`backup.service`) sur bases FICHIER
 * temporaires (`os.tmpdir()` — `VACUUM INTO` et la copie de
 * restauration exigent des fichiers réels).
 *
 * Couvre (§5) :
 * - `createBackup` : fichier `sauvegarde-*.db` + ligne `backup_history`
 *   kind MANUEL + audit CREATE + `exists` ;
 * - `listBackups` : tri DESC, `exists=false` si le fichier est effacé ;
 * - rotation BR-23 : conserve les `backup_retention` plus récentes
 *   MANUEL/AUTO, supprime fichier + ligne des excédentaires,
 *   PRE_MIGRATION hors rotation ;
 * - `restoreBackup` : sauvegarde de sécurité `avant-restauration-*.db`
 *   (kind AUTO) créée, données réellement restaurées (fichier rouvert),
 *   `restored=1` durable sur la ligne restaurée, `restart()` injecté
 *   appelé, refus id inconnu / fichier absent / en-tête non-SQLite ;
 * - `deleteBackup` : PRE_MIGRATION refusée (FieldError kind), MANUEL
 *   supprimée (fichier + ligne + audit DELETE) ;
 * - garde IPC : `requireRole:'ADMIN'` refuse un GESTIONNAIRE.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  all,
  get,
  openDatabase,
  run,
} from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import {
  ensureProfiles,
  listProfiles,
  setCurrentProfile,
} from '../electron/main/db/profile.service';
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
} from '../electron/main/db/backup.service';
import { setRetention } from '../electron/main/db/settings.service';
import { currentUserId, guard } from '../electron/main/ipc/helpers';
import type { ApiResult } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

let dbs: DatabaseSync[];
let dirs: string[];

interface FileDb {
  db: DatabaseSync;
  dbPath: string;
  backupDir: string;
  dir: string;
}

/** Base fichier temporaire migrée + profils — `dir` nettoyé après test. */
function freshFileDb(): FileDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-p12-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'mastertime.db');
  const backupDir = path.join(dir, 'backups');
  const db = openDatabase(dbPath);
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return { db, dbPath, backupDir, dir };
}

function adminId(db: DatabaseSync): number {
  const admin = listProfiles(db).find((p) => p.role === 'ADMIN');
  expect(admin).toBeDefined();
  return admin!.id;
}

interface AuditRow {
  action: string;
  entity: string;
  entity_id: number | string | null;
}

const auditRows = (db: DatabaseSync): AuditRow[] =>
  all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY id');

const countTable = (db: DatabaseSync, table: string): number =>
  get<{ c: number }>(db, `SELECT count(*) AS c FROM "${table}"`)!.c;

beforeEach(() => {
  dbs = [];
  dirs = [];
});

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // déjà fermée (restoreBackup ferme la connexion)
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // fichiers éventuellement encore verrouillés — toléré en test
    }
  }
  dbs = [];
  dirs = [];
});

// --- Création + listing ------------------------------------------------------------

describe('createBackup / listBackups', () => {
  it('crée le fichier horodaté + la ligne MANUEL + audit CREATE', () => {
    const { db, backupDir } = freshFileDb();
    const res = createBackup(db, adminId(db), backupDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.kind).toBe('MANUEL');
    expect(res.data.exists).toBe(true);
    expect(res.data.size_bytes).toBeGreaterThan(0);
    expect(path.basename(res.data.path)).toMatch(/^sauvegarde-.*\.db$/);
    expect(fs.existsSync(res.data.path)).toBe(true);
    // Le snapshot contient le schéma (et sa propre ligne d'historique —
    // insérée avant le VACUUM, convention du service).
    const snap = openDatabase(res.data.path);
    dbs.push(snap);
    expect(countTable(snap, 'backup_history')).toBe(1);
    expect(countTable(snap, 'time_slot')).toBe(0);
    const audit = auditRows(db).find(
      (r) => r.entity === 'backup_history' && r.action === 'CREATE',
    );
    expect(audit).toBeDefined();
  });

  it('listBackups : DESC + exists=false quand le fichier est effacé', () => {
    const { db, backupDir } = freshFileDb();
    const uid = adminId(db);
    const b1 = createBackup(db, uid, backupDir);
    const b2 = createBackup(db, uid, backupDir);
    expect(b1.ok && b2.ok).toBe(true);
    if (!b1.ok || !b2.ok) return;
    fs.unlinkSync(b1.data.path);
    const rows = listBackups(db, backupDir);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(b2.data.id); // plus récent d'abord
    expect(rows[1].exists).toBe(false);
    // La ligne reste présente — la restauration sera refusée proprement.
  });
});

// --- Rotation BR-23 ------------------------------------------------------------------

describe('rotation (BR-23)', () => {
  it('conserve les N plus récentes MANUEL/AUTO ; PRE_MIGRATION épargnée', () => {
    const { db, backupDir } = freshFileDb();
    const uid = adminId(db);
    setRetention(db, uid, 3);
    // Ligne PRE_MIGRATION hors rotation (référence historique).
    const prePath = path.join(backupDir, 'pre-migration-2026-01-01.db');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(prePath, 'fake-pre-migration');
    run(
      db,
      "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 20, 'PRE_MIGRATION')",
      prePath,
    );

    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = createBackup(db, uid, backupDir);
      expect(res.ok).toBe(true);
      if (res.ok) created.push(res.data.path);
    }

    const rows = listBackups(db, backupDir);
    const rotated = rows.filter((r) => r.kind !== 'PRE_MIGRATION');
    expect(rotated).toHaveLength(3); // rétention = 3
    // Les 2 plus anciens fichiers ont disparu (fichier + ligne).
    expect(fs.existsSync(created[0])).toBe(false);
    expect(fs.existsSync(created[1])).toBe(false);
    // Les 3 plus récents subsistent.
    for (const p of created.slice(2)) expect(fs.existsSync(p)).toBe(true);
    // PRE_MIGRATION : ligne + fichier conservés.
    const pre = rows.find((r) => r.kind === 'PRE_MIGRATION');
    expect(pre).toBeDefined();
    expect(pre!.exists).toBe(true);
  });

  it('exempte la plus récente sécurité avant-restauration-*, saute les lignes mortes', () => {
    const { db, backupDir } = freshFileDb();
    const uid = adminId(db);
    setRetention(db, uid, 2);
    fs.mkdirSync(backupDir, { recursive: true });

    // Sécurité AUTO (basename `avant-restauration-*`) la plus récente
    // de son type → exemptée : jamais rotée, même en fin de liste.
    const safetyPath = path.join(
      backupDir,
      'avant-restauration-2026-01-01T00-00-00.db',
    );
    fs.writeFileSync(safetyPath, 'fake-safety');
    run(
      db,
      "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 10, 'AUTO')",
      safetyPath,
    );

    const a = createBackup(db, uid, backupDir);
    const b = createBackup(db, uid, backupDir);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Ligne morte (fichier absent) insérée APRÈS les sauvegardes :
    // avec un id plus récent, elle compterait un slot si non sautée.
    const deadId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 1, 'MANUEL')",
        path.join(backupDir, 'fichier-absent.db'),
      ).lastInsertRowid,
    );

    const c = createBackup(db, uid, backupDir); // déclenche la rotation
    expect(c.ok).toBe(true);

    const rows = listBackups(db, backupDir);
    // Sécurité exemptée : fichier + ligne toujours présents.
    const safety = rows.find((r) => r.path === safetyPath);
    expect(safety).toBeDefined();
    expect(fs.existsSync(safetyPath)).toBe(true);
    // Ligne morte sautée : non comptée → b + c (rétention 2) conservés,
    // et la ligne morte elle-même n'est pas effacée (affichée grisée).
    const dead = rows.find((r) => r.id === deadId);
    expect(dead).toBeDefined();
    expect(dead!.exists).toBe(false);
    expect(fs.existsSync(b.data.path)).toBe(true);
    // a (le plus ancien vivant) a été roté.
    expect(fs.existsSync(a.data.path)).toBe(false);
    expect(rows.find((r) => r.id === a.data.id)).toBeUndefined();
  });
});

// --- Orpheline après échec VACUUM -----------------------------------------------

/**
 * `db` dont tout `exec('VACUUM …')` échoue — simule un `VACUUM INTO`
 * impossible (droits, disque…) sans dépendre des ACL Windows :
 * alternative « mock » acceptée par la revue, le chemin cible étant
 * calculé en interne (`freeBackupPath`) et non injectable.
 */
function sabotageVacuum(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === 'exec') {
        return (sql: string) => {
          if (/^\s*VACUUM/i.test(sql)) {
            throw new Error('VACUUM INTO simulé en échec');
          }
          return (v as DatabaseSync['exec']).call(target, sql);
        };
      }
      // Méthodes liées à la vraie connexion (prepare, close…).
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('orpheline VACUUM', () => {
  it('createBackup : ligne + fichier partiel nettoyés avant propagation', () => {
    const { db, backupDir } = freshFileDb();
    const bad = sabotageVacuum(db);
    expect(() => createBackup(bad, adminId(db), backupDir)).toThrow(
      /VACUUM/,
    );
    expect(countTable(db, 'backup_history')).toBe(0);
    expect(fs.readdirSync(backupDir)).toHaveLength(0);
  });

  it('sécurité restore : idem, la connexion reste ouverte et utilisable', () => {
    const { db, backupDir } = freshFileDb();
    const uid = adminId(db);
    const backup = createBackup(db, uid, backupDir);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const bad = sabotageVacuum(db);
    expect(() =>
      restoreBackup(bad, uid, backupDir, backup.data.id, {
        dbPath: path.join(backupDir, 'x.db'),
        restart: () => undefined,
      }),
    ).toThrow(/VACUUM/);
    // Ligne orpheline de la sécurité supprimée ; seule la MANUEL reste.
    expect(countTable(db, 'backup_history')).toBe(1);
    expect(
      fs.readdirSync(backupDir).filter((f) =>
        f.startsWith('avant-restauration-'),
      ),
    ).toHaveLength(0);
    // Connexion non fermée (le close survient après la sécurité).
    expect(countTable(db, 'time_slot')).toBe(0);
  });
});

// --- Restauration (FR-52) ------------------------------------------------------------

describe('restoreBackup', () => {
  it('restaure les données + sécurité AUTO + restored=1 + restart appelé', () => {
    const { db, dbPath, backupDir } = freshFileDb();
    const uid = adminId(db);
    // État sauvegardé : 1 créneau « marqueur ».
    run(
      db,
      "INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (0, 480, 720, 'MARQUEUR')",
    );
    const backup = createBackup(db, uid, backupDir);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;

    // Mutation post-sauvegarde : le marqueur disparaît de la base live.
    run(db, 'DELETE FROM time_slot');
    run(
      db,
      "INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (1, 840, 1080, 'AUTRE')",
    );

    let restarted = false;
    const res = restoreBackup(db, uid, backupDir, backup.data.id, {
      dbPath,
      restart: () => {
        restarted = true;
      },
    });
    expect(res.ok).toBe(true);
    expect(restarted).toBe(true);
    // La connexion passée est fermée — toute requête dessus échoue.
    expect(() => countTable(db, 'time_slot')).toThrow();

    // Sécurité AUTO : le fichier existe dans le dossier backups.
    const files = fs.readdirSync(backupDir);
    expect(
      files.some((f) => f.startsWith('avant-restauration-')),
    ).toBe(true);

    // La base restaurée (fichier rouvert) contient le marqueur, pas « AUTRE ».
    const restored = openDatabase(dbPath);
    dbs.push(restored);
    const labels = all<{ label: string }>(
      restored,
      'SELECT label FROM time_slot',
    ).map((r) => r.label);
    expect(labels).toEqual(['MARQUEUR']);

    // `restored=1` durable sur la ligne de la sauvegarde restaurée —
    // la ligne figurait dans le snapshot (insérée avant le VACUUM).
    const rows = all<{
      path: string;
      restored: number;
      kind: string;
      size_bytes: number | null;
    }>(restored, 'SELECT path, restored, kind, size_bytes FROM backup_history');
    const restoredRow = rows.find((r) => r.path === backup.data.path);
    expect(restoredRow?.restored).toBe(1);

    // La ligne de la sécurité `avant-restauration-*`, absente du
    // snapshot, est réinsérée dans la base restaurée : elle reste
    // listable ET restaurable après le redémarrage.
    const safetyRow = rows.find((r) =>
      path.basename(r.path).startsWith('avant-restauration-'),
    );
    expect(safetyRow).toBeDefined();
    expect(safetyRow!.kind).toBe('AUTO');
    expect(safetyRow!.size_bytes).toBeGreaterThan(0);
    expect(fs.existsSync(safetyRow!.path)).toBe(true);
  });

  it('refuse une ligne pointant sur la base active (path === dbPath)', () => {
    const { db, dbPath, backupDir } = freshFileDb();
    const uid = adminId(db);
    const selfId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 1, 'MANUEL')",
        dbPath,
      ).lastInsertRowid,
    );
    let restarted = false;
    const res = restoreBackup(db, uid, backupDir, selfId, {
      dbPath,
      restart: () => {
        restarted = true;
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fields?.map((f) => f.field)).toContain('id');
    }
    expect(restarted).toBe(false);
    // Refus en amont : la connexion et la base sont intactes.
    expect(countTable(db, 'time_slot')).toBe(0);
  });

  it('copie échouée → base intacte, tmp effacé et restart appelé', () => {
    const { db, dbPath, backupDir, dir } = freshFileDb();
    const uid = adminId(db);
    run(
      db,
      "INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (0, 480, 720, 'MARQUEUR')",
    );
    const backup = createBackup(db, uid, backupDir);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;

    // Cible de copie dans un dossier inexistant → copyFileSync lève
    // ENOENT avant le rename. Le `dbPath` réel n'est jamais touché.
    const deadTarget = path.join(dir, 'inexistant', 'deep', 'x.db');
    let restarted = false;
    const res = restoreBackup(db, uid, backupDir, backup.data.id, {
      dbPath: deadTarget,
      restart: () => {
        restarted = true;
      },
    });
    expect(res.ok).toBe(false);
    expect(restarted).toBe(true); // restart TOUJOURS appelé (connexion morte)
    expect(fs.existsSync(deadTarget + '.restore-tmp')).toBe(false);

    // La base d'origine (vrai dbPath) est intacte — rouvrable.
    const intact = openDatabase(dbPath);
    dbs.push(intact);
    expect(countTable(intact, 'backup_history')).toBeGreaterThan(0);
  });

  it('refuse id inconnu, fichier absent et en-tête non-SQLite', () => {
    const { db, dbPath, backupDir, dir } = freshFileDb();
    const uid = adminId(db);
    const noop = (): void => undefined;

    // Id inexistant.
    const missing = restoreBackup(db, uid, backupDir, 999, {
      dbPath,
      restart: noop,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/introuvable/i);

    // Fichier supprimé du disque.
    const gonePath = path.join(dir, 'gone.db');
    const goneId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 1, 'MANUEL')",
        gonePath,
      ).lastInsertRowid,
    );
    const gone = restoreBackup(db, uid, backupDir, goneId, {
      dbPath,
      restart: noop,
    });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toMatch(/absent/i);

    // Fichier présent mais pas SQLite.
    const junkPath = path.join(dir, 'junk.db');
    fs.writeFileSync(junkPath, 'CECI N EST PAS UNE BASE SQLITE......');
    const junkId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 40, 'MANUEL')",
        junkPath,
      ).lastInsertRowid,
    );
    const junk = restoreBackup(db, uid, backupDir, junkId, {
      dbPath,
      restart: noop,
    });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error).toMatch(/SQLite/i);

    // Refus en amont : la base est toujours ouverte et intacte.
    expect(countTable(db, 'backup_history')).toBe(2);
  });
});

// --- Suppression (FR-53) ---------------------------------------------------------------

describe('deleteBackup', () => {
  it('refuse PRE_MIGRATION (FieldError kind), supprime MANUEL (fichier+ligne+audit)', () => {
    const { db, backupDir, dir } = freshFileDb();
    const uid = adminId(db);

    // PRE_MIGRATION → refus avec FieldError.
    const prePath = path.join(backupDir, 'pre-migration-x.db');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(prePath, 'fake');
    const preId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 4, 'PRE_MIGRATION')",
        prePath,
      ).lastInsertRowid,
    );
    const refused = deleteBackup(db, uid, backupDir, preId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.fields?.map((f) => f.field)).toContain('kind');
    }
    expect(fs.existsSync(prePath)).toBe(true);
    expect(countTable(db, 'backup_history')).toBe(1);

    // MANUEL → fichier + ligne supprimés + audit DELETE.
    const backup = createBackup(db, uid, backupDir);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const del = deleteBackup(db, uid, backupDir, backup.data.id);
    expect(del.ok).toBe(true);
    expect(fs.existsSync(backup.data.path)).toBe(false);
    const row = get(
      db,
      'SELECT id FROM backup_history WHERE id = ?',
      backup.data.id,
    );
    expect(row).toBeUndefined();
    expect(
      auditRows(db).some(
        (r) => r.entity === 'backup_history' && r.action === 'DELETE',
      ),
    ).toBe(true);

    // Id inconnu → erreur propre.
    expect(deleteBackup(db, uid, backupDir, 999).ok).toBe(false);

    // Fichier hors backupDir : la ligne est supprimée mais le fichier
    // externe n'est JAMAIS touché (unlink confiné au dossier backups).
    const outsidePath = path.join(dir, 'hors-dossier.db');
    fs.writeFileSync(outsidePath, 'fake');
    const outsideId = Number(
      run(
        db,
        "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, 4, 'MANUEL')",
        outsidePath,
      ).lastInsertRowid,
    );
    expect(deleteBackup(db, uid, backupDir, outsideId).ok).toBe(true);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });
});

// --- Garde IPC (BR-24) ---------------------------------------------------------------------

describe('garde IPC — requireRole ADMIN', () => {
  it('mutations refusées en GESTIONNAIRE, acceptées en ADMIN', () => {
    const { db, backupDir } = freshFileDb();
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    const admin = listProfiles(db).find((p) => p.role === 'ADMIN')!;

    const mutations: ((d: DatabaseSync) => ApiResult<unknown>)[] = [
      (d) => createBackup(d, currentUserId(d), backupDir),
      (d) => deleteBackup(d, currentUserId(d), backupDir, 1),
      (d) =>
        restoreBackup(d, currentUserId(d), backupDir, 1, {
          dbPath: ':memory:',
          restart: () => undefined,
        }),
    ];

    setCurrentProfile(db, gest.id);
    for (const fn of mutations) {
      const denied = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toMatch(/Administrateur/);
    }
    // Aucun backup ni audit n'a été créé.
    expect(countTable(db, 'backup_history')).toBe(0);
    expect(auditRows(db)).toHaveLength(0);

    setCurrentProfile(db, admin.id);
    const allowed = guard(() => db, mutations[0], { requireRole: 'ADMIN' });
    expect(allowed.ok).toBe(true);
    expect(countTable(db, 'backup_history')).toBe(1);
  });
});
