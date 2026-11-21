/**
 * État de la base exposé au renderer via `api.dbStatus()` (P5) :
 * nombre de tables, chemin, migrations appliquées, compteurs du jeu de données.
 */
import { DatabaseSync } from 'node:sqlite';
import { all, countRows, get } from './connection';
import { userTableCount } from './migrate';
import type {
  AcademicYearRef,
  AppContext,
  ContextSemesters,
  DbStatus,
  SemesterRef,
} from '../../../shared/types';

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
        demo: 0,
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
      demo: countDemoRows(db),
    },
  };
}

/** Total des lignes `is_demo=1` — pilote le bandeau DÉMO (AD-11). */
function countDemoRows(db: DatabaseSync): number {
  let total = 0;
  // Toutes les tables portant `is_demo` (seed DÉMO, AD-11).
  for (const table of ['master', 'professor', 'module', 'session', 'student']) {
    total += get<{ c: number }>(
      db,
      `SELECT count(*) AS c FROM "${table}" WHERE is_demo = 1`,
    )?.c ?? 0;
  }
  return total;
}

/**
 * Contexte global de la topbar : année universitaire courante
 * (`is_current=1`) et son premier semestre (ordinal le plus bas).
 */
export function collectAppContext(db: DatabaseSync | null): AppContext {
  if (!db) return { academicYear: null, semester: null };
  const year = get<{ id: number; label: string }>(
    db,
    'SELECT id, label FROM academic_year WHERE is_current = 1 ORDER BY id LIMIT 1',
  );
  const semester = year
    ? get<{ label: string }>(
        db,
        'SELECT label FROM semester WHERE academic_year_id = ? ORDER BY ordinal LIMIT 1',
        year.id,
      )
    : undefined;
  return {
    academicYear: year?.label ?? null,
    semester: semester?.label ?? null,
  };
}

/**
 * Références années/semestres exposées via `context:semesters` (P6c) —
 * alimente les Select `academic_year_id`/`semester_id` des formulaires.
 */
export function collectContextSemesters(
  db: DatabaseSync | null,
): ContextSemesters {
  if (!db) return { academicYears: [], semesters: [] };
  const academicYears = all<AcademicYearRef>(
    db,
    'SELECT id, label, is_current FROM academic_year ORDER BY id',
  );
  const semesters = all<SemesterRef>(
    db,
    'SELECT id, academic_year_id, label, ordinal FROM semester' +
      ' ORDER BY academic_year_id, ordinal',
  );
  return { academicYears, semesters };
}
