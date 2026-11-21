/**
 * Tests P5 — migrations, seed DÉMO, FK, idempotence, rollback (Vitest, node).
 * Chaque test utilise une base temporaire (fichier ou `:memory:`) — aucun
 * Electron requis : `DatabaseSync` est injecté dans le runner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDb,
  countRows,
  get,
  getDb,
  openDatabase,
  resolveDbPath,
} from '../electron/main/db/connection';
import {
  bundledMigrations,
  loadMigrationsFromDir,
  runMigrations,
  userTableCount,
  type MigrationSource,
} from '../electron/main/db/migrate';
import { seedDemo } from '../electron/main/db/seed-demo';
import { collectDbStatus } from '../electron/main/db/status';
import { effectiveSessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

let tmpDir: string;
let dbPath: string;
let backupDir: string;
let dbs: DatabaseSync[];

function openTempFileDb(): DatabaseSync {
  const db = openDatabase(dbPath);
  dbs.push(db);
  return db;
}

function openMemoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mastertime-test-'));
  dbPath = path.join(tmpDir, 'mastertime.db');
  backupDir = path.join(tmpDir, 'backups');
  dbs = [];
});

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // déjà fermée
    }
  }
  dbs = [];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applique 0001→0005 sur une base vierge : 25 tables + index', () => {
    const db = openTempFileDb();
    const result = runMigrations(db, {
      migrations: loadMigrationsFromDir(MIGRATIONS_DIR),
    });
    expect(result.applied).toEqual(['0001_init.sql', '0002_perf_indexes.sql', '0003_external_occupancy.sql', '0004_professor_active.sql', '0005_session_group.sql']);
    expect(userTableCount(db)).toBe(25);

    const indexCount = get<{ c: number }>(
      db,
      "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    )!.c;
    // 14 (0001→0003) + ix_sg_group (0005)
    expect(indexCount).toBe(15);

    const versions = db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it('bundledMigrations() charge le même SQL que le fichier disque', () => {
    const fromDisk = loadMigrationsFromDir(MIGRATIONS_DIR);
    const bundled = bundledMigrations();
    expect(bundled.map((m) => m.name)).toEqual(fromDisk.map((m) => m.name));
    expect(bundled[0].sql).toBe(fromDisk[0].sql);
  });

  it('idempotence : une seconde exécution ne rejoue rien', () => {
    const db = openTempFileDb();
    const migrations = loadMigrationsFromDir(MIGRATIONS_DIR);
    runMigrations(db, { migrations });
    const second = runMigrations(db, { migrations });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([1, 2, 3, 4, 5]);
    expect(second.backupPath).toBeUndefined();
    expect(userTableCount(db)).toBe(25);
  });

  it('pragmas : journal_mode=WAL (fichier) et foreign_keys=ON', () => {
    const db = openTempFileDb();
    expect(
      get<{ journal_mode: string }>(db, 'PRAGMA journal_mode')!.journal_mode,
    ).toBe('wal');
    expect(
      get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')!.foreign_keys,
    ).toBe(1);
  });

  it('FK violée : insertion de session orpheline → exception', () => {
    const db = openTempFileDb();
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    expect(() =>
      db
        .prepare(
          `INSERT INTO session (master_module_id, professor_id, room_id, date,
             start_min, end_min) VALUES (999, 999, 999, '2026-10-26', 480, 570)`,
        )
        .run(),
    ).toThrow();
  });

  it('migration défectueuse : ROLLBACK, schéma inchangé, backup PRE_MIGRATION conservée', () => {
    const db = openTempFileDb();
    const migrations = loadMigrationsFromDir(MIGRATIONS_DIR);
    runMigrations(db, { migrations });
    seedDemo(db);
    const mastersBefore = countRows(db, 'master');
    const tablesBefore = userTableCount(db);

    const bad: MigrationSource[] = [
      {
        version: 6,
        name: '0006_partial.sql',
        sql: "CREATE TABLE should_not_survive (id INTEGER); INSERT INTO schema_migrations VALUES (6, 'x'); THIS IS NOT SQL;",
      },
    ];
    expect(() =>
      runMigrations(db, { migrations: bad, backupDir, dbPath }),
    ).toThrow(/0006_partial/);

    // Rien n'a été appliqué : ni table fantôme, ni version enregistrée
    expect(userTableCount(db)).toBe(tablesBefore);
    expect(
      get(
        db,
        "SELECT count(*) AS c FROM sqlite_master WHERE name='should_not_survive'",
      )!.c,
    ).toBe(0);
    expect(countRows(db, 'schema_migrations')).toBe(5);
    expect(countRows(db, 'master')).toBe(mastersBefore);

    // Sauvegarde PRE_MIGRATION créée + enregistrée (base existante non vide)
    const backups = fs.readdirSync(backupDir);
    expect(backups.some((f) => f.startsWith('pre-migration-'))).toBe(true);
    const history = db
      .prepare("SELECT kind FROM backup_history WHERE kind='PRE_MIGRATION'")
      .all();
    expect(history.length).toBe(1);
  });
});

describe('seed DÉMO', () => {
  it('insère le jeu complet, is_demo=1 sur toutes les entités marquées', () => {
    const db = openTempFileDb();
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    const result = seedDemo(db);
    expect(result.inserted).toBe(true);

    expect(countRows(db, 'academic_year')).toBe(1);
    expect(countRows(db, 'semester')).toBe(2);
    expect(countRows(db, 'room')).toBe(3);
    expect(countRows(db, 'time_slot')).toBe(6); // Lun–Sam
    expect(countRows(db, 'master')).toBe(3);
    expect(countRows(db, 'professor')).toBe(8);
    expect(countRows(db, 'module')).toBe(6);
    expect(countRows(db, 'master_module')).toBe(6);
    expect(countRows(db, 'session')).toBeGreaterThan(0);

    for (const table of ['master', 'professor', 'module', 'session']) {
      const nonDemo = get<{ c: number }>(
        db,
        `SELECT count(*) AS c FROM ${table} WHERE is_demo != 1`,
      )!.c;
      expect(nonDemo, `${table} : lignes non-DÉMO`).toBe(0);
    }
  });

  it('idempotent : base non vide → aucune insertion, pas de doublon', () => {
    const db = openTempFileDb();
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    seedDemo(db);
    const second = seedDemo(db);
    expect(second.inserted).toBe(false);
    expect(countRows(db, 'master')).toBe(3);
    expect(countRows(db, 'professor')).toBe(8);
  });

  it('seed : aucun chevauchement de salle ni de Master entre séances', () => {
    const db = openMemoryDb();
    runMigrations(db, { migrations: bundledMigrations() });
    seedDemo(db);
    const overlap = get<{ c: number }>(
      db,
      `SELECT count(*) AS c FROM session a
         JOIN session b ON a.id < b.id AND a.date = b.date
         AND a.start_min < b.end_min AND a.end_min > b.start_min
         AND (a.room_id = b.room_id OR a.professor_id = b.professor_id
              OR a.master_module_id = b.master_module_id)`,
    )!.c;
    expect(overlap).toBe(0);
  });

  it('cycle complet sur :memory: — migrate + seed + séances futures', () => {
    const db = openMemoryDb();
    runMigrations(db, { migrations: bundledMigrations() });
    seedDemo(db);
    expect(userTableCount(db)).toBe(25);
    // Toutes les séances DÉMO sont PREVUE et datées dans le futur
    const past = get<{ c: number }>(
      db,
      "SELECT count(*) AS c FROM session WHERE status='PREVUE' AND date < date('now')",
    )!.c;
    expect(past).toBe(0);
  });
});

describe('collectDbStatus', () => {
  it('ok path : 25 tables, migrations [0001..0005], compteurs du seed', () => {
    const db = openTempFileDb();
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    seedDemo(db);
    const status = collectDbStatus(db, dbPath, null);
    expect(status.ok).toBe(true);
    expect(status.error).toBeNull();
    expect(status.dbPath).toBe(dbPath);
    expect(status.tableCount).toBe(25);
    expect(status.appliedMigrations).toEqual(['0001', '0002', '0003', '0004', '0005']);
    expect(status.counts.master).toBe(3);
    expect(status.counts.professor).toBe(8);
    expect(status.counts.room).toBe(3);
    expect(status.counts.session).toBeGreaterThan(0);
  });

  it('startupError est remonté : ok=false + error, compteurs conservés', () => {
    const db = openTempFileDb();
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    seedDemo(db);
    const status = collectDbStatus(db, dbPath, 'migration 0002 a échoué');
    expect(status.ok).toBe(false);
    expect(status.error).toBe('migration 0002 a échoué');
    expect(status.tableCount).toBe(25); // base lisible malgré l'erreur
  });

  it('db null : ok=false même sans startupError', () => {
    const status = collectDbStatus(null, ':memory:', null);
    expect(status.ok).toBe(false);
    expect(status.error).not.toBeNull();
  });
});

describe('resolveDbPath / getDb', () => {
  afterEach(() => {
    closeDb(); // réinitialise le singleton entre les tests
  });

  it('resolveDbPath : chemin explicite > MASTERTIME_DB_PATH > :memory:', () => {
    expect(resolveDbPath('/tmp/explicite.db')).toBe('/tmp/explicite.db');
    const prev = process.env.MASTERTIME_DB_PATH;
    try {
      process.env.MASTERTIME_DB_PATH = '/tmp/env.db';
      expect(resolveDbPath()).toBe('/tmp/env.db');
      expect(resolveDbPath('/tmp/explicite.db')).toBe('/tmp/explicite.db');
      delete process.env.MASTERTIME_DB_PATH;
      expect(resolveDbPath()).toBe(':memory:');
    } finally {
      if (prev === undefined) delete process.env.MASTERTIME_DB_PATH;
      else process.env.MASTERTIME_DB_PATH = prev;
    }
  });

  it('getDb(path) fichier : isMemory=false, ouverture sur disque', () => {
    const handle = getDb(dbPath);
    expect(handle.isMemory).toBe(false);
    expect(handle.path).toBe(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    // même appel → même handle
    expect(getDb(dbPath)).toBe(handle);
    // chemin différent → erreur explicite
    expect(() => getDb(path.join(tmpDir, 'autre.db'))).toThrow(/déjà ouvert/);
    closeDb();
  });
});

describe('effectiveSessionStatus (AD-7)', () => {
  it('PREVUE passée → NON_ENCORE_REALISEE, autres statuts inchangés', () => {
    expect(effectiveSessionStatus('PREVUE', '2020-01-01', '2026-10-22')).toBe(
      'NON_ENCORE_REALISEE',
    );
    expect(effectiveSessionStatus('PREVUE', '2027-01-01', '2026-10-22')).toBe(
      'PREVUE',
    );
    expect(effectiveSessionStatus('REALISEE', '2020-01-01', '2026-10-22')).toBe(
      'REALISEE',
    );
    expect(effectiveSessionStatus('ANNULEE', '2020-01-01', '2026-10-22')).toBe(
      'ANNULEE',
    );
    expect(effectiveSessionStatus('REPORTEE', '2020-01-01', '2026-10-22')).toBe(
      'REPORTEE',
    );
  });
});
