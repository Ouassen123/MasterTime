/**
 * Seed DÉMO (AD-11) — insère le jeu de démonstration une seule fois,
 * dans une transaction unique. Idempotent.
 *
 * Gardes : drapeau `setting.seed_done='1'` (survit à une future purge
 * DÉMO qui viderait `master` mais garderait salles/modules réels) —
 * `master` non vide sert de garde secondaire.
 *
 * Toutes les entités portant la colonne `is_demo` sont insérées avec
 * `is_demo = 1`. Les salles (paramétrage initial exigé par le brief :
 * Amphi 7, Amphi 8, Salle 1) n'ont pas de colonne `is_demo` — ce sont les
 * seules données réelles autorisées.
 */
import { DatabaseSync } from 'node:sqlite';
import { countRows, get } from './connection';

export interface SeedResult {
  /** true si le jeu DÉMO a été inséré, false sinon. */
  inserted: boolean;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

/** Prochaine occurrence d'un jour de semaine (0=lun … 6=dim, convention AD-7). */
function nextWeekday(weekday: number, from = new Date()): Date {
  const jsDay = weekday === 6 ? 0 : weekday + 1; // Date.getDay(): 0=dim
  const d = new Date(from);
  const delta = (jsDay - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}

export function seedDemo(db: DatabaseSync): SeedResult {
  const flag = get<{ value: string }>(
    db,
    "SELECT value FROM setting WHERE key = 'seed_done'",
  );
  if (flag?.value === '1' || countRows(db, 'master') > 0) {
    return { inserted: false }; // déjà seedé ou base non vide → idempotent
  }

  try {
    db.exec('BEGIN IMMEDIATE;');

    // --- Paramètres par défaut --------------------------------------------
    const insSetting = db.prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?)',
    );
    insSetting.run('backup_retention', '10');
    insSetting.run('max_daily_load_min', '360');
    insSetting.run('generation_tolerance_min', '0');

    // --- Référentiel temps : 1 année, 2 semestres -------------------------
    const yearRes = db
      .prepare(
        "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)",
      )
      .run();
    const yearId = Number(yearRes.lastInsertRowid);
    const insSemester = db.prepare(
      'INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?, ?, ?)',
    );
    const sem1 = Number(insSemester.run(yearId, 'S1', 1).lastInsertRowid);
    const sem2 = Number(insSemester.run(yearId, 'S2', 2).lastInsertRowid);

    // --- Créneaux par défaut : Lun–Sam 08h–19h ----------------------------
    const insSlot = db.prepare(
      'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, ?, ?, ?)',
    );
    for (let weekday = 0; weekday <= 5; weekday++) {
      insSlot.run(weekday, 8 * 60, 19 * 60, 'Journée 08h–19h');
    }

    // --- Salles (paramétrage initial réel, exigé par le brief) ------------
    const insRoom = db.prepare(
      'INSERT INTO room (name, capacity, is_active) VALUES (?, ?, 1)',
    );
    insRoom.run('Amphi 7', 240);
    insRoom.run('Amphi 8', 200);
    insRoom.run('Salle 1', 40);

    // --- Masters DÉMO ------------------------------------------------------
    const insMaster = db.prepare(
      `INSERT INTO master (code, name, filiere, department, responsible_name,
         academic_year_id, semester_id, status, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIF', 1)`,
    );
    insMaster.run('M-DEMO-GL', 'Master DÉMO Génie Logiciel', 'Informatique', 'Dépt. Informatique', 'Coord. DÉMO GL', yearId, sem1);
    insMaster.run('M-DEMO-DS', 'Master DÉMO Data Science', 'Data', 'Dépt. Mathématiques', 'Coord. DÉMO DS', yearId, sem1);
    insMaster.run('M-DEMO-RT', 'Master DÉMO Réseaux & Télécoms', 'Réseaux', 'Dépt. Génie Électrique', 'Coord. DÉMO RT', yearId, sem2);

    // --- Professeurs DÉMO (~8) --------------------------------------------
    const insProf = db.prepare(
      'INSERT INTO professor (full_name, internal_ref, email, is_demo) VALUES (?, ?, ?, 1)',
    );
    const demoProfs = [
      'Prof. DÉMO Alami', 'Prof. DÉMO Benjelloun', 'Prof. DÉMO Chraibi',
      'Prof. DÉMO El Fassi', 'Prof. DÉMO Idrissi', 'Prof. DÉMO Moussaoui',
      'Prof. DÉMO Tahiri', 'Prof. DÉMO Ziani',
    ];
    demoProfs.forEach((name, i) => {
      insProf.run(name, `DEMO-P${i + 1}`, `demo.prof${i + 1}@example.test`);
    });
    const profIds = (db.prepare('SELECT id FROM professor ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    // --- Modules DÉMO ------------------------------------------------------
    const insModule = db.prepare(
      'INSERT INTO module (code, name, is_demo) VALUES (?, ?, 1)',
    );
    const demoModules: [string, string][] = [
      ['MOD-DEMO-ALGO', 'Algorithmique avancée (DÉMO)'],
      ['MOD-DEMO-BD', 'Bases de données (DÉMO)'],
      ['MOD-DEMO-IA', 'Intelligence artificielle (DÉMO)'],
      ['MOD-DEMO-ML', 'Machine learning (DÉMO)'],
      ['MOD-DEMO-RES', 'Réseaux IP (DÉMO)'],
      ['MOD-DEMO-SEC', 'Sécurité des systèmes (DÉMO)'],
    ];
    for (const [code, name] of demoModules) insModule.run(code, name);
    const modIds = (db.prepare('SELECT id FROM module ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    const masterIds = (db.prepare('SELECT id FROM master ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    // --- MasterModules DÉMO -------------------------------------------------
    const insMM = db.prepare(
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          distribution_rule, sched_start, sched_end)
       VALUES (?, ?, ?, ?, NULL, 1350, 90, 15, NULL, ?, ?)`,
    );
    // Fenêtre de planification relative à aujourd'hui : maintenant → +6 mois
    const schedStart = isoDate(new Date());
    const schedEnd = isoDate(addMonths(new Date(), 6));
    // 2 modules par master (student_group NULL = master entier)
    const mmPairs: [number, number, number, number][] = [
      [masterIds[0], modIds[0], sem1, profIds[0]],
      [masterIds[0], modIds[1], sem1, profIds[1]],
      [masterIds[1], modIds[2], sem1, profIds[2]],
      [masterIds[1], modIds[3], sem1, profIds[3]],
      [masterIds[2], modIds[4], sem2, profIds[4]],
      [masterIds[2], modIds[5], sem2, profIds[5]],
    ];
    for (const [mId, modId, semId, pId] of mmPairs) {
      insMM.run(mId, modId, semId, pId, schedStart, schedEnd);
    }
    const mmRows = db
      .prepare('SELECT id, professor_id FROM master_module ORDER BY id')
      .all() as { id: number; professor_id: number }[];
    const roomIds = (db.prepare('SELECT id FROM room ORDER BY id').all() as { id: number }[]).map((r) => r.id);

    // --- Séances DÉMO (PREVUE, dates futures pour rester "prévues") --------
    const insSession = db.prepare(
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, 'PREVUE', 1)`,
    );
    const slots: [number, number][] = [
      [8 * 60, 9 * 60 + 30],   // 08h00–09h30
      [9 * 60 + 45, 11 * 60 + 15], // 09h45–11h15
      [14 * 60, 15 * 60 + 30], // 14h00–15h30
    ];
    for (let i = 0; i < 8; i++) {
      const mm = mmRows[i % mmRows.length];
      const weekday = Math.floor(i / slots.length) % 6; // répartit lun→sam
      const [start, end] = slots[i % slots.length];
      insSession.run(
        mm.id,
        mm.professor_id, // prof désigné par le master_module
        roomIds[i % roomIds.length],
        isoDate(nextWeekday(weekday)),
        start,
        end,
      );
    }

    // --- Drapeau d'idempotence (en dernier, dans la même transaction) ------
    insSetting.run('seed_done', '1');

    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
  return { inserted: true };
}
