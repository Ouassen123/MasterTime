/**
 * Tests P8 — génération automatique de l'emploi du temps : moteur
 * glouton (occupation simulée en mémoire), modes COMPLETE/REGENERATE,
 * rapport BR-15, apply atomique re-vérifié par `checkSessionPlacement`,
 * idempotence, reproductibilité par seed, audit/history — base
 * `:memory:` + acceptation sur le seed RÉEL (seedReal).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, openDatabase, run } from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import { ensureProfiles } from '../electron/main/db/profile.service';
import { detectConflicts } from '../electron/main/db/conflict.service';
import { seedReal } from '../electron/main/db/seed-real';
import {
  abandonGeneration,
  applyGeneration,
  generate,
  generationCatalog,
  getGeneration,
  listGenerations,
} from '../electron/main/db/generation.service';
import type { GenerateParams, SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

// Fenêtre de génération : 2 semaines (lun 2026-09-21 → ven 2026-10-02).
const SEM_START = '2026-09-21';
const SEM_END = '2026-10-02';
const FERIE = '2026-09-23'; // mercredi sem. 1 — calendar_exception
const ABSENCE = '2026-09-29'; // mardi sem. 2 — absence P1
const TODAY = '2026-09-15'; // injecté : toute la fenêtre est future
const SLOT_START = 480; // 08h00
const SLOT_END = 1080; // 18h00

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return db;
}

/** uid du profil courant (Administrateur seedé) — FK audit/history. */
function uid(db: DatabaseSync): number {
  return get<{ id: number }>(
    db,
    "SELECT id FROM app_user WHERE role = 'ADMIN' ORDER BY id LIMIT 1",
  )!.id;
}

interface Fixture {
  yearId: number;
  semId: number;
  master1: number;
  master2: number;
  group1: number; // size 30 (M1)
  group2: number; // size 100 (M2 — seule la grande salle convient)
  prof1: number; // DISPO lun–ven 08-18 + absence le 2026-09-29
  prof2: number; // INDISPO mardi, sinon toujours dispo
  prof3: number; // DISPO dimanche seulement → jamais disponible (BR-15)
  prof4: number; // aucune contrainte (REGENERATE)
  room1: number; // capacité 40
  room2: number; // capacité 80
  room3: number; // capacité 300 (blocage Licence mardi 08-12)
  mm1: number; // M1 Mod1 P1 G1 planned 4
  mm2: number; // M2 Mod2 P2 G2 planned 2
  mm3: number; // M2 Mod3 P3 G2 planned 1 → impossible
  mm4: number; // M1 Mod4 P4 G1 planned 3 → REGENERATE
}

function insertMm(
  db: DatabaseSync,
  masterId: number,
  modId: number,
  semId: number,
  profId: number,
  groupId: number | null,
  planned: number,
): number {
  return Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, ?, 2400, 120, ?, ?, ?)`,
      masterId,
      modId,
      semId,
      profId,
      groupId,
      planned,
      SEM_START,
      SEM_END,
    ).lastInsertRowid,
  );
}

function seedFixture(db: DatabaseSync): Fixture {
  const yearId = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
    ).lastInsertRowid,
  );
  const semId = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S3', 3)",
      yearId,
    ).lastInsertRowid,
  );
  // Créneaux autorisés : lun–sam 08h–18h (fenêtre continue subdivisée).
  for (let w = 0; w <= 5; w++) {
    run(
      db,
      'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, ?, ?, ?)',
      w,
      SLOT_START,
      SLOT_END,
      'Journée',
    );
  }
  // Exception : mercredi 2026-09-23 férié.
  run(
    db,
    `INSERT INTO calendar_exception (start_date, end_date, type, label)
     VALUES (?, ?, 'FERIE', 'Jour férié')`,
    FERIE,
    FERIE,
  );
  const master1 = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T1', 'Master Un', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const master2 = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T2', 'Master Deux', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const group1 = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G1', 30)",
      master1,
    ).lastInsertRowid,
  );
  const group2 = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G2', 100)",
      master2,
    ).lastInsertRowid,
  );
  const prof1 = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Alpha')")
      .lastInsertRowid,
  );
  const prof2 = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Beta')")
      .lastInsertRowid,
  );
  const prof3 = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Gamma')")
      .lastInsertRowid,
  );
  const prof4 = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Delta')")
      .lastInsertRowid,
  );
  // P1 : DISPO lun–ven 08–18 (samedi indisponible) + absence 2026-09-29.
  for (let w = 0; w <= 4; w++) {
    run(
      db,
      `INSERT INTO professor_availability
         (professor_id, weekday, start_min, end_min, kind)
       VALUES (?, ?, ?, ?, 'DISPO')`,
      prof1,
      w,
      SLOT_START,
      SLOT_END,
    );
  }
  run(
    db,
    `INSERT INTO professor_absence (professor_id, start_date, end_date, reason)
     VALUES (?, ?, ?, 'Déplacement')`,
    prof1,
    ABSENCE,
    ABSENCE,
  );
  // P2 : INDISPO mardi toute la journée, aucune DISPO → sinon toujours dispo.
  run(
    db,
    `INSERT INTO professor_availability
       (professor_id, weekday, start_min, end_min, kind)
     VALUES (?, 1, ?, ?, 'INDISPO')`,
    prof2,
    SLOT_START,
    SLOT_END,
  );
  // P3 : DISPO dimanche seulement — aucun time_slot dimanche → jamais dispo.
  run(
    db,
    `INSERT INTO professor_availability
       (professor_id, weekday, start_min, end_min, kind)
     VALUES (?, 6, ?, ?, 'DISPO')`,
    prof3,
    SLOT_START,
    SLOT_END,
  );
  const room1 = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)")
      .lastInsertRowid,
  );
  const room2 = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle B', 80)")
      .lastInsertRowid,
  );
  const room3 = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Amphi C', 300)")
      .lastInsertRowid,
  );
  // Occupation Licence : Amphi C bloqué le mardi 08–12 (même année).
  run(
    db,
    `INSERT INTO external_occupancy
       (program, groupe, room_id, weekday, start_min, end_min,
        academic_year_id)
     VALUES ('Licence S1', 'unique', ?, 1, 480, 720, ?)`,
    room3,
    yearId,
  );
  const mod = (code: string, name: string): number =>
    Number(
      run(db, 'INSERT INTO module (code, name) VALUES (?, ?)', code, name)
        .lastInsertRowid,
    );
  const mm1 = insertMm(db, master1, mod('MOD-1', 'Algo'), semId, prof1, group1, 4);
  const mm2 = insertMm(db, master2, mod('MOD-2', 'Droit'), semId, prof2, group2, 2);
  const mm3 = insertMm(db, master2, mod('MOD-3', 'Fiscal'), semId, prof3, group2, 1);
  const mm4 = insertMm(db, master1, mod('MOD-4', 'Penal'), semId, prof4, group1, 3);
  return {
    yearId, semId, master1, master2, group1, group2,
    prof1, prof2, prof3, prof4, room1, room2, room3,
    mm1, mm2, mm3, mm4,
  };
}

function addSession(
  db: DatabaseSync,
  mmId: number,
  profId: number,
  roomId: number,
  date: string,
  start: number,
  end: number,
  status: SessionStatus = 'PREVUE',
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      mmId,
      profId,
      roomId,
      date,
      start,
      end,
      status,
    ).lastInsertRowid,
  );
}

function baseParams(f: Fixture, over: Partial<GenerateParams> = {}): GenerateParams {
  return {
    semester_id: f.semId,
    mode: 'COMPLETE',
    date_start: SEM_START,
    date_end: SEM_END,
    pause_min: 0,
    seed: 7,
    ...over,
  };
}

function weekday(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function sessionCount(db: DatabaseSync): number {
  return get<{ c: number }>(db, 'SELECT count(*) AS c FROM session')!.c;
}

function auditRows(db: DatabaseSync): { action: string; entity: string }[] {
  return all<{ action: string; entity: string }>(
    db,
    'SELECT action, entity FROM audit_log ORDER BY id',
  );
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

describe('generate — COMPLETE', () => {
  it('ne place que le manquant (BR-12 : planned − non-ANNULEE)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // mm1 : planned 4, 2 séances existantes → exactement 2 à placer.
    addSession(db, f.mm1, f.prof1, f.room1, '2026-09-21', 480, 600);
    addSession(db, f.mm1, f.prof1, f.room1, '2026-09-21', 600, 720);
    const res = generate(db, uid(db), baseParams(f), TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const forMm1 = res.data.placed.filter(
      (p) => p.master_module_id === f.mm1,
    );
    expect(forMm1).toHaveLength(2);
    // mm2 : planned 2, rien → 2 placées.
    expect(
      res.data.placed.filter((p) => p.master_module_id === f.mm2),
    ).toHaveLength(2);
    // mm4 : planned 3, 3 séances insérées ci-dessous → 0.
    // (pas de séance mm4 ici : missing = 3 − 0 = 3 si non ciblé — voir test REGEN)
    // Preview : aucune séance écrite (BR-14).
    expect(sessionCount(db)).toBe(2);
    const gen = get<{ status: string; placed_count: number }>(
      db,
      'SELECT status, placed_count FROM schedule_generation WHERE id = ?',
      res.data.generation_id,
    )!;
    expect(gen.status).toBe('PREVIEW');
    expect(gen.placed_count).toBe(res.data.placed.length);
    expect(res.data.summary.placed).toBe(res.data.placed.length);
  });

  it('BR-7/BR-8 : jamais de chevauchement, INDISPO, absence, exception ni hors time_slot', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f.mm1, f.prof1, f.room1, '2026-09-21', 480, 600);
    addSession(db, f.mm1, f.prof1, f.room1, '2026-09-21', 600, 720);
    const res = generate(db, uid(db), baseParams(f), TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const p of res.data.placed) {
      // Fenêtre + jours ouvrés (time_slot 0-5) + hors exception.
      expect(p.date >= SEM_START && p.date <= SEM_END).toBe(true);
      expect(weekday(p.date)).toBeLessThanOrEqual(5);
      expect(p.date).not.toBe(FERIE);
      expect(p.start_min).toBeGreaterThanOrEqual(SLOT_START);
      expect(p.end_min).toBeLessThanOrEqual(SLOT_END);
      if (p.master_module_id === f.mm1) {
        // P1 : DISPO lun–ven → jamais samedi ; absence 2026-09-29.
        expect(weekday(p.date)).toBeLessThanOrEqual(4);
        expect(p.date).not.toBe(ABSENCE);
      }
      if (p.master_module_id === f.mm2) {
        // P2 : INDISPO mardi ; G2 (100) → seule Amphi C (cap 300).
        expect(weekday(p.date)).not.toBe(1);
        expect(p.room_id).toBe(f.room3);
        // EXTERNAL : jamais sur le blocage Licence mardi 08–12.
        if (weekday(p.date) === 1) {
          expect(p.start_min >= 720 || p.end_min <= 480).toBe(true);
        }
      }
    }
    // Non-chevauchement produit entre candidates (même ressource/date).
    for (const p of res.data.placed) {
      for (const q of res.data.placed) {
        if (p === q || p.date !== q.date) continue;
        const overlap = p.start_min < q.end_min && q.start_min < p.end_min;
        if (!overlap) continue;
        expect(p.room_id).not.toBe(q.room_id);
        expect(p.professor_id).not.toBe(q.professor_id);
        expect(p.master_id).not.toBe(q.master_id);
      }
    }
  });

  it('BR-9 : petit groupe placé dans la plus petite salle adaptée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // G1 (30) : Salle A (40) minimise le gaspillage — jamais B/Amphi.
    expect(res.data.placed).toHaveLength(4);
    for (const p of res.data.placed) {
      expect(p.room_id).toBe(f.room1);
    }
  });

  it('BR-15 : mm impossible (prof sans DISPO exploitable) → unplaced motivé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm3] }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.placed).toHaveLength(0);
    expect(res.data.unplaced).toHaveLength(1);
    const u = res.data.unplaced[0];
    expect(u.master_module_id).toBe(f.mm3);
    expect(u.missing).toBe(1);
    expect(u.reasons.length).toBeGreaterThan(0);
    expect(u.reasons.join(' ')).toContain('rofesseur');
    expect(u.suggestions.length).toBeGreaterThan(0);
    expect(res.data.summary.unplaced).toBe(1);
  });

  it('params invalides → fields, rien persisté', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const bad = generate(
      db,
      uid(db),
      {
        ...baseParams(f),
        date_start: '2026-02-30',
      },
      TODAY,
    );
    expect(bad.ok).toBe(false);
    const bad2 = generate(
      db,
      uid(db),
      { ...baseParams(f), date_start: SEM_END, date_end: SEM_START },
      TODAY,
    );
    expect(bad2.ok).toBe(false);
    const bad3 = generate(
      db,
      uid(db),
      { ...baseParams(f), mode: 'X' as GenerateParams['mode'] },
      TODAY,
    );
    expect(bad3.ok).toBe(false);
    const bad4 = generate(
      db,
      uid(db),
      { ...baseParams(f), semester_id: 9999 },
      TODAY,
    );
    expect(bad4.ok).toBe(false);
    expect(all(db, 'SELECT id FROM schedule_generation')).toHaveLength(0);
  });

  it('reproductibilité : même seed → même résultat', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const p = baseParams(f, { master_module_ids: [f.mm1, f.mm2], seed: 42 });
    const r1 = generate(db, uid(db), p, TODAY);
    const r2 = generate(db, uid(db), p, TODAY);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const key = (x: {
      master_module_id: number;
      date: string;
      start_min: number;
      end_min: number;
      room_id: number;
    }): string =>
      `${x.master_module_id}|${x.date}|${x.start_min}|${x.end_min}|${x.room_id}`;
    expect(r1.data.placed.map(key)).toEqual(r2.data.placed.map(key));
  });
});

describe('generate — REGENERATE', () => {
  function regenFixture(db: DatabaseSync, f: Fixture): {
    futur: number;
    passe: number;
    realisee: number;
  } {
    // mm4 : 1 PREVUE future (remplacée), 1 PREVUE passée, 1 REALISEE.
    const futur = addSession(db, f.mm4, f.prof4, f.room1, '2026-09-24', 480, 600);
    const passe = addSession(db, f.mm4, f.prof4, f.room1, '2026-09-14', 480, 600);
    const realisee = addSession(
      db, f.mm4, f.prof4, f.room2, '2026-09-15', 480, 600, 'REALISEE',
    );
    return { futur, passe, realisee };
  }

  it('marque les PREVUE futures remplacées ; quota = planned − conservées', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const { futur } = regenFixture(db, f);
    const res = generate(
      db,
      uid(db),
      baseParams(f, {
        mode: 'REGENERATE',
        master_module_ids: [f.mm4],
      }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // conservées = 3 existantes − 1 remplacée = 2 → missing = 3 − 2 = 1.
    expect(res.data.placed).toHaveLength(1);
    expect(res.data.summary.replaced).toBe(1);
    expect(res.data.replaced_ids).toEqual([futur]);
    const p = res.data.placed[0];
    expect(p.replaces_session_id).toBe(futur);
    expect(p.replaces_label).toContain('2026-09-24');
    expect(p.date >= TODAY).toBe(true);
  });

  it('apply : remplacée → ANNULEE (motif + history), passées/REALISEE intactes', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const { futur, passe, realisee } = regenFixture(db, f);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, {
        mode: 'REGENERATE',
        master_module_ids: [f.mm4],
      }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const app = applyGeneration(db, uid(db), gen.data.generation_id, TODAY);
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    expect(app.data.inserted).toBe(1);
    expect(app.data.cancelled).toBe(1);
    const st = (id: number): string =>
      get<{ status: string }>(db, 'SELECT status FROM session WHERE id = ?', id)!
        .status;
    expect(st(futur)).toBe('ANNULEE');
    expect(st(passe)).toBe('PREVUE'); // passée : jamais touchée
    expect(st(realisee)).toBe('REALISEE');
    const h = all<{ old_status: string | null; new_status: string; reason: string | null }>(
      db,
      'SELECT old_status, new_status, reason FROM session_status_history WHERE session_id = ? ORDER BY id',
      futur,
    );
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('PREVUE');
    expect(h[0].new_status).toBe('ANNULEE');
    expect(h[0].reason).toContain('génération');
    // Nouvelle séance : PREVUE + history NULL→PREVUE + generation_id.
    const inserted = get<{
      status: string;
      generation_id: number | null;
      master_module_id: number;
    }>(
      db,
      `SELECT status, generation_id, master_module_id FROM session
        WHERE generation_id = ? AND status = 'PREVUE'`,
      gen.data.generation_id,
    )!;
    expect(inserted.master_module_id).toBe(f.mm4);
    expect(inserted.generation_id).toBe(gen.data.generation_id);
    const hNew = all<{ old_status: string | null; new_status: string }>(
      db,
      `SELECT h.old_status, h.new_status FROM session_status_history h
        JOIN session s ON s.id = h.session_id
       WHERE s.generation_id = ?`,
      gen.data.generation_id,
    );
    expect(hNew).toHaveLength(1);
    expect(hNew[0].old_status).toBeNull();
    expect(hNew[0].new_status).toBe('PREVUE');
    // session_group = groupe du mm (G1).
    expect(
      all<{ student_group_id: number }>(
        db,
        `SELECT sg.student_group_id FROM session_group sg
          JOIN session s ON s.id = sg.session_id
         WHERE s.generation_id = ?`,
        gen.data.generation_id,
      ).map((r) => r.student_group_id),
    ).toEqual([f.group1]);
  });
});

describe('applyGeneration', () => {
  it('succès : séances insérées, 0 conflit détecté ensuite (BR-7 bout en bout)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1, f.mm2] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const before = sessionCount(db);
    const app = applyGeneration(db, uid(db), gen.data.generation_id, TODAY);
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    expect(app.data.inserted).toBe(6);
    expect(app.data.cancelled).toBe(0);
    expect(sessionCount(db)).toBe(before + 6);
    const conflicts = detectConflicts(db);
    expect(conflicts.ok).toBe(true);
    if (conflicts.ok) expect(conflicts.data).toHaveLength(0);
    const st = get<{ status: string }>(
      db,
      'SELECT status FROM schedule_generation WHERE id = ?',
      gen.data.generation_id,
    )!;
    expect(st.status).toBe('APPLIED');
  });

  it('idempotent : APPLIED/ABANDONED → refus sans écriture', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const id = gen.data.generation_id;
    expect(applyGeneration(db, uid(db), id, TODAY).ok).toBe(true);
    const count = sessionCount(db);
    const again = applyGeneration(db, uid(db), id, TODAY);
    expect(again.ok).toBe(false);
    expect(sessionCount(db)).toBe(count);
    // Abandon d'une génération déjà appliquée → refus aussi.
    expect(abandonGeneration(db, uid(db), id).ok).toBe(false);
  });

  it('conflit apparu après la preview → refus détaillé, atomicité (0 écriture)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const p = gen.data.placed[0];
    // Le monde change : une séance concurrente occupe la même salle.
    addSession(db, f.mm2, f.prof2, p.room_id, p.date, p.start_min, p.end_min);
    const before = sessionCount(db);
    const app = applyGeneration(db, uid(db), gen.data.generation_id, TODAY);
    expect(app.ok).toBe(false);
    if (app.ok) return;
    expect(app.conflicts && app.conflicts.length > 0).toBe(true);
    expect(app.conflicts!.some((c) => c.kind === 'ROOM')).toBe(true);
    // Atomicité : rien d'écrit, preview toujours PREVIEW.
    expect(sessionCount(db)).toBe(before);
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM schedule_generation WHERE id = ?',
        gen.data.generation_id,
      )!.status,
    ).toBe('PREVIEW');
    expect(
      all(
        db,
        `SELECT h.id FROM session_status_history h
          JOIN session s ON s.id = h.session_id
         WHERE s.generation_id = ?`,
        gen.data.generation_id,
      ),
    ).toHaveLength(0);
  });

  it('audit GENERATE (CREATE) + APPLY (UPDATE) tracés', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const gen = generate(db, u, baseParams(f, { master_module_ids: [f.mm1] }), TODAY);
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const app = applyGeneration(db, u, gen.data.generation_id, TODAY);
    expect(app.ok).toBe(true);
    const audit = auditRows(db);
    const genAudit = audit.filter((a) => a.entity === 'schedule_generation');
    expect(genAudit.map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);
  });
});

describe('lecture / abandon', () => {
  it('list + get restituent params et résultat ; abandon → ABANDONED', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm3] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const list = listGenerations(db);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data).toHaveLength(1);
    expect(list.data[0].mode).toBe('COMPLETE');
    expect(list.data[0].status).toBe('PREVIEW');
    expect(list.data[0].unplaced_count).toBe(1);
    const detail = getGeneration(db, gen.data.generation_id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.params?.seed).toBe(7);
    expect(detail.data.result?.unplaced).toHaveLength(1);
    const ab = abandonGeneration(db, uid(db), gen.data.generation_id);
    expect(ab.ok).toBe(true);
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM schedule_generation WHERE id = ?',
        gen.data.generation_id,
      )!.status,
    ).toBe('ABANDONED');
    // Abandonnée → apply refusé.
    expect(applyGeneration(db, uid(db), gen.data.generation_id, TODAY).ok).toBe(false);
  });

  it('catalog : mm éligibles du semestre + fenêtre sched globale', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = generationCatalog(db, f.semId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.modules.map((m) => m.id).sort()).toEqual(
      [f.mm1, f.mm2, f.mm3, f.mm4].sort(),
    );
    expect(res.data.sched_start).toBe(SEM_START);
    expect(res.data.sched_end).toBe(SEM_END);
    expect(generationCatalog(db, 9999).ok).toBe(false);
  });
});

describe('revue — patches exigés', () => {
  it('EXTERNAL non vacuus : seule la salle bloquée est compatible', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // mm factice : prof sans contrainte + G2 (100) → seule Amphi C (300)
    // convient — bloquée mardi 08–12 par une occupation Licence.
    const modId = Number(
      run(db, "INSERT INTO module (code, name) VALUES ('MOD-EXT', 'Ext')")
        .lastInsertRowid,
    );
    const mmExt = insertMm(db, f.master2, modId, f.semId, f.prof4, f.group2, 3);
    // Fenêtre réduite au seul mardi bloqué : sans le blocage Licence, les
    // séances démarreraient à 08h00 — la contrainte mord forcément.
    const res = generate(
      db,
      uid(db),
      baseParams(f, {
        master_module_ids: [mmExt],
        date_start: '2026-09-22',
        date_end: '2026-09-22',
      }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.placed).toHaveLength(3);
    for (const p of res.data.placed) {
      expect(p.room_id).toBe(f.room3);
      expect(p.date).toBe('2026-09-22');
      expect(p.start_min).toBeGreaterThanOrEqual(720); // jamais sur 08–12
    }
  });

  it('REGENERATE bornée à la fenêtre : PREVUE future hors fenêtre conservée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // mm4 planned 3 : 1 PREVUE passée, 1 PREVUE future dans la fenêtre
    // (date_end = 2026-09-25), 1 PREVUE future HORS fenêtre (09-30 ≤
    // sched_end mais > date_end) → conservée, pas annulée.
    const passe = addSession(db, f.mm4, f.prof4, f.room1, '2026-09-14', 480, 600);
    const inWindow = addSession(db, f.mm4, f.prof4, f.room1, '2026-09-24', 480, 600);
    const outWindow = addSession(db, f.mm4, f.prof4, f.room1, '2026-09-30', 480, 600);
    const res = generate(
      db,
      uid(db),
      baseParams(f, {
        mode: 'REGENERATE',
        master_module_ids: [f.mm4],
        date_end: '2026-09-25',
      }),
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replaced_ids).toEqual([inWindow]);
    expect(res.data.replaced).toHaveLength(1);
    expect(res.data.replaced![0].session_id).toBe(inWindow);
    // conservées = 3 − 1 = 2 → missing = 1, appariée à la remplacée.
    expect(res.data.placed).toHaveLength(1);
    expect(res.data.replaced![0].replaced_by_index).toBe(0);
    const app = applyGeneration(db, uid(db), res.data.generation_id, TODAY);
    expect(app.ok).toBe(true);
    const st = (id: number): string =>
      get<{ status: string }>(db, 'SELECT status FROM session WHERE id = ?', id)!
        .status;
    expect(st(inWindow)).toBe('ANNULEE');
    expect(st(outWindow)).toBe('PREVUE'); // hors fenêtre : jamais touchée
    expect(st(passe)).toBe('PREVUE');
  });

  it('COMPLETE : début passé clampé à today (warning + jamais de proposition passée)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      '2026-09-25', // today au milieu de la fenêtre
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings.some((w) => w.includes('amputée'))).toBe(true);
    expect(res.data.placed.length).toBeGreaterThan(0);
    for (const p of res.data.placed) {
      expect(p.date >= '2026-09-25').toBe(true);
    }
  });

  it('seed non-entier → erreur de champ, rien persisté', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const bad = generate(
      db,
      uid(db),
      { ...baseParams(f), seed: 1.5 },
      TODAY,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.fields?.some((e) => e.field === 'seed')).toBe(true);
    const bad2 = generate(
      db,
      uid(db),
      { ...baseParams(f), seed: 'abc' as unknown as number },
      TODAY,
    );
    expect(bad2.ok).toBe(false);
    expect(all(db, 'SELECT id FROM schedule_generation')).toHaveLength(0);
  });

  it('apply : INDISPO / exception / is_active apparus depuis la preview → refus, rien écrit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const genId = gen.data.generation_id;
    const p0 = gen.data.placed[0];
    const sessionsBefore = sessionCount(db);
    const isPreview = (): string =>
      get<{ status: string }>(
        db,
        'SELECT status FROM schedule_generation WHERE id = ?',
        genId,
      )!.status;
    // a) salle désactivée → refus.
    run(db, 'UPDATE room SET is_active = 0 WHERE id = ?', p0.room_id);
    let app = applyGeneration(db, uid(db), genId, TODAY);
    expect(app.ok).toBe(false);
    run(db, 'UPDATE room SET is_active = 1 WHERE id = ?', p0.room_id);
    // b) exception calendaire apparue sur la date d'une proposition.
    const exId = Number(
      run(
        db,
        `INSERT INTO calendar_exception (start_date, end_date, type, label)
         VALUES (?, ?, 'FERMETURE', 'Fermeture imprévue')`,
        p0.date,
        p0.date,
      ).lastInsertRowid,
    );
    app = applyGeneration(db, uid(db), genId, TODAY);
    expect(app.ok).toBe(false);
    if (!app.ok) expect(app.error).toContain('exception');
    run(db, 'DELETE FROM calendar_exception WHERE id = ?', exId);
    // c) INDISPO effective apparue pour le prof sur le créneau proposé.
    const avId = Number(
      run(
        db,
        `INSERT INTO professor_availability
           (professor_id, weekday, start_min, end_min, kind)
         VALUES (?, ?, ?, ?, 'INDISPO')`,
        p0.professor_id,
        weekday(p0.date),
        p0.start_min,
        p0.end_min,
      ).lastInsertRowid,
    );
    app = applyGeneration(db, uid(db), genId, TODAY);
    expect(app.ok).toBe(false);
    if (!app.ok) expect(app.error).toContain('rofesseur');
    run(db, 'DELETE FROM professor_availability WHERE id = ?', avId);
    // d) professeur désactivé → refus.
    run(db, 'UPDATE professor SET is_active = 0 WHERE id = ?', p0.professor_id);
    app = applyGeneration(db, uid(db), genId, TODAY);
    expect(app.ok).toBe(false);
    run(db, 'UPDATE professor SET is_active = 1 WHERE id = ?', p0.professor_id);
    // Atomicité tout du long : aucune séance écrite, preview intacte.
    expect(sessionCount(db)).toBe(sessionsBefore);
    expect(isPreview()).toBe('PREVIEW');
    // Monde restauré → l'application réussit.
    app = applyGeneration(db, uid(db), genId, TODAY);
    expect(app.ok).toBe(true);
  });

  it('apply : proposition date < today → refus', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const before = sessionCount(db);
    // Le monde avance : toutes les propositions sont désormais passées.
    const app = applyGeneration(
      db,
      uid(db),
      gen.data.generation_id,
      '2026-10-05',
    );
    expect(app.ok).toBe(false);
    if (!app.ok) expect(app.error).toContain('passée');
    expect(sessionCount(db)).toBe(before);
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM schedule_generation WHERE id = ?',
        gen.data.generation_id,
      )!.status,
    ).toBe('PREVIEW');
  });

  it('apply : payload malformé → refus explicite', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gen = generate(
      db,
      uid(db),
      baseParams(f, { master_module_ids: [f.mm1] }),
      TODAY,
    );
    expect(gen.ok).toBe(true);
    if (!gen.ok) return;
    const genId = gen.data.generation_id;
    const orig = get<{ result_json: string }>(
      db,
      'SELECT result_json FROM schedule_generation WHERE id = ?',
      genId,
    )!.result_json;
    const setResult = (json: string): void => {
      run(
        db,
        'UPDATE schedule_generation SET result_json = ? WHERE id = ?',
        json,
        genId,
      );
    };
    const before = sessionCount(db);
    // a) JSON illisible.
    setResult('{oops');
    expect(applyGeneration(db, uid(db), genId, TODAY).ok).toBe(false);
    // b) proposition avec room_id non numérique.
    const shape = {
      placed: [
        {
          master_module_id: f.mm1,
          master_id: f.master1,
          professor_id: f.prof1,
          room_id: 'abc',
          group_id: f.group1,
          date: '2026-09-25',
          start_min: 480,
          end_min: 600,
        },
      ],
      unplaced: [],
      warnings: [],
      summary: { placed: 1, unplaced: 0, replaced: 0, days: 1 },
      replaced_ids: [],
    };
    setResult(JSON.stringify(shape));
    expect(applyGeneration(db, uid(db), genId, TODAY).ok).toBe(false);
    // c) date non calendaire.
    shape.placed[0].room_id = f.room1 as unknown as string;
    shape.placed[0].date = '2026-02-30';
    setResult(JSON.stringify(shape));
    expect(applyGeneration(db, uid(db), genId, TODAY).ok).toBe(false);
    // d) horaire inversé.
    shape.placed[0].date = '2026-09-25';
    shape.placed[0].start_min = 600;
    shape.placed[0].end_min = 480;
    setResult(JSON.stringify(shape));
    expect(applyGeneration(db, uid(db), genId, TODAY).ok).toBe(false);
    // Rien d'écrit ; payload restauré → application OK.
    expect(sessionCount(db)).toBe(before);
    setResult(orig);
    expect(applyGeneration(db, uid(db), genId, TODAY).ok).toBe(true);
  });
});

describe('acceptation seed RÉEL FSJP', () => {
  it('COMPLETE sur S3 : unplaced vide, aucun doublon écrit', () => {
    const db = freshDb();
    seedReal(db);
    const sem3 = get<{ id: number }>(
      db,
      'SELECT id FROM semester WHERE ordinal = 3',
    )!;
    const before = sessionCount(db);
    expect(before).toBe(97 * 12);
    const res = generate(
      db,
      uid(db),
      {
        semester_id: sem3.id,
        mode: 'COMPLETE',
        date_start: '2026-09-21',
        date_end: '2026-12-13',
        pause_min: 0,
        seed: 1,
      },
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Tout est déjà planifié : 0 à placer, 0 non placée.
    expect(res.data.placed).toHaveLength(0);
    expect(res.data.unplaced).toHaveLength(0);
    expect(res.data.summary.placed).toBe(0);
    expect(sessionCount(db)).toBe(before);
  });

  it('mm factice à volume connu sur données réelles → séances conformes', () => {
    const db = freshDb();
    seedReal(db);
    const sem3 = get<{ id: number }>(
      db,
      'SELECT id FROM semester WHERE ordinal = 3',
    )!;
    const master = get<{ id: number }>(
      db,
      'SELECT id FROM master ORDER BY id LIMIT 1',
    )!;
    const modId = Number(
      run(db, "INSERT INTO module (code, name) VALUES ('MOD-X', 'Module X')")
        .lastInsertRowid,
    );
    const profId = Number(
      run(db, "INSERT INTO professor (full_name) VALUES ('Prof Test X')")
        .lastInsertRowid,
    );
    const mmId = Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id,
            student_group_id, volume_min, session_duration_min,
            planned_sessions, sched_start, sched_end)
         VALUES (?, ?, ?, ?, NULL, 360, 120, 3, '2026-09-21', '2026-12-13')`,
        master.id,
        modId,
        sem3.id,
        profId,
      ).lastInsertRowid,
    );
    const conflictsBefore = detectConflicts(db);
    expect(conflictsBefore.ok).toBe(true);
    if (!conflictsBefore.ok) return;
    const res = generate(
      db,
      uid(db),
      {
        semester_id: sem3.id,
        master_module_ids: [mmId],
        mode: 'COMPLETE',
        date_start: '2026-09-21',
        date_end: '2026-12-13',
        pause_min: 0,
        seed: 3,
      },
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.placed).toHaveLength(3);
    expect(res.data.unplaced).toHaveLength(0);
    for (const p of res.data.placed) {
      expect(p.date >= '2026-09-21' && p.date <= '2026-12-13').toBe(true);
      expect(weekday(p.date)).toBeLessThanOrEqual(5);
    }
    // Application réelle : aucun conflit supplémentaire produit.
    const app = applyGeneration(db, uid(db), res.data.generation_id, TODAY);
    expect(app.ok).toBe(true);
    if (!app.ok) return;
    expect(app.data.inserted).toBe(3);
    const conflictsAfter = detectConflicts(db);
    expect(conflictsAfter.ok).toBe(true);
    if (conflictsAfter.ok) {
      expect(conflictsAfter.data).toHaveLength(conflictsBefore.data.length);
    }
  });
});
