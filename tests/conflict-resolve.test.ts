/**
 * Tests P16 — résolution assistée des conflits de salle
 * (`conflict-resolve.service.ts`) :
 * - preview : une seule séance bouge par collision, salle libre au même
 *   créneau, capacité la plus proche de l'effectif (BR-9), choix
 *   déterministe, propositions EN SÉQUENCE (une salle attribuée/libérée
 *   est prise en compte par les suivantes) ;
 * - EXTERNAL : la séance Master sort de la salle bloquée Licence ;
 * - `skipped` quand aucune salle compatible ;
 * - apply : transaction + re-vérification `checkSessionPlacement`
 *   (kinds ROOM+EXTERNAL) + UPDATE + audit explicite + motif en
 *   historique ; monde changé depuis la preview → recalculé.
 * Base `:memory:` + migrations, fixtures directes SQL (les insertions
 * conflictuelles contournent volontairement la garde BR-10).
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
import {
  checkSessionPlacement,
  detectConflicts,
} from '../electron/main/db/conflict.service';
import {
  applyReassignment,
  previewReassignment,
} from '../electron/main/db/conflict-resolve.service';
import type { SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const TUE = '2026-10-13'; // mardi → weekday 1 (AD-7, 0=lun)

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return db;
}

interface Fixture {
  yearId: number;
  mmId: number; // master M1 / module MOD-T / prof P1 / groupe G1 (50)
  mm2Id: number; // master M2 / module MOD-U / prof P2 / sans groupe
  masterId: number;
  master2Id: number;
  profId: number;
  prof2Id: number;
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
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T', 'Master T', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const master2Id = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-U', 'Master U', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const groupId = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G1', 50)",
      masterId,
    ).lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Un')")
      .lastInsertRowid,
  );
  const prof2Id = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Deux')")
      .lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')")
      .lastInsertRowid,
  );
  const mod2Id = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-U', 'Module U')")
      .lastInsertRowid,
  );
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, ?, 1200, 120, 10, '2026-09-01', '2027-01-31')`,
      masterId,
      modId,
      semId,
      profId,
      groupId,
    ).lastInsertRowid,
  );
  const mm2Id = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, 1200, 120, 10, '2026-09-01', '2027-01-31')`,
      master2Id,
      mod2Id,
      semId,
      prof2Id,
    ).lastInsertRowid,
  );
  return { yearId, mmId, mm2Id, masterId, master2Id, profId, prof2Id };
}

function addRoom(
  db: DatabaseSync,
  name: string,
  capacity: number | null = null,
): number {
  return Number(
    run(db, 'INSERT INTO room (name, capacity) VALUES (?, ?)', name, capacity)
      .lastInsertRowid,
  );
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: {
    mmId?: number;
    profId?: number;
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
      opts.mmId ?? f.mmId,
      opts.profId ?? f.profId,
      opts.roomId,
      opts.date ?? TUE,
      opts.start ?? 480,
      opts.end ?? 600,
      opts.status ?? 'PREVUE',
    ).lastInsertRowid,
  );
}

interface AuditRowLite {
  action: string;
  entity: string;
  entity_id: number;
  old_values: string | null;
  new_values: string | null;
}

function auditRows(db: DatabaseSync): AuditRowLite[] {
  return all<AuditRowLite>(
    db,
    'SELECT action, entity, entity_id, old_values, new_values FROM audit_log ORDER BY id',
  );
}

function uid(db: DatabaseSync): number {
  return get<{ id: number }>(
    db,
    "SELECT id FROM app_user WHERE role = 'ADMIN' ORDER BY id LIMIT 1",
  )!.id;
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

describe('previewReassignment', () => {
  it('collision 2 séances 1 salle → une seule bouge, capacité la plus proche', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 40);
    addRoom(db, 'Salle B', 60); // 60 ≥ 50 (G1) — plus proche que 90
    addRoom(db, 'Salle C', 90);
    const s1 = addSession(db, f, { roomId: roomA, start: 480, end: 600 });
    const s2 = addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // La séance au début le plus tôt (s1) part ; s2 reste en place.
    expect(res.data.proposals).toHaveLength(1);
    const p = res.data.proposals[0];
    expect(p.session_id).toBe(s1);
    expect(p.old_room).toBe('Salle A');
    expect(p.new_room).toBe('Salle B');
    expect(p.kinds).toEqual(['ROOM']);
    expect(p.date).toBe(TUE);
    expect(res.data.skipped).toHaveLength(0);
    expect(res.data.proposals.some((x) => x.session_id === s2)).toBe(false);
  });

  it('collision Licence → la séance Master sort de la salle occupée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 40);
    addRoom(db, 'Salle B', 60);
    run(
      db,
      `INSERT INTO external_occupancy
         (program, groupe, room_id, weekday, start_min, end_min,
          academic_year_id)
       VALUES ('Licence S1', 'unique', ?, 1, 480, 700, ?)`,
      roomA,
      f.yearId,
    );
    const s1 = addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.proposals).toHaveLength(1);
    expect(res.data.proposals[0].session_id).toBe(s1);
    expect(res.data.proposals[0].new_room).toBe('Salle B');
    expect(res.data.proposals[0].kinds).toEqual(['EXTERNAL']);
  });

  it('pas de salle compatible (toutes occupées) → skipped avec raison', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 60);
    const roomB = addRoom(db, 'Salle B', 60);
    // B occupée tout le créneau par une séance sans rapport.
    addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomB,
      start: 480,
      end: 720,
    });
    addSession(db, f, { roomId: roomA, start: 480, end: 600 });
    addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.proposals).toHaveLength(0);
    expect(res.data.skipped).toHaveLength(2);
    for (const s of res.data.skipped) {
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it('séquence : 3 séances, 2 salles libres → aucune proposition ne crée de conflit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 60);
    const roomB = addRoom(db, 'Salle B', 60);
    const roomC = addRoom(db, 'Salle C', 60);
    // mm2 = sans groupe → pas de contrainte capacité.
    const s1 = addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomA,
    });
    const s2 = addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomA,
    });
    const s3 = addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomA,
    });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // s1 → B, s2 → C ; s3 reste seule dans A (conflit résorbé).
    expect(res.data.proposals).toHaveLength(2);
    expect(res.data.proposals.map((p) => p.session_id)).toEqual([s1, s2]);
    // Applique les propositions en séquence : chaque salle cible doit
    // passer la garde réelle (kinds ROOM + EXTERNAL).
    for (const p of res.data.proposals) {
      const cur = get<{ professor_id: number; master_id: number }>(
        db,
        `SELECT s.professor_id, mm.master_id
           FROM session s JOIN master_module mm ON mm.id = s.master_module_id
          WHERE s.id = ?`,
        p.session_id,
      )!;
      run(
        db,
        'UPDATE session SET room_id = ? WHERE id = ?',
        p.new_room_id,
        p.session_id,
      );
      const check = checkSessionPlacement(db, {
        date: p.date,
        startMin: p.start_min,
        endMin: p.end_min,
        roomId: p.new_room_id,
        professorId: cur.professor_id,
        masterId: cur.master_id,
        excludeSessionId: p.session_id,
        kinds: ['ROOM', 'EXTERNAL'],
      });
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.data).toHaveLength(0);
    }
    const after = detectConflicts(db);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.data.filter((c) => c.kind === 'ROOM')).toHaveLength(0);
    }
    expect(roomB).toBeGreaterThan(0);
    expect(roomC).toBeGreaterThan(0);
    expect(s3).toBeGreaterThan(0);
  });

  it('capacité : salle trop petite écartée quand l’effectif est connu', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 40);
    addRoom(db, 'Salle B', 30); // < 50 (G1) → écartée
    addRoom(db, 'Salle C', 60);
    addSession(db, f, { roomId: roomA, start: 480, end: 600 });
    addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.proposals).toHaveLength(1);
    expect(res.data.proposals[0].new_room).toBe('Salle C');
  });

  it('capacité : effectif inconnu → la plus petite salle libre est choisie', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 60);
    addRoom(db, 'Salle B', 30); // plus petite — gagne faute d'effectif connu
    addRoom(db, 'Salle C', 90);
    // mm2 sans groupe → effectif inconnu → pas de contrainte capacité.
    addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomA,
      start: 480,
      end: 600,
    });
    addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomA,
      start: 540,
      end: 660,
    });
    const res = previewReassignment(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.proposals).toHaveLength(1);
    expect(res.data.proposals[0].new_room).toBe('Salle B');
  });
});

describe('applyReassignment', () => {
  it('UPDATE salle + audit explicite + motif en historique', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 60);
    const roomB = addRoom(db, 'Salle B', 60);
    const s1 = addSession(db, f, { roomId: roomA, start: 480, end: 600 });
    addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const res = applyReassignment(db, uid(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.moved).toBe(1);
    expect(res.data.skipped).toHaveLength(0);
    // La séance déplacée pointe vers la salle B.
    const moved = get<{ room_id: number }>(
      db,
      'SELECT room_id FROM session WHERE id = ?',
      s1,
    )!;
    expect(moved.room_id).toBe(roomB);
    // Audit explicite : UPDATE session, old/new room_id.
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('UPDATE');
    expect(audit[0].entity).toBe('session');
    expect(audit[0].entity_id).toBe(s1);
    expect(JSON.parse(audit[0].old_values!).room_id).toBe(roomA);
    expect(JSON.parse(audit[0].new_values!).room_id).toBe(roomB);
    // Historique : statut inchangé + motif de résolution.
    const hist = get<{ old_status: string; new_status: string; reason: string }>(
      db,
      `SELECT old_status, new_status, reason
         FROM session_status_history WHERE session_id = ?`,
      s1,
    )!;
    expect(hist.old_status).toBe('PREVUE');
    expect(hist.new_status).toBe('PREVUE');
    expect(hist.reason).toBe('Réaffectation salle — résolution de conflit');
    // Plus aucun conflit ROOM.
    const after = detectConflicts(db);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.data.filter((c) => c.kind === 'ROOM')).toHaveLength(0);
    }
  });

  it('monde changé depuis la preview → recalculé, skipped sans écriture', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const roomA = addRoom(db, 'Salle A', 60);
    const roomB = addRoom(db, 'Salle B', 60);
    const s1 = addSession(db, f, { roomId: roomA, start: 480, end: 600 });
    addSession(db, f, { roomId: roomA, start: 540, end: 660 });
    const before = previewReassignment(db);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.data.proposals).toHaveLength(1);
    // Séance concurrente insérée dans la salle cible entre preview et apply.
    addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: roomB,
      start: 480,
      end: 600,
    });
    const res = applyReassignment(db, uid(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // La cible n'est plus libre : rien d'écrit, les deux séances skipped.
    expect(res.data.moved).toBe(0);
    expect(res.data.skipped.length).toBeGreaterThanOrEqual(1);
    const still = get<{ room_id: number }>(
      db,
      'SELECT room_id FROM session WHERE id = ?',
      s1,
    )!;
    expect(still.room_id).toBe(roomA);
    expect(auditRows(db)).toHaveLength(0);
  });
});
