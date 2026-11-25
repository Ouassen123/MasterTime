/**
 * Tests P18 — grille des salles disponibles (`free-rooms.service.ts`) :
 * - salle occupée par une séance au créneau → absente, présente ailleurs ;
 *   séance ANNULEE n'occupe pas ;
 * - `external_occupancy` du weekday (année NULL ou année du jour) →
 *   salle exclue ; occupation d'une autre année ignorée ;
 * - `is_active=0` → jamais listée ;
 * - créneau hors `time_slot` → pas de ligne ; jour sans fenêtre → pas
 *   de case ;
 * - jour en `calendar_exception` → `closed` + aucune case ;
 * - validation : `week_start` non-lundi et `duration_min` forgé →
 *   FieldError ; ordre capacité croissante puis nom.
 * Base `:memory:` + migrations, fixtures directes SQL (mêmes conventions
 * que conflict-resolve.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, run } from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import { freeRoomsGrid } from '../electron/main/db/free-rooms.service';
import type { FreeRoomsGrid, SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

/** Semaine du lundi 2026-10-12 → dimanche 2026-10-18. */
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const SAT = '2026-10-17';
const SUN = '2026-10-18';

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  return db;
}

interface Fixture {
  yearId: number;
  otherYearId: number;
  mmId: number;
  profId: number;
  rooms: { petite: number; moyenne: number; grande: number; inactive: number };
}

/**
 * Fenêtres : lun–ven 08h–18h (5 créneaux de 2h), samedi 08h–12h
 * (2 créneaux seulement — les suivants ne tiennent pas dans la fenêtre),
 * dimanche sans time_slot. Exception FERIE le mercredi 2026-10-14.
 */
function seedFixture(db: DatabaseSync): Fixture {
  const yearId = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
    ).lastInsertRowid,
  );
  const otherYearId = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2025-2026', '2025-09-01', '2026-08-31', 0)",
    ).lastInsertRowid,
  );
  const semId = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S3', 3)",
      yearId,
    ).lastInsertRowid,
  );
  for (let w = 0; w <= 4; w++) {
    run(
      db,
      'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, 480, 1080, ?)',
      w,
      'Journée',
    );
  }
  run(
    db,
    'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (5, 480, 720, ?)',
    'Matinée',
  );
  run(
    db,
    `INSERT INTO calendar_exception (start_date, end_date, type, label)
     VALUES (?, ?, 'FERIE', 'Jour férié')`,
    WED,
    WED,
  );
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T', 'Master T', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Un')")
      .lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')")
      .lastInsertRowid,
  );
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, 1200, 120, 10, '2026-09-01', '2027-01-31')`,
      masterId,
      modId,
      semId,
      profId,
    ).lastInsertRowid,
  );
  const room = (name: string, capacity: number | null, active = 1): number =>
    Number(
      run(
        db,
        'INSERT INTO room (name, capacity, is_active) VALUES (?, ?, ?)',
        name,
        capacity,
        active,
      ).lastInsertRowid,
    );
  const rooms = {
    moyenne: room('Moyenne', 80),
    petite: room('Petite', 30),
    grande: room('Grande', 200),
    inactive: room('Inactive', 50, 0),
  };
  return { yearId, otherYearId, mmId, profId, rooms };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: {
    roomId: number;
    date?: string;
    start?: number;
    end?: number;
    status?: SessionStatus;
  },
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      f.mmId,
      f.profId,
      opts.roomId,
      opts.date ?? MON,
      opts.start ?? 480,
      opts.end ?? 600,
      opts.status ?? 'PREVUE',
    ).lastInsertRowid,
  );
}

function addExtOcc(
  db: DatabaseSync,
  opts: {
    roomId: number;
    weekday: number;
    start: number;
    end: number;
    yearId?: number | null;
  },
): void {
  run(
    db,
    `INSERT INTO external_occupancy
       (program, groupe, room_id, weekday, start_min, end_min,
        academic_year_id)
     VALUES ('Licence S1', 'unique', ?, ?, ?, ?, ?)`,
    opts.roomId,
    opts.weekday,
    opts.start,
    opts.end,
    opts.yearId ?? null,
  );
}

function gridOf(db: DatabaseSync, durationMin = 120): FreeRoomsGrid {
  const res = freeRoomsGrid(db, {
    week_start: MON,
    duration_min: durationMin,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function cellNames(
  grid: FreeRoomsGrid,
  date: string,
  start: number,
): string[] {
  return (grid.cells[`${date}|${start}`] ?? []).map((r) => r.name);
}

beforeEach(() => {
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
});

describe('freeRoomsGrid', () => {
  it('semaine : jours + créneaux + tri capacité croissante puis nom', () => {
    const db = freshDb();
    seedFixture(db);
    const g = gridOf(db);
    expect(g.days.map((d) => d.date)).toEqual([
      MON,
      TUE,
      WED,
      '2026-10-15',
      '2026-10-16',
      SAT,
      SUN,
    ]);
    expect(g.days.find((d) => d.date === WED)?.closed).toBe('FERIE');
    expect(g.days.find((d) => d.date === MON)?.closed).toBeNull();
    // Découpe 480–1080 @120 → 5 créneaux (union de tous les jours).
    expect(g.slots.map((s) => [s.start_min, s.end_min])).toEqual([
      [480, 600],
      [600, 720],
      [720, 840],
      [840, 960],
      [960, 1080],
    ]);
    // Tri capacité croissante : Petite(30), Moyenne(80), Grande(200).
    expect(cellNames(g, MON, 600)).toEqual([
      'Petite',
      'Moyenne',
      'Grande',
    ]);
  });

  it('salle occupée par une séance au créneau → absente ; autre créneau → présente', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { roomId: f.rooms.moyenne, start: 480, end: 600 });
    const g = gridOf(db);
    expect(cellNames(g, MON, 480)).toEqual(['Petite', 'Grande']);
    expect(cellNames(g, MON, 600)).toEqual([
      'Petite',
      'Moyenne',
      'Grande',
    ]);
  });

  it("séance ANNULEE n'occupe pas la salle", () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, {
      roomId: f.rooms.moyenne,
      start: 480,
      end: 600,
      status: 'ANNULEE',
    });
    const g = gridOf(db);
    expect(cellNames(g, MON, 480)).toContain('Moyenne');
  });

  it('external_occupancy du weekday → salle exclue (année NULL)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Lundi 08h–12h sur Grande : exclut les créneaux 08–10 et 10–12.
    addExtOcc(db, { roomId: f.rooms.grande, weekday: 0, start: 480, end: 720 });
    const g = gridOf(db);
    expect(cellNames(g, MON, 480)).toEqual(['Petite', 'Moyenne']);
    expect(cellNames(g, MON, 600)).toEqual(['Petite', 'Moyenne']);
    // Autre weekday : pas d'occupation → Grande libre.
    expect(cellNames(g, TUE, 480)).toContain('Grande');
  });

  it("external_occupancy rattachée à une autre année → salle non exclue", () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Même créneau mais rattaché à l'année 2025-2026 (≠ année du jour).
    addExtOcc(db, {
      roomId: f.rooms.grande,
      weekday: 0,
      start: 480,
      end: 720,
      yearId: f.otherYearId,
    });
    const g = gridOf(db);
    expect(cellNames(g, MON, 480)).toContain('Grande');
    // L'année du jour exclut bien.
    addExtOcc(db, {
      roomId: f.rooms.moyenne,
      weekday: 0,
      start: 480,
      end: 720,
      yearId: f.yearId,
    });
    const g2 = gridOf(db);
    expect(cellNames(g2, MON, 480)).not.toContain('Moyenne');
  });

  it('salle is_active=0 → jamais listée', () => {
    const db = freshDb();
    seedFixture(db);
    const g = gridOf(db);
    const all = Object.values(g.cells).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((r) => r.name === 'Inactive')).toBe(false);
  });

  it('créneau hors time_slot → pas de ligne / pas de case ce jour', () => {
    const db = freshDb();
    seedFixture(db);
    const g = gridOf(db);
    // Samedi : fenêtre 08h–12h → créneaux 08–10 et 10–12 seulement ;
    // les suivants ne tiennent pas dans la fenêtre → pas de case.
    expect(g.cells[`${SAT}|480`]).toBeDefined();
    expect(g.cells[`${SAT}|600`]).toBeDefined();
    expect(g.cells[`${SAT}|720`]).toBeUndefined();
    // Dimanche : aucun time_slot → aucune case.
    expect(
      Object.keys(g.cells).filter((k) => k.startsWith(`${SUN}|`)),
    ).toHaveLength(0);
  });

  it('jour en exception → closed et aucune case', () => {
    const db = freshDb();
    seedFixture(db);
    const g = gridOf(db);
    expect(g.days.find((d) => d.date === WED)?.closed).toBe('FERIE');
    expect(
      Object.keys(g.cells).filter((k) => k.startsWith(`${WED}|`)),
    ).toHaveLength(0);
  });

  it('duration_min forgé → FieldError', () => {
    const db = freshDb();
    seedFixture(db);
    for (const bad of [0, 45, 95, 'deux-heures' as unknown as number]) {
      const res = freeRoomsGrid(db, {
        week_start: MON,
        duration_min: bad,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.some((f) => f.field === 'duration_min')).toBe(
          true,
        );
      }
    }
  });

  it('week_start non-lundi ou invalide → FieldError', () => {
    const db = freshDb();
    seedFixture(db);
    for (const bad of [TUE, '12/10/2026', '']) {
      const res = freeRoomsGrid(db, {
        week_start: bad,
        duration_min: 120,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.some((f) => f.field === 'week_start')).toBe(true);
      }
    }
  });

  it('duration_min omis → 120 par défaut ; 60 découpe plus fin', () => {
    const db = freshDb();
    seedFixture(db);
    const def = freeRoomsGrid(db, { week_start: MON });
    expect(def.ok).toBe(true);
    if (def.ok) expect(def.data.slots).toHaveLength(5);
    const fine = gridOf(db, 60);
    // 480–1080 @60 → 10 créneaux.
    expect(fine.slots).toHaveLength(10);
    expect(fine.slots[0]).toEqual({ start_min: 480, end_min: 540 });
  });
});
