/**
 * État de la base exposé au renderer via `api.dbStatus()` (P5) :
 * nombre de tables, chemin, migrations appliquées, compteurs du jeu de données.
 */
import { DatabaseSync } from 'node:sqlite';
import { all, countRows } from './connection';
import { userTableCount } from './migrate';
import type { DbStatus } from '../../../shared/types';

export function collectDbStatus(
  db: DatabaseSync | null,
  dbPath: string,
  startupError: string | null = null,
): DbStatus {
  if (!db) {
    return {
      ok: false,
      error: startupError ?? 'Base de données non initialisée',
      dbPath,
      tableCount: 0,
      appliedMigrations: [],
      counts: {
        academicYear: 0, semester: 0, timeSlot: 0, room: 0,
        master: 0, professor: 0, module: 0, masterModule: 0, session: 0,
      },
    };
  }
  const hasMigrationsTable =
    all<{ c: number }>(
      db,
      "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )[0]?.c === 1;
  const appliedMigrations = hasMigrationsTable
    ? all<{ version: number }>(
        db,
        'SELECT version FROM schema_migrations ORDER BY version',
      ).map((r) => String(r.version).padStart(4, '0'))
    : [];
  return {
    ok: !startupError,
    error: startupError,
    dbPath,
    tableCount: userTableCount(db),
    appliedMigrations,
    counts: {
      academicYear: countRows(db, 'academic_year'),
      semester: countRows(db, 'semester'),
      timeSlot: countRows(db, 'time_slot'),
      room: countRows(db, 'room'),
      master: countRows(db, 'master'),
      professor: countRows(db, 'professor'),
      module: countRows(db, 'module'),
      masterModule: countRows(db, 'master_module'),
      session: countRows(db, 'session'),
    },
  };
}
