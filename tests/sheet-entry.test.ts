/**
 * Tests P17 — saisie groupée de la feuille de présence
 * (`sheet-entry.service.ts` : `recordAttendanceSheet`) sur base
 * `:memory:` : PREVUE/REPORTEE → REALISEE + nominatif en UNE
 * transaction auditée, actual_* enregistrés, refus sur statut verrouillé
 * (FieldError `status`), bornes identiques à `setNominative`
 * (roster, JUSTIFIE compté absent), séance sans étudiants → marquage
 * réalisée seul. Aucun Electron — le canal `sessions:recordSheet`
 * n'est pas testé ici.
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
import { recordAttendanceSheet } from '../electron/main/db/sheet-entry.service';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

/** `today` injecté : les séances 2026-10-xx sont réalisables. */
const TODAY = '2026-10-25';

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
  g1Id: number;
  g2Id: number;
  /** mm rattaché au groupe G1. */
  mmG1Id: number;
  /** mm sans groupe (séance « master entier », roster vide). */
  mmWholeId: number;
  profId: number;
  roomId: number;
  st1: number;
  st2: number;
  st3: number; // G2
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
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, 'S1', 1)",
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
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module T')")
      .lastInsertRowid,
  );
  const roomId = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)")
      .lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Test')")
      .lastInsertRowid,
  );
  const g1Id = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G1', 30)",
      masterId,
    ).lastInsertRowid,
  );
  const g2Id = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G2', 25)",
      masterId,
    ).lastInsertRowid,
  );
  const addSt = (groupId: number, name: string, ext: string): number =>
    Number(
      run(
        db,
        'INSERT INTO student (student_group_id, external_id, full_name) VALUES (?, ?, ?)',
        groupId,
        ext,
        name,
      ).lastInsertRowid,
    );
  const st1 = addSt(g1Id, 'Yassine Amrani', 'ETU-001');
  const st2 = addSt(g1Id, 'Fatima Zahra', 'ETU-002');
  const st3 = addSt(g2Id, 'Amina Ziani', 'ETU-003');

  const mkMm = (groupId: number | null): number =>
    Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id, student_group_id,
            volume_min, session_duration_min, planned_sessions,
            sched_start, sched_end)
         VALUES (?, ?, ?, ?, ?, 1200, 90, 10, '2026-09-01', '2027-01-31')`,
        masterId,
        modId,
        semId,
        profId,
        groupId,
      ).lastInsertRowid,
    );
  return {
    masterId,
    g1Id,
    g2Id,
    mmG1Id: mkMm(g1Id),
    mmWholeId: mkMm(null),
    profId,
    roomId,
    st1,
    st2,
    st3,
  };
}

function addSession(
  db: DatabaseSync,
  f: Fixture,
  mmId: number,
  date = '2026-10-20',
  status = 'PREVUE',
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, ?, 480, 570, ?)`,
      mmId,
      f.profId,
      f.roomId,
      date,
      status,
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
});

describe('P17 — recordAttendanceSheet', () => {
  it('PREVUE → REALISEE + nominatif + compteurs en une transaction', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmG1Id);
    // session_group élargit le roster à G2 (union mm ∪ session_group).
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.g2Id,
    );

    const res = recordAttendanceSheet(
      db,
      null,
      sid,
      {
        actual_date: '2026-10-20',
        actual_start_min: 485,
        actual_end_min: 565,
        rows: [
          { student_id: f.st1, status: 'PRESENT' },
          { student_id: f.st2, status: 'ABSENT' },
          { student_id: f.st3, status: 'JUSTIFIE' },
        ],
      },
      TODAY,
    );
    expect(res).toEqual({
      ok: true,
      data: { session_id: sid, realised: true, marked: 3 },
    });

    const s = get<{
      status: string;
      actual_date: string | null;
      actual_start_min: number | null;
      actual_end_min: number | null;
    }>(
      db,
      'SELECT status, actual_date, actual_start_min, actual_end_min FROM session WHERE id = ?',
      sid,
    );
    // Statut + horaires réels enregistrés.
    expect(s).toEqual({
      status: 'REALISEE',
      actual_date: '2026-10-20',
      actual_start_min: 485,
      actual_end_min: 565,
    });

    // Nominatif écrit.
    const items = all<{ student_id: number; status: string }>(
      db,
      'SELECT student_id, status FROM student_attendance WHERE session_id = ? ORDER BY student_id',
      sid,
    );
    expect(items).toEqual([
      { student_id: f.st1, status: 'PRESENT' },
      { student_id: f.st2, status: 'ABSENT' },
      { student_id: f.st3, status: 'JUSTIFIE' },
    ]);

    // Compteurs recalculés : JUSTIFIE = absent comptablement (règle v1).
    const counts = get<{ present_count: number; absent_count: number }>(
      db,
      'SELECT present_count, absent_count FROM session_attendance WHERE session_id = ?',
      sid,
    );
    expect(counts).toEqual({ present_count: 1, absent_count: 2 });

    // Historique de statut tracé (motif « Saisie feuille »).
    const hist = all<{ old_status: string; new_status: string; reason: string }>(
      db,
      'SELECT old_status, new_status, reason FROM session_status_history WHERE session_id = ?',
      sid,
    );
    expect(hist).toEqual([
      {
        old_status: 'PREVUE',
        new_status: 'REALISEE',
        reason: 'Saisie feuille de présence',
      },
    ]);

    // Audit : récap 'student_attendance' (inséré dans la TX) puis
    // ligne pilote 'session' (insérée par withAudit après fn()).
    const audit = all<{ entity: string; action: string }>(
      db,
      'SELECT entity, action FROM audit_log ORDER BY id',
    );
    expect(audit).toEqual([
      { entity: 'student_attendance', action: 'CREATE' },
      { entity: 'session', action: 'UPDATE' },
    ]);
  });

  it('REPORTEE acceptée ; actual_* par défaut = créneau planifié', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmG1Id, '2026-10-21', 'REPORTEE');
    const res = recordAttendanceSheet(
      db,
      null,
      sid,
      { rows: [{ student_id: f.st1, status: 'PRESENT' }] },
      TODAY,
    );
    expect(res.ok).toBe(true);
    const s = get<{ status: string; actual_date: string; actual_start_min: number }>(
      db,
      'SELECT status, actual_date, actual_start_min FROM session WHERE id = ?',
      sid,
    );
    expect(s?.status).toBe('REALISEE');
    expect(s?.actual_date).toBe('2026-10-21');
    expect(s?.actual_start_min).toBe(480);
  });

  it('refus FieldError `status` sur REALISEE et ANNULEE — rien n\'est écrit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    for (const status of ['REALISEE', 'ANNULEE']) {
      const sid = addSession(db, f, f.mmG1Id, '2026-10-20', status);
      const res = recordAttendanceSheet(
        db,
        null,
        sid,
        { rows: [{ student_id: f.st1, status: 'PRESENT' }] },
        TODAY,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.some((e) => e.field === 'status')).toBe(true);
      }
      // Aucune écriture : statut inchangé, pas de nominatif, pas d'audit.
      expect(
        get<{ status: string }>(
          db,
          'SELECT status FROM session WHERE id = ?',
          sid,
        )?.status,
      ).toBe(status);
    }
    expect(all(db, 'SELECT id FROM student_attendance')).toHaveLength(0);
    expect(all(db, 'SELECT id FROM audit_log')).toHaveLength(0);
  });

  it('étudiant hors roster refusé ; statut invalide refusé ; id invalide refusé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmG1Id);
    // st3 appartient à G2 — hors roster (mm lié à G1 seul).
    const out = recordAttendanceSheet(
      db,
      null,
      sid,
      { rows: [{ student_id: f.st3, status: 'PRESENT' }] },
      TODAY,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.fields?.some((e) => e.field === 'rows')).toBe(true);
    }

    const badStatus = recordAttendanceSheet(
      db,
      null,
      sid,
      {
        rows: [
          {
            student_id: f.st1,
            status: 'RETARD' as never,
          },
        ],
      },
      TODAY,
    );
    expect(badStatus.ok).toBe(false);

    const badId = recordAttendanceSheet(
      db,
      null,
      sid,
      { rows: [{ student_id: -1, status: 'PRESENT' }] },
      TODAY,
    );
    expect(badId.ok).toBe(false);

    // La séance est restée PREVUE — aucun des trois refus n'a écrit.
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM session WHERE id = ?',
        sid,
      )?.status,
    ).toBe('PREVUE');
  });

  it('séance sans étudiants (master entier) → REALISEE seule, marked=0', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmWholeId);
    const res = recordAttendanceSheet(db, null, sid, { rows: [] }, TODAY);
    expect(res).toEqual({
      ok: true,
      data: { session_id: sid, realised: true, marked: 0 },
    });
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM session WHERE id = ?',
        sid,
      )?.status,
    ).toBe('REALISEE');
    expect(
      all(db, 'SELECT id FROM student_attendance WHERE session_id = ?', sid),
    ).toHaveLength(0);
    // Ligne pilote 'session' présente (statut réellement changé).
    const audit = all<{ entity: string }>(
      db,
      'SELECT entity FROM audit_log',
    );
    expect(audit).toEqual([{ entity: 'session' }]);
  });

  it('séance inexistante → erreur ; actual_date future → FieldError', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const missing = recordAttendanceSheet(
      db,
      null,
      9999,
      { rows: [] },
      TODAY,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/introuvable/);

    const sid = addSession(db, f, f.mmG1Id);
    const future = recordAttendanceSheet(
      db,
      null,
      sid,
      { actual_date: '2026-11-01', rows: [] },
      TODAY,
    );
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(future.fields?.some((e) => e.field === 'actual_date')).toBe(true);
    }
    expect(
      get<{ status: string }>(
        db,
        'SELECT status FROM session WHERE id = ?',
        sid,
      )?.status,
    ).toBe('PREVUE');
  });
});
