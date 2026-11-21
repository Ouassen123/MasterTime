/**
 * Seed RÉEL FSJP Tanger (données officielles 2026/2027) — insère les
 * référentiels réels une seule fois, dans une transaction unique.
 * is_demo = 0 partout : ce ne sont PAS des données de démonstration.
 *
 * Contenu : 17 salles (capacités officielles, Salle 3/9 capacité inconnue),
 * 14 Masters S3, 149 professeurs, 93 modules, master_module par (master,
 * module), 97 séances hebdomadaires × 12 semaines (fenêtre 2026-09-21 →
 * 2026-12-13), 168 occupations Licence (external_occupancy).
 *
 * NB : les collisions présentes dans les documents officiels sont insérées
 * telles quelles — le panneau de conflits devra les arbitrer (BR-12).
 */
import { DatabaseSync } from 'node:sqlite';
import { countRows, get } from './connection';
import {
  REAL_LIC,
  REAL_MASTERS,
  REAL_MODULES,
  REAL_PROFS,
  REAL_ROOMS,
  REAL_SESSIONS,
} from './real-data';

export interface SeedResult {
  inserted: boolean;
}

const SEM_START = '2026-09-21'; // lundi — début programmation S3 2026/2027
const SEM_END = '2026-12-13'; // 12 semaines
const WEEKS = 12;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Première occurrence du jour de semaine (0=lun … 5=sam) >= SEM_START. */
function firstOccurrence(weekday: number): Date {
  const d = new Date(SEM_START + 'T00:00:00Z');
  const jsDay = weekday + 1; // lun=1 … sam=6
  const delta = (jsDay - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

export function seedReal(db: DatabaseSync): SeedResult {
  const flag = get<{ value: string }>(
    db,
    "SELECT value FROM setting WHERE key = 'seed_done'",
  );
  if (flag?.value === '1' || countRows(db, 'master') > 0) {
    return { inserted: false };
  }

  try {
    db.exec('BEGIN IMMEDIATE;');
    const insSetting = db.prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?)',
    );
    insSetting.run('backup_retention', '10');
    insSetting.run('data_source', 'FSJP Tanger — EDT officiels 2026/2027');

    const yearId = Number(
      db
        .prepare(
          "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
        )
        .run().lastInsertRowid,
    );
    const insSem = db.prepare(
      'INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, ?, ?)',
    );
    const sems: number[] = [];
    for (let i = 1; i <= 6; i++)
      sems.push(Number(insSem.run(yearId, `S${i}`, i).lastInsertRowid));
    const sem3 = sems[2];

    const insSlot = db.prepare(
      'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, ?, ?, ?)',
    );
    for (let w = 0; w <= 5; w++) insSlot.run(w, 8 * 60, 18 * 60, 'Journée 08h–18h');

    // Salles réelles
    const insRoom = db.prepare(
      'INSERT INTO room (name, capacity, is_active) VALUES (?, ?, 1)',
    );
    for (const [name, cap] of REAL_ROOMS) insRoom.run(name, cap);
    const roomIdByName = new Map<string, number>(
      (db.prepare('SELECT id, name FROM room').all() as {
        id: number;
        name: string;
      }[]).map((r) => [r.name, r.id]),
    );

    // Professeurs réels
    const insProf = db.prepare('INSERT INTO professor (full_name) VALUES (?)');
    for (const p of REAL_PROFS) insProf.run(p);
    const profIds = (db.prepare('SELECT id FROM professor ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    // Modules réels
    const insMod = db.prepare(
      'INSERT INTO module (code, name) VALUES (?, ?)',
    );
    REAL_MODULES.forEach((m, i) =>
      insMod.run(`MOD-${String(i + 1).padStart(3, '0')}`, m),
    );
    const modIds = (db.prepare('SELECT id FROM module ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    // Masters réels (S3)
    const insMaster = db.prepare(
      `INSERT INTO master (code, name, filiere, department, responsible_name,
         academic_year_id, semester_id, status)
       VALUES (?, ?, 'Droit', 'FSJP Tanger — Boukhalef', ?, ?, ?, 'ACTIF')`,
    );
    for (const [code, name, coord] of REAL_MASTERS)
      insMaster.run(code, name, coord, yearId, sem3);
    const masterIds = (db.prepare('SELECT id FROM master ORDER BY code').all() as { id: number }[]).map((r) => r.id);

    // master_module : une ligne par (master, module) distinct
    const insMM = db.prepare(
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          distribution_rule, sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, ?, 120, ?, NULL, ?, ?)`,
    );
    const mmId = new Map<string, number>();
    const insSession = db.prepare(
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status, comment)
       VALUES (?, ?, ?, ?, ?, ?, 'PREVUE', ?)`,
    );
    const insHist = db.prepare(
      `INSERT INTO session_status_history (session_id, old_status, new_status, reason)
       VALUES (?, NULL, 'PREVUE', 'Import EDT officiel S3 2026/2027')`,
    );
    let sessCount = 0;
    for (const [mi, modi, p1, p2, wd, s, e, roomName] of REAL_SESSIONS) {
      const key = `${mi}:${modi}`;
      let mm = mmId.get(key);
      if (mm === undefined) {
        mm = Number(
          insMM
            .run(masterIds[mi], modIds[modi], sem3, profIds[p1], 120 * WEEKS, WEEKS, SEM_START, SEM_END)
            .lastInsertRowid,
        );
        mmId.set(key, mm);
      }
      const roomId = roomIdByName.get(roomName);
      if (roomId === undefined) continue;
      const comment =
        p2 >= 0 ? `Co-enseigné avec ${REAL_PROFS[p2]}` : null;
      const base = firstOccurrence(wd);
      for (let w = 0; w < WEEKS; w++) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + w * 7);
        const sid = Number(
          insSession
            .run(mm, profIds[p1], roomId, iso(d), s, e, comment)
            .lastInsertRowid,
        );
        insHist.run(sid);
        sessCount++;
      }
    }

    // Occupation Licence (BR-25)
    const insOcc = db.prepare(
      `INSERT INTO external_occupancy
         (program, groupe, module, professor, room_id, weekday, start_min,
          end_min, academic_year_id, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let licCount = 0;
    for (const [prog, grp, mod, prof, wd, s, e, roomName] of REAL_LIC) {
      const roomId = roomIdByName.get(roomName);
      if (roomId === undefined) continue;
      insOcc.run(prog, grp, mod, prof, roomId, wd, s, e, yearId, 'a.fsjest.ma');
      licCount++;
    }

    insSetting.run('seed_done', '1');
    insSetting.run('seed_kind', 'real-fsjp-2026');
    insSetting.run('seed_counts', `${sessCount} sessions, ${licCount} occupations licence`);

    db.exec('COMMIT;');
    return { inserted: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}
