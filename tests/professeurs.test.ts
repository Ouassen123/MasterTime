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

  it('update : introuvable / no-op sans audit / nom propre ok / nom d’autrui refusé / is_active', () => {
    const db = freshDb();
    const uid = admin(db).id;

    // Introuvable : pas d'écriture, pas d'audit.
    expect(updateProfessor(db, uid, 9999, { full_name: 'X' }).ok).toBe(false);

    const a = createProfessor(db, uid, { full_name: 'Prof A', email: 'a@x.ma' });
    const b = createProfessor(db, uid, { full_name: 'Prof B' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Même nom conservé : le doublon ignore la ligne elle-même → accepté.
    const same = updateProfessor(db, uid, a.data.id, {
      full_name: 'Prof A',
      email: 'a@x.ma',
    });
    expect(same.ok).toBe(true);

    // No-op : UPDATE sans effet → aucune ligne audit superflue.
    expect(
      all(
        db,
        "SELECT id FROM audit_log WHERE entity = 'professor' AND action = 'UPDATE'",
      ),
    ).toHaveLength(0);

    // Nom d'un autre professeur (casse différente) → refus champ full_name.
    const steal = updateProfessor(db, uid, b.data.id, {
      full_name: 'prof a',
    });
    expect(steal.ok).toBe(false);
    if (!steal.ok) expect(steal.fields?.[0].field).toBe('full_name');

    // is_active : omis → préservé ; false strict → désactive ; true → réactive.
    setProfessorActive(db, uid, a.data.id, false);
    const kept = updateProfessor(db, uid, a.data.id, {
      full_name: 'Prof A',
    });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.data.is_active).toBe(0);

    const explicit = updateProfessor(db, uid, a.data.id, {
      full_name: 'Prof A',
      is_active: false,
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.data.is_active).toBe(0);

    const reactivated = updateProfessor(db, uid, a.data.id, {
      full_name: 'Prof A',
      is_active: true,
    });
    expect(reactivated.ok).toBe(true);
    if (reactivated.ok) expect(reactivated.data.is_active).toBe(1);
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

  it('suppression refusée si lié seulement par des disponibilités — BR-22', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const created = createProfessor(db, uid, { full_name: 'Prof Dispo' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const av = addAvailability(db, uid, created.data.id, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    });
    expect(av.ok).toBe(true);
    // FK sans CASCADE : sans linkedCount complet, le DELETE crasherait.
    const res = deleteProfessor(db, uid, created.data.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/suppression impossible/);
      expect(res.error).toMatch(/désactiver/);
    }
    expect(listAvailabilities(db, created.data.id)).toHaveLength(1);
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

  it('borne inclusive : PREVUE datée aujourd’hui = restante, hier = non réalisée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TODAY }); // date == aujourd'hui → restante
    addSession(db, f, { date: '2026-10-14' }); // hier → non réalisée
    const row = listProfessors(db, undefined, TODAY).find(
      (p) => p.id === f.profId,
    )!;
    expect(row.nb_restantes).toBe(1);
    expect(row.nb_non_realisees).toBe(1);
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
    // Jokers LIKE échappés : '%' et '_' restent littéraux.
    expect(listProfessors(db, '%')).toHaveLength(0);
    expect(listProfessors(db, '_')).toHaveLength(0);
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

  it('chevauchement même kind refusé (DISPO et INDISPO) ; autres kind/jour acceptés', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    });
    addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 840,
      end_min: 1020,
      kind: 'INDISPO',
    });

    const overlapDispo = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 900,
      kind: 'DISPO',
    });
    expect(overlapDispo.ok).toBe(false);
    if (!overlapDispo.ok)
      expect(overlapDispo.fields?.[0].field).toBe('start_min');

    const overlapIndispo = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 900,
      end_min: 960,
      kind: 'INDISPO',
    });
    expect(overlapIndispo.ok).toBe(false);
    if (!overlapIndispo.ok)
      expect(overlapIndispo.fields?.[0].field).toBe('start_min');

    // Même plage qu'une DISPO existante mais kind différent → accepté.
    const otherKind = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 660,
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

  it('chevauchement : fenêtres d’effet disjointes acceptées, jointes refusées', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // DISPO bornée S1 : lun 08h-12h, sept.→déc. 2026.
    const first = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
      effective_from: '2026-09-01',
      effective_to: '2026-12-31',
    });
    expect(first.ok).toBe(true);

    // Même plage horaire, fenêtre disjointe (S2 2027) → acceptée.
    const disjoint = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
      effective_from: '2027-01-01',
      effective_to: '2027-03-31',
    });
    expect(disjoint.ok).toBe(true);

    // Fenêtre qui se joint (déc. 2026 commun) → refusée.
    const joint = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 660,
      kind: 'DISPO',
      effective_from: '2026-12-01',
      effective_to: '2027-06-30',
    });
    expect(joint.ok).toBe(false);
    if (!joint.ok) expect(joint.fields?.[0].field).toBe('start_min');

    // Sans bornes = fenêtre infinie → chevauche toute fenêtre.
    const unbounded = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 600,
      end_min: 660,
      kind: 'DISPO',
    });
    expect(unbounded.ok).toBe(false);
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

    // Borne horaire : end_min > 1440 refusé, 1440 (24h00) accepté.
    const tooLate = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 1441,
      kind: 'DISPO',
    });
    expect(tooLate.ok).toBe(false);
    if (!tooLate.ok) expect(tooLate.fields?.[0].field).toBe('end_min');
    const midnight = addAvailability(db, uid, f.profId, {
      weekday: 2,
      start_min: 480,
      end_min: 1440,
      kind: 'DISPO',
    });
    expect(midnight.ok).toBe(true);
    expect(removeAvailability(db, uid, midnight.ok ? midnight.data.id : -1).ok).toBe(true);

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

    // Format ISO correct mais date inexistante (30 février).
    const badEff = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
      effective_from: '2026-02-30',
    });
    expect(badEff.ok).toBe(false);
    if (!badEff.ok) expect(badEff.fields?.[0].field).toBe('effective_from');
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
  it('ajout ok : séances PREVUE impactées (bornes incluses), AUCUNE annulée', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    // Bornes inclusives : 1er et dernier jour de la fenêtre impactés.
    const inA = addSession(db, f, { date: '2026-11-01' });
    const inB = addSession(db, f, { date: '2026-11-05' });
    addSession(db, f, { date: '2026-12-01' }); // hors fenêtre
    addSession(db, f, { date: '2026-11-03', status: 'REALISEE' }); // non PREVUE
    const other = addSession(db, f, { date: '2026-11-02', profId: f.prof2Id });

    const res = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-11-05',
      reason: 'Convention internationale',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.absence.resolution).toBe('A_TRAITER');
    const impactedIds = res.data.impacted
      .map((s) => s.id)
      .sort((a, b) => a - b);
    expect(impactedIds).toEqual([inA, inB].sort((a, b) => a - b));
    // La séance de l'autre professeur (même fenêtre) n'est pas impactée.
    expect(impactedIds).not.toContain(other);
    expect(res.data.impacted[0].module_name).toBe('Module T');
    expect(res.data.impacted[0].room_name).toBe('Salle T');

    // BR-17 : statuts RELUS en base — tout reste PREVUE, rien d'annulé.
    const statuses = all<{ id: number; status: string }>(
      db,
      'SELECT id, status FROM session WHERE professor_id = ?',
      f.profId,
    );
    for (const s of statuses) {
      if ([inA, inB].includes(s.id)) expect(s.status).toBe('PREVUE');
    }
    expect(statuses.filter((s) => s.status === 'ANNULEE')).toHaveLength(0);
    expect(listAbsences(db, f.profId)).toHaveLength(1);
    // Compteur nb_absences vu par la liste.
    expect(
      listProfessors(db, undefined, TODAY).find((p) => p.id === f.profId)!
        .nb_absences,
    ).toBe(1);
  });

  it('absence sans séance PREVUE dans la fenêtre : impacted vide', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-12-10' });
    const res = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-11-05',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.impacted).toEqual([]);
  });

  it('dates invalides : format, calendrier ou ordre refusés, aucune écriture', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db);
    const badFormat = addAbsence(db, uid, f.profId, {
      start_date: '01/11/2026',
      end_date: '2026-11-05',
    });
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) expect(badFormat.fields?.[0].field).toBe('start_date');

    // Format ISO correct mais date inexistante (30 février / mois 13).
    const badDay = addAbsence(db, uid, f.profId, {
      start_date: '2026-02-30',
      end_date: '2026-03-05',
    });
    expect(badDay.ok).toBe(false);
    if (!badDay.ok) expect(badDay.fields?.[0].field).toBe('start_date');
    const badMonth = addAbsence(db, uid, f.profId, {
      start_date: '2026-11-01',
      end_date: '2026-13-40',
    });
    expect(badMonth.ok).toBe(false);
    if (!badMonth.ok)
      expect(badMonth.fields?.map((x) => x.field)).toContain('end_date');

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
  it('requireRole ADMIN : les 4 mutations refusées en GESTIONNAIRE, acceptées en ADMIN', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    const adminUser = admin(db);
    // Même composition que les handlers create/update/setActive/remove.
    const mutations = [
      (d: DatabaseSync) =>
        createProfessor(d, currentUserId(d), { full_name: 'Prof R1' }),
      (d: DatabaseSync) =>
        updateProfessor(d, currentUserId(d), f.prof2Id, {
          full_name: 'Prof R2',
        }),
      (d: DatabaseSync) =>
        setProfessorActive(d, currentUserId(d), f.prof2Id, false),
      (d: DatabaseSync) => deleteProfessor(d, currentUserId(d), f.prof2Id),
    ];

    setCurrentProfile(db, gest.id);
    for (const fn of mutations) {
      const denied = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toMatch(/Administrateur/);
    }
    // Aucune mutation n'a eu lieu.
    expect(listProfessors(db)).toHaveLength(2);
    expect(
      all(db, 'SELECT id FROM audit_log'),
    ).toHaveLength(0);

    setCurrentProfile(db, adminUser.id);
    for (const fn of mutations) {
      const allowed = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(allowed.ok).toBe(true);
    }
  });

  it('payloads invalides rejetés avec erreurs {field,message} (pas de TypeError)', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const f = seedFixture(db); // professeur réel pour les validations par prof

    const badName = createProfessor(db, uid, {
      full_name: 123,
    } as never);
    expect(badName.ok).toBe(false);
    if (!badName.ok) {
      expect(badName.fields?.[0].field).toBe('full_name');
      expect(badName.error).toMatch(/Validation/);
    }

    const badMail = updateProfessor(db, uid, f.profId, {
      full_name: 'Prof Test',
      email: 42,
    } as never);
    expect(badMail.ok).toBe(false);
    if (!badMail.ok) expect(badMail.fields?.[0].field).toBe('email');

    const badPhone = updateProfessor(db, uid, f.profId, {
      full_name: 'Prof Test',
      phone: { x: 1 },
    } as never);
    expect(badPhone.ok).toBe(false);
    if (!badPhone.ok) expect(badPhone.fields?.[0].field).toBe('phone');

    const badWeekday = addAvailability(db, uid, f.profId, {
      weekday: 'lundi',
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
    } as never);
    expect(badWeekday.ok).toBe(false);
    if (!badWeekday.ok) expect(badWeekday.fields?.[0].field).toBe('weekday');

    const badEff = addAvailability(db, uid, f.profId, {
      weekday: 0,
      start_min: 480,
      end_min: 720,
      kind: 'DISPO',
      effective_from: 20261101,
    } as never);
    expect(badEff.ok).toBe(false);
    if (!badEff.ok) expect(badEff.fields?.[0].field).toBe('effective_from');

    const badAbs = addAbsence(db, uid, f.profId, {
      start_date: 123,
      end_date: '2026-11-05',
      reason: 7,
    } as never);
    expect(badAbs.ok).toBe(false);
    if (!badAbs.ok) {
      expect(badAbs.fields?.map((x) => x.field)).toEqual(
        expect.arrayContaining(['start_date', 'reason']),
      );
    }

    // Rien n'a été écrit par les payloads forgés.
    expect(listAvailabilities(db, f.profId)).toHaveLength(0);
    expect(listAbsences(db, f.profId)).toHaveLength(0);
  });
});
