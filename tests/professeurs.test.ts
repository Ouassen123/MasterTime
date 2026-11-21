/**
 * Tests P6b — service Professeurs (CRUD, compteurs de suivi AD-7,
 * disponibilités, absences BR-17) sur base temporaire `:memory:` —
 * aucun Electron. Les handlers IPC sont couverts via la composition
 * `guard(..., { requireRole: 'ADMIN' })` utilisée par `ipc/professors.ts`.
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
  addAbsence,
  addAvailability,
  createProfessor,
  deleteProfessor,
  getProfessorDetail,
  listAbsences,
  listAvailabilities,
  listProfessors,
  removeAbsence,
  removeAvailability,
  setProfessorActive,
  updateProfessor,
} from '../electron/main/db/professor.service';
import { currentUserId, guard } from '../electron/main/ipc/helpers';
import type { AppUser } from '../shared/types';

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
  profId: number;
  prof2Id: number;
  mmId: number;
  roomId: number;
}

/** Référentiel minimal : année, semestre, master, module, salle, 2 profs. */
function seedFixture(db: DatabaseSync): Fixture {
  const year = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
    ).lastInsertRowid,
  );
  const sem = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S1', 1)",
      year,
    ).lastInsertRowid,
  );
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T', 'Master T', ?, ?)",
      year,
      sem,
    ).lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')")
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
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, volume_min,
          session_duration_min, planned_sessions, sched_start, sched_end)
       VALUES (?, ?, ?, ?, 1200, 90, 10, '2026-09-01', '2027-01-31')`,
      masterId,
      modId,
      sem,
      profId,
    ).lastInsertRowid,
  );
  return { profId, prof2Id, mmId, roomId };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  opts: {
    profId?: number;
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
      f.mmId,
      opts.profId ?? f.profId,
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

describe('migration 0004 — professor.is_active', () => {
  it('colonne présente, défaut 1', () => {
    const db = freshDb();
    const cols = all<{ name: string }>(db, "PRAGMA table_info(professor)");
    expect(cols.some((c) => c.name === 'is_active')).toBe(true);
    const f = seedFixture(db);
    expect(
      get<{ is_active: number }>(
        db,
        'SELECT is_active FROM professor WHERE id = ?',
        f.profId,
      )!.is_active,
    ).toBe(1);
  });
});

describe('professeurs — CRUD', () => {
  it('créer : INSERT + audit CREATE, champs normalisés', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const res = createProfessor(db, uid, {
      full_name: '  Prof Alami  ',
      internal_ref: 'P-01',
      email: 'alami@fsjp.ma',
      phone: '0600000000',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.full_name).toBe('Prof Alami');
    expect(res.data.is_active).toBe(1);
    expect(res.data.is_demo).toBe(0);

    const log = all<{ action: string; entity: string; new_values: string }>(
      db,
      "SELECT action, entity, new_values FROM audit_log WHERE entity = 'professor'",
    );
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('CREATE');
    expect(JSON.parse(log[0].new_values)).toMatchObject({
      full_name: 'Prof Alami',
      internal_ref: 'P-01',
    });
  });

  it('doublon de nom NOCASE : refus avec erreur champ full_name', () => {
    const db = freshDb();
    const uid = admin(db).id;
    createProfessor(db, uid, { full_name: 'Prof Bennis' });
    const dup = createProfessor(db, uid, { full_name: 'prof bennis' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.fields?.[0].field).toBe('full_name');
    expect(
      listProfessors(db).filter((p) => p.full_name === 'Prof Bennis'),
    ).toHaveLength(1);
  });

  it('nom vide / email invalide : erreurs de champs, aucune écriture', () => {
    const db = freshDb();
    const empty = createProfessor(db, null, { full_name: '  ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.fields?.[0].field).toBe('full_name');

    const badMail = createProfessor(db, null, {
      full_name: 'Prof X',
      email: 'pas-un-email',
    });
    expect(badMail.ok).toBe(false);
    if (!badMail.ok) expect(badMail.fields?.[0].field).toBe('email');
    expect(listProfessors(db)).toHaveLength(0);
  });

  it('modifier : UPDATE + audit old/new', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const created = createProfessor(db, uid, { full_name: 'Prof Avant' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = updateProfessor(db, uid, created.data.id, {
      full_name: 'Prof Après',
      email: 'apres@fsjp.ma',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.full_name).toBe('Prof Après');
    const log = all<{ old_values: string; new_values: string }>(
      db,
      "SELECT old_values, new_values FROM audit_log WHERE entity = 'professor' AND action = 'UPDATE'",
    );
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].old_values).full_name).toBe('Prof Avant');
    expect(JSON.parse(log[0].new_values).full_name).toBe('Prof Après');
  });

  it('suppression refusée si lié (master_module, séance, absence) — BR-22', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // Lié par master_module seul : refus chiffré.
    let res = deleteProfessor(db, uid, f.profId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/suppression impossible/);

    // Lié aussi par séance et absence : toujours refusé, rien supprimé.
    addSession(db, f, { date: '2026-10-20' });
    addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-11-03',
    });
    res = deleteProfessor(db, uid, f.profId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/désactiver/);
    expect(
      get(db, 'SELECT id FROM professor WHERE id = ?', f.profId),
    ).toBeDefined();
  });

  it('suppression d’un professeur libre : DELETE + audit', () => {
    const db = freshDb();
    const uid = admin(db).id;
    seedFixture(db);
    const created = createProfessor(db, uid, { full_name: 'Prof Solo' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = deleteProfessor(db, uid, created.data.id);
    expect(res.ok).toBe(true);
    expect(
      listProfessors(db).some((p) => p.full_name === 'Prof Solo'),
    ).toBe(false);
    const del = all<{ action: string }>(
      db,
      "SELECT action FROM audit_log WHERE entity = 'professor' AND action = 'DELETE'",
    );
    expect(del).toHaveLength(1);
  });

  it('setActive : is_active bascule, données liées intactes, audit UPDATE', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-10-20' });
    const res = setProfessorActive(db, uid, f.profId, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.is_active).toBe(0);
    expect(
      get<{ c: number }>(
        db,
        'SELECT count(*) AS c FROM session WHERE professor_id = ?',
        f.profId,
      )!.c,
    ).toBe(1);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'professor' AND action = 'UPDATE'",
      ),
    ).toHaveLength(1);
    // Réactivation
    expect(setProfessorActive(db, uid, f.profId, true).ok).toBe(true);
  });
});

describe('professeurs — compteurs (AD-7)', () => {
  it('statuts exacts : réalisées/restantes/non réalisées/annulées/reportées, heures', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // 2 REALISEE : l'une avec actual_* (60 min comptées), l'autre sans (repli 90).
    addSession(db, f, {
      date: '2026-10-05',
      status: 'REALISEE',
      actualStart: 480,
      actualEnd: 540,
    });
    addSession(db, f, { date: '2026-10-06', status: 'REALISEE' });
    // 2 PREVUE futures → restantes ; 1 PREVUE passée → non réalisée.
    addSession(db, f, { date: '2026-10-20' });
    addSession(db, f, { date: '2026-10-22' });
    addSession(db, f, { date: '2026-10-10' });
    // 1 ANNULEE + 1 REPORTEE — jamais comptées réalisées.
    addSession(db, f, { date: '2026-10-07', status: 'ANNULEE' });
    addSession(db, f, { date: '2026-10-08', status: 'REPORTEE' });
    run(
      db,
      "INSERT INTO professor_absence (professor_id, start_date, end_date) VALUES (?, '2026-09-01', '2026-09-02')",
      f.profId,
    );

    const row = listProfessors(db, undefined, TODAY).find(
      (p) => p.id === f.profId,
    )!;
    expect(row.nb_realisees).toBe(2);
    expect(row.nb_restantes).toBe(2);
    expect(row.nb_non_realisees).toBe(1);
    expect(row.nb_annulees).toBe(1);
    expect(row.nb_reportees).toBe(1);
    // 60 (actual) + 90 (repli planifié) — l'annulée n'apporte aucune heure.
    expect(row.heures_enseignees_min).toBe(150);
    expect(row.nb_absences).toBe(1);
    expect(row.masters).toEqual(['Master T']);
    expect(row.linkedCount).toBe(1 /* mm */ + 7 /* sessions */ + 1 /* absence */);

    // Prof sans aucune séance : compteurs à zéro.
    const libre = listProfessors(db, undefined, TODAY).find(
      (p) => p.id === f.prof2Id,
    )!;
    expect(libre.nb_realisees).toBe(0);
    expect(libre.heures_enseignees_min).toBe(0);
    expect(libre.masters).toEqual([]);
  });

  it('recherche : nom, référence interne, email (sous-chaîne, casse ignorée)', () => {
    const db = freshDb();
    const uid = admin(db).id;
    createProfessor(db, uid, {
      full_name: 'Prof Alami',
      internal_ref: 'REF-1',
      email: 'alami@fsjp.ma',
    });
    createProfessor(db, uid, { full_name: 'Prof Bennis', internal_ref: 'REF-2' });
    expect(listProfessors(db, 'alami')).toHaveLength(1);
    expect(listProfessors(db, 'REF-2')).toHaveLength(1);
    expect(listProfessors(db, 'FSJP.MA')).toHaveLength(1);
    expect(listProfessors(db, 'inexistant')).toHaveLength(0);
  });
});

describe('professeurs — fiche de suivi (getProfessorDetail)', () => {
  it('enseignements, dispos, absences, 20 prochaines séances', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // 25 séances futures + 1 passée (exclue des "prochaines").
    for (let i = 0; i < 25; i++) {
      addSession(db, f, {
        date: `2026-11-${String(1 + i).padStart(2, '0')}`,
        start: 480 + i,
        end: 570 + i,
      });
    }
    addSession(db, f, { date: '2026-10-01' });
    addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    });
    addAbsence(db, uid, f.profId, {
      start_date: '2026-11-05',
      end_date: '2026-11-06',
    });

    const res = getProfessorDetail(db, f.profId, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.professor.full_name).toBe('Prof Test');
    expect(res.data.teachings).toEqual([
      { master_code: 'M-T', master_name: 'Master T', module_name: 'Module T' },
    ]);
    expect(res.data.availabilities).toHaveLength(1);
    expect(res.data.absences).toHaveLength(1);
    expect(res.data.upcoming).toHaveLength(20); // limite, passée exclue
    expect(res.data.upcoming[0].date).toBe('2026-11-01');
    expect(res.data.upcoming[0].module_name).toBe('Module T');
    expect(res.data.upcoming[0].room_name).toBe('Salle T');
    // Ordre chronologique
    const dates = res.data.upcoming.map((s) => s.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('id inexistant → ok:false', () => {
    const db = freshDb();
    const res = getProfessorDetail(db, 9999);
    expect(res.ok).toBe(false);
  });
});

describe('professeurs — disponibilités', () => {
  it('ajout ok + audit, listage trié par jour/heure', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const res = addAvailability(db, uid, f.profId, {
      weekday: 2,
      start_min: 840,
      end_min: 1020,
      kind: 'INDISPO',
      effective_from: '2026-11-01',
      effective_to: '2026-12-31',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.kind).toBe('INDISPO');
    expect(listAvailabilities(db, f.profId)).toHaveLength(1);
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'professor_availability' AND action = 'CREATE'",
      ),
    ).toHaveLength(1);
  });

  it('chevauchement même kind refusé ; kind différent accepté', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    });
    const overlap = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 900,
      kind: 'DISPO',
    });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.fields?.[0].field).toBe('start_min');

    const otherKind = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 900,
      kind: 'INDISPO',
    });
    expect(otherKind.ok).toBe(true);

    const otherDay = addAvailability(db, uid, f.profId, {
      weekday: 1,
      start_min: 600,
      end_min: 900,
      kind: 'DISPO',
    });
    expect(otherDay.ok).toBe(true);
  });

  it('weekday invalide, start>=end, effective inversé : refusés', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    for (const weekday of [-1, 7, 1.5]) {
      const res = addAvailability(db, uid, f.profId, {
        weekday,
        start_min: 480,
        end_min: 720,
        kind: 'DISPO',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.fields?.[0].field).toBe('weekday');
    }
    const badTime = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 720,
      end_min: 480,
      kind: 'DISPO',
    });
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) expect(badTime.fields?.[0].field).toBe('end_min');

    const badRange = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
      effective_from: '2026-12-31',
      effective_to: '2026-01-01',
    });
    expect(badRange.ok).toBe(false);
    if (!badRange.ok) expect(badRange.fields?.[0].field).toBe('effective_to');
    expect(listAvailabilities(db, f.profId)).toHaveLength(0);
  });

  it('suppression : DELETE + audit', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const created = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = removeAvailability(db, uid, created.data.id);
    expect(res.ok).toBe(true);
    expect(listAvailabilities(db, f.profId)).toHaveLength(0);
    expect(removeAvailability(db, uid, 9999).ok).toBe(false);
  });
});

describe('professeurs — absences (BR-17)', () => {
  it('ajout ok : séances PREVUE impactées retournées, AUCUNE annulée', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // 2 PREVUE dans la fenêtre, 1 hors fenêtre, 1 déjà REALISEE (non impactée).
    const inA = addSession(db, f, { date: '2026-11-02' });
    const inB = addSession(db, f, { date: '2026-11-04' });
    addSession(db, f, { date: '2026-12-01' });
    addSession(db, f, { date: '2026-11-03', status: 'REALISEE' });

    const res = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-11-05',
      reason: 'Convention internationale',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.absence.resolution).toBe('A_TRAITER');
    expect(res.data.impacted.map((s) => s.id).sort()).toEqual(
      [inA, inB].sort(),
    );
    expect(res.data.impacted[0].status).toBe('PREVUE');
    expect(res.data.impacted[0].module_name).toBe('Module T');

    // BR-17 : toutes les séances restent PREVUE — aucune annulation auto.
    const statuses = all<{ status: string }>(
      db,
      'SELECT status FROM session WHERE professor_id = ?',
      f.profId,
    );
    expect(statuses.filter((s) => s.status === 'ANNULEE')).toHaveLength(0);
    expect(listAbsences(db, f.profId)).toHaveLength(1);
    // Compteur nb_absences vu par la liste.
    expect(
      listProfessors(db, undefined, TODAY).find((p) => p.id === f.profId)!
        .nb_absences,
    ).toBe(1);
  });

  it('dates invalides : format ou ordre refusés, aucune écriture', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const badFormat = addAbsence(db, uid, f.profId, {
      start_date: '01/11/2026',
      end_date: '2026-11-05',
    });
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) expect(badFormat.fields?.[0].field).toBe('start_date');

    const inverted = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-05',
      end_date: '2026-11-01',
    });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.fields?.[0].field).toBe('end_date');
    expect(listAbsences(db, f.profId)).toHaveLength(0);
  });

  it('suppression : DELETE + audit', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const created = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-11-02',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(removeAbsence(db, uid, created.data.absence.id).ok).toBe(true);
    expect(listAbsences(db, f.profId)).toHaveLength(0);
    expect(removeAbsence(db, uid, 9999).ok).toBe(false);
  });
});

describe('professeurs — garde IPC (composition des handlers)', () => {
  it('requireRole ADMIN : création refusée en GESTIONNAIRE, acceptée en ADMIN', () => {
    const db = freshDb();
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    setCurrentProfile(db, gest.id);
    // Même composition que ipcMain.handle('professors:create').
    const denied = guard(
      () => db,
      (d) => createProfessor(d, currentUserId(d), { full_name: 'Prof G' }),
      { requireRole: 'ADMIN' },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/Administrateur/);
    expect(listProfessors(db)).toHaveLength(0);

    setCurrentProfile(db, admin(db).id);
    const allowed = guard(
      () => db,
      (d) => createProfessor(d, currentUserId(d), { full_name: 'Prof G' }),
      { requireRole: 'ADMIN' },
    );
    expect(allowed.ok).toBe(true);
  });

  it('payloads invalides rejetés côté service : aucune écriture', () => {
    const db = freshDb();
    const uid = admin(db).id;
    // Types erronés possibles après désérialisation IPC.
    expect(
      createProfessor(db, uid, {} as never).ok,
    ).toBe(false);
    expect(
      updateProfessor(db, uid, 1, { full_name: '' }).ok,
    ).toBe(false);
    expect(
      addAvailability(db, uid, 1, {
        weekday: 'lundi' as never,
        start_min: 480,
        end_min: 720,
        kind: 'DISPO',
      }).ok,
    ).toBe(false);
    expect(
      addAbsence(db, uid, 1, { start_date: '', end_date: '' }).ok,
    ).toBe(false);
    expect(listProfessors(db)).toHaveLength(0);
  });
});
