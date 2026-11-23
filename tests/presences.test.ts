/**
 * Tests P9b — présences étudiants : `attendance.service` (getAttendance
 * modes NONE/COUNT/NOMINATIVE, roster multi-groupes et « master entier »,
 * setCounts, setNominative remplace+recalcule, clearAttendance) et
 * `student.service` (listByGroup/addStudent/removeStudent, unicité
 * external_id, BR-22 chiffré) — audit explicite par mutation, base
 * `:memory:`.
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
  clearAttendance,
  getAttendance,
  setCounts,
  setNominative,
} from '../electron/main/db/attendance.service';
import {
  addStudent,
  listByGroup,
  removeStudent,
} from '../electron/main/db/student.service';
import type { SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const DAY = '2026-10-13';

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return db;
}

interface Fixture {
  masterId: number;
  master2Id: number;
  groupId: number; // G1 — groupe du mmId
  group2Id: number; // G2 — rattaché via session_group
  groupOtherId: number; // GU — autre master
  mmId: number; // master 1, groupe G1
  mmWholeId: number; // master 1, master entier (student_group_id NULL)
  st1: number; // étudiant G1
  st2: number; // étudiant G1
  st3: number; // étudiant G2
  stOther: number; // étudiant GU (hors roster)
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
    run(db, "INSERT INTO student_group (master_id, name) VALUES (?, 'G1')", masterId)
      .lastInsertRowid,
  );
  const group2Id = Number(
    run(db, "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')", masterId)
      .lastInsertRowid,
  );
  const groupOtherId = Number(
    run(db, "INSERT INTO student_group (master_id, name) VALUES (?, 'GU')", master2Id)
      .lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Un')").lastInsertRowid,
  );
  run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)");
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')").lastInsertRowid,
  );
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, ?, 1200, 120, 10, '2026-09-01', '2027-01-31')`,
      masterId, modId, semId, profId, groupId,
    ).lastInsertRowid,
  );
  const mmWholeId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, 1200, 120, 10, '2026-09-01', '2027-01-31')`,
      masterId, modId, semId, profId,
    ).lastInsertRowid,
  );
  // external_id distinct obligatoire : ux_student_group_ext coalesce
  // NULL→'' — deux NULL dans le même groupe violeraient l'unicité.
  const addSt = (groupId_: number, name: string, ext: string): number =>
    Number(
      run(
        db,
        'INSERT INTO student (student_group_id, external_id, full_name) VALUES (?, ?, ?)',
        groupId_,
        ext,
        name,
      ).lastInsertRowid,
    );
  return {
    masterId, master2Id, groupId, group2Id, groupOtherId,
    mmId, mmWholeId,
    st1: addSt(groupId, 'Alice Alami', 'FIX-1'),
    st2: addSt(groupId, 'Badr Bennis', 'FIX-2'),
    st3: addSt(group2Id, 'Chaima Chafik', 'FIX-3'),
    stOther: addSt(groupOtherId, 'Omar Out of Group', 'FIX-4'),
  };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: { mmId?: number; status?: SessionStatus } = {},
): number {
  const profId = Number(
    get<{ professor_id: number }>(
      db,
      'SELECT professor_id FROM master_module WHERE id = ?',
      opts.mmId ?? f.mmId,
    )!.professor_id,
  );
  const roomId = Number(
    get<{ id: number }>(db, 'SELECT id FROM room LIMIT 1')!.id,
  );
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, ?, 480, 600, ?)`,
      opts.mmId ?? f.mmId,
      profId,
      roomId,
      DAY,
      opts.status ?? 'REALISEE',
    ).lastInsertRowid,
  );
}

/** Séance multi-groupes : mm G1 + G2 rattaché via session_group. */
function addMultiGroupSession(db: DatabaseSync, f: Fixture): number {
  const sid = addSession(db, f);
  run(
    db,
    'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
    sid,
    f.group2Id,
  );
  return sid;
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

/** uid du profil courant (Administrateur seedé) — FK audit. */
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

describe('getAttendance', () => {
  it('séance inexistante → erreur ; séance sans saisie → mode NONE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    expect(getAttendance(db, 9999).ok).toBe(false);
    const sid = addSession(db, f);
    const res = getAttendance(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mode).toBe('NONE');
    expect(res.data.counts).toBeNull();
    expect(res.data.nominative).toHaveLength(0);
  });

  it('roster multi-groupes : mm.student_group ∪ session_group', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addMultiGroupSession(db, f);
    const res = getAttendance(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // G1 (mm) + G2 (session_group) → 3 étudiants, hors GU.
    expect(res.data.roster.map((r) => r.student_id).sort()).toEqual(
      [f.st1, f.st2, f.st3].sort(),
    );
  });

  it('séance « master entier » : tous les groupes du master sont candidats', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { mmId: f.mmWholeId });
    const res = getAttendance(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.roster.map((r) => r.student_id).sort()).toEqual(
      [f.st1, f.st2, f.st3].sort(),
    );
  });

  it('séance à groupe sans session_group : roster = groupe du mm seul', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = getAttendance(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.roster.map((r) => r.student_id).sort()).toEqual(
      [f.st1, f.st2].sort(),
    );
  });
});

describe('setCounts', () => {
  it('écrit + relit (mode COUNT, note)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = setCounts(db, uid(db), sid, {
      present_count: 18,
      absent_count: 2,
      note: 'Deux absents non justifiés',
    });
    expect(res.ok).toBe(true);
    const g = getAttendance(db, sid);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.data.mode).toBe('COUNT');
    expect(g.data.counts).toEqual({
      present_count: 18,
      absent_count: 2,
      note: 'Deux absents non justifiés',
    });
    // Audit explicite : entity session_attendance, old NULL → new JSON.
    const audit = auditRows(db).filter(
      (a) => a.entity === 'session_attendance',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('CREATE');
    expect(audit[0].entity_id).toBe(sid);
    expect(audit[0].old_values).toBeNull();
    expect(JSON.parse(audit[0].new_values!).present_count).toBe(18);
    expect(audit[0].user_id).toBe(uid(db));
  });

  it('refus sur séance non REALISEE (PREVUE / ANNULEE)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const prevue = addSession(db, f, { status: 'PREVUE' });
    const annulee = addSession(db, f, { status: 'ANNULEE' });
    expect(
      setCounts(db, uid(db), prevue, { present_count: 1, absent_count: 0 }).ok,
    ).toBe(false);
    expect(
      setCounts(db, uid(db), annulee, { present_count: 1, absent_count: 0 }).ok,
    ).toBe(false);
    expect(all(db, 'SELECT session_id FROM session_attendance')).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('compteurs négatifs / non entiers refusés', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const bad = setCounts(db, uid(db), sid, {
      present_count: -1,
      absent_count: 0,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.fields?.some((x) => x.field === 'present_count')).toBe(true);
    }
    const bad2 = setCounts(db, uid(db), sid, {
      present_count: 1.5,
      absent_count: 0,
    });
    expect(bad2.ok).toBe(false);
    expect(all(db, 'SELECT session_id FROM session_attendance')).toHaveLength(0);
  });

  it('note > 500 refusée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = setCounts(db, uid(db), sid, {
      present_count: 0,
      absent_count: 0,
      note: 'x'.repeat(501),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fields?.some((x) => x.field === 'note')).toBe(true);
    }
  });

  it('refus si des lignes nominatives existent déjà', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const nom = setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
    ]);
    expect(nom.ok).toBe(true);
    const res = setCounts(db, uid(db), sid, {
      present_count: 5,
      absent_count: 1,
    });
    expect(res.ok).toBe(false);
    // Le nominatif est intact.
    const g = getAttendance(db, sid);
    expect(g.ok && g.data.mode).toBe('NOMINATIVE');
    expect(
      all(db, 'SELECT id FROM student_attendance WHERE session_id = ?', sid),
    ).toHaveLength(1);
  });
});

describe('setNominative', () => {
  it('écrit les lignes et recalcule les compteurs (JUSTIFIE → absent)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
      { student_id: f.st2, status: 'ABSENT' },
      // st3 absent de la liste → pas de ligne écrite (défaut UI = PRESENT)
    ]);
    expect(res.ok).toBe(true);
    const g = getAttendance(db, sid);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.data.mode).toBe('NOMINATIVE');
    expect(g.data.nominative).toHaveLength(2);
    // 1 PRESENT ; ABSENT compté absent — JUSTIFIE aussi (règle v1).
    expect(g.data.counts?.present_count).toBe(1);
    expect(g.data.counts?.absent_count).toBe(1);
  });

  it('JUSTIFIE compté absent dans absent_count', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
      { student_id: f.st2, status: 'JUSTIFIE' },
    ]);
    expect(res.ok).toBe(true);
    const counts = get<{ present_count: number; absent_count: number }>(
      db,
      'SELECT present_count, absent_count FROM session_attendance WHERE session_id = ?',
      sid,
    )!;
    expect(counts).toEqual({ present_count: 1, absent_count: 1 });
  });

  it('remplace l’ensemble (DELETE+INSERT) et reste idempotent', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
      { student_id: f.st2, status: 'ABSENT' },
    ]);
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st2, status: 'PRESENT' },
    ]);
    expect(res.ok).toBe(true);
    const rows = all<{ student_id: number; status: string }>(
      db,
      'SELECT student_id, status FROM student_attendance WHERE session_id = ?',
      sid,
    );
    expect(rows).toEqual([{ student_id: f.st2, status: 'PRESENT' }]);
    const counts = get<{ present_count: number; absent_count: number }>(
      db,
      'SELECT present_count, absent_count FROM session_attendance WHERE session_id = ?',
      sid,
    )!;
    expect(counts).toEqual({ present_count: 1, absent_count: 0 });
    // Rejouer le même ensemble → même état final.
    const again = setNominative(db, uid(db), sid, [
      { student_id: f.st2, status: 'PRESENT' },
    ]);
    expect(again.ok).toBe(true);
    expect(
      all(db, 'SELECT id FROM student_attendance WHERE session_id = ?', sid),
    ).toHaveLength(1);
  });

  it('statut invalide et étudiant hors groupes refusés — rien n’écrit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const badStatus = setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'RETARD' as never },
    ]);
    expect(badStatus.ok).toBe(false);
    const outsider = setNominative(db, uid(db), sid, [
      { student_id: f.stOther, status: 'PRESENT' },
    ]);
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) {
      expect(outsider.fields?.some((x) => x.field === 'items')).toBe(true);
    }
    expect(
      all(db, 'SELECT id FROM student_attendance WHERE session_id = ?', sid),
    ).toHaveLength(0);
    expect(
      all(db, 'SELECT session_id FROM session_attendance WHERE session_id = ?', sid),
    ).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('étudiant d’un groupe non rattaché à la séance refusé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Séance G1 seul (pas de session_group) : st3 (G2) est hors roster.
    const sid = addSession(db, f);
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st3, status: 'ABSENT' },
    ]);
    expect(res.ok).toBe(false);
  });

  it('session_group élargit le roster (st3 accepté)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addMultiGroupSession(db, f);
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st3, status: 'ABSENT' },
    ]);
    expect(res.ok).toBe(true);
  });

  it('audit explicite : old/new JSON de la liste nominative', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
    ]);
    const audit = auditRows(db).filter(
      (a) => a.entity === 'student_attendance',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe(sid);
    expect(JSON.parse(audit[0].new_values!).items).toEqual([
      { student_id: f.st1, status: 'PRESENT' },
    ]);
    expect(JSON.parse(audit[0].old_values!).items).toEqual([]);
  });

  it('note du comptage conservée au recalcul nominatif', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    setCounts(db, uid(db), sid, {
      present_count: 0,
      absent_count: 0,
      note: 'Note gardée',
    });
    const res = setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
    ]);
    expect(res.ok).toBe(true);
    const counts = get<{ note: string | null }>(
      db,
      'SELECT note FROM session_attendance WHERE session_id = ?',
      sid,
    )!;
    expect(counts.note).toBe('Note gardée');
  });
});

describe('clearAttendance', () => {
  it('purge compteurs + nominatif, trace DELETE explicite', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    setNominative(db, uid(db), sid, [
      { student_id: f.st1, status: 'PRESENT' },
      { student_id: f.st2, status: 'ABSENT' },
    ]);
    const before = auditRows(db).length;
    const res = clearAttendance(db, uid(db), sid);
    expect(res.ok).toBe(true);
    expect(
      all(db, 'SELECT id FROM student_attendance WHERE session_id = ?', sid),
    ).toHaveLength(0);
    expect(
      all(db, 'SELECT session_id FROM session_attendance WHERE session_id = ?', sid),
    ).toHaveLength(0);
    const g = getAttendance(db, sid);
    expect(g.ok && g.data.mode).toBe('NONE');
    const audit = auditRows(db).slice(before);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('DELETE');
    expect(audit[0].entity).toBe('session_attendance');
    const old = JSON.parse(audit[0].old_values!);
    expect(old.items).toHaveLength(2);
    expect(old.counts.present_count).toBe(1);
    expect(audit[0].new_values).toBeNull();
  });

  it('sur une séance vide : succès sans écriture ni audit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f);
    const res = clearAttendance(db, uid(db), sid);
    expect(res.ok).toBe(true);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('refus sur séance non REALISEE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { status: 'PREVUE' });
    expect(clearAttendance(db, uid(db), sid).ok).toBe(false);
  });
});

describe('students (registre)', () => {
  it('add/list : nom obligatoire, external_id optionnel (généré MAN-*)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const missing = addStudent(db, u, f.groupId, { full_name: '  ' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.fields?.some((x) => x.field === 'full_name')).toBe(true);
    }
    const a = addStudent(db, u, f.groupId, { full_name: 'Nadia Nouar' });
    expect(a.ok).toBe(true);
    if (a.ok) {
      // external_id omis → synthétique MAN- (unicité COALESCE→'').
      expect(a.data.external_id).toMatch(/^MAN-\d+$/);
    }
    const list = listByGroup(db, f.groupId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.map((s) => s.full_name)).toContain('Nadia Nouar');
    // Audit CREATE student.
    expect(auditRows(db).some((x) => x.entity === 'student' && x.action === 'CREATE')).toBe(true);
  });

  it('deux étudiants sans external_id dans le même groupe : OK (MAN-*)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const a = addStudent(db, u, f.groupId, { full_name: 'Etu Un' });
    const b = addStudent(db, u, f.groupId, { full_name: 'Etu Deux' });
    expect(a.ok && b.ok).toBe(true);
  });

  it('unicité (groupe, external_id) → erreur de champ', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const a = addStudent(db, u, f.groupId, {
      full_name: 'Etu Un',
      external_id: 'EXT-1',
    });
    expect(a.ok).toBe(true);
    const dup = addStudent(db, u, f.groupId, {
      full_name: 'Etu Bis',
      external_id: 'EXT-1',
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.fields?.some((x) => x.field === 'external_id')).toBe(true);
    }
    // Même external_id dans un AUTRE groupe : autorisé.
    const other = addStudent(db, u, f.group2Id, {
      full_name: 'Etu Autre Groupe',
      external_id: 'EXT-1',
    });
    expect(other.ok).toBe(true);
  });

  it('remove : OK sans lien ; refus chiffré si student_attendance lié (BR-22)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const u = uid(db);
    const sid = addSession(db, f);
    setNominative(db, u, sid, [{ student_id: f.st1, status: 'ABSENT' }]);
    const refused = removeStudent(db, u, f.st1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.linkedCount).toBe(1);
      expect(refused.error).toContain('1');
    }
    // st3 non référencé → suppression OK + audit DELETE student.
    const okRes = removeStudent(db, u, f.st3);
    expect(okRes.ok).toBe(true);
    expect(
      all(db, 'SELECT id FROM student WHERE id = ?', f.st3),
    ).toHaveLength(0);
    expect(
      auditRows(db).some((x) => x.entity === 'student' && x.action === 'DELETE'),
    ).toBe(true);
  });
});
