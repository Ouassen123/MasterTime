/**
 * Seed RÉEL FSJP Tanger (données officielles 2026/2027) — insère les
 * référentiels réels une seule fois, dans une transaction unique.
 * is_demo = 0 partout : ce ne sont PAS des données de démonstration.
 *
 * Contenu : 17 salles (capacités officielles, Salle 3/9 capacité inconnue),
 * 14 Masters S3, 133 professeurs (149 extraits − 30 doublons + 14 ajoutés),
 * 93 modules, master_module par (master, module), 97 séances hebdomadaires
 * × 12 semaines (fenêtre 2026-09-21 → 2026-12-13), 168 occupations Licence
 * (external_occupancy).
 *
 * Dédup professeurs : les PDF sources écrivent le même enseignant de
 * plusieurs façons (casse, ordre des mots, variantes hamza آ/أ/إ, formes
 * courtes) — fusion validée manuellement le 2026-11-22. Canonique =
 * première occurrence normalisée, sauf PROF_ALIAS (forme courte → nom
 * complet, liste officielle utilisateur).
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

// --- Dédup professeurs -------------------------------------------------------
const AR_NORM = (s: string): string =>
  s
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء');
const normName = (s: string): string =>
  AR_NORM(s.toLowerCase())
    .normalize('NFD')
    .replace(/[̀-ͯـً-ٰٟ]/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');

/** Formes courtes → nom complet (fusion manuelle 2026-11-22). */
const PROF_ALIAS = new Map<string, string>([
  ['jami', 'Jami Jihad'],
  ['merbouh', 'k. merbouh'],
  ['essarsar', 'M. essarsar'],
  ['cheddadi', 'EL cheddadi'],
  ['ouais', 'Simou ouaiss'],
  ['simou ouais', 'Simou ouaiss'],
  ['حامي الدين', 'محمد حامي الدين'],
  ['محمد الحسناوي', 'الحسناوي محمد التقال'],
  ['عبد الله اشركي', 'أشركي أفقير عبد الله'],
  ['عبد الله أشركي', 'أشركي أفقير عبد الله'],
  // ordre des mots : canonique = forme conservée en base (la plus référencée)
  ['الحسناوي التقال محمد', 'الحسناوي محمد التقال'],
  ['محمد الحسناوي التقال', 'الحسناوي محمد التقال'],
  ['الحواشي عمر', 'عمر الحواشي'],
  ['البغيل عبد اللطيف', 'عبد اللطيف البغيل'],
  ['الكلعي عبد اللطيف', 'عبد اللطيف الكلعي'],
  ['بنيعيش محمد', 'محمد بنيعيش'],
]);

/** 14 professeurs ajoutés sur liste officielle utilisateur (2026-11-22). */
const EXTRA_PROFS = [
  'Rharzouz Jaouad',
  'Sekali Jamal',
  'Lamkaraf Ikram',
  'El Hafid Allah Samira',
  'Zarki Nabil',
  'Ejbari Abdelbar',
  'Morroun Rachid',
  'Miloudi Chaymae',
  'Bennani Anas',
  'Jami Jihad',
  'Boubker Omar',
  'Belqasmi Sabrine',
  'El Bakkouchi Youness',
  'Balkiss Ben Hayoun',
];

interface ProfSeed {
  /** Nom canonique par index REAL_PROFS (même longueur). */
  canonByIdx: string[];
  /** Noms dédupliqués dans l'ordre d'insertion. */
  names: string[];
  /** Index REAL_PROFS → index dans `names`. */
  remap: number[];
  /** Texte occupancy normalisé → nom canonique. */
  canonByNorm: Map<string, string>;
}

function buildProfs(): ProfSeed {
  const canonByIdx = REAL_PROFS.map(
    (p) => PROF_ALIAS.get(p) ?? PROF_ALIAS.get(p.toLowerCase()) ?? p,
  );
  const names: string[] = [];
  const idxByNorm = new Map<string, number>();
  const remap = canonByIdx.map((name) => {
    const k = normName(name);
    let idx = idxByNorm.get(k);
    if (idx === undefined) {
      idx = names.length;
      names.push(name);
      idxByNorm.set(k, idx);
    }
    return idx;
  });
  for (const name of EXTRA_PROFS) {
    const k = normName(name);
    if (!idxByNorm.has(k)) {
      idxByNorm.set(k, names.length);
      names.push(name);
    }
  }
  const canonByNorm = new Map<string, string>();
  canonByIdx.forEach((name, i) => canonByNorm.set(normName(name), names[remap[i]]));
  for (const p of REAL_PROFS) canonByNorm.set(normName(p), names[remap[REAL_PROFS.indexOf(p)]]);
  return { canonByIdx, names, remap, canonByNorm };
}

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

    // Professeurs réels (dédupliqués — voir buildProfs)
    const profs = buildProfs();
    const insProf = db.prepare('INSERT INTO professor (full_name) VALUES (?)');
    for (const p of profs.names) insProf.run(p);
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
      const p1r = profs.remap[p1];
      const p2r = p2 >= 0 ? profs.remap[p2] : -1;
      let mm = mmId.get(key);
      if (mm === undefined) {
        mm = Number(
          insMM
            .run(masterIds[mi], modIds[modi], sem3, profIds[p1r], 120 * WEEKS, WEEKS, SEM_START, SEM_END)
            .lastInsertRowid,
        );
        mmId.set(key, mm);
      }
      const roomId = roomIdByName.get(roomName);
      if (roomId === undefined) continue;
      const comment =
        p2r >= 0 ? `Co-enseigné avec ${profs.names[p2r]}` : null;
      const base = firstOccurrence(wd);
      for (let w = 0; w < WEEKS; w++) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + w * 7);
        const sid = Number(
          insSession
            .run(mm, profIds[p1r], roomId, iso(d), s, e, comment)
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
      const canonProf = prof ? (profs.canonByNorm.get(normName(prof)) ?? prof) : prof;
      insOcc.run(prog, grp, mod, canonProf, roomId, wd, s, e, yearId, 'a.fsjest.ma');
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
