/**
 * Tests P7b — édition des séances : garde d'écriture `checkSessionPlacement`
 * (BR-10, les 5 kinds sur un candidat unique), mutations `session-edit`
 * (create/move/changeSessionStatus/setSessionGroups/delete) avec audit AD-6
 * et historique AD-7, transitions de statut (REPORTEE = bascule sur le
 * nouveau créneau, REALISEE verrouillée sauf correction) — base `:memory:`.
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
import { checkSessionPlacement } from '../electron/main/db/conflict.service';
import {
  changeSessionStatus,
  createSession,
  deleteSession,
  moveSession,
  setSessionGroups,
} from '../electron/main/db/session-edit.service';
import type { SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const MON = '2026-10-12';
const TUE = '2026-10-13';
const SAT = '2026-10-17';

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
  semId: number;
  masterId: number;
  master2Id: number;
  groupId: number;
  group2Id: number;
  groupOtherId: number; // groupe du master 2 (refus cross-master)
  profId: number;
  prof2Id: number;
  modId: number;
  mod2Id: number;
  roomId: number;
  room2Id: number;
  mmId: number;
  mm2Id: number;
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
      "INSERT INTO student_group (master_id, name) VALUES (?, 'G1')",
      masterId,
    ).lastInsertRowid,
  );
  const group2Id = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')",
      masterId,
    ).lastInsertRowid,
  );
  const groupOtherId = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name) VALUES (?, 'GU')",
      master2Id,
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
  const roomId = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)")
      .lastInsertRowid,
  );
  const room2Id = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle B', 80)")
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
  return {
    yearId, semId, masterId, master2Id, groupId, group2Id, groupOtherId,
    profId, prof2Id, modId, mod2Id, roomId, room2Id, mmId, mm2Id,
  };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: {
    mmId?: number;
    profId?: number;
    roomId?: number;
    date: string;
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
      opts.roomId ?? f.roomId,
      opts.date,
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
  user_id: number | null;
}

function auditRows(db: DatabaseSync): AuditRowLite[] {
  return all<AuditRowLite>(
    db,
    'SELECT action, entity, entity_id, old_values, new_values, user_id FROM audit_log ORDER BY id',
  );
}

interface HistoryRowLite {
  old_status: string | null;
  new_status: string;
  reason: string | null;
  old_date: string | null;
  new_date: string | null;
  old_start_min: number | null;
  new_start_min: number | null;
}

function historyRows(
  db: DatabaseSync,
  sessionId: number,
): HistoryRowLite[] {
  return all<HistoryRowLite>(
    db,
    `SELECT old_status, new_status, reason,
            old_date, new_date, old_start_min, new_start_min
       FROM session_status_history WHERE session_id = ? ORDER BY id`,
    sessionId,
  );
}

/** uid du profil courant (Administrateur seedé) — FK audit/history. */
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

describe('checkSessionPlacement', () => {
  it('détecte ROOM, PROFESSOR et MASTER sur un candidat unique', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    const q = {
      date: TUE, startMin: 540, endMin: 660,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
      groupIds: [f.groupId],
    };
    const res = checkSessionPlacement(db, q);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const kinds = res.data.map((c) => c.kind).sort();
    // ROOM (salle A) + PROFESSOR (Prof Un) + MASTER (M-T) + GROUP (G1 via mm).
    expect(kinds).toEqual(['GROUP', 'MASTER', 'PROFESSOR', 'ROOM']);
    const room = res.data.find((c) => c.kind === 'ROOM')!;
    expect(room.entityLabel).toBe('Salle A');
    expect(room.startMin).toBe(540);
    expect(room.endMin).toBe(600);
    expect(room.sessions).toHaveLength(1);
  });

  it('excludeSessionId : déplacer une séance sur son propre créneau est libre', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: TUE, start: 480, end: 600 });
    const res = checkSessionPlacement(db, {
      date: TUE, startMin: 480, endMin: 600,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
      excludeSessionId: sid, groupIds: [f.groupId],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(0);
  });

  it('adjacence non-conflit (fin = début) et ANNULEE ignorée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 }); // adjacent
    addSession(db, f, {
      date: TUE, start: 600, end: 720, status: 'ANNULEE',
      mmId: f.mm2Id, profId: f.prof2Id,
    });
    const res = checkSessionPlacement(db, {
      date: TUE, startMin: 600, endMin: 720,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(0);
  });

  it('EXTERNAL : weekday(date) ↔ blocage Licence, année compatible', () => {
    const db = freshDb();
    const f = seedFixture(db);
    run(
      db,
      `INSERT INTO external_occupancy
         (program, groupe, room_id, weekday, start_min, end_min,
          academic_year_id)
       VALUES ('Licence S1', 'unique', ?, 1, 480, 700, ?)`,
      f.roomId,
      f.yearId,
    );
    // TUE = mardi (weekday 1) → conflit externe.
    const res = checkSessionPlacement(db, {
      date: TUE, startMin: 600, endMin: 720,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.data[0].kind).toBe('EXTERNAL');
    expect(res.data[0].entityLabel).toContain('Licence');
    expect(res.data[0].sessions).toHaveLength(0);
    // MON = lundi (weekday 0) → pas de blocage.
    const free = checkSessionPlacement(db, {
      date: MON, startMin: 600, endMin: 720,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
    });
    expect(free.ok).toBe(true);
    if (free.ok) expect(free.data).toHaveLength(0);
  });

  it('GROUP : chemins croisés mm.student_group_id ↔ session_group', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Adverse : séance de G1 via son mm (mmId a student_group_id = G1).
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    // Candidat sans groupe → pas de conflit GROUP.
    const none = checkSessionPlacement(db, {
      date: TUE, startMin: 540, endMin: 660,
      roomId: f.room2Id, professorId: f.prof2Id, masterId: f.master2Id,
      groupIds: [],
    });
    expect(none.ok).toBe(true);
    if (none.ok) {
      expect(none.data.filter((c) => c.kind === 'GROUP')).toHaveLength(0);
    }
    // Candidat rattaché à G1 via session_group → conflit croisé.
    const res = checkSessionPlacement(db, {
      date: TUE, startMin: 540, endMin: 660,
      roomId: f.room2Id, professorId: f.prof2Id, masterId: f.master2Id,
      groupIds: [f.groupId],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const groups = res.data.filter((c) => c.kind === 'GROUP');
    expect(groups).toHaveLength(1);
    expect(groups[0].entityLabel).toBe('G1 (Master T)');
  });

  it('payload invalide : date non calendaire / bornes / refs → erreur', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const base = {
      date: TUE, startMin: 480, endMin: 600,
      roomId: f.roomId, professorId: f.profId, masterId: f.masterId,
    };
    expect(
      checkSessionPlacement(db, { ...base, date: '2026-02-30' }).ok,
    ).toBe(false);
    expect(
      checkSessionPlacement(db, { ...base, startMin: 600, endMin: 600 }).ok,
    ).toBe(false);
    expect(
      checkSessionPlacement(db, { ...base, endMin: 1441 }).ok,
    ).toBe(false);
    expect(
      checkSessionPlacement(db, { ...base, roomId: -1 }).ok,
    ).toBe(false);
    expect(
      checkSessionPlacement(db, { ...base, masterId: 9999 }).ok,
    ).toBe(false);
  });
});

describe('createSession', () => {
  it('refs invalides → erreurs de champs, rien inséré', () => {
    const db = freshDb();
    seedFixture(db);
    const res = createSession(db, uid(db), {
      master_module_id: 9999,
      room_id: -3,
      date: MON,
      start_min: 480,
      end_min: 600,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fields?.some((x) => x.field === 'master_module_id')).toBe(true);
    expect(res.fields?.some((x) => x.field === 'room_id')).toBe(true);
    expect(all(db, 'SELECT id FROM session')).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('date non calendaire (2026-02-30) et bornes horaires refusées', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const base = {
      master_module_id: f.mmId, room_id: f.roomId,
      date: MON, start_min: 480, end_min: 600,
    };
    const bad1 = createSession(db, uid(db), { ...base, date: '2026-02-30' });
    expect(bad1.ok).toBe(false);
    const bad2 = createSession(db, uid(db), {
      ...base, start_min: 600, end_min: 600,
    });
    expect(bad2.ok).toBe(false);
    const bad3 = createSession(db, uid(db), { ...base, end_min: 1441 });
    expect(bad3.ok).toBe(false);
    const bad4 = createSession(db, uid(db), { ...base, start_min: -10 });
    expect(bad4.ok).toBe(false);
    expect(all(db, 'SELECT id FROM session')).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('conflit dur → refus avec détails, 0 insertion + 0 audit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    const res = createSession(db, uid(db), {
      master_module_id: f.mm2Id,
      room_id: f.roomId,
      date: TUE,
      start_min: 540,
      end_min: 660,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
    expect(all(db, 'SELECT id FROM session')).toHaveLength(1);
    expect(all(db, 'SELECT id FROM session_status_history')).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('succès : PREVUE + prof par défaut du mm + history + session_group + audit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const res = createSession(db, u, {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 720,
      end_min: 840,
      // groupId est le groupe IMPLICITE du mm : dédup silencieuse —
      // seul group2Id doit finir dans session_group.
      group_ids: [f.groupId, f.group2Id],
      comment: 'Rattrapage',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sid = res.data.sessionId;
    const s = get<{
      status: string; professor_id: number; comment: string;
    }>(db, 'SELECT status, professor_id, comment FROM session WHERE id = ?', sid)!;
    expect(s.status).toBe('PREVUE');
    expect(s.professor_id).toBe(f.profId); // défaut = mm.professor_id
    expect(s.comment).toBe('Rattrapage');
    // Historique initiale : NULL → PREVUE.
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBeNull();
    expect(h[0].new_status).toBe('PREVUE');
    // session_group : G2 rattaché.
    expect(
      all<{ student_group_id: number }>(
        db,
        'SELECT student_group_id FROM session_group WHERE session_id = ?',
        sid,
      ).map((r) => r.student_group_id),
    ).toEqual([f.group2Id]);
    // Audit CREATE : old NULL, new = row JSON, changed_by = uid.
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('CREATE');
    expect(audit[0].entity).toBe('session');
    expect(audit[0].entity_id).toBe(sid);
    expect(audit[0].old_values).toBeNull();
    expect(JSON.parse(audit[0].new_values!).status).toBe('PREVUE');
    expect(audit[0].user_id).toBe(u);
  });

  it('groupe d’un autre master → refus', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = createSession(db, uid(db), {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 720,
      end_min: 840,
      group_ids: [f.groupOtherId],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fields?.some((x) => x.field === 'group_ids')).toBe(true);
    expect(all(db, 'SELECT id FROM session')).toHaveLength(0);
  });

  it('bornes 0/1440 acceptées (journée entière)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = createSession(db, uid(db), {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 0,
      end_min: 1440,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = get<{ start_min: number; end_min: number }>(
      db,
      'SELECT start_min, end_min FROM session WHERE id = ?',
      res.data.sessionId,
    )!;
    expect(s.start_min).toBe(0);
    expect(s.end_min).toBe(1440);
  });

  it('ressources inactives refusées (salle / professeur désactivés)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    run(db, 'UPDATE room SET is_active = 0 WHERE id = ?', f.roomId);
    run(db, 'UPDATE professor SET is_active = 0 WHERE id = ?', f.prof2Id);
    const room3 = Number(
      run(db, "INSERT INTO room (name) VALUES ('Salle C')").lastInsertRowid,
    );
    const badRoom = createSession(db, u, {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 720,
      end_min: 840,
    });
    expect(badRoom.ok).toBe(false);
    if (!badRoom.ok) {
      expect(badRoom.fields?.some((x) => x.field === 'room_id')).toBe(true);
    }
    const badProf = createSession(db, u, {
      master_module_id: f.mmId,
      professor_id: f.prof2Id,
      room_id: room3,
      date: SAT,
      start_min: 720,
      end_min: 840,
    });
    expect(badProf.ok).toBe(false);
    if (!badProf.ok) {
      expect(
        badProf.fields?.some((x) => x.field === 'professor_id'),
      ).toBe(true);
    }
    expect(all(db, 'SELECT id FROM session')).toHaveLength(0);
  });

  it('master ARCHIVE → création refusée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    run(db, "UPDATE master SET status = 'ARCHIVE' WHERE id = ?", f.masterId);
    const res = createSession(db, uid(db), {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 720,
      end_min: 840,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(
      res.fields?.some((x) => x.field === 'master_module_id'),
    ).toBe(true);
    expect(all(db, 'SELECT id FROM session')).toHaveLength(0);
  });

  it('uid GESTIONNAIRE écrit (BR-24 : pas de requireRole sur les mutations)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gest = get<{ id: number }>(
      db,
      "SELECT id FROM app_user WHERE role = 'GESTIONNAIRE' ORDER BY id LIMIT 1",
    )!.id;
    const res = createSession(db, gest, {
      master_module_id: f.mmId,
      room_id: f.roomId,
      date: SAT,
      start_min: 720,
      end_min: 840,
    });
    expect(res.ok).toBe(true);
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(gest);
  });
});

describe('moveSession', () => {
  it('conflit bloqué : 0 écriture (session, historique, audit intacts)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    const sid = addSession(db, f, {
      date: MON, start: 480, end: 600, mmId: f.mm2Id, profId: f.prof2Id,
    });
    const res = moveSession(db, uid(db), sid, {
      date: TUE, start_min: 540, end_min: 660, room_id: f.roomId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
    const s = get<{ date: string; start_min: number }>(
      db, 'SELECT date, start_min FROM session WHERE id = ?', sid,
    )!;
    expect(s.date).toBe(MON);
    expect(s.start_min).toBe(480);
    expect(historyRows(db, sid)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('succès : créneau+salle mis à jour, statut inchangé, history old→new + audit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    const res = moveSession(db, u, sid, {
      date: SAT, start_min: 720, end_min: 840, room_id: f.room2Id,
      professor_id: f.prof2Id, reason: 'Contrainte de salle',
    });
    expect(res.ok).toBe(true);
    const s = get<{
      date: string; start_min: number; end_min: number;
      room_id: number; professor_id: number; status: string;
    }>(
      db,
      `SELECT date, start_min, end_min, room_id, professor_id, status
         FROM session WHERE id = ?`,
      sid,
    )!;
    expect(s.date).toBe(SAT);
    expect(s.start_min).toBe(720);
    expect(s.end_min).toBe(840);
    expect(s.room_id).toBe(f.room2Id);
    expect(s.professor_id).toBe(f.prof2Id);
    expect(s.status).toBe('PREVUE'); // déplacement ≠ report : statut inchangé
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('PREVUE');
    expect(h[0].new_status).toBe('PREVUE');
    expect(h[0].old_date).toBe(MON);
    expect(h[0].new_date).toBe(SAT);
    expect(h[0].old_start_min).toBe(480);
    expect(h[0].new_start_min).toBe(720);
    expect(h[0].reason).toBe('Contrainte de salle');
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('UPDATE');
    expect(JSON.parse(audit[0].old_values!).date).toBe(MON);
    expect(JSON.parse(audit[0].new_values!).date).toBe(SAT);
    expect(audit[0].user_id).toBe(u);
  });

  it('changement salle seul : pas de ligne history (créneau inchangé)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON });
    const res = moveSession(db, uid(db), sid, { room_id: f.room2Id });
    expect(res.ok).toBe(true);
    expect(historyRows(db, sid)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(1);
  });

  it('séance REALISEE : déplacement refusé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON, status: 'REALISEE' });
    const res = moveSession(db, uid(db), sid, { date: TUE });
    expect(res.ok).toBe(false);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('séance REPORTEE : motif obligatoire (re-report)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON, status: 'REPORTEE' });
    const refused = moveSession(db, u, sid, { date: TUE });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fields?.some((x) => x.field === 'reason')).toBe(true);
    const ok = moveSession(db, u, sid, { date: TUE, reason: 'Re-report' });
    expect(ok.ok).toBe(true);
  });

  it('move partiel non bloqué par un conflit orthogonal ; reason historisée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    // Conflit PROFESSOR pré-existant (inséré sans garde) : s1 et s2
    // partagent le même professeur en chevauchement, salles différentes.
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    const s2 = addSession(db, f, {
      date: TUE, start: 540, end: 660, roomId: f.room2Id, mmId: f.mm2Id,
    });
    const room3 = Number(
      run(db, "INSERT INTO room (name) VALUES ('Salle C')").lastInsertRowid,
    );
    // Changer la salle seule : seuls ROOM+EXTERNAL sont re-vérifiés —
    // le conflit PROFESSOR orthogonal ne bloque plus (anti-wedging).
    const res = moveSession(db, u, s2, {
      room_id: room3,
      reason: 'Changement de salle',
    });
    expect(res.ok).toBe(true);
    expect(
      get<{ room_id: number }>(
        db, 'SELECT room_id FROM session WHERE id = ?', s2,
      )!.room_id,
    ).toBe(room3);
    // Le motif est historisé même sans changement de créneau.
    const h = historyRows(db, s2);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('PREVUE');
    expect(h[0].new_status).toBe('PREVUE');
    expect(h[0].reason).toBe('Changement de salle');
    expect(h[0].old_date).toBe(TUE);
    expect(h[0].new_date).toBe(TUE);
    // En revanche, changer la salle VERS une salle occupée reste bloqué.
    const blocked = moveSession(db, u, s2, { room_id: f.roomId });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
  });

  it('salle inactive : inchangée tolérée au move, changée refusée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    // La séance est déjà sur la salle qui sera désactivée (donnée liée).
    const sid = addSession(db, f, { date: MON });
    run(db, 'UPDATE room SET is_active = 0 WHERE id = ?', f.roomId);
    run(db, 'UPDATE room SET is_active = 0 WHERE id = ?', f.room2Id);
    // Changer VERS une autre salle inactive → refus.
    const refused = moveSession(db, u, sid, { room_id: f.room2Id });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fields?.some((x) => x.field === 'room_id')).toBe(true);
    // Salle inactive INCHANGÉE + retouche du créneau → accepté.
    const ok = moveSession(db, u, sid, { start_min: 540 });
    expect(ok.ok).toBe(true);
    expect(
      get<{ start_min: number; room_id: number }>(
        db, 'SELECT start_min, room_id FROM session WHERE id = ?', sid,
      ),
    ).toEqual({ start_min: 540, room_id: f.roomId });
  });
});

describe('changeSessionStatus', () => {
  it('transitions illégales refusées : même statut et ANNULEE→REPORTEE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const same = changeSessionStatus(db, uid(db), s1, { status: 'PREVUE' });
    expect(same.ok).toBe(false);
    const s2 = addSession(db, f, { date: TUE, status: 'ANNULEE' });
    const illegal = changeSessionStatus(db, uid(db), s2, {
      status: 'REPORTEE', reason: 'x',
      date: SAT, start_min: 720, end_min: 840,
    });
    expect(illegal.ok).toBe(false);
    const forged = changeSessionStatus(db, uid(db), s1, {
      status: 'BIDOUILLE' as SessionStatus,
    });
    expect(forged.ok).toBe(false);
    expect(historyRows(db, s1)).toHaveLength(0);
  });

  it('→ REALISEE : actual_* par défaut = créneau planifié', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    const res = changeSessionStatus(db, uid(db), sid, { status: 'REALISEE' });
    expect(res.ok).toBe(true);
    const s = get<{
      status: string; actual_date: string | null;
      actual_start_min: number | null; actual_end_min: number | null;
    }>(
      db,
      `SELECT status, actual_date, actual_start_min, actual_end_min
         FROM session WHERE id = ?`,
      sid,
    )!;
    expect(s.status).toBe('REALISEE');
    expect(s.actual_date).toBe(MON);
    expect(s.actual_start_min).toBe(480);
    expect(s.actual_end_min).toBe(600);
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].new_status).toBe('REALISEE');
  });

  it('→ ANNULEE sans motif → refusé ; avec motif → ok + reason en history', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON });
    const refused = changeSessionStatus(db, uid(db), sid, {
      status: 'ANNULEE',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fields?.some((x) => x.field === 'reason')).toBe(true);
    const ok = changeSessionStatus(db, uid(db), sid, {
      status: 'ANNULEE', reason: 'Prof absent',
    });
    expect(ok.ok).toBe(true);
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].new_status).toBe('ANNULEE');
    expect(h[0].reason).toBe('Prof absent');
  });

  it('→ REPORTEE : bascule sur le nouveau créneau, historique conserve l’ancien', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    const res = changeSessionStatus(db, uid(db), sid, {
      status: 'REPORTEE', reason: 'Grève transport',
      date: SAT, start_min: 840, end_min: 960,
    }, '2026-10-01');
    expect(res.ok).toBe(true);
    const s = get<{ status: string; date: string; start_min: number }>(
      db,
      'SELECT status, date, start_min FROM session WHERE id = ?',
      sid,
    )!;
    expect(s.status).toBe('REPORTEE');
    expect(s.date).toBe(SAT); // la séance bascule sur le nouveau créneau
    expect(s.start_min).toBe(840);
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('PREVUE');
    expect(h[0].new_status).toBe('REPORTEE');
    expect(h[0].old_date).toBe(MON); // l'historique conserve l'ancien créneau
    expect(h[0].new_date).toBe(SAT);
    expect(h[0].old_start_min).toBe(480);
    expect(h[0].new_start_min).toBe(840);
    expect(h[0].reason).toBe('Grève transport');
  });

  it('→ REPORTEE : garde conflits sur le NOUVEAU créneau', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Occupant sur le créneau cible (même salle).
    addSession(db, f, {
      date: SAT, start: 720, end: 900, mmId: f.mm2Id, profId: f.prof2Id,
    });
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    const res = changeSessionStatus(db, uid(db), sid, {
      status: 'REPORTEE', reason: 'Déplacement demandé',
      date: SAT, start_min: 800, end_min: 920,
    }, '2026-10-01');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
    // Rien n'a bougé.
    const s = get<{ status: string; date: string }>(
      db, 'SELECT status, date FROM session WHERE id = ?', sid,
    )!;
    expect(s.status).toBe('PREVUE');
    expect(s.date).toBe(MON);
    expect(historyRows(db, sid)).toHaveLength(0);
  });

  it('ANNULEE→PREVUE : réactivation ok si libre, refusée avec conflits sinon', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, {
      date: MON, start: 480, end: 600, status: 'ANNULEE',
    });
    // Occupant sur le même créneau/salle → réactivation refusée.
    addSession(db, f, {
      date: MON, start: 540, end: 660, mmId: f.mm2Id, profId: f.prof2Id,
    });
    const refused = changeSessionStatus(db, uid(db), sid, { status: 'PREVUE' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
    // Libère le créneau (occupant sur une autre salle) → réactivation ok.
    run(
      db,
      `UPDATE session SET room_id = ?
        WHERE id = (SELECT max(id) FROM session WHERE id != ?)`,
      f.room2Id,
      sid,
    );
    const ok = changeSessionStatus(db, uid(db), sid, { status: 'PREVUE' });
    expect(ok.ok).toBe(true);
    const s = get<{ status: string }>(
      db, 'SELECT status FROM session WHERE id = ?', sid,
    )!;
    expect(s.status).toBe('PREVUE');
    expect(historyRows(db, sid)[0].new_status).toBe('PREVUE');
  });

  it('REALISEE verrouillée : sortie refusée sans correction, autorisée avec {corrective, reason}', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON, status: 'REALISEE' });
    run(
      db,
      'UPDATE session SET actual_date = ?, actual_start_min = 480, actual_end_min = 600 WHERE id = ?',
      MON,
      sid,
    );
    const refused = changeSessionStatus(db, uid(db), sid, {
      status: 'PREVUE',
    });
    expect(refused.ok).toBe(false);
    const refused2 = changeSessionStatus(db, uid(db), sid, {
      status: 'ANNULEE', corrective: true, // motif manquant
    });
    expect(refused2.ok).toBe(false);
    const ok = changeSessionStatus(db, uid(db), sid, {
      status: 'PREVUE', corrective: true, reason: 'Saisie erronée',
    });
    expect(ok.ok).toBe(true);
    const s = get<{
      status: string; actual_date: string | null;
    }>(
      db, 'SELECT status, actual_date FROM session WHERE id = ?', sid,
    )!;
    expect(s.status).toBe('PREVUE');
    expect(s.actual_date).toBeNull(); // actual_* purgés hors REALISEE
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('REALISEE');
    expect(h[0].reason).toBe('Saisie erronée');
    expect(auditRows(db)).toHaveLength(1);
  });

  it('ANNULEE→REALISEE : re-check conflits — bloquée si occupé, OK si libre', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, {
      date: MON, start: 480, end: 600, status: 'ANNULEE',
    });
    // Occupant PREVUE sur le même créneau/salle (master U, prof2).
    addSession(db, f, {
      date: MON, start: 540, end: 660, mmId: f.mm2Id, profId: f.prof2Id,
    });
    const refused = changeSessionStatus(
      db, u, sid, { status: 'REALISEE' }, '2026-10-20',
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflicts?.some((c) => c.kind === 'ROOM')).toBe(true);
    expect(
      get<{ status: string }>(
        db, 'SELECT status FROM session WHERE id = ?', sid,
      )!.status,
    ).toBe('ANNULEE');
    // Libère la salle → sortie d'ANNULEE vers statut occupant acceptée.
    run(
      db,
      `UPDATE session SET room_id = ?
        WHERE id = (SELECT max(id) FROM session WHERE id != ?)`,
      f.room2Id,
      sid,
    );
    const ok = changeSessionStatus(
      db, u, sid, { status: 'REALISEE' }, '2026-10-20',
    );
    expect(ok.ok).toBe(true);
    const s = get<{ status: string; actual_date: string | null }>(
      db,
      'SELECT status, actual_date FROM session WHERE id = ?',
      sid,
    )!;
    expect(s.status).toBe('REALISEE');
    expect(s.actual_date).toBe(MON); // défaut = créneau planifié
    expect(historyRows(db, sid)[0].new_status).toBe('REALISEE');
  });

  it('REPORTEE→REPORTEE : re-report sur un autre créneau (motif obligatoire)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const today = '2026-10-01';
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    // Premier report : MON → SAT.
    expect(
      changeSessionStatus(db, u, sid, {
        status: 'REPORTEE', reason: 'Grève',
        date: SAT, start_min: 840, end_min: 960,
      }, today).ok,
    ).toBe(true);
    // Re-report sans motif → refusé.
    const noReason = changeSessionStatus(
      db, u, sid,
      { status: 'REPORTEE', date: TUE, start_min: 600, end_min: 720 },
      today,
    );
    expect(noReason.ok).toBe(false);
    if (noReason.ok) return;
    expect(noReason.fields?.some((x) => x.field === 'reason')).toBe(true);
    // Re-report : SAT → TUE.
    const res = changeSessionStatus(
      db, u, sid,
      {
        status: 'REPORTEE', reason: 'Nouvelle contrainte',
        date: TUE, start_min: 600, end_min: 720,
      },
      today,
    );
    expect(res.ok).toBe(true);
    const s = get<{ status: string; date: string; start_min: number }>(
      db,
      'SELECT status, date, start_min FROM session WHERE id = ?',
      sid,
    )!;
    expect(s.status).toBe('REPORTEE');
    expect(s.date).toBe(TUE);
    const h = historyRows(db, sid);
    expect(h).toHaveLength(2);
    expect(h[1].old_status).toBe('REPORTEE');
    expect(h[1].new_status).toBe('REPORTEE');
    expect(h[1].old_date).toBe(SAT);
    expect(h[1].new_date).toBe(TUE);
    expect(h[1].reason).toBe('Nouvelle contrainte');
  });

  it('bornes temporelles : REPORTEE vers le passé refusée, = today acceptée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    // today = 2026-10-14 → TUE (13) est passé → refus.
    const refused = changeSessionStatus(
      db, u, sid,
      {
        status: 'REPORTEE', reason: 'x',
        date: TUE, start_min: 600, end_min: 720,
      },
      '2026-10-14',
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fields?.some((x) => x.field === 'date')).toBe(true);
    // Nouveau créneau = today → accepté.
    const ok = changeSessionStatus(
      db, u, sid,
      {
        status: 'REPORTEE', reason: 'x',
        date: '2026-10-14', start_min: 600, end_min: 720,
      },
      '2026-10-14',
    );
    expect(ok.ok).toBe(true);
  });

  it('bornes temporelles : actual_date future refusée, = today acceptée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON, start: 480, end: 600 });
    const refused = changeSessionStatus(
      db, u, sid,
      { status: 'REALISEE', actual_date: '2026-10-13' },
      '2026-10-12',
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.fields?.some((x) => x.field === 'actual_date')).toBe(true);
    const ok = changeSessionStatus(
      db, u, sid,
      { status: 'REALISEE', actual_date: '2026-10-12' },
      '2026-10-12',
    );
    expect(ok.ok).toBe(true);
    expect(
      get<{ actual_date: string }>(
        db, 'SELECT actual_date FROM session WHERE id = ?', sid,
      )!.actual_date,
    ).toBe('2026-10-12');
  });

  it('REALISEE→REALISEE corrective : actual_* seuls + history + audit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON, status: 'REALISEE' });
    run(
      db,
      'UPDATE session SET actual_date = ?, actual_start_min = 480, actual_end_min = 600 WHERE id = ?',
      MON,
      sid,
    );
    // Sans corrective → refus « déjà dans ce statut » conservé.
    expect(
      changeSessionStatus(db, u, sid, { status: 'REALISEE' }, '2026-10-20').ok,
    ).toBe(false);
    // Corrective sans motif → refusée aussi.
    expect(
      changeSessionStatus(
        db, u, sid,
        { status: 'REALISEE', corrective: true },
        '2026-10-20',
      ).ok,
    ).toBe(false);
    // Corrective + motif + retouche horaire réelle → ok.
    const res = changeSessionStatus(
      db, u, sid,
      {
        status: 'REALISEE', corrective: true, reason: 'Horaire corrigé',
        actual_start_min: 500, actual_end_min: 610,
      },
      '2026-10-20',
    );
    expect(res.ok).toBe(true);
    const s = get<{
      status: string; date: string; start_min: number;
      actual_date: string | null;
      actual_start_min: number | null; actual_end_min: number | null;
    }>(
      db,
      `SELECT status, date, start_min,
              actual_date, actual_start_min, actual_end_min
         FROM session WHERE id = ?`,
      sid,
    )!;
    expect(s.status).toBe('REALISEE');
    expect(s.date).toBe(MON); // créneau inchangé
    expect(s.start_min).toBe(480);
    expect(s.actual_date).toBe(MON); // actual_date conservée
    expect(s.actual_start_min).toBe(500);
    expect(s.actual_end_min).toBe(610);
    const h = historyRows(db, sid);
    expect(h).toHaveLength(1);
    expect(h[0].old_status).toBe('REALISEE');
    expect(h[0].new_status).toBe('REALISEE');
    expect(h[0].reason).toBe('Horaire corrigé');
    expect(auditRows(db)).toHaveLength(1);
  });

  it('not-found : les 4 mutations refusent proprement', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    expect(moveSession(db, u, 999999, { room_id: f.roomId }).ok).toBe(false);
    expect(
      changeSessionStatus(db, u, 999999, {
        status: 'ANNULEE', reason: 'x',
      }).ok,
    ).toBe(false);
    expect(setSessionGroups(db, u, 999999, []).ok).toBe(false);
    expect(deleteSession(db, u, 999999).ok).toBe(false);
    expect(auditRows(db)).toHaveLength(0);
  });
});

describe('setSessionGroups', () => {
  it('groupe d’un autre master refusé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    // Séance sur mm2 (master U) : G1/G2 appartiennent au master T → refus.
    const sid = addSession(db, f, {
      date: TUE, start: 540, end: 660, roomId: f.room2Id, mmId: f.mm2Id,
      profId: f.prof2Id,
    });
    const wrong = setSessionGroups(db, u, sid, [f.groupId]);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.fields?.some((x) => x.field === 'group_ids')).toBe(true);
    // Inexistant → refus aussi.
    expect(setSessionGroups(db, u, sid, [99999]).ok).toBe(false);
    // Remplacement par GU (master U) → ok + ligne écrite.
    expect(setSessionGroups(db, u, sid, [f.groupOtherId]).ok).toBe(true);
    expect(
      all<{ student_group_id: number }>(
        db,
        'SELECT student_group_id FROM session_group WHERE session_id = ?',
        sid,
      ).map((r) => r.student_group_id),
    ).toEqual([f.groupOtherId]);
    // Audit explicite : old/new = listes de group_ids JSON (1 ligne).
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('UPDATE');
    expect(audit[0].entity).toBe('session');
    expect(JSON.parse(audit[0].old_values!)).toEqual({ group_ids: [] });
    expect(JSON.parse(audit[0].new_values!)).toEqual({
      group_ids: [f.groupOtherId],
    });
  });

  it('REALISEE refusée ; groupe implicite du mm dédupliqué silencieusement', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const done = addSession(db, f, { date: MON, status: 'REALISEE' });
    expect(setSessionGroups(db, u, done, [f.group2Id]).ok).toBe(false);
    // Séance PREVUE sur mmId (groupe implicite = G1) : passer G1 dans
    // group_ids est ignoré — il n'entre jamais dans session_group.
    const sid = addSession(db, f, { date: SAT, start: 720, end: 840 });
    const res = setSessionGroups(db, u, sid, [f.groupId]);
    expect(res.ok).toBe(true);
    expect(
      all(
        db,
        'SELECT student_group_id FROM session_group WHERE session_id = ?',
        sid,
      ),
    ).toHaveLength(0);
  });

  it('re-check GROUP : rattacher un groupe déjà occupé sur le créneau → refus', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    // Occupant : séance de G1 (via son mm, master T) sur le créneau.
    addSession(db, f, { date: TUE, start: 480, end: 600, roomId: f.roomId });
    // Deuxième mm sur le MÊME master T (sans groupe implicite).
    const mm3 = Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id, student_group_id,
            volume_min, session_duration_min, planned_sessions,
            sched_start, sched_end)
         VALUES (?, ?, ?, ?, NULL, 600, 90, 5, '2026-09-01', '2027-01-31')`,
        f.masterId, f.mod2Id, f.semId, f.prof2Id,
      ).lastInsertRowid,
    );
    // Séance chevauchant, autres salle/prof — sans groupe rattaché.
    const sid = addSession(db, f, {
      date: TUE, start: 540, end: 660, roomId: f.room2Id, mmId: mm3,
      profId: f.prof2Id,
    });
    // Rattacher G2 (master T, libre sur ce créneau) → OK.
    expect(setSessionGroups(db, u, sid, [f.group2Id]).ok).toBe(true);
    // Rattacher G1 (déjà occupé à ce créneau via le mm de l'autre séance)
    // → refus avec conflit GROUP.
    const refused = setSessionGroups(db, u, sid, [f.groupId]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflicts?.some((c) => c.kind === 'GROUP')).toBe(true);
    // Le rattachement G2 a persisté (premier appel réussi).
    expect(
      all<{ student_group_id: number }>(
        db,
        'SELECT student_group_id FROM session_group WHERE session_id = ?',
        sid,
      ).map((r) => r.student_group_id),
    ).toEqual([f.group2Id]);
  });
});

describe('deleteSession', () => {
  it('REALISEE refusée ; PREVUE supprimée + enfants + audit DELETE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    // today injecté : les dates fixture (oct. 2026) sont « futures » —
    // la borne « passé non supprimable » ne s'applique pas.
    const today = '2026-10-01';
    const done = addSession(db, f, { date: MON, status: 'REALISEE' });
    const refused = deleteSession(db, u, done, today);
    expect(refused.ok).toBe(false);
    expect(get(db, 'SELECT id FROM session WHERE id = ?', done)).toBeTruthy();

    const sid = addSession(db, f, { date: TUE });
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.group2Id,
    );
    run(
      db,
      `INSERT INTO session_status_history
         (session_id, old_status, new_status) VALUES (?, NULL, 'PREVUE')`,
      sid,
    );
    const res = deleteSession(db, u, sid, today);
    expect(res.ok).toBe(true);
    expect(get(db, 'SELECT id FROM session WHERE id = ?', sid)).toBeUndefined();
    expect(
      all(db, 'SELECT session_id FROM session_group WHERE session_id = ?', sid),
    ).toHaveLength(0);
    expect(historyRows(db, sid)).toHaveLength(0);
    const audit = auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('DELETE');
    expect(audit[0].entity).toBe('session');
    expect(JSON.parse(audit[0].old_values!).status).toBe('PREVUE');
    expect(audit[0].new_values).toBeNull();
    expect(audit[0].user_id).toBe(u);
  });

  it('séance passée (date < today) refusée — à annuler, pas effacer', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f, { date: MON });
    const refused = deleteSession(db, u, sid, '2026-10-20');
    expect(refused.ok).toBe(false);
    expect(get(db, 'SELECT id FROM session WHERE id = ?', sid)).toBeTruthy();
    // today avant la date de la séance → suppression acceptée.
    expect(deleteSession(db, u, sid, '2026-10-01').ok).toBe(true);
    expect(get(db, 'SELECT id FROM session WHERE id = ?', sid)).toBeUndefined();
  });
});
