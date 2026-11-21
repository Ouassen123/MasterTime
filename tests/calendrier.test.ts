/**
 * Tests P7a — services Emplois du temps (listSessionsWeek/Month/Annual,
 * getSessionDetail, listOccupancyWeek) et détection de conflits BR-11
 * (ROOM/PROFESSOR/MASTER/GROUP/EXTERNAL, summary) sur base `:memory:` —
 * aucun Electron. Conventions AD-7 : dates 'YYYY-MM-DD', heures en
 * minutes, weekday 0=lundi.
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
import { seedReal } from '../electron/main/db/seed-real';
import {
  getSessionDetail,
  listAnnual,
  listOccupancyWeek,
  listSessionsMonth,
  listSessionsWeek,
} from '../electron/main/db/session.service';
import {
  conflictSummary,
  detectConflicts,
} from '../electron/main/db/conflict.service';
import { guard } from '../electron/main/ipc/helpers';
import type { SessionStatus } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

const TODAY = '2026-10-15'; // jeudi — fixture fixe pour le statut dérivé AD-7
const MON = '2026-10-12'; // lundi de la semaine de test
const TUE = '2026-10-13';
const SAT = '2026-10-17';
const SUN = '2026-10-18';
const NEXT_MON = '2026-10-19';

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
  profId: number;
  prof2Id: number;
  modId: number;
  mod2Id: number;
  roomId: number;
  room2Id: number;
  mmId: number;
  mm2Id: number;
}

/**
 * Référentiel minimal : 1 année courante + S3, 2 masters (M-T a un groupe
 * « G1 »), 2 modules, 2 profs, 2 salles, un master_module par master.
 */
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
      "INSERT INTO student_group (master_id, name, size) VALUES (?, 'G1', 30)",
      masterId,
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
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle A', 40)")
      .lastInsertRowid,
  );
  const room2Id = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle B', 80)")
      .lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Un')")
      .lastInsertRowid,
  );
  const prof2Id = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Deux')")
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
    yearId, semId, masterId, master2Id, groupId,
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
    comment?: string;
  },
): number {
  const mm = opts.mmId ?? f.mmId;
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      mm,
      opts.profId ?? f.profId,
      opts.roomId ?? f.roomId,
      opts.date,
      opts.start ?? 480,
      opts.end ?? 600,
      opts.status ?? 'PREVUE',
      opts.comment ?? null,
    ).lastInsertRowid,
  );
}

/** Deuxième mm sur le même master (autre module/prof) — conflit MASTER. */
function addMm(
  db: DatabaseSync,
  f: Fixture,
  over: Partial<{
    masterId: number;
    modId: number;
    profId: number;
    groupId: number | null;
  }> = {},
): number {
  return Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?, ?, ?, ?, ?, 600, 90, 5, '2026-09-01', '2027-01-31')`,
      over.masterId ?? f.masterId,
      over.modId ?? f.mod2Id,
      f.semId,
      over.profId ?? f.prof2Id,
      over.groupId ?? null,
    ).lastInsertRowid,
  );
}

function addOccupancy(
  db: DatabaseSync,
  f: Fixture,
  opts: { weekday: number; start: number; end: number; roomId?: number; program?: string },
): number {
  return Number(
    run(
      db,
      `INSERT INTO external_occupancy
         (program, groupe, module, professor, room_id, weekday, start_min,
          end_min, academic_year_id)
       VALUES (?, 'unique', 'Cours licence', 'Prof Lic', ?, ?, ?, ?, ?)`,
      opts.program ?? 'Licence S1 droit privé (fr)',
      opts.roomId ?? f.roomId,
      opts.weekday,
      opts.start,
      opts.end,
      f.yearId,
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

describe('listSessionsWeek', () => {
  it('bornes lundi/dimanche incluses, semaine suivante exclue, tri (date, start)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: MON, start: 600, end: 660 });
    addSession(db, f, { date: MON, start: 480 });
    addSession(db, f, { date: SUN, mmId: f.mm2Id, profId: f.prof2Id });
    addSession(db, f, { date: NEXT_MON }); // hors plage
    addSession(db, f, { date: '2026-10-11' }); // dimanche précédent

    const res = listSessionsWeek(db, { weekStart: MON }, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(3);
    expect(res.data.map((s) => `${s.date}@${s.start_min}`)).toEqual([
      `${MON}@480`,
      `${MON}@600`,
      `${SUN}@480`,
    ]);
  });

  it('enrichissements : master/module/prof/salle/group_name + effective_status AD-7', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const past = addSession(db, f, { date: MON }); // < TODAY → dérivé
    addSession(db, f, { date: '2026-10-15' }); // jour même → PREVUE
    addSession(db, f, { date: SAT, status: 'REALISEE' });

    const res = listSessionsWeek(db, { weekStart: MON }, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.data.find((x) => x.id === past)!;
    expect(s.master).toEqual({ id: f.masterId, code: 'M-T', name: 'Master T' });
    expect(s.module.code).toBe('MOD-T');
    expect(s.professor.full_name).toBe('Prof Un');
    expect(s.room).toEqual({ id: f.roomId, name: 'Salle A', capacity: 40 });
    expect(s.group_name).toBe('G1');
    expect(s.effective_status).toBe('NON_ENCORE_REALISEE');
    expect(s.status).toBe('PREVUE');
    const today = res.data.find((x) => x.date === '2026-10-15')!;
    expect(today.effective_status).toBe('PREVUE');
    const done = res.data.find((x) => x.status === 'REALISEE')!;
    expect(done.effective_status).toBe('REALISEE');
  });

  it('group_name agrège mm.student_group + session_group', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: TUE });
    const g2 = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')",
        f.masterId,
      ).lastInsertRowid,
    );
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      g2,
    );
    const res = listSessionsWeek(db, { weekStart: MON }, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.data.find((x) => x.id === sid)!;
    // G1 (mm) + G2 (session_group) — UNION trie par valeur dans le group_concat.
    expect(s.group_name?.split(', ').sort()).toEqual(['G1', 'G2']);
  });

  it('filtres master / professeur / salle / module / statuts effectifs', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: MON }); // M-T passé → NON_ENCORE_REALISEE
    addSession(db, f, {
      date: TUE, mmId: f.mm2Id, profId: f.prof2Id, roomId: f.room2Id,
    }); // M-U passé → NON_ENCORE_REALISEE
    addSession(db, f, { date: TUE, status: 'ANNULEE' }); // M-T annulée
    addSession(db, f, { date: SAT }); // M-T futur → PREVUE (effective)

    const week = (extra: object = {}): number => {
      const r = listSessionsWeek(
        db,
        { weekStart: MON, ...extra },
        TODAY,
      );
      return r.ok ? r.data.length : -1;
    };
    expect(week({ masterId: f.masterId })).toBe(3);
    expect(week({ masterId: f.master2Id })).toBe(1);
    expect(week({ professorId: f.prof2Id })).toBe(1);
    expect(week({ roomId: f.room2Id })).toBe(1);
    expect(week({ moduleId: f.mod2Id })).toBe(1);
    // Expansion effective (patch 3) : 'PREVUE' = à venir seulement,
    // les dérivées passées sont exclues du filtre 'PREVUE'.
    expect(week({ statuses: ['PREVUE'] })).toBe(1);
    expect(week({ statuses: ['NON_ENCORE_REALISEE'] })).toBe(2);
    // Les deux ensemble = toutes les PREVUE stockées (passées + futures).
    expect(week({ statuses: ['PREVUE', 'NON_ENCORE_REALISEE'] })).toBe(3);
    expect(week({ statuses: ['ANNULEE'] })).toBe(1);
    expect(week({ statuses: ['PREVUE', 'ANNULEE'] })).toBe(2);
    // Filtre combiné : entité + statuts effectifs.
    expect(week({ masterId: f.masterId, statuses: ['PREVUE'] })).toBe(1);
    expect(
      week({ masterId: f.masterId, statuses: ['NON_ENCORE_REALISEE'] }),
    ).toBe(1);
  });

  it('weekStart invalide ou non-lundi → erreur propre', () => {
    const db = freshDb();
    seedFixture(db);
    expect(listSessionsWeek(db, { weekStart: '' }, TODAY).ok).toBe(false);
    expect(listSessionsWeek(db, { weekStart: 'pas-une-date' }, TODAY).ok).toBe(
      false,
    );
    expect(listSessionsWeek(db, { weekStart: '2026-02-30' }, TODAY).ok).toBe(
      false,
    );
    expect(listSessionsWeek(db, { weekStart: TUE }, TODAY).ok).toBe(false);
    // Payload forgé
    expect(
      listSessionsWeek(db, { weekStart: 42 } as never, TODAY).ok,
    ).toBe(false);
  });

  it('semaine à cheval sur deux années : 2026-12-28 → 2027-01-03', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-12-28' }); // lundi
    addSession(db, f, { date: '2027-01-01' }); // vendredi, année suivante
    addSession(db, f, { date: '2027-01-03' }); // dimanche, borne incluse
    addSession(db, f, { date: '2027-01-04' }); // lundi suivant → exclu
    const res = listSessionsWeek(db, { weekStart: '2026-12-28' }, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((s) => s.date)).toEqual([
      '2026-12-28',
      '2027-01-01',
      '2027-01-03',
    ]);
  });
});

describe('listSessionsMonth', () => {
  it('bornes du mois incluses, mois voisins exclus, même enrichissement', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: '2026-10-01' });
    addSession(db, f, { date: '2026-10-31' });
    addSession(db, f, { date: '2026-09-30' });
    addSession(db, f, { date: '2026-11-01' });
    const res = listSessionsMonth(db, { year: 2026, month: 10 }, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((s) => s.date)).toEqual(['2026-10-01', '2026-10-31']);
    expect(res.data[0].master.code).toBe('M-T');
    // mois de février : 28 jours, pas de fuite en mars
    addSession(db, f, { date: '2027-02-28' });
    addSession(db, f, { date: '2027-03-01' });
    const feb = listSessionsMonth(db, { year: 2027, month: 2 }, TODAY);
    expect(feb.ok).toBe(true);
    if (feb.ok) expect(feb.data.map((s) => s.date)).toEqual(['2027-02-28']);
    // invalides
    expect(listSessionsMonth(db, { year: 2026, month: 13 }, TODAY).ok).toBe(
      false,
    );
    expect(listSessionsMonth(db, { year: 2026, month: 0 }, TODAY).ok).toBe(
      false,
    );
  });
});

describe('listAnnual', () => {
  it('regroupe par master × semaine ISO (lundi), parStatut exact', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Semaine du lun 12 oct : 2 séances M-T + 1 M-U ; dimanche 18 = même semaine.
    addSession(db, f, { date: MON });
    addSession(db, f, { date: SUN, status: 'REALISEE' });
    addSession(db, f, {
      date: TUE, mmId: f.mm2Id, profId: f.prof2Id, status: 'ANNULEE',
    });
    addSession(db, f, { date: NEXT_MON, status: 'REPORTEE' }); // sem. suivante
    const res = listAnnual(db, { academicYearId: f.yearId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const mt = res.data.filter((r) => r.masterId === f.masterId);
    expect(mt).toHaveLength(2);
    expect(mt[0].weekStart).toBe(MON);
    expect(mt[0].count).toBe(2);
    expect(mt[0].parStatut).toEqual({
      prevue: 1, realisee: 1, annulee: 0, reportee: 0,
    });
    expect(mt[1].weekStart).toBe(NEXT_MON);
    expect(mt[1].parStatut.reportee).toBe(1);
    const mu = res.data.find((r) => r.masterId === f.master2Id)!;
    expect(mu.weekStart).toBe(MON);
    expect(mu.parStatut.annulee).toBe(1);
    // dimanche 18 oct rattaché à la semaine du 12 (pas au 19).
    expect(res.data.every((r) => r.weekStart !== SUN)).toBe(true);
  });

  it('année inexistante → erreur ; année sans séance → []', () => {
    const db = freshDb();
    const f = seedFixture(db);
    expect(listAnnual(db, { academicYearId: 9999 }).ok).toBe(false);
    expect(listAnnual(db, { academicYearId: -1 }).ok).toBe(false);
    const year2 = Number(
      run(
        db,
        "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2027-2028', '2027-09-01', '2028-08-31', 0)",
      ).lastInsertRowid,
    );
    addSession(db, f, { date: MON });
    const res = listAnnual(db, { academicYearId: year2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual([]);
  });
});

describe('getSessionDetail', () => {
  it('row complet + historique trié desc + groupes', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, { date: MON, comment: 'Cours magistral' });
    run(
      db,
      `INSERT INTO session_status_history
         (session_id, old_status, new_status, changed_at, reason)
       VALUES (?, NULL, 'PREVUE', '2026-10-01 09:00:00', 'Import')`,
      sid,
    );
    run(
      db,
      `INSERT INTO session_status_history
         (session_id, old_status, new_status, changed_at, reason,
          old_date, old_start_min, old_end_min,
          new_date, new_start_min, new_end_min)
       VALUES (?, 'PREVUE', 'REPORTEE', '2026-10-05 10:00:00', 'Prof absent',
               ?, 480, 600, ?, 840, 960)`,
      sid,
      MON,
      SAT,
    );
    const res = getSessionDetail(db, sid, TODAY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.session.comment).toBe('Cours magistral');
    expect(res.data.session.master_module_id).toBe(f.mmId);
    expect(res.data.session.effective_status).toBe('NON_ENCORE_REALISEE');
    expect(res.data.groups.map((g) => g.name)).toEqual(['G1']);
    expect(res.data.history).toHaveLength(2);
    expect(res.data.history[0].new_status).toBe('REPORTEE');
    expect(res.data.history[0].new_date).toBe(SAT);
    expect(res.data.history[1].new_status).toBe('PREVUE');
    expect(res.data.history[1].reason).toBe('Import');
  });

  it('séance inexistante → erreur', () => {
    const db = freshDb();
    seedFixture(db);
    const res = getSessionDetail(db, 9999, TODAY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/introuvable/);
  });
});

describe('listOccupancyWeek', () => {
  it('blocages récurrents par weekday, date matérialisée, filtre salle', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addOccupancy(db, f, { weekday: 0, start: 480, end: 600 });
    addOccupancy(db, f, {
      weekday: 5, start: 720, end: 840, roomId: f.room2Id,
      program: 'Licence S5 (ar)',
    });
    const res = listOccupancyWeek(db, { weekStart: MON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[0].date).toBe(MON); // weekday 0 → lundi
    expect(res.data[1].date).toBe(SAT); // weekday 5 → samedi
    expect(res.data[1].label).toBe('Licence — Licence S5 (ar) · unique');
    expect(res.data[1].room_name).toBe('Salle B');
    const filtered = listOccupancyWeek(db, {
      weekStart: MON, roomId: f.roomId,
    });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) expect(filtered.data).toHaveLength(1);
  });

  it('filtre par année + roomId/academicYearId forgés → erreur propre', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addOccupancy(db, f, { weekday: 0, start: 480, end: 600 });
    // academicYearId NULL : visible sur toute année (déjà couvert).
    // Ici : l'occupation appartient à yearId → filtre explicite OK.
    const ok = listOccupancyWeek(db, {
      weekStart: MON, academicYearId: f.yearId,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toHaveLength(1);
    const other = Number(
      run(
        db,
        "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2027-2028', '2027-09-01', '2028-08-31', 0)",
      ).lastInsertRowid,
    );
    const wrongYear = listOccupancyWeek(db, {
      weekStart: MON, academicYearId: other,
    });
    expect(wrongYear.ok).toBe(true);
    if (wrongYear.ok) expect(wrongYear.data).toHaveLength(0);
    // Payloads forgés → apiErr, pas de filtre silencieusement ignoré.
    expect(
      listOccupancyWeek(db, { weekStart: MON, roomId: 'abc' as never }).ok,
    ).toBe(false);
    expect(
      listOccupancyWeek(db, {
        weekStart: MON, academicYearId: 'x' as never,
      }).ok,
    ).toBe(false);
  });
});

describe('detectConflicts', () => {
  it('ROOM : même salle + chevauchement strict ; paire miroir dédupliquée', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    addSession(db, f, {
      date: TUE, start: 540, end: 660, mmId: f.mm2Id, profId: f.prof2Id,
    });
    // Pas de chevauchement (fin = début) → ignoré.
    addSession(db, f, { date: TUE, start: 660, end: 720, mmId: f.mm2Id });
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rooms = res.data.filter((c) => c.kind === 'ROOM');
    expect(rooms).toHaveLength(1);
    expect(rooms[0].entityLabel).toBe('Salle A');
    expect(rooms[0].date).toBe(TUE);
    expect(rooms[0].startMin).toBe(540);
    expect(rooms[0].endMin).toBe(600);
    expect(rooms[0].sessions).toHaveLength(2);
    expect(rooms[0].sessions[0].id).toBeLessThan(rooms[0].sessions[1].id);
  });

  it('PROFESSOR : même prof, deux salles ; MASTER : même master', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Même professeur (profId) en Salle A et Salle B en même temps.
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    const mm3 = addMm(db, f, {
      masterId: f.master2Id, modId: f.modId,
    });
    addSession(db, f, {
      date: TUE, start: 540, end: 660, mmId: mm3, roomId: f.room2Id,
    });
    // Même master M-T : deux mm différents qui se chevauchent
    // (prof2 sur la 2e pour isoler le conflit MASTER du PROFESSOR).
    const mm4 = addMm(db, f);
    addSession(db, f, {
      date: '2026-10-20', start: 480, end: 600, mmId: mm4,
      profId: f.prof2Id, roomId: f.room2Id,
    });
    addSession(db, f, { date: '2026-10-20', start: 500, end: 560 });
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const profs = res.data.filter((c) => c.kind === 'PROFESSOR');
    expect(profs).toHaveLength(1);
    expect(profs[0].entityLabel).toBe('Prof Un');
    const masters = res.data.filter((c) => c.kind === 'MASTER');
    expect(masters).toHaveLength(1);
    expect(masters[0].entityLabel).toBe('Master T');
    expect(masters[0].date).toBe('2026-10-20');
  });

  it('ANNULEE ne produit jamais de conflit', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    addSession(db, f, {
      date: TUE, start: 480, end: 600, mmId: f.mm2Id, profId: f.prof2Id,
      status: 'ANNULEE',
    });
    // Occupation sur une AUTRE salle : la séance PREVUE restante n'est
    // pas en conflit externe.
    addOccupancy(db, f, {
      weekday: 1, start: 480, end: 720, roomId: f.room2Id,
    });
    addSession(db, f, {
      date: SAT, start: 480, end: 600, status: 'ANNULEE',
    });
    addOccupancy(db, f, { weekday: 5, start: 480, end: 600 });
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(0);
  });

  it('EXTERNAL : séance ↔ blocage Licence même salle (weekday ↔ date)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addOccupancy(db, f, { weekday: 1, start: 600, end: 840 }); // mardi
    addSession(db, f, { date: TUE, start: 720, end: 900 }); // chevauche
    addSession(db, f, {
      date: TUE, start: 720, end: 900, mmId: f.mm2Id, profId: f.prof2Id,
      roomId: f.room2Id, // autre salle → pas de conflit externe
    });
    addSession(db, f, { date: MON, start: 720, end: 900 }); // mauvais weekday
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ext = res.data.filter((c) => c.kind === 'EXTERNAL');
    expect(ext).toHaveLength(1);
    expect(ext[0].entityLabel).toBe('Licence — Licence S1 droit privé (fr) · unique');
    expect(ext[0].startMin).toBe(720);
    expect(ext[0].endMin).toBe(840);
    expect(ext[0].sessions).toHaveLength(1);
    expect(ext[0].detail).toContain('Salle A');
  });

  it('GROUP : appartenance = mm.student_group_id UNION session_group (chemins croisés)', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, {
      date: TUE, start: 480, end: 600, roomId: f.roomId,
    });
    const s2 = addSession(db, f, {
      date: TUE, start: 540, end: 660, roomId: f.room2Id, mmId: f.mm2Id,
      profId: f.prof2Id,
    });
    // s1 a G1 via mm.student_group_id ; s2 n'a aucun groupe → 0 conflit.
    let res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.filter((c) => c.kind === 'GROUP')).toHaveLength(0);
    }
    // s2 liée à G1 via session_group : même groupe, chemins différents
    // (mm d'un côté, session_group de l'autre) → conflit détecté.
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      s2,
      f.groupId,
    );
    res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const groups = res.data.filter((c) => c.kind === 'GROUP');
    expect(groups).toHaveLength(1);
    expect(groups[0].entityLabel).toBe('G1 (Master T)');
    expect(groups[0].sessions.map((s) => s.id)).toEqual([s1, s2]);
  });

  it('GROUP : paire partageant 2 groupes fusionnée — entityLabel + detail complets', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const g2 = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')",
        f.masterId,
      ).lastInsertRowid,
    );
    const s1 = addSession(db, f, {
      date: TUE, start: 480, end: 600, roomId: f.roomId,
    });
    const s2 = addSession(db, f, {
      date: TUE, start: 540, end: 660, roomId: f.room2Id, mmId: f.mm2Id,
      profId: f.prof2Id,
    });
    // s1 : G1 via mm + G2 via session_group ; s2 : G1 + G2 via session_group.
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      s1,
      g2,
    );
    for (const gid of [f.groupId, g2]) {
      run(
        db,
        'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
        s2,
        gid,
      );
    }
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const groups = res.data.filter((c) => c.kind === 'GROUP');
    // Une seule entrée pour la paire, les deux groupes listés.
    expect(groups).toHaveLength(1);
    expect(groups[0].entityLabel).toBe('G1 (Master T), G2 (Master T)');
    expect(groups[0].detail).toContain('G1 (Master T)');
    expect(groups[0].detail).toContain('G2 (Master T)');
  });

  it('plage de dates : filtre inclusif, plage vide → []', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    addSession(db, f, {
      date: TUE, start: 540, end: 660, mmId: f.mm2Id, profId: f.prof2Id,
    });
    const inRange = detectConflicts(db, {
      dateFrom: TUE, dateTo: TUE,
    });
    expect(inRange.ok).toBe(true);
    if (inRange.ok) expect(inRange.data).toHaveLength(1);
    const empty = detectConflicts(db, {
      dateFrom: '2027-01-01', dateTo: '2027-01-31',
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data).toHaveLength(0);
    // Dates invalides → erreur.
    expect(detectConflicts(db, { dateFrom: 'xx' }).ok).toBe(false);
    expect(detectConflicts(db, { dateTo: '2026-13-01' }).ok).toBe(false);
  });

  it('conflictSummary : total + byKind exacts', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: TUE, start: 480, end: 600 });
    addSession(db, f, {
      date: TUE, start: 540, end: 660, mmId: f.mm2Id, profId: f.prof2Id,
    }); // ROOM
    addOccupancy(db, f, { weekday: 1, start: 480, end: 700 }); // 2 EXTERNAL
    const sum = conflictSummary(db);
    expect(sum.byKind.ROOM).toBe(1);
    expect(sum.byKind.EXTERNAL).toBe(2);
    expect(sum.byKind.PROFESSOR).toBe(0);
    expect(sum.byKind.MASTER).toBe(0);
    expect(sum.byKind.GROUP).toBe(0);
    expect(sum.total).toBe(3);
  });

  it('fixture : deux masters distincts en collision même salle/créneau', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Rejoue le motif de la collision officielle Salle 6 (samedi 12h–14h,
    // deux masters) sur fixture synthétique — la version réelle est
    // couverte par le test seedReal ci-dessous.
    addSession(db, f, {
      date: SAT, start: 720, end: 840, roomId: f.roomId, // 'Salle A' tient lieu de Salle 6
    });
    addSession(db, f, {
      date: SAT, start: 720, end: 840, roomId: f.roomId,
      mmId: f.mm2Id, profId: f.prof2Id,
    });
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const room = res.data.filter((c) => c.kind === 'ROOM');
    expect(room).toHaveLength(1);
    expect(room[0].date).toBe(SAT);
    const names = room[0].sessions.map((s) => s.masterName).sort();
    expect(names).toEqual(['Master T', 'Master U']);
  });

  it('acceptation — seedReal : ≥6 MASTER, ≥10 EXTERNAL, Salle 6 le samedi', () => {
    const db = freshDb();
    seedReal(db);
    const sum = conflictSummary(db);
    expect(sum.byKind.MASTER).toBeGreaterThanOrEqual(6);
    expect(sum.byKind.EXTERNAL).toBeGreaterThanOrEqual(10);
    const res = detectConflicts(db);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // La vraie collision officielle : 'Salle 6' occupée par deux masters
    // (M-02 ↔ M-04) le samedi 12h–14h — doit produire des ROOM samedis.
    const s6 = res.data.filter(
      (c) =>
        c.kind === 'ROOM' &&
        c.entityLabel === 'Salle 6' &&
        new Date(`${c.date}T00:00:00Z`).getUTCDay() === 6,
    );
    expect(s6.length).toBeGreaterThanOrEqual(1);
    expect(s6[0].startMin).toBe(720);
    expect(s6[0].endMin).toBe(840);
  });
});

describe('ipc guard (lecture)', () => {
  it('guard enveloppe les résultats services sans requireRole', () => {
    const db = freshDb();
    const f = seedFixture(db);
    addSession(db, f, { date: MON });
    const res = guard(
      () => db,
      (d) => listSessionsWeek(d, { weekStart: MON }, TODAY),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(1);
    const noDb = guard(
      () => null,
      (d) => listSessionsWeek(d, { weekStart: MON }, TODAY),
    );
    expect(noDb.ok).toBe(false);
    // compteur de séances présent dans la base mémoire
    expect(
      get<{ c: number }>(db, 'SELECT count(*) AS c FROM session')!.c,
    ).toBe(1);
    expect(
      all(db, 'SELECT id FROM session_status_history'),
    ).toHaveLength(0); // pas d'historique auto sur insert direct
  });
});
