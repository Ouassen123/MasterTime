/**
 * Tests P9a — suivi des absences et registre des séances :
 *
 * - migration 0006 (table `absence_decision`, index, UNIQUE) ;
 * - séances impactées : PREVUE **et** REPORTEE dans la fenêtre,
 *   exclusions hors fenêtre / statuts fermés ;
 * - décisions : REMPLACEMENT (garde disponibilité DISPO/INDISPO/absence
 *   + conflit BR-10 kinds=['PROFESSOR']), REPORT/ANNULATION (délégation
 *   `planStatusChange`, motif auto « Absence du titulaire ») ;
 * - atomicité : échec BR-10 → ni mutation ni décision ni audit ;
 *   succès → audit session + absence_decision + resolution en une TX ;
 * - résolution stockée A_TRAITER → PARTIELLE → RESOLUE ;
 * - registre `/seances` : filtres combinés, statut effectif et
 *   retard_jours avec `today` injectable, recherche LIKE échappée,
 *   `remaining`, pagination ;
 * - migration : table/index/contraintes.
 *
 * Base `:memory:` (pattern `edition-seances.test.ts`).
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
  decideSession,
  getAbsence,
  listAbsences,
} from '../electron/main/db/absence.service';
import {
  listSessionsRegistry,
  remainingSessions,
} from '../electron/main/db/session.service';
import type { SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

// 2026-10-12 = lundi (weekday 0), 2026-10-13 = mardi, 2026-10-19 = lundi+7.
const MON = '2026-10-12';
const TUE = '2026-10-13';
const OUT = '2026-10-26'; // hors fenêtre d'absence
const NEXT_MON = '2026-10-19';
const TODAY = '2026-10-12';

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
  masterId: number;
  master2Id: number;
  groupId: number;
  profId: number; // titulaire absent
  prof2Id: number; // remplaçant
  prof3Id: number; // remplaçant inactif / second remplaçant
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
    run(db, "INSERT INTO student_group (master_id, name) VALUES (?, 'G1')", masterId)
      .lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Absent')")
      .lastInsertRowid,
  );
  const prof2Id = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Remplaçant')")
      .lastInsertRowid,
  );
  const prof3Id = Number(
    run(db, "INSERT INTO professor (full_name, is_active) VALUES ('Prof Inactif', 0)")
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
       VALUES (?, ?, ?, ?, NULL, 1200, 120, 5, '2026-09-01', '2027-01-31')`,
      master2Id,
      mod2Id,
      semId,
      prof2Id,
    ).lastInsertRowid,
  );
  return {
    masterId, master2Id, groupId, profId, prof2Id, prof3Id,
    modId, mod2Id, roomId, room2Id, mmId, mm2Id,
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

function addAbsence(
  db: DatabaseSync,
  professorId: number,
  start: string,
  end: string,
): number {
  return Number(
    run(
      db,
      `INSERT INTO professor_absence (professor_id, start_date, end_date, reason)
       VALUES (?, ?, ?, 'Maladie')`,
      professorId,
      start,
      end,
    ).lastInsertRowid,
  );
}

function resolution(db: DatabaseSync, absenceId: number): string {
  return get<{ resolution: string }>(
    db,
    'SELECT resolution FROM professor_absence WHERE id = ?',
    absenceId,
  )!.resolution;
}

interface AuditRowLite {
  action: string;
  entity: string;
  entity_id: number;
}

function auditRows(db: DatabaseSync): AuditRowLite[] {
  return all<AuditRowLite>(
    db,
    'SELECT action, entity, entity_id FROM audit_log ORDER BY id',
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
      /* déjà fermée */
    }
  }
});

// ---------------------------------------------------------------------------
// Migration 0006
// ---------------------------------------------------------------------------

describe('migration 0006 — absence_decision', () => {
  it('crée la table, l’index et les contraintes', () => {
    const db = freshDb();
    expect(
      get<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='absence_decision'",
      ),
    ).toBeDefined();
    expect(
      get<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_decision_absence'",
      ),
    ).toBeDefined();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, TUE);
    // UNIQUE(absence_id, session_id) — la seconde insertion lève.
    run(
      db,
      `INSERT INTO absence_decision
         (absence_id, session_id, decision) VALUES (?, ?, 'ANNULATION')`,
      aId,
      s1,
    );
    expect(() =>
      run(
        db,
        `INSERT INTO absence_decision
           (absence_id, session_id, decision) VALUES (?, ?, 'REPORT')`,
        aId,
        s1,
      ),
    ).toThrow(/UNIQUE/);
    // CHECK(decision IN …) — valeur forgée refusée.
    expect(() =>
      run(
        db,
        `INSERT INTO absence_decision
           (absence_id, session_id, decision) VALUES (?, ?, 'BIDON')`,
        aId,
        s1 + 1000,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Séances impactées + résolution
// ---------------------------------------------------------------------------

describe('séances impactées (getAbsence / listAbsences)', () => {
  it('inclut PREVUE et REPORTEE dans la fenêtre ; exclut hors fenêtre et statuts fermés', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const s2 = addSession(db, f, { date: TUE, status: 'REPORTEE' });
    addSession(db, f, { date: OUT }); // hors fenêtre
    addSession(db, f, { date: MON, status: 'ANNULEE' }); // statut fermé
    addSession(db, f, { date: MON, status: 'REALISEE' }); // statut fermé
    const aId = addAbsence(db, f.profId, MON, TUE);

    const detail = getAbsence(db, aId);
    expect(detail).not.toBeNull();
    expect(detail!.absence.professor_name).toBe('Prof Absent');
    expect(detail!.impacted.map((s) => s.id).sort()).toEqual([s1, s2].sort());
    for (const s of detail!.impacted) {
      expect(s.decision).toBeNull();
      expect(['PREVUE', 'REPORTEE']).toContain(s.status);
    }

    const rows = listAbsences(db, f.profId);
    expect(rows).toHaveLength(1);
    expect(rows[0].nb_impacted).toBe(2);
    expect(rows[0].nb_decisions).toBe(0);
    expect(rows[0].resolution).toBe('A_TRAITER');
  });
});

// ---------------------------------------------------------------------------
// Décisions : REMPLACEMENT
// ---------------------------------------------------------------------------

describe('décision REMPLACEMENT', () => {
  it('remplace le professeur, trace la décision et passe la résolution à RESOLUE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);

    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof2Id,
    }, TODAY);
    expect(res.ok).toBe(true);

    const s = get<{ professor_id: number; status: string }>(
      db,
      'SELECT professor_id, status FROM session WHERE id = ?',
      s1,
    )!;
    expect(s.professor_id).toBe(f.prof2Id);
    expect(s.status).toBe('PREVUE'); // statut inchangé

    const dec = get<{
      decision: string;
      substitute_professor_id: number | null;
      note: string | null;
      decided_by: number | null;
    }>(
      db,
      'SELECT * FROM absence_decision WHERE absence_id = ? AND session_id = ?',
      aId,
      s1,
    )!;
    expect(dec.decision).toBe('REMPLACEMENT');
    expect(dec.substitute_professor_id).toBe(f.prof2Id);
    expect(dec.note).toBeNull(); // pas de note libre fournie
    expect(dec.decided_by).toBe(uid(db));

    // Plus de séance ouverte non décidée → RESOLUE.
    expect(resolution(db, aId)).toBe('RESOLUE');
    const rows = listAbsences(db, f.profId);
    expect(rows[0].resolution).toBe('RESOLUE');
    expect(rows[0].nb_decisions).toBe(1);
    expect(rows[0].nb_impacted).toBe(0); // prof changé → plus impactée

    // Historique de statut : le move trace le motif (old=new status).
    const hist = get<{ reason: string | null; old_status: string }>(
      db,
      'SELECT reason, old_status FROM session_status_history WHERE session_id = ?',
      s1,
    )!;
    expect(hist.reason).toBe('Absence du titulaire');
  });

  it('refuse le titulaire comme remplaçant', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.profId,
    }, TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fields?.some((f2) => f2.field === 'substitute_professor_id'))
        .toBe(true);
    }
  });

  it('refuse un remplaçant inexistant ou désactivé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const inactif = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof3Id, // is_active = 0
    }, TODAY);
    expect(inactif.ok).toBe(false);
    const inexistant = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: 9999,
    }, TODAY);
    expect(inexistant.ok).toBe(false);
  });

  it('refuse un remplaçant INDISPO, sans DISPO ce jour ou absent', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON }); // lundi 08:00–10:00
    const aId = addAbsence(db, f.profId, MON, MON);

    // INDISPO le lundi sur le créneau → refus.
    run(
      db,
      `INSERT INTO professor_availability
         (professor_id, weekday, start_min, end_min, kind)
       VALUES (?, 0, 540, 720, 'INDISPO')`,
      f.prof2Id,
    );
    const indispo = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof2Id,
    }, TODAY);
    expect(indispo.ok).toBe(false);
    if (!indispo.ok) expect(indispo.fields).toBeDefined();
    run(db, 'DELETE FROM professor_availability WHERE professor_id = ?', f.prof2Id);

    // DISPO uniquement un autre jour → « nodispo » : refus.
    run(
      db,
      `INSERT INTO professor_availability
         (professor_id, weekday, start_min, end_min, kind)
       VALUES (?, 2, 480, 720, 'DISPO')`,
      f.prof2Id,
    );
    const nodispo = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof2Id,
    }, TODAY);
    expect(nodispo.ok).toBe(false);
    run(db, 'DELETE FROM professor_availability WHERE professor_id = ?', f.prof2Id);

    // Le remplaçant est lui-même absent ce jour → refus.
    addAbsence(db, f.prof2Id, MON, MON);
    const absent = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof2Id,
    }, TODAY);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error).toBeTruthy();
  });

  it('refuse un remplaçant déjà pris (BR-10 PROFESSOR) et n’écrit rien', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    // Le remplaçant a déjà une séance au même créneau (autre mm/salle).
    addSession(db, f, {
      mmId: f.mm2Id,
      profId: f.prof2Id,
      roomId: f.room2Id,
      date: MON,
    });
    const aId = addAbsence(db, f.profId, MON, MON);
    const before = auditRows(db).length;

    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'REMPLACEMENT',
      substitute_professor_id: f.prof2Id,
    }, TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflicts).toBeDefined();
      expect(res.conflicts!.some((c) => c.kind === 'PROFESSOR')).toBe(true);
    }
    // Atomicité : séance inchangée, aucune décision, aucun audit.
    expect(
      get<{ professor_id: number }>(
        db,
        'SELECT professor_id FROM session WHERE id = ?',
        s1,
      )!.professor_id,
    ).toBe(f.profId);
    expect(
      get<{ c: number }>(
        db,
        'SELECT count(*) AS c FROM absence_decision WHERE absence_id = ?',
        aId,
      )!.c,
    ).toBe(0);
    expect(resolution(db, aId)).toBe('A_TRAITER');
    expect(auditRows(db).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Décisions : REPORT / ANNULATION
// ---------------------------------------------------------------------------

describe('décisions REPORT et ANNULATION', () => {
  it('REPORT : REPORTEE sur le nouveau créneau, historique + motif auto', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);

    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'REPORT',
      new_date: NEXT_MON,
      new_start: 600,
      new_end: 720,
    }, TODAY);
    expect(res.ok).toBe(true);
    const s = get<{ status: string; date: string; start_min: number; end_min: number }>(
      db,
      'SELECT status, date, start_min, end_min FROM session WHERE id = ?',
      s1,
    )!;
    expect(s.status).toBe('REPORTEE');
    expect(s.date).toBe(NEXT_MON);
    expect(s.start_min).toBe(600);
    expect(s.end_min).toBe(720);
    const hist = get<{ old_status: string; new_status: string; reason: string | null; old_date: string }>(
      db,
      'SELECT old_status, new_status, reason, old_date FROM session_status_history WHERE session_id = ?',
      s1,
    )!;
    expect(hist.old_status).toBe('PREVUE');
    expect(hist.new_status).toBe('REPORTEE');
    expect(hist.reason).toBe('Absence du titulaire');
    expect(hist.old_date).toBe(MON);
    expect(resolution(db, aId)).toBe('RESOLUE');
  });

  it('REPORT sans nouveau créneau : refus de validation (P7b)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'REPORT',
    }, TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fields?.some((f2) => f2.field === 'date')).toBe(true);
    }
  });

  it('ANNULATION : ANNULEE + motif auto + historique', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const res = decideSession(db, uid(db), aId, s1, {
      decision: 'ANNULATION',
      note: 'Absence non remplaçable',
    }, TODAY);
    expect(res.ok).toBe(true);
    const s = get<{ status: string }>(
      db,
      'SELECT status FROM session WHERE id = ?',
      s1,
    )!;
    expect(s.status).toBe('ANNULEE');
    const hist = get<{ reason: string | null; new_status: string }>(
      db,
      'SELECT reason, new_status FROM session_status_history WHERE session_id = ?',
      s1,
    )!;
    expect(hist.new_status).toBe('ANNULEE');
    expect(hist.reason).toBe('Absence non remplaçable'); // note = motif
    const dec = get<{ decision: string; substitute_professor_id: number | null; note: string | null }>(
      db,
      'SELECT decision, substitute_professor_id, note FROM absence_decision WHERE session_id = ?',
      s1,
    )!;
    expect(dec.decision).toBe('ANNULATION');
    expect(dec.substitute_professor_id).toBeNull();
    expect(dec.note).toBe('Absence non remplaçable');
  });

  it('refuse les décisions et séances non impactées ou déjà traitées', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const sOut = addSession(db, f, { date: OUT });
    const aId = addAbsence(db, f.profId, MON, TUE);

    // Décision invalide.
    expect(
      decideSession(db, uid(db), aId, s1, {
        decision: 'BIDON' as never,
      }, TODAY).ok,
    ).toBe(false);
    // Absence inconnue.
    expect(
      decideSession(db, uid(db), 9999, s1, { decision: 'ANNULATION' }, TODAY).ok,
    ).toBe(false);
    // Séance hors fenêtre d'absence.
    const out = decideSession(db, uid(db), aId, sOut, {
      decision: 'ANNULATION',
    }, TODAY);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/impactée/);

    // Déjà traitée : décision présente (insérée directement) → refus.
    run(
      db,
      `INSERT INTO absence_decision
         (absence_id, session_id, decision) VALUES (?, ?, 'ANNULATION')`,
      aId,
      s1,
    );
    const again = decideSession(db, uid(db), aId, s1, {
      decision: 'ANNULATION',
    }, TODAY);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/décision/);
  });
});

// ---------------------------------------------------------------------------
// Résolution A_TRAITER → PARTIELLE → RESOLUE + audit transactionnel
// ---------------------------------------------------------------------------

describe('résolution et audit', () => {
  it('A_TRAITER → PARTIELLE → RESOLUE au fil des décisions', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const s2 = addSession(db, f, { date: TUE });
    const aId = addAbsence(db, f.profId, MON, TUE);
    expect(resolution(db, aId)).toBe('A_TRAITER');

    // 1re décision : s1 annulée, s2 encore ouverte → PARTIELLE.
    expect(
      decideSession(db, uid(db), aId, s1, { decision: 'ANNULATION' }, TODAY).ok,
    ).toBe(true);
    expect(resolution(db, aId)).toBe('PARTIELLE');
    expect(getAbsence(db, aId)!.impacted).toHaveLength(1);

    // 2e décision : s2 remplacée → RESOLUE.
    expect(
      decideSession(db, uid(db), aId, s2, {
        decision: 'REMPLACEMENT',
        substitute_professor_id: f.prof2Id,
      }, TODAY).ok,
    ).toBe(true);
    expect(resolution(db, aId)).toBe('RESOLUE');
  });

  it('écrit audit session + absence_decision + résolution dans la même TX', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const before = auditRows(db).length;

    expect(
      decideSession(db, uid(db), aId, s1, {
        decision: 'REMPLACEMENT',
        substitute_professor_id: f.prof2Id,
      }, TODAY).ok,
    ).toBe(true);

    const rows = auditRows(db).slice(before);
    expect(rows.some((r) => r.entity === 'session' && r.entity_id === s1 && r.action === 'UPDATE'))
      .toBe(true);
    expect(rows.some((r) => r.entity === 'absence_decision' && r.action === 'CREATE'))
      .toBe(true);
    expect(rows.some((r) => r.entity === 'professor_absence' && r.entity_id === aId && r.action === 'UPDATE'))
      .toBe(true); // resolution A_TRAITER → RESOLUE tracée
  });
});

// ---------------------------------------------------------------------------
// Registre des séances (FR-30/35)
// ---------------------------------------------------------------------------

describe('registre des séances (listSessionsRegistry / remainingSessions)', () => {
  it('filtre combiné : dates + master + professeur + recherche LIKE échappée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    addSession(db, f, { date: OUT, profId: f.prof2Id }); // autre prof + date
    addSession(db, f, { mmId: f.mm2Id, profId: f.prof2Id, roomId: f.room2Id, date: MON });

    const res = listSessionsRegistry(
      db,
      {
        date_from: MON,
        date_to: TUE,
        master_id: f.masterId,
        professor_id: f.profId,
        search: 'Module T',
      },
      { page: 1, pageSize: 10 },
      TODAY,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(1);
    expect(res.data.rows[0].id).toBe(s1);
    // Recherche littérale : '%' n'est pas un joker.
    const esc = listSessionsRegistry(
      db,
      { search: '100%' },
      { page: 1, pageSize: 10 },
      TODAY,
    );
    expect(esc.ok && esc.data.total === 0).toBe(true);
    // Filtres incohérents : erreur propre.
    expect(
      listSessionsRegistry(
        db,
        { date_from: TUE, date_to: MON },
        undefined,
        TODAY,
      ).ok,
    ).toBe(false);
  });

  it('statut effectif dérivé + retard_jours avec today injectable', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const today = '2026-10-15'; // jeudi
    const past = addSession(db, f, { date: MON }); // PREVUE passée → NER + retard
    const future = addSession(db, f, { date: NEXT_MON }); // PREVUE future
    const done = addSession(db, f, { date: TUE, status: 'REALISEE' });

    const res = listSessionsRegistry(db, {}, { page: 1, pageSize: 10 }, today);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.data.rows.map((r) => [r.id, r]));
    expect(byId.get(past)!.effective_status).toBe('NON_ENCORE_REALISEE');
    expect(byId.get(past)!.retard_jours).toBe(3); // 15 − 12
    expect(byId.get(future)!.effective_status).toBe('PREVUE');
    expect(byId.get(future)!.retard_jours).toBe(0);
    expect(byId.get(done)!.effective_status).toBe('REALISEE');
    expect(byId.get(done)!.retard_jours).toBe(0);
    // Compteurs d'en-tête sur l'ensemble filtré.
    expect(res.data.stats.total).toBe(3);
    expect(res.data.stats.realisee).toBe(1);
    expect(res.data.stats.non_realisee).toBe(1);
    expect(res.data.stats.en_retard).toBe(1);
    // Filtre statut effectif.
    const ner = listSessionsRegistry(
      db,
      { status_effectif: 'NON_ENCORE_REALISEE' },
      { page: 1, pageSize: 10 },
      today,
    );
    expect(ner.ok && ner.data.rows.map((r) => r.id)).toEqual([past]);
  });

  it('remaining : planned − séances non ANNULEE', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: MON });
    addSession(db, f, { date: TUE });
    addSession(db, f, { date: OUT, status: 'ANNULEE' }); // exclue
    const res = remainingSessions(db, f.mmId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planned).toBe(10);
    expect(res.data.scheduled_non_cancelled).toBe(2);
    expect(res.data.remaining).toBe(8);
    expect(remainingSessions(db, 9999).ok).toBe(false);
  });

  it('pagination serveur : page/pageSize bornés, total sur l’ensemble', () => {
    const db = freshDb();
    const f = seedFixture(db);
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.UTC(2026, 9, 12 + i))
        .toISOString()
        .slice(0, 10);
      addSession(db, f, { date: d, start: 480 + (i % 6) * 60, end: 540 + (i % 6) * 60 });
    }
    const p1 = listSessionsRegistry(db, {}, { page: 1, pageSize: 10 }, TODAY);
    expect(p1.ok && p1.data.rows.length === 10 && p1.data.total === 25).toBe(true);
    const p3 = listSessionsRegistry(db, {}, { page: 3, pageSize: 10 }, TODAY);
    expect(p3.ok && p3.data.rows.length === 5 && p3.data.page === 3).toBe(true);
    // Payload forgé : pageSize hors borne → défaut 20.
    const forged = listSessionsRegistry(
      db,
      {},
      { page: 0, pageSize: 9999 },
      TODAY,
    );
    expect(forged.ok && forged.data.page === 1 && forged.data.pageSize === 20)
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Revue P9a + addendum : suppressions en présence de décisions
// ---------------------------------------------------------------------------

describe('suppressions liées aux décisions (FK sans CASCADE)', () => {
  it('removeAbsence supprime les décisions dans la TX — pas d\'erreur FK', async () => {
    const { removeAbsence } = await import(
      '../electron/main/db/professor.service'
    );
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const aId = addAbsence(db, f.profId, MON, MON);
    const dec = decideSession(db, uid(db), aId, s1, {
      decision: 'ANNULATION',
    }, TODAY);
    expect(dec.ok).toBe(true);

    const res = removeAbsence(db, uid(db), aId);
    expect(res.ok).toBe(true);
    expect(
      get(db, 'SELECT id FROM professor_absence WHERE id = ?', aId),
    ).toBeUndefined();
    expect(
      get(db, 'SELECT id FROM absence_decision WHERE absence_id = ?', aId),
    ).toBeUndefined();
  });

  it('deleteSession supprime la décision et recalcule la résolution', async () => {
    const { deleteSession } = await import(
      '../electron/main/db/session-edit.service'
    );
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, { date: MON });
    const s2 = addSession(db, f, { date: TUE });
    const aId = addAbsence(db, f.profId, MON, TUE);
    // 2 impactées, 1 décidée → PARTIELLE.
    const dec = decideSession(db, uid(db), aId, s1, {
      decision: 'ANNULATION',
    }, TODAY);
    expect(dec.ok).toBe(true);
    expect(resolution(db, aId)).toBe('PARTIELLE');

    // La séance ANNULEE restante est supprimable (date >= today).
    const del = deleteSession(db, uid(db), s1, TODAY);
    expect(del.ok).toBe(true);
    expect(
      get(db, 'SELECT id FROM absence_decision WHERE session_id = ?', s1),
    ).toBeUndefined();
    // Plus aucune décision sur les impactées restantes → A_TRAITER.
    expect(resolution(db, aId)).toBe('A_TRAITER');
    void s2;
  });
});
