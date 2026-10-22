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
import { countRows, get, openDatabase } from '../electron/main/db/connection';
import {
  bundledMigrations,
  loadMigrationsFromDir,
  runMigrations,
  userTableCount,
  type MigrationSource,
} from '../electron/main/db/migrate';
import { seedDemo } from '../electron/main/db/seed-demo';

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
  it('applique 0001 sur une base vierge : 23 tables + index', () => {
    const db = openTempFileDb();
    const result = runMigrations(db, {
      migrations: loadMigrationsFromDir(MIGRATIONS_DIR),
    });
    expect(result.applied).toEqual(['0001_init.sql']);
    expect(userTableCount(db)).toBe(23);

    const indexCount = get<{ c: number }>(
      db,
      "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    )!.c;
    expect(indexCount).toBe(9);

    const versions = db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[];
    expect(versions.map((v) => v.version)).toEqual([1]);
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
    expect(second.alreadyApplied).toEqual([1]);
    expect(second.backupPath).toBeUndefined();
    expect(userTableCount(db)).toBe(23);
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
        version: 2,
        name: '0002_partial.sql',
        sql: "CREATE TABLE should_not_survive (id INTEGER); INSERT INTO schema_migrations VALUES (2, 'x'); THIS IS NOT SQL;",
      },
    ];
    expect(() =>
      runMigrations(db, { migrations: bad, backupDir, dbPath }),
    ).toThrow(/0002_partial/);

    // Rien n'a été appliqué : ni table fantôme, ni version enregistrée
    expect(userTableCount(db)).toBe(tablesBefore);
    expect(
      get(
        db,
        "SELECT count(*) AS c FROM sqlite_master WHERE name='should_not_survive'",
      )!.c,
    ).toBe(0);
    expect(countRows(db, 'schema_migrations')).toBe(1);
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

  it('cycle complet sur :memory: — migrate + seed + status dérivé', () => {
    const db = openMemoryDb();
    runMigrations(db, { migrations: bundledMigrations() });
    seedDemo(db);
    expect(userTableCount(db)).toBe(23);
    // Toutes les séances DÉMO sont PREVUE et datées dans le futur
    const past = get<{ c: number }>(
      db,
      "SELECT count(*) AS c FROM session WHERE status='PREVUE' AND date < date('now')",
    )!.c;
    expect(past).toBe(0);
  });
});
