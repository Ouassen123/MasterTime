/**
 * Tests P6c — service Masters (CRUD, statut ACTIF/ARCHIVE, groupes,
 * master-modules, compteurs de suivi AD-7, suppression protégée BR-22)
 * sur base temporaire `:memory:` — aucun Electron. Les handlers IPC sont
 * couverts via la composition `guard(..., { requireRole: 'ADMIN' })`
 * utilisée par `ipc/masters.ts`.
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
import {
  ensureProfiles,
  listProfiles,
  setCurrentProfile,
} from '../electron/main/db/profile.service';
import {
  addGroup,
  attachModule,
  createMaster,
  deleteMaster,
  detachModule,
  getMasterDetail,
  listMasters,
  removeGroup,
  renameGroup,
  setMasterStatus,
  updateMaster,
  updateMasterModule,
} from '../electron/main/db/master.service';
import { collectContextSemesters } from '../electron/main/db/status';
import { currentUserId, guard } from '../electron/main/ipc/helpers';
import {
  applyImport,
  exportEntity,
  previewImport,
} from '../electron/main/db/import.service';
import type {
  ApiResult,
  AppUser,
  DeleteResult,
  MasterModuleInput,
} from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const TODAY = '2026-10-15'; // jeudi — fixture fixe pour les compteurs AD-7

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return db;
}

function admin(db: DatabaseSync): AppUser {
  const user = listProfiles(db).find((p) => p.role === 'ADMIN');
  expect(user).toBeDefined();
  return user!;
}

interface Fixture {
  yearId: number;
  year2Id: number;
  semId: number;
  sem2Id: number;
  year2SemId: number;
  profId: number;
  prof2Id: number;
  modId: number;
  mod2Id: number;
  masterId: number;
  master2Id: number;
  groupId: number;
  mmId: number;
  roomId: number;
}

/**
 * Référentiel minimal : 2 années (2026-2027 courante + 2027-2028),
 * 2 semestres sur l'année 1 + 1 sur l'année 2, 2 masters (M-T a un
 * groupe « G1 » et un master_module), 2 modules, 2 profs, 1 salle.
 */
function seedFixture(db: DatabaseSync): Fixture {
  const yearId = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
    ).lastInsertRowid,
  );
  const year2Id = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2027-2028', '2027-09-01', '2028-08-31', 0)",
    ).lastInsertRowid,
  );
  const semId = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S1', 1)",
      yearId,
    ).lastInsertRowid,
  );
  const sem2Id = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S2', 2)",
      yearId,
    ).lastInsertRowid,
  );
  const year2SemId = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S1', 1)",
      year2Id,
    ).lastInsertRowid,
  );
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, filiere, academic_year_id, semester_id) VALUES ('M-T', 'Master T', 'Droit', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const master2Id = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-U', 'Master U', ?, ?)",
      yearId,
      sem2Id,
    ).lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')")
      .lastInsertRowid,
  );
  const mod2Id = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-U', 'Module U')")
      .lastInsertRowid,
  );
  const roomId = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle T', 30)")
      .lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Test')")
      .lastInsertRowid,
  );
  const prof2Id = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Libre')")
      .lastInsertRowid,
  );
  const groupId = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G1', 30)",
      masterId,
    ).lastInsertRowid,
  );
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, volume_min,
          session_duration_min, planned_sessions, sched_start, sched_end)
       VALUES (?, ?, ?, ?, 1200, 90, 10, '2026-09-01', '2027-01-31')`,
      masterId,
      modId,
      semId,
      profId,
    ).lastInsertRowid,
  );
  return {
    yearId,
    year2Id,
    semId,
    sem2Id,
    year2SemId,
    profId,
    prof2Id,
    modId,
    mod2Id,
    masterId,
    master2Id,
    groupId,
    mmId,
    roomId,
  };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: {
    mmId?: number;
    date: string;
    status?: string;
    start?: number;
    end?: number;
    actualStart?: number | null;
    actualEnd?: number | null;
  },
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status, actual_start_min, actual_end_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.mmId ?? f.mmId,
      f.profId,
      f.roomId,
      opts.date,
      opts.start ?? 480,
      opts.end ?? 570,
      opts.status ?? 'PREVUE',
      opts.actualStart ?? null,
      opts.actualEnd ?? null,
    ).lastInsertRowid,
  );
}

function mmInput(f: Fixture, over: Partial<MasterModuleInput> = {}): MasterModuleInput {
  return {
    module_id: f.mod2Id,
    semester_id: f.semId,
    professor_id: f.prof2Id,
    volume_min: 600,
    session_duration_min: 120,
    planned_sessions: 5,
    sched_start: '2027-02-01',
    sched_end: '2027-06-30',
    ...over,
  };
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

describe('migration 0005 — session_group', () => {
  it('table + index présents, PK composite et FK actives', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: '2026-11-10' });
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.groupId,
    );
    // PK composite : doublon refusé.
    expect(() =>
      run(
        db,
        'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
        sid,
        f.groupId,
      ),
    ).toThrow();
    // FK : groupe inexistant refusé.
    expect(() =>
      run(
        db,
        'INSERT INTO session_group (session_id, student_group_id) VALUES (?, 9999)',
        sid,
      ),
    ).toThrow();
    expect(
      get<{ c: number }>(
        db,
        "SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name='ix_sg_group'",
      )!.c,
    ).toBe(1);
  });
});

describe('masters — liste', () => {
  it('compteurs corrects : nb_modules, nb_groupes, nb_seances (hors ANNULEE), Σ volume', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: '2026-10-20' });
    addSession(db, f, { date: '2026-10-21' });
    addSession(db, f, { date: '2026-10-22', status: 'ANNULEE' });
    // session_group rattaché au groupe du master → compté dans linkedCount.
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.groupId,
    );

    const rows = listMasters(db);
    expect(rows).toHaveLength(2);
    const m = rows.find((r) => r.id === f.masterId)!;
    expect(m.nb_modules).toBe(1);
    expect(m.nb_groupes).toBe(1);
    expect(m.nb_seances).toBe(2); // l'ANNULEE n'est pas comptée
    expect(m.volume_prevu_min).toBe(1200);
    expect(m.status).toBe('ACTIF');
    expect(m.academic_year_label).toBe('2026-2027');
    expect(m.semester_label).toBe('S1');
    // linkedCount : 1 groupe + 1 mm + 3 séances + 1 session_group.
    expect(m.linkedCount).toBe(6);
    const u = rows.find((r) => r.id === f.master2Id)!;
    expect(u.nb_modules).toBe(0);
    expect(u.nb_seances).toBe(0);
    expect(u.linkedCount).toBe(0);
  });

  it('recherche name/code/filiere (casse ignorée, jokers échappés), tri par nom', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    createMaster(db, uid, {
      code: 'M-A',
      name: 'Zzz Alpha',
      academic_year_id: f.yearId,
      filiere: 'Informatique',
    });
    expect(listMasters(db, { search: 'master t' })).toHaveLength(1);
    expect(listMasters(db, { search: 'M-U' })).toHaveLength(1);
    expect(listMasters(db, { search: 'informatique' })).toHaveLength(1);
    expect(listMasters(db, { search: 'inexistant' })).toHaveLength(0);
    // Jokers LIKE échappés : '%', '_' et '\' restent littéraux.
    expect(listMasters(db, { search: '%' })).toHaveLength(0);
    expect(listMasters(db, { search: '_' })).toHaveLength(0);
    expect(listMasters(db, { search: '\\' })).toHaveLength(0);
    // Payload forgé : search non-string ignoré (pas de TypeError).
    expect(listMasters(db, { search: 42 } as never)).toHaveLength(3);
    const names = listMasters(db).map((r) => r.name);
    expect(names).toEqual(['Master T', 'Master U', 'Zzz Alpha']);
  });

  it('filtre statut ACTIF / ARCHIVE / TOUS', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    setMasterStatus(db, uid, f.master2Id, 'ARCHIVE');
    expect(listMasters(db, { status: 'ACTIF' })).toHaveLength(1);
    expect(listMasters(db, { status: 'ARCHIVE' })).toHaveLength(1);
    expect(listMasters(db, { status: 'TOUS' })).toHaveLength(2);
    expect(listMasters(db)).toHaveLength(2);
  });
});

describe('masters — CRUD', () => {
  it('créer : INSERT + audit CREATE, champs normalisés', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = createMaster(db, uid, {
      code: '  M-X  ',
      name: '  Master X  ',
      filiere: 'Droit privé',
      department: 'FSJP',
      responsible_name: 'Coord. X',
      academic_year_id: f.yearId,
      semester_id: f.sem2Id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.code).toBe('M-X');
    expect(res.data.name).toBe('Master X');
    expect(res.data.status).toBe('ACTIF');
    expect(res.data.is_demo).toBe(0);

    const log = all<{ action: string; new_values: string }>(
      db,
      "SELECT action, new_values FROM audit_log WHERE entity = 'master'",
    );
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('CREATE');
    expect(JSON.parse(log[0].new_values)).toMatchObject({
      code: 'M-X',
      name: 'Master X',
    });
  });

  it('code obligatoire + unique NOCASE ; name obligatoire ; refs inexistantes rejetées', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const empty = createMaster(db, uid, {
      code: ' ',
      name: ' ',
      academic_year_id: f.yearId,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.fields?.map((x) => x.field)).toEqual(['code', 'name']);
    }

    const dup = createMaster(db, uid, {
      code: 'm-t',
      name: 'Autre',
      academic_year_id: f.yearId,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.fields?.[0].field).toBe('code');

    const badYear = createMaster(db, uid, {
      code: 'M-Y',
      name: 'Master Y',
      academic_year_id: 9999,
    });
    expect(badYear.ok).toBe(false);
    if (!badYear.ok) expect(badYear.fields?.[0].field).toBe('academic_year_id');

    const badSem = createMaster(db, uid, {
      code: 'M-Y',
      name: 'Master Y',
      academic_year_id: f.yearId,
      semester_id: 9999,
    });
    expect(badSem.ok).toBe(false);
    if (!badSem.ok) expect(badSem.fields?.[0].field).toBe('semester_id');

    // Semestre existant mais rattaché à une AUTRE année → refusé.
    const wrongYear = createMaster(db, uid, {
      code: 'M-Y',
      name: 'Master Y',
      academic_year_id: f.yearId,
      semester_id: f.year2SemId,
    });
    expect(wrongYear.ok).toBe(false);
    if (!wrongYear.ok) {
      expect(wrongYear.fields?.[0].field).toBe('semester_id');
      expect(wrongYear.fields?.[0].message).toMatch(/année/);
    }

    const badStatus = createMaster(db, uid, {
      code: 'M-Y',
      name: 'Master Y',
      academic_year_id: f.yearId,
      status: 'GELE' as never,
    });
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.fields?.[0].field).toBe('status');
    expect(listMasters(db)).toHaveLength(2);
  });

  it('modifier : UPDATE + audit old/new ; no-op sans audit ; doublon refusé', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);

    expect(
      updateMaster(db, uid, 9999, {
        code: 'Z',
        name: 'Z',
        academic_year_id: f.yearId,
      }).ok,
    ).toBe(false);

    const res = updateMaster(db, uid, f.master2Id, {
      code: 'M-U',
      name: 'Master U bis',
      filiere: 'Pénal',
      academic_year_id: f.yearId,
      semester_id: f.sem2Id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe('Master U bis');
    const log = all<{ old_values: string; new_values: string }>(
      db,
      "SELECT old_values, new_values FROM audit_log WHERE entity = 'master' AND action = 'UPDATE'",
    );
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].old_values).name).toBe('Master U');
    expect(JSON.parse(log[0].new_values).name).toBe('Master U bis');

    // No-op : aucune trace superflue.
    const noop = updateMaster(db, uid, f.master2Id, {
      code: 'M-U',
      name: 'Master U bis',
      filiere: 'Pénal',
      academic_year_id: f.yearId,
      semester_id: f.sem2Id,
    });
    expect(noop.ok).toBe(true);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'master' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);

    // Code d'un autre master (casse différente) → refus champ code.
    const steal = updateMaster(db, uid, f.master2Id, {
      code: 'm-T',
      name: 'Master U bis',
      academic_year_id: f.yearId,
    });
    expect(steal.ok).toBe(false);
    if (!steal.ok) expect(steal.fields?.[0].field).toBe('code');
  });

  it('setStatus : ACTIF ↔ ARCHIVE, audit UPDATE, données liées intactes', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-10-20' });
    const res = setMasterStatus(db, uid, f.masterId, 'ARCHIVE');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe('ARCHIVE');
    expect(
      get<{ c: number }>(
        db,
        'SELECT count(*) AS c FROM session s JOIN master_module mm ON mm.id = s.master_module_id WHERE mm.master_id = ?',
        f.masterId,
      )!.c,
    ).toBe(1);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'master' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);
    expect(setMasterStatus(db, uid, f.masterId, 'ACTIF').ok).toBe(true);
    expect(setMasterStatus(db, uid, f.masterId, 'GELE').ok).toBe(false);
    expect(setMasterStatus(db, uid, 9999, 'ARCHIVE').ok).toBe(false);
  });
});

describe('masters — suppression (BR-22)', () => {
  it('lié : refus + suggest ARCHIVE + linkedCount exact', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-10-20' });
    // Étudiant rattaché au groupe → compté dans linkedCount.
    run(
      db,
      "INSERT INTO student (student_group_id, full_name) VALUES (?, 'Etudiant T')",
      f.groupId,
    );
    const res = deleteMaster(db, uid, f.masterId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.suggest).toBe('ARCHIVE');
    // 1 groupe + 1 mm + 1 séance + 1 étudiant.
    expect(res.linkedCount).toBe(4);
    expect(res.error).toMatch(/suppression impossible/);
    expect(
      get(db, 'SELECT id FROM master WHERE id = ?', f.masterId),
    ).toBeDefined();
    // L'archivage suggéré fonctionne et conserve tout.
    const arch = setMasterStatus(db, uid, f.masterId, 'ARCHIVE');
    expect(arch.ok).toBe(true);
  });

  it('non lié : suppression réelle + audit DELETE', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = deleteMaster(db, uid, f.master2Id);
    expect(res.ok).toBe(true);
    expect(listMasters(db).some((x) => x.id === f.master2Id)).toBe(false);
    const del = all<{ action: string }>(
      db,
      "SELECT action FROM audit_log WHERE entity = 'master' AND action = 'DELETE'",
    );
    expect(del).toHaveLength(1);
    expect(deleteMaster(db, uid, 9999).ok).toBe(false);
  });
});

describe('masters — groupes', () => {
  it('ajout ok + audit ; doublon NOCASE refusé ; size invalide refusée', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = addGroup(db, uid, f.masterId, { name: '  G2  ', size: 25 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe('G2');
    expect(res.data.size).toBe(25);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'student_group' AND action = 'CREATE'",
      ),
    ).toHaveLength(1);

    // Doublon NOCASE dans le même master.
    const dup = addGroup(db, uid, f.masterId, { name: 'g1' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.fields?.[0].field).toBe('name');
    // Même nom dans un AUTRE master : autorisé.
    expect(
      addGroup(db, uid, f.master2Id, { name: 'G1' }).ok,
    ).toBe(true);

    for (const size of [0, -3, 2.5, 'trente' as never]) {
      const bad = addGroup(db, uid, f.masterId, { name: `B-${String(size)}`, size });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe('size');
    }
    expect(addGroup(db, uid, 9999, { name: 'Orph' }).ok).toBe(false);
  });

  it('renameGroup : renommage + audit UPDATE ; no-op sans audit ; doublon refusé', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = renameGroup(db, uid, f.groupId, { name: 'Groupe 1', size: 32 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe('Groupe 1');
    expect(res.data.size).toBe(32);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'student_group' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);

    // No-op : mêmes valeurs → aucune trace superflue.
    const noop = renameGroup(db, uid, f.groupId, { name: 'Groupe 1', size: 32 });
    expect(noop.ok).toBe(true);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'student_group' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);

    // size : NULL explicite effaçable (pas de COALESCE) — l'effectif
    // déclaré repasse à NULL avec audit.
    const erased = renameGroup(db, uid, f.groupId, { name: 'Groupe 1' });
    expect(erased.ok).toBe(true);
    if (!erased.ok) return;
    expect(erased.data.size).toBeNull();
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'student_group' AND action = 'UPDATE'",
      ),
    ).toHaveLength(2);

    addGroup(db, uid, f.masterId, { name: 'G9' });
    const dup = renameGroup(db, uid, f.groupId, { name: 'g9' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.fields?.[0].field).toBe('name');
    expect(renameGroup(db, uid, 9999, { name: 'X' }).ok).toBe(false);
  });

  it('removeGroup : lié refusé (mm.student_group_id, student, session_group) ; libre supprimé', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // Groupe libre : suppression + audit.
    const free = addGroup(db, uid, f.masterId, { name: 'Libre' });
    expect(free.ok).toBe(true);
    if (!free.ok) return;
    expect(removeGroup(db, uid, free.data.id).ok).toBe(true);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'student_group' AND action = 'DELETE'",
      ),
    ).toHaveLength(1);

    // Lié par master_module.student_group_id → refus chiffré, message « lié ».
    run(
      db,
      'UPDATE master_module SET student_group_id = ? WHERE id = ?',
      f.groupId,
      f.mmId,
    );
    let res = removeGroup(db, uid, f.groupId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.linkedCount).toBe(1);
      expect(res.error).toMatch(/lié à 1 donnée/);
      expect(res.error).toMatch(/suppression impossible/);
    }
    run(
      db,
      'UPDATE master_module SET student_group_id = NULL WHERE id = ?',
      f.mmId,
    );

    // Lié par un étudiant → refus.
    run(
      db,
      "INSERT INTO student (student_group_id, full_name) VALUES (?, 'Etu')",
      f.groupId,
    );
    res = removeGroup(db, uid, f.groupId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.linkedCount).toBe(1);
    run(db, 'DELETE FROM student');

    // Lié par session_group → refus.
    const sid = addSession(db, f, { date: '2026-11-10' });
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.groupId,
    );
    res = removeGroup(db, uid, f.groupId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.linkedCount).toBe(1);
    expect(
      get(db, 'SELECT id FROM student_group WHERE id = ?', f.groupId),
    ).toBeDefined();
    expect(removeGroup(db, uid, 9999).ok).toBe(false);
  });
});

describe('masters — master_modules', () => {
  it('attach : INSERT + audit ; doublon (module/semestre/groupe) → erreur champ module_id', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = attachModule(db, uid, f.masterId, mmInput(f));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.module_name).toBe('Module U');
    expect(res.data.professor_name).toBe('Prof Libre');
    expect(res.data.semester_label).toBe('S1');
    expect(res.data.group_name).toBeNull();
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'master_module' AND action = 'CREATE'",
      ),
    ).toHaveLength(1);

    // Doublon exact (même module, semestre, groupe NULL → COALESCE 0).
    const dup = attachModule(db, uid, f.masterId, mmInput(f));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.fields?.[0].field).toBe('module_id');
      expect(dup.fields?.[0].message).toMatch(/déjà rattaché/);
    }
    // Même module mais autre semestre → autorisé.
    expect(
      attachModule(db, uid, f.masterId, mmInput(f, { semester_id: f.sem2Id })).ok,
    ).toBe(true);
    // Même module même semestre mais groupe différent → autorisé,
    // group_name joint et non null.
    const grouped = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { student_group_id: f.groupId }),
    );
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(grouped.data.group_name).toBe('G1');
  });

  it('groupe d’un autre master refusé ; refs inexistantes rejetées', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const otherGroup = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'Autre')",
        f.master2Id,
      ).lastInsertRowid,
    );
    const wrong = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { student_group_id: otherGroup }),
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.fields?.[0].field).toBe('student_group_id');
      expect(wrong.fields?.[0].message).toMatch(/n'appartient pas/);
    }

    // Semestre existant mais d'une AUTRE année que celle du master → refusé
    // (même contrôle que validateMaster).
    const wrongYear = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { semester_id: f.year2SemId }),
    );
    expect(wrongYear.ok).toBe(false);
    if (!wrongYear.ok) {
      expect(wrongYear.fields?.[0].field).toBe('semester_id');
      expect(wrongYear.fields?.[0].message).toMatch(/année/);
    }

    for (const [key, val] of [
      ['module_id', 9999],
      ['semester_id', 9999],
      ['professor_id', 9999],
    ] as const) {
      const bad = attachModule(
        db,
        uid,
        f.masterId,
        mmInput(f, { [key]: val } as Partial<MasterModuleInput>),
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe(key);
    }
    expect(attachModule(db, uid, 9999, mmInput(f)).ok).toBe(false);
  });

  it('sched_start >= sched_end, dates invalides, volumes ≤ 0 : refusés', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const inverted = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { sched_start: '2027-06-30', sched_end: '2027-02-01' }),
    );
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.fields?.[0].field).toBe('sched_end');

    const equal = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { sched_start: '2027-02-01', sched_end: '2027-02-01' }),
    );
    expect(equal.ok).toBe(false);

    const badDate = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { sched_start: '2027-02-30' }),
    );
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.fields?.[0].field).toBe('sched_start');

    // Volumes : 0, négatif et non-entier refusés.
    for (const volume_min of [0, -90, 2.5]) {
      const bad = attachModule(db, uid, f.masterId, mmInput(f, { volume_min }));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe('volume_min');
    }
    for (const session_duration_min of [0, -30, 1.5]) {
      const bad = attachModule(
        db,
        uid,
        f.masterId,
        mmInput(f, { session_duration_min }),
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe('session_duration_min');
    }
    for (const planned_sessions of [0, -2, 3.5]) {
      const bad = attachModule(
        db,
        uid,
        f.masterId,
        mmInput(f, { planned_sessions }),
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe('planned_sessions');
    }

    const d0 = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { session_duration_min: 0 }),
    );
    expect(d0.ok).toBe(false);
    if (!d0.ok) expect(d0.fields?.[0].field).toBe('session_duration_min');

    const d481 = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { session_duration_min: 481 }),
    );
    expect(d481.ok).toBe(false);
    expect(
      attachModule(db, uid, f.masterId, mmInput(f, { session_duration_min: 480 })).ok,
    ).toBe(true);

    const p0 = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { planned_sessions: 0 }),
    );
    expect(p0.ok).toBe(false);
    if (!p0.ok) expect(p0.fields?.[0].field).toBe('planned_sessions');

    const badJson = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { semester_id: f.sem2Id, distribution_rule: '{oops' }),
    );
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.fields?.[0].field).toBe('distribution_rule');

    // JSON valide mais non-objet (scalaire, 'null') : refusé aussi.
    for (const rule of ['42', '"texte"', 'null']) {
      const scalar = attachModule(
        db,
        uid,
        f.masterId,
        mmInput(f, { semester_id: f.sem2Id, distribution_rule: rule }),
      );
      expect(scalar.ok).toBe(false);
      if (!scalar.ok)
        expect(scalar.fields?.[0].field).toBe('distribution_rule');
    }
    // Objet JSON valide → accepté.
    const goodJson = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, {
        semester_id: f.sem2Id,
        student_group_id: f.groupId,
        distribution_rule: '{"pref":"matin"}',
      }),
    );
    expect(goodJson.ok).toBe(true);
  });

  it('update partiel : UPDATE + audit ; doublon vers un mm existant refusé', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = updateMasterModule(db, uid, f.mmId, {
      module_id: f.modId,
      semester_id: f.semId,
      professor_id: f.prof2Id, // changé
      volume_min: 900, // changé
      session_duration_min: 60,
      planned_sessions: 15,
      sched_start: '2026-09-01',
      sched_end: '2027-01-31',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.professor_name).toBe('Prof Libre');
    expect(res.data.volume_min).toBe(900);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'master_module' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);

    // Collision avec le mm de la fixture (même module/semestre/groupe NULL).
    const other = attachModule(db, uid, f.masterId, mmInput(f));
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const clash = updateMasterModule(db, uid, other.data.id, {
      ...mmInput(f),
      module_id: f.modId,
      student_group_id: null,
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.fields?.[0].field).toBe('module_id');
    expect(updateMasterModule(db, uid, 9999, mmInput(f)).ok).toBe(false);
  });

  it('detach : lié à des séances refusé (message explicite) ; libre → DELETE + audit', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-10-20' });
    addSession(db, f, { date: '2026-10-21' });
    const linked = detachModule(db, uid, f.mmId);
    expect(linked.ok).toBe(false);
    if (!linked.ok) {
      expect(linked.linkedCount).toBe(2);
      expect(linked.error).toMatch(/supprimez d'abord/);
    }
    expect(
      get(db, 'SELECT id FROM master_module WHERE id = ?', f.mmId),
    ).toBeDefined();

    // BR-22 porte sur TOUTES les séances, y compris ANNULEE : un mm dont la
    // seule séance est annulée reste bloqué (historique à préserver).
    const mm2 = attachModule(
      db,
      uid,
      f.masterId,
      mmInput(f, { semester_id: f.sem2Id }),
    );
    expect(mm2.ok).toBe(true);
    if (!mm2.ok) return;
    addSession(db, f, {
      mmId: mm2.data.id,
      date: '2026-10-23',
      status: 'ANNULEE',
    });
    const onlyCancelled = detachModule(db, uid, mm2.data.id);
    expect(onlyCancelled.ok).toBe(false);
    if (!onlyCancelled.ok) {
      expect(onlyCancelled.linkedCount).toBe(1);
      expect(onlyCancelled.error).toMatch(/supprimez d'abord/);
    }
    run(db, 'DELETE FROM session WHERE master_module_id = ?', mm2.data.id);

    const free = attachModule(db, uid, f.masterId, mmInput(f));
    expect(free.ok).toBe(true);
    if (!free.ok) return;
    expect(detachModule(db, uid, free.data.id).ok).toBe(true);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'master_module' AND action = 'DELETE'",
      ),
    ).toHaveLength(1);
    expect(detachModule(db, uid, 9999).ok).toBe(false);
  });
});

describe('masters — mutations refusées sur master ARCHIVE', () => {
  it('les 6 mutations groupes/master_modules refusées avec erreur champ status', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    setMasterStatus(db, uid, f.masterId, 'ARCHIVE');

    // Groupe libre et mm libre (créés directement) pour les cas update/delete.
    const freeGroup = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'Libre')",
        f.masterId,
      ).lastInsertRowid,
    );

    const add = addGroup(db, uid, f.masterId, { name: 'Nouveau' });
    expect(add.ok).toBe(false);
    if (!add.ok) {
      expect(add.fields?.[0].field).toBe('status');
      expect(add.error).toMatch(/archivé/);
    }

    const rename = renameGroup(db, uid, f.groupId, { name: 'Autre nom' });
    expect(rename.ok).toBe(false);
    if (!rename.ok) expect(rename.fields?.[0].field).toBe('status');

    const rem = removeGroup(db, uid, freeGroup);
    expect(rem.ok).toBe(false);
    if (!rem.ok) expect(rem.fields?.[0].field).toBe('status');

    const att = attachModule(db, uid, f.masterId, mmInput(f));
    expect(att.ok).toBe(false);
    if (!att.ok) expect(att.fields?.[0].field).toBe('status');

    const upd = updateMasterModule(db, uid, f.mmId, {
      module_id: f.modId,
      semester_id: f.semId,
      professor_id: f.profId,
      volume_min: 600,
      session_duration_min: 90,
      planned_sessions: 5,
      sched_start: '2026-09-01',
      sched_end: '2027-01-31',
    });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.fields?.[0].field).toBe('status');

    const det = detachModule(db, uid, f.mmId);
    expect(det.ok).toBe(false);
    if (!det.ok) expect(det.fields?.[0].field).toBe('status');

    // Rien n'a été écrit.
    expect(all(db, 'SELECT id FROM audit_log')).toHaveLength(1); // le setStatus seul
    // Réactivation → les mutations repassent.
    setMasterStatus(db, uid, f.masterId, 'ACTIF');
    expect(addGroup(db, uid, f.masterId, { name: 'Nouveau' }).ok).toBe(true);
    expect(attachModule(db, uid, f.masterId, mmInput(f)).ok).toBe(true);
  });
});

describe('masters — fiche de suivi (getMasterDetail)', () => {
  it('jointures + compteurs AD-7 (borne date == today incluse)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // 2 REALISEE (dont une avec actual_*), 2 PREVUE futures (dont aujourd'hui),
    // 1 PREVUE passée, 1 ANNULEE, 1 REPORTEE.
    addSession(db, f, {
      date: '2026-10-05',
      status: 'REALISEE',
      actualStart: 480,
      actualEnd: 540,
    });
    addSession(db, f, { date: '2026-10-06', status: 'REALISEE' });
    addSession(db, f, { date: '2026-10-20' });
    addSession(db, f, { date: TODAY }); // borne inclusive → restante
    addSession(db, f, { date: '2026-10-14' }); // hier → non réalisée
    addSession(db, f, { date: '2026-10-07', status: 'ANNULEE' });
    addSession(db, f, { date: '2026-10-08', status: 'REPORTEE' });

    const res = getMasterDetail(db, f.masterId, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.data.master;
    expect(m.name).toBe('Master T');
    expect(m.nb_realisees).toBe(2);
    expect(m.nb_restantes).toBe(2);
    expect(m.nb_non_realisees).toBe(1);
    expect(m.nb_annulees).toBe(1);
    expect(m.nb_reportees).toBe(1);
    // 60 (actual) + 90 (repli planifié).
    expect(m.heures_enseignees_min).toBe(150);

    expect(res.data.groups).toEqual([
      expect.objectContaining({ name: 'G1', size: 30, linkedCount: 0 }),
    ]);
    expect(res.data.modules).toHaveLength(1);
    expect(res.data.modules[0]).toMatchObject({
      module_code: 'MOD-T',
      module_name: 'Module T',
      professor_name: 'Prof Test',
      semester_label: 'S1',
      group_name: null,
      volume_min: 1200,
      session_duration_min: 90,
      planned_sessions: 10,
      sched_start: '2026-09-01',
      sched_end: '2027-01-31',
      session_count: 7,
      nb_seances: 6, // ANNULEE exclue
    });
    expect(m.linkedCount).toBe(1 + 1 + 7);

    // 20 prochaines : passées exclues, ordre chronologique.
    expect(res.data.upcoming.length).toBeGreaterThanOrEqual(2);
    expect(res.data.upcoming.every((s) => s.date >= TODAY)).toBe(true);
    const dates = res.data.upcoming.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
    expect(res.data.upcoming[0].professor_name).toBe('Prof Test');
    expect(res.data.upcoming[0].room_name).toBe('Salle T');
  });

  it('limite 20 sur les prochaines ; master inexistant → ok:false', () => {
    const db = freshDb();
    const f = seedFixture(db);
    for (let i = 0; i < 25; i++) {
      addSession(db, f, {
        date: `2026-11-${String(1 + i).padStart(2, '0')}`,
        start: 480 + i,
        end: 570 + i,
      });
    }
    const res = getMasterDetail(db, f.masterId, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.upcoming).toHaveLength(20);
    expect(getMasterDetail(db, 9999).ok).toBe(false);
  });
});

describe('masters — context:semesters', () => {
  it('retourne années + semestres triés', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const ctx = collectContextSemesters(db);
    expect(ctx.academicYears).toEqual([
      { id: f.yearId, label: '2026-2027', is_current: 1 },
      { id: f.year2Id, label: '2027-2028', is_current: 0 },
    ]);
    expect(ctx.semesters.map((s) => s.label)).toEqual(['S1', 'S2', 'S1']);
    expect(ctx.semesters[0].academic_year_id).toBe(f.yearId);
    expect(ctx.semesters[2].academic_year_id).toBe(f.year2Id);
  });
});

describe('masters — garde IPC (composition des handlers)', () => {
  it('requireRole ADMIN : mutations refusées en GESTIONNAIRE, acceptées en ADMIN', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    const adminUser = admin(db);
    // Cibles libres pour les mutations update/delete de groupes/mm.
    const freeGroupId = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'G9')",
        f.masterId,
      ).lastInsertRowid,
    );
    let attachedMmId = 0;
    // Les 10 mutations du handler `masters:*` : chacune doit exiger ADMIN.
    const mutations: ((
      d: DatabaseSync,
    ) => ApiResult<unknown> | DeleteResult)[] = [
      (d: DatabaseSync) =>
        createMaster(d, currentUserId(d), {
          code: 'M-R',
          name: 'Master R',
          academic_year_id: f.yearId,
        }),
      (d: DatabaseSync) =>
        updateMaster(d, currentUserId(d), f.master2Id, {
          code: 'M-U',
          name: 'Master U',
          academic_year_id: f.yearId,
        }),
      (d: DatabaseSync) =>
        setMasterStatus(d, currentUserId(d), f.master2Id, 'ARCHIVE'),
      (d: DatabaseSync) =>
        addGroup(d, currentUserId(d), f.masterId, { name: 'GR' }),
      (d: DatabaseSync) =>
        renameGroup(d, currentUserId(d), freeGroupId, { name: 'G9b' }),
      (d: DatabaseSync) =>
        removeGroup(d, currentUserId(d), freeGroupId),
      (d: DatabaseSync) => {
        const r = attachModule(d, currentUserId(d), f.masterId, mmInput(f));
        if (r.ok) attachedMmId = r.data.id;
        return r;
      },
      (d: DatabaseSync) =>
        updateMasterModule(d, currentUserId(d), attachedMmId, mmInput(f)),
      (d: DatabaseSync) =>
        detachModule(d, currentUserId(d), attachedMmId),
      (d: DatabaseSync) => deleteMaster(d, currentUserId(d), f.master2Id),
    ];

    setCurrentProfile(db, gest.id);
    for (const fn of mutations) {
      const denied = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toMatch(/Administrateur/);
    }
    // Aucune mutation n'a eu lieu.
    expect(listMasters(db)).toHaveLength(2);
    expect(all(db, 'SELECT id FROM audit_log')).toHaveLength(0);

    setCurrentProfile(db, adminUser.id);
    for (const fn of mutations) {
      const allowed = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(allowed.ok).toBe(true);
    }
  });

  it('payloads invalides rejetés avec erreurs {field,message} (pas de TypeError)', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);

    const badCode = createMaster(db, uid, {
      code: 42,
      name: 'X',
      academic_year_id: f.yearId,
    } as never);
    expect(badCode.ok).toBe(false);
    if (!badCode.ok) expect(badCode.fields?.[0].field).toBe('code');

    const badYear = createMaster(db, uid, {
      code: 'M-Z',
      name: 'Z',
      academic_year_id: 'année',
    } as never);
    expect(badYear.ok).toBe(false);
    if (!badYear.ok) expect(badYear.fields?.[0].field).toBe('academic_year_id');

    const badName = addGroup(db, uid, f.masterId, { name: 7 } as never);
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.fields?.[0].field).toBe('name');

    const badMm = attachModule(db, uid, f.masterId, {
      module_id: 'MOD',
      semester_id: f.semId,
      professor_id: f.profId,
      volume_min: 'beaucoup',
      session_duration_min: 90,
      planned_sessions: 5,
      sched_start: '2026-09-01',
      sched_end: '2027-01-31',
    } as never);
    expect(badMm.ok).toBe(false);
    if (!badMm.ok) {
      expect(badMm.fields?.map((x) => x.field)).toEqual(
        expect.arrayContaining(['module_id', 'volume_min']),
      );
    }

    // Rien n'a été écrit par les payloads forgés.
    expect(listMasters(db)).toHaveLength(2);
    expect(
      all(db, "SELECT id FROM student_group WHERE master_id = ? AND name != 'G1'", f.masterId),
    ).toHaveLength(0);
  });
});

describe('masters — temps_amenage (P14)', () => {
  it('create/update : flag 0/1 persisté, listé ; valeur forgée → FieldError', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);

    // Création sans flag → 0 par défaut.
    const created = createMaster(db, uid, {
      code: 'M-TA',
      name: 'Master TA',
      academic_year_id: f.yearId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.temps_amenage).toBe(0);

    // Création explicite à 1.
    const paid = createMaster(db, uid, {
      code: 'M-TP',
      name: 'Master TP',
      academic_year_id: f.yearId,
      temps_amenage: true,
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.data.temps_amenage).toBe(1);

    // Update : bascule 1 → 0 puis 0 → 1.
    const off = updateMaster(db, uid, paid.data.id, {
      code: 'M-TP',
      name: 'Master TP',
      academic_year_id: f.yearId,
      temps_amenage: false,
    });
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.data.temps_amenage).toBe(0);
    const on = updateMaster(db, uid, paid.data.id, {
      code: 'M-TP',
      name: 'Master TP',
      academic_year_id: f.yearId,
      temps_amenage: true,
    });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.data.temps_amenage).toBe(1);
    // flag visible dans la liste
    const listed = listMasters(db).find((m) => m.id === paid.data.id);
    expect(listed?.temps_amenage).toBe(1);
    // et dans le détail
    const detail = getMasterDetail(db, paid.data.id, TODAY);
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.data.master.temps_amenage).toBe(1);

    // Valeurs forgées rejetées en FieldError (champ temps_amenage).
    for (const forged of ['oui', 2, 1.5, {}]) {
      const bad = createMaster(db, uid, {
        code: 'M-F',
        name: 'Forged',
        academic_year_id: f.yearId,
        temps_amenage: forged,
      } as never);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.fields?.[0].field).toBe('temps_amenage');
    }
  });

  it('import : colonne optionnelle — absente/valeur 0-1 OK, valeur invalide rejetée', () => {
    const db = freshDb();
    const uid = admin(db).id;
    seedFixture(db);

    // Sans la colonne → 0.
    let applied = applyImport(
      db,
      uid,
      'masters',
      'code;nom\nM-NC;Sans colonne',
      'IGNORER',
    );
    expect(applied.ok).toBe(true);
    expect(
      get(db, "SELECT temps_amenage FROM master WHERE code = 'M-NC'")
        ?.temps_amenage,
    ).toBe(0);

    // Avec la colonne à 1.
    applied = applyImport(
      db,
      uid,
      'masters',
      'code;nom;temps_amenage(0/1)\nM-PC;Payant;1',
      'IGNORER',
    );
    expect(applied.ok).toBe(true);
    expect(
      get(db, "SELECT temps_amenage FROM master WHERE code = 'M-PC'")
        ?.temps_amenage,
    ).toBe(1);

    // Colonne à 0.
    applied = applyImport(
      db,
      uid,
      'masters',
      'code;nom;temps_amenage(0/1)\nM-PU;Payant 0;0',
      'IGNORER',
    );
    expect(applied.ok).toBe(true);
    expect(
      get(db, "SELECT temps_amenage FROM master WHERE code = 'M-PU'")
        ?.temps_amenage,
    ).toBe(0);

    // Valeur invalide : ligne en erreur au preview ET ignorée à l'apply.
    const bad = previewImport(
      db,
      'masters',
      'code;nom;temps_amenage(0/1)\nM-BAD;Bad;oui',
    );
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      expect(bad.data.rows[0].status).toBe('ERREUR');
      expect(bad.data.rows[0].errors.length).toBeGreaterThan(0);
    }
    const res = applyImport(
      db,
      uid,
      'masters',
      'code;nom;temps_amenage(0/1)\nM-BAD;Bad;oui',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.inserted).toBe(0);
      expect(res.data.errors.length).toBe(1);
    }
    expect(
      get(db, "SELECT id FROM master WHERE code = 'M-BAD'"),
    ).toBeUndefined();
  });

  it('export : temps_amenage en dernière colonne (0/1)', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const created = createMaster(db, uid, {
      code: 'M-XP',
      name: 'Export payant',
      academic_year_id: f.yearId,
      temps_amenage: true,
    });
    expect(created.ok).toBe(true);
    const res = exportEntity(db, 'masters');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columns[res.data.columns.length - 1].label).toBe(
      'temps_amenage(0/1)',
    );
    const row = res.data.rows.find((r) => r['code'] === 'M-XP');
    expect(row).toBeDefined();
    expect(Number(row!['temps_amenage'])).toBe(1);
    const freeRow = res.data.rows.find((r) => r['code'] === 'M-T');
    expect(freeRow).toBeDefined();
    expect(Number(freeRow!['temps_amenage'])).toBe(0);
  });
});
