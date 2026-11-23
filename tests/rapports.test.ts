/**
 * Tests P10 — rapports & statistiques (`report.service`) : les 10
 * rapports sur fixture minimale (chiffres exacts : heures, taux,
 * retards), filtres période/entité, `reportCsv` (BOM, `;`, quoting,
 * accents), FR-44 (aucune écriture — audit vide) et l'acceptation
 * réelle `seedReal` (`conflits_restes` cohérent avec `conflictSummary`,
 * `avancement` 14 masters). `today` injecté : '2026-11-15'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countRows,
  openDatabase,
  run,
} from '../electron/main/db/connection';
import {
  bundledMigrations,
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import { reportCsv, runReport } from '../electron/main/db/report.service';
import { conflictSummary } from '../electron/main/db/conflict.service';
import { seedReal } from '../electron/main/db/seed-real';
import type {
  Report,
  ReportFilter,
  SessionStatus,
} from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const TODAY = '2026-11-15';

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  return db;
}

interface Fixture {
  yearId: number;
  semId: number;
  masterId: number;
  profId: number;
  roomA: number;
  roomB: number;
  mmId: number;
  mm2Id: number;
  absenceId: number;
  s1: number; // PREVUE passée (lun 2026-10-05) — NON_ENCORE_REALISEE
  s2: number; // PREVUE future (mar 2026-12-01) — dans la fenêtre d'absence
  s3: number; // REALISEE avec actual ≠ planifié (mar 2026-10-06)
  s4: number; // ANNULEE + motif (mer 2026-10-07)
  s5: number; // REPORTEE + origine (jeu 2026-10-08 → ven 2026-10-09)
  s6: number; // PREVUE room B (lun 2026-12-07) — conflit EXTERNAL Licence
}

function addSession(
  db: DatabaseSync,
  mmId: number,
  profId: number,
  roomId: number,
  date: string,
  start: number,
  end: number,
  status: SessionStatus,
  actual?: { start: number; end: number },
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status, actual_date, actual_start_min, actual_end_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mmId,
      profId,
      roomId,
      date,
      start,
      end,
      status,
      actual ? date : null,
      actual?.start ?? null,
      actual?.end ?? null,
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
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-T', 'Master Test', ?, ?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Un')")
      .lastInsertRowid,
  );
  const roomA = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)")
      .lastInsertRowid,
  );
  const roomB = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle B', 30)")
      .lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-T', 'Module Test')")
      .lastInsertRowid,
  );
  const mod2Id = Number(
    run(
      db,
      "INSERT INTO module (code, name) VALUES ('MOD-U', 'Module Vide')",
    ).lastInsertRowid,
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
  const mm2Id = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, 600, 120, 5, '2026-09-01', '2027-01-31')`,
      masterId,
      mod2Id,
      semId,
      profId,
    ).lastInsertRowid,
  );
  // Créneaux ouvrables : lun–sam 08:00–18:00.
  const insSlot = db.prepare(
    'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, 480, 1080, ?)',
  );
  for (let w = 0; w <= 5; w++) insSlot.run(w, 'Journée');
  // Blocage Licence récurrent : salle B, lundis 09:00–11:00 (toutes années).
  run(
    db,
    `INSERT INTO external_occupancy
       (program, room_id, weekday, start_min, end_min, academic_year_id)
     VALUES ('Licence droit privé', ?, 0, 540, 660, NULL)`,
    roomB,
  );

  const s1 = addSession(db, mmId, profId, roomA, '2026-10-05', 480, 600, 'PREVUE');
  const s2 = addSession(db, mmId, profId, roomA, '2026-12-01', 600, 720, 'PREVUE');
  const s3 = addSession(
    db,
    mmId,
    profId,
    roomA,
    '2026-10-06',
    480,
    600,
    'REALISEE',
    { start: 480, end: 570 },
  );
  const s4 = addSession(db, mmId, profId, roomA, '2026-10-07', 480, 600, 'ANNULEE');
  const s5 = addSession(db, mmId, profId, roomA, '2026-10-09', 480, 600, 'REPORTEE');
  const s6 = addSession(db, mmId, profId, roomB, '2026-12-07', 600, 720, 'PREVUE');

  // Historiques : motif ANNULEE + REPORTEE (old_* = créneau initial).
  run(
    db,
    `INSERT INTO session_status_history
       (session_id, old_status, new_status, reason)
     VALUES (?, 'PREVUE', 'ANNULEE', 'Grève des transports')`,
    s4,
  );
  run(
    db,
    `INSERT INTO session_status_history
       (session_id, old_status, new_status, reason,
        old_date, old_start_min, old_end_min)
     VALUES (?, 'PREVUE', 'REPORTEE', 'Salle indisponible',
             '2026-10-08', 480, 600)`,
    s5,
  );

  // Absence prof : 2026-11-30 → 2026-12-04 (couvre s2 le 12-01) + décision.
  const absenceId = Number(
    run(
      db,
      `INSERT INTO professor_absence
         (professor_id, start_date, end_date, reason, resolution)
       VALUES (?, '2026-11-30', '2026-12-04', 'Maladie', 'PARTIELLE')`,
      profId,
    ).lastInsertRowid,
  );
  run(
    db,
    `INSERT INTO absence_decision (absence_id, session_id, decision, note)
     VALUES (?, ?, 'REPORT', 'Reportée fin décembre')`,
    absenceId,
    s2,
  );

  return { yearId, semId, masterId, profId, roomA, roomB, mmId, mm2Id, absenceId, s1, s2, s3, s4, s5, s6 };
}

function runOk(
  db: DatabaseSync,
  id: Parameters<typeof runReport>[1],
  filter?: ReportFilter,
): Report {
  const res = runReport(db, id, filter, TODAY);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data;
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

describe('edt_hebdo', () => {
  it('week lundi → lignes jour×créneau, statut NON_ENCORE_REALISEE dérivé', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'edt_hebdo', { week: '2026-10-05' });
    expect(r.columns.map((c) => c.key)).toEqual([
      'date',
      'horaire',
      'master',
      'module',
      'professeur',
      'salle',
      'statut',
    ]);
    expect(r.rows).toHaveLength(4);
    expect(r.rows.map((x) => x.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-09',
    ]);
    expect(r.rows[0].statut).toBe('Non réalisée'); // PREVUE passée
    expect(r.rows[1].statut).toBe('Réalisée');
    expect(r.rows[2].statut).toBe('Annulée');
    expect(r.rows[3].statut).toBe('Reportée');
    expect(r.rows[0].horaire).toBe('08:00–10:00');
  });

  it('week requise et lundi obligatoire', () => {
    const db = freshDb();
    seedFixture(db);
    expect(runReport(db, 'edt_hebdo', {}, TODAY).ok).toBe(false);
    expect(runReport(db, 'edt_hebdo', { week: '2026-10-06' }, TODAY).ok).toBe(
      false,
    );
    expect(runReport(db, 'edt_hebdo', { week: 'xx' }, TODAY).ok).toBe(false);
  });

  it('filtre master_id', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const r = runOk(db, 'edt_hebdo', {
      week: '2026-10-05',
      master_id: f.masterId,
    });
    expect(r.rows).toHaveLength(4);
    const vide = runOk(db, 'edt_hebdo', {
      week: '2026-10-05',
      master_id: 9999,
    });
    expect(vide.rows).toHaveLength(0);
  });
});

describe('salles_planning', () => {
  it('occupation salle × jour : séances + blocages Licence vs time_slot', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'salles_planning', {
      date_from: '2026-10-05',
      date_to: '2026-10-11',
    });
    // A×(lun, mar, ven) + B×(lun) — mer = ANNULEE donc absente.
    expect(r.rows).toHaveLength(4);
    const aLun = r.rows.find((x) => x.salle === 'Salle A' && x.jour === 'Lundi')!;
    expect(aLun.seances_masters).toBe('08:00–10:00 ×1');
    expect(aLun.blocages_licence).toBe('');
    expect(aLun.creneaux_ouverts).toBe('08:00–18:00');
    expect(aLun.nb_seances).toBe(1);
    const bLun = r.rows.find((x) => x.salle === 'Salle B' && x.jour === 'Lundi')!;
    expect(bLun.blocages_licence).toBe('09:00–11:00 ×1');
    expect(bLun.nb_blocages).toBe(1);
    expect(
      r.rows.some((x) => x.jour === 'Mercredi'),
    ).toBe(false); // séance ANNULEE non comptée
  });

  it('période par défaut = année universitaire ; filtre salle', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const r = runOk(db, 'salles_planning', { room_id: f.roomB });
    expect(r.rows.every((x) => x.salle === 'Salle B')).toBe(true);
    // Année complète : 52 lundis en 2026-2027 (01/09→31/08).
    const bLun = r.rows.find((x) => x.jour === 'Lundi')!;
    expect(bLun.blocages_licence).toBe('09:00–11:00 ×52');
  });
});

describe('prof_programme', () => {
  it('toutes les séances du prof triées ; borne de période incluse/exclue', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const all6 = runOk(db, 'prof_programme', {});
    expect(all6.rows).toHaveLength(6);
    expect(all6.rows[0].professeur).toBe('Prof Un');
    // date_from incluse : 10-06 exclut s1 (10-05).
    const bounded = runOk(db, 'prof_programme', { date_from: '2026-10-06' });
    expect(bounded.rows).toHaveLength(5);
    // date_to incluse : borne du 10-06 inclut s3.
    const to = runOk(db, 'prof_programme', { date_to: '2026-10-06' });
    expect(to.rows.map((x) => x.date)).toEqual(['2026-10-05', '2026-10-06']);
    const byProf = runOk(db, 'prof_programme', { professor_id: f.profId });
    expect(byProf.rows).toHaveLength(6);
    expect(
      runOk(db, 'prof_programme', { professor_id: 9999 }).rows,
    ).toHaveLength(0);
  });
});

describe('bilan_heures', () => {
  it('prévu vs effectué : actual_* prioritaire, ANNULEE exclue', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'bilan_heures', {});
    expect(r.rows).toHaveLength(2);
    const mm1 = r.rows.find((x) => x.module === 'Module Test')!;
    // Non-ANNULEE : s1,s2,s3,s5,s6 → 5 × 120 = 600 ; réalisé = actual 90.
    expect(mm1.prevu_min).toBe(600);
    expect(mm1.realise_min).toBe(90);
    expect(mm1.ecart_min).toBe(90 - 600);
    expect(mm1.nb_prevues).toBe(5);
    expect(mm1.nb_realisees).toBe(1);
    expect(mm1.volume_min).toBe(1200);
    const mm2 = r.rows.find((x) => x.module === 'Module Vide')!;
    expect(mm2.prevu_min).toBe(0);
    expect(mm2.ecart_min).toBe(0);
    expect(r.summary?.find((s) => s.key === 'prevu')?.value).toBe(600);
  });

  it('période borne les séances comptées', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'bilan_heures', {
      date_from: '2026-10-05',
      date_to: '2026-10-11',
    });
    const mm1 = r.rows.find((x) => x.module === 'Module Test')!;
    // s1 + s3 + s5 (s4 annulée exclue) = 360 ; réalisé 90.
    expect(mm1.prevu_min).toBe(360);
    expect(mm1.realise_min).toBe(90);
  });
});

describe('non_realisees', () => {
  it('PREVUE passée dérivée via today injecté : retard exact en jours', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'non_realisees', {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].date).toBe('2026-10-05');
    // 2026-11-15 − 2026-10-05 = 41 jours.
    expect(r.rows[0].retard_jours).toBe(41);
    expect(r.summary?.find((s) => s.key === 'retard_max')?.value).toBe(41);
  });

  it('today plus tôt → aucune non réalisée', () => {
    const db = freshDb();
    seedFixture(db);
    const res = runReport(db, 'non_realisees', {}, '2026-10-01');
    expect(res.ok && res.data.rows).toHaveLength(0);
  });
});

describe('annulees_reportees', () => {
  it('motifs du dernier historique + créneau initial des REPORTEE', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'annulees_reportees', {});
    expect(r.rows).toHaveLength(2);
    const ann = r.rows.find((x) => x.statut === 'Annulée')!;
    expect(ann.motif).toBe('Grève des transports');
    expect(ann.origine).toBeNull();
    const rep = r.rows.find((x) => x.statut === 'Reportée')!;
    expect(rep.motif).toBe('Salle indisponible');
    expect(rep.origine).toBe('2026-10-08 08:00–10:00');
    expect(rep.date).toBe('2026-10-09');
    expect(r.summary?.find((s) => s.key === 'annulees')?.value).toBe(1);
    expect(r.summary?.find((s) => s.key === 'reportees')?.value).toBe(1);
  });
});

describe('absences', () => {
  it('intersection période, séances impactées et décisions', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'absences', {});
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.professeur).toBe('Prof Un');
    expect(row.debut).toBe('2026-11-30');
    expect(row.fin).toBe('2026-12-04');
    expect(row.motif).toBe('Maladie');
    expect(row.resolution).toBe('Partielle');
    // s2 (12-01 PREVUE) est la seule ouverte dans la fenêtre.
    expect(row.nb_impactees).toBe(1);
    expect(row.nb_decisions).toBe(1);
  });

  it('période intersectée resserrée sur les bornes du filtre', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'absences', {
      date_from: '2026-12-01',
      date_to: '2026-12-02',
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].debut).toBe('2026-12-01');
    expect(r.rows[0].fin).toBe('2026-12-02');
    // Hors intersection → exclue.
    const out = runOk(db, 'absences', { date_from: '2027-01-01' });
    expect(out.rows).toHaveLength(0);
  });
});

describe('avancement', () => {
  it('réalisées/prévues, taux, restant, modules à l’heure/en retard', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'avancement', {});
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.realisees).toBe(1);
    expect(row.prevues).toBe(5); // non-ANNULEE
    expect(row.taux).toBe(20);
    expect(row.restant).toBe(4);
    // mm1 a s1 PREVUE passée → en retard ; mm2 sans séance → à l'heure.
    expect(row.modules_en_retard).toBe(1);
    expect(row.modules_a_l_heure).toBe(1);
    expect(r.summary?.find((s) => s.key === 'masters')?.value).toBe(1);
  });
});

describe('occupation_salles', () => {
  it('heures Master + Licence vs ouvrables → taux exacts', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'occupation_salles', {
      date_from: '2026-10-05',
      date_to: '2026-10-11',
    });
    expect(r.rows).toHaveLength(2);
    // Ouvrables : 6 jours (lun–sam) × 600 min = 3600.
    const a = r.rows.find((x) => x.salle === 'Salle A')!;
    expect(a.heures_ouvrables_min).toBe(3600);
    // s1+s3+s5 (ANNULEE exclue) = 360 → 10 %.
    expect(a.heures_master_min).toBe(360);
    expect(a.heures_licence_min).toBe(0);
    expect(a.taux_occupation).toBe(10);
    const b = r.rows.find((x) => x.salle === 'Salle B')!;
    // Licence 09:00–11:00 = 120 min × 1 occurrence.
    expect(b.heures_licence_min).toBe(120);
    expect(b.taux_occupation).toBe(3.3);
    expect(r.summary?.find((s) => s.key === 'heures_master')?.value).toBe(360);
    expect(r.summary?.find((s) => s.key === 'heures_licence')?.value).toBe(120);
  });
});

describe('conflits_restes', () => {
  it('cohérent avec detectConflicts + reste à placer FR-35', () => {
    const db = freshDb();
    seedFixture(db);
    const r = runOk(db, 'conflits_restes', {});
    const summary = conflictSummary(db);
    const conflictRows = r.rows.filter((x) => x.kind !== 'Reste à placer');
    expect(conflictRows).toHaveLength(summary.total);
    // Fixture : 1 seul conflit — s6 ↔ blocage Licence salle B (EXTERNAL).
    expect(summary.total).toBe(1);
    expect(conflictRows[0].kind).toBe('Externe (Licence)');
    expect(conflictRows[0].date).toBe('2026-12-07');
    expect(conflictRows[0].horaire).toBe('10:00–11:00');
    expect(r.summary?.find((s) => s.key === 'kind_EXTERNAL')?.value).toBe(1);
    expect(r.summary?.find((s) => s.key === 'kind_ROOM')?.value).toBe(0);
    // Reste : mm1 10−5=5, mm2 5−0=5 → 10 ; 2 modules incomplets.
    const restRows = r.rows.filter((x) => x.kind === 'Reste à placer');
    expect(restRows).toHaveLength(2);
    expect(r.summary?.find((s) => s.key === 'reste')?.value).toBe(10);
    expect(r.summary?.find((s) => s.key === 'modules_incomplets')?.value).toBe(
      2,
    );
  });
});

describe('reportCsv', () => {
  it('BOM UTF-8, séparateur ;, quoting et accents', () => {
    const report: Report = {
      id: 'prof_programme',
      title: 'T',
      columns: [
        { key: 'a', label: 'Colonne; A' },
        { key: 'b', label: 'Été' },
      ],
      rows: [
        { a: 'Droit; privé', b: 'Été « chaud »' },
        { a: 'Nom "guillemets"', b: null },
        { a: 'ligne\nbas', b: 'éèê' },
      ],
    };
    const csv = reportCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('"Colonne; A";Été');
    expect(lines[1]).toBe('"Droit; privé";Été « chaud »');
    expect(lines[2]).toBe('"Nom ""guillemets""";'); // b null → cellule vide
    expect(lines[3]).toBe('"ligne\nbas";éèê');
  });
});

describe('validation du filtre', () => {
  it('dates invalides ou inversées → erreur', () => {
    const db = freshDb();
    seedFixture(db);
    expect(
      runReport(db, 'prof_programme', { date_from: '13/10/2026' }, TODAY).ok,
    ).toBe(false);
    expect(
      runReport(
        db,
        'prof_programme',
        { date_from: '2026-10-10', date_to: '2026-10-01' },
        TODAY,
      ).ok,
    ).toBe(false);
    expect(runReport(db, 'nope' as never, {}, TODAY).ok).toBe(false);
  });
});

describe('FR-44 — aucune écriture', () => {
  it('run de tous les rapports ne modifie rien (audit vide)', () => {
    const db = freshDb();
    seedFixture(db);
    const ids = [
      'edt_hebdo',
      'salles_planning',
      'prof_programme',
      'bilan_heures',
      'non_realisees',
      'annulees_reportees',
      'absences',
      'avancement',
      'occupation_salles',
      'conflits_restes',
    ] as const;
    const before = {
      session: countRows(db, 'session'),
      history: countRows(db, 'session_status_history'),
      audit: countRows(db, 'audit_log'),
      decision: countRows(db, 'absence_decision'),
    };
    for (const id of ids) {
      const res = runReport(db, id, { week: '2026-10-05' }, TODAY);
      expect(res.ok).toBe(true);
    }
    expect(countRows(db, 'session')).toBe(before.session);
    expect(countRows(db, 'session_status_history')).toBe(before.history);
    expect(countRows(db, 'audit_log')).toBe(before.audit);
    expect(countRows(db, 'absence_decision')).toBe(before.decision);
  });
});

describe('acceptation réelle — seedReal', () => {
  function realDb(): DatabaseSync {
    const db = openDatabase(':memory:');
    dbs.push(db);
    runMigrations(db, { migrations: bundledMigrations() });
    seedReal(db);
    return db;
  }

  it('conflits_restes cohérent avec conflictSummary', () => {
    const db = realDb();
    const summary = conflictSummary(db);
    const r = runOk(db, 'conflits_restes', {});
    const conflictRows = r.rows.filter((x) => x.kind !== 'Reste à placer');
    expect(conflictRows).toHaveLength(summary.total);
    expect(summary.total).toBeGreaterThan(0);
    for (const kind of ['EXTERNAL', 'GROUP', 'MASTER', 'PROFESSOR', 'ROOM']) {
      expect(
        Number(r.summary?.find((s) => s.key === `kind_${kind}`)?.value),
      ).toBe(summary.byKind[kind as keyof typeof summary.byKind]);
    }
    expect(r.summary?.find((s) => s.key === 'total')?.value).toBe(
      summary.total,
    );
  });

  it('avancement couvre les 14 masters', () => {
    const db = realDb();
    const r = runOk(db, 'avancement', {});
    expect(r.rows).toHaveLength(14);
    expect(r.summary?.find((s) => s.key === 'masters')?.value).toBe(14);
    // Chaque master a 12×N séances planifiées non annulées > 0.
    expect(r.rows.every((x) => (x.prevues as number) > 0)).toBe(true);
  });
});
