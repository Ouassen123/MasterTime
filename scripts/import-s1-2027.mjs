// Import des distributions S1 2026/2027 depuis import_plan.json.
// Usage : node scripts/import-s1-2027.mjs <chemin-db> [apply]
// Sans "apply" : rapport seul (dry-run).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const dbPath = process.argv[2];
const apply = process.argv[3] === 'apply';
const planPath = new URL('./data/import-s1-2027.plan.json', import.meta.url);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON');

const SCHED_START = '2026-09-21';
const SCHED_END = '2026-12-13';
const SEMESTER_S1 = 1;

// ---- Helpers ---------------------------------------------------------------
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const TITLES = new Set(['ذ', 'ذة', 'د', 'ذو', 'دة', 'دو', 'أ', 'الاستاذ', 'الأستاذ']);
const normAr = (s) => String(s ?? '')
  .replace(/[ـً-ْ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
  .replace('.', ' ')
  .split(/\s+/).filter((p) => p && !TITLES.has(p)).join(' ').trim();
const stripAl = (t) => new Set([...t].map((w) => w.replace(/^ال/, '')));
const toks = (s) => new Set(normAr(s).split(' ').filter(Boolean));
const same = (a, b) => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

// dates hebdo pour un weekday (0=lun) entre SCHED_START..SCHED_END
function weekDates(weekday) {
  const out = [];
  const d = new Date(`${SCHED_START}T00:00:00Z`);
  const end = new Date(`${SCHED_END}T00:00:00Z`);
  while (d <= end) {
    if ((d.getUTCDay() + 6) % 7 === weekday) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ---- Entités ---------------------------------------------------------------
const profs = q('SELECT id, full_name FROM professor');
const findProf = (raw) => {
  const t = toks(raw.split(/[/،]/)[0]);
  for (const p of profs) if (same(t, toks(p.full_name))) return p;
  const tNoAl = stripAl(t);
  for (const p of profs) {
    const pt = toks(p.full_name);
    if (same(tNoAl, stripAl(pt))) return p;
  }
  // sous-ensemble unique
  const c = profs.filter((p) => {
    const pt = toks(p.full_name);
    return t.size && [...t].every((x) => pt.has(x));
  });
  return c.length === 1 ? c[0] : null;
};

const mods = q('SELECT id, name FROM module');
const normMod = (s) => normAr(s).toLowerCase().replace(/[،,.:;]+$/, '').trim();
const findMod = (name) => mods.find((m) => normMod(m.name) === normMod(name));

const masters = q('SELECT id, code, name, semester_id FROM master');
const findMaster = (name) => {
  const t = normAr(name);
  return masters.find((m) => normAr(m.name) === t)
    ?? masters.find((m) => normAr(m.name).includes(t) || t.includes(normAr(m.name)));
};

const rooms = q('SELECT id, name, capacity FROM room WHERE is_active=1');
const roomByName = (n) => rooms.find((r) => r.name === n);

const report = { created: { masters: [], modules: [], profs: [], rooms: [] }, mm: 0, sessions: 0, conflicts: [], moved: [], errors: [] };

// occupation existante : sessions + licence, index par salle
const busy = new Map(); // room_id -> [{date,start,end,who}]
const addBusy = (roomId, date, s, e, who) => {
  if (!busy.has(roomId)) busy.set(roomId, []);
  busy.get(roomId).push({ date, s, e, who });
};
for (const s of q('SELECT room_id, date, start_min, end_min FROM session WHERE status != \'ANNULEE\''))
  addBusy(s.room_id, s.date, s.start_min, s.end_min, 'master');
const weekdayDates = new Map();
for (const o of q('SELECT room_id, weekday, start_min, end_min, program, groupe FROM external_occupancy')) {
  if (!weekdayDates.has(o.weekday)) weekdayDates.set(o.weekday, weekDates(o.weekday));
  for (const d of weekdayDates.get(o.weekday))
    addBusy(o.room_id, d, o.start_min, o.end_min, `licence:${o.program}`);
}
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const roomFree = (roomId, dates, s, e) =>
  !(busy.get(roomId) ?? []).some((b) => dates.includes(b.date) && overlaps(s, e, b.s, b.e));
const profBusy = new Map(); // prof_id -> [{date,s,e}]
const addProfBusy = (pid, date, s, e) => {
  if (!profBusy.has(pid)) profBusy.set(pid, []);
  profBusy.get(pid).push({ date, s, e });
};
for (const s of q('SELECT professor_id, date, start_min, end_min FROM session WHERE status != \'ANNULEE\''))
  addProfBusy(s.professor_id, s.date, s.start_min, s.end_min);

// ---- Créations préalables ---------------------------------------------------
const tx = () => db.exec('BEGIN');
const commit = () => db.exec('COMMIT');

tx();
try {
  if (!roomByName('Salle 10')) {
    const r = run("INSERT INTO room (name, capacity, is_active) VALUES ('Salle 10', 40, 1)");
    rooms.push({ id: Number(r.lastInsertRowid), name: 'Salle 10', capacity: 40 });
    report.created.rooms.push('Salle 10');
  }
  if (!roomByName('Annexe 2')) {
    const r = run("INSERT INTO room (name, capacity, is_active) VALUES ('Annexe 2', NULL, 1)");
    rooms.push({ id: Number(r.lastInsertRowid), name: 'Annexe 2', capacity: null });
    report.created.rooms.push('Annexe 2');
  }

  let nextModCode = Math.max(...q("SELECT MAX(CAST(SUBSTR(code,5) AS INT)) c FROM module").map((x) => x.c ?? 93)) + 1;
  let nextMasterCode = Math.max(...masters.map((m) => Number(m.code?.slice(2)) || 0)) + 1;
  const masterRows = new Map(); // master name -> id
  const getMaster = (name, coord) => {
    // cohorte S1 déjà importée ? -> réutiliser (idempotent)
    const s1 = masters.find((m) => m.semester_id === SEMESTER_S1 && normAr(m.name) === normAr(name));
    if (s1) return s1.id;
    const ex = masters.find((m) => normAr(m.name) === normAr(name));
    if (!ex) {
      const code = `M-${String(nextMasterCode++).padStart(2, '0')}`;
      const r = run(
        `INSERT INTO master (code, name, filiere, department, responsible_name, academic_year_id, semester_id, status, is_demo, temps_amenage)
         VALUES (?,?,?,?,?,?,1,'ACTIF',0,0)`,
        code, name, 'Droit', 'FSJP Tanger — Boukhalef', coord ?? null, 1,
      );
      masters.push({ id: Number(r.lastInsertRowid), name, code, semester_id: SEMESTER_S1 });
      report.created.masters.push(`${code} ${name}`);
      return Number(r.lastInsertRowid);
    }
    if (ex.semester_id === SEMESTER_S1) return ex.id;
    // cohorte S1 du même programme : nouvelle ligne master
    const key = `S1:${ex.id}`;
    if (!masterRows.has(key)) {
      const code = `M-${String(nextMasterCode++).padStart(2, '0')}`;
      const src = q1('SELECT * FROM master WHERE id=?', ex.id);
      const r = run(
        `INSERT INTO master (code, name, filiere, department, responsible_name, academic_year_id, semester_id, status, is_demo, temps_amenage)
         VALUES (?,?,?,?,?,?,1,'ACTIF',0,?)`,
        code, src.name, src.filiere, src.department, coord ?? src.responsible_name, 1, src.temps_amenage,
      );
      masterRows.set(key, Number(r.lastInsertRowid));
      report.created.masters.push(`${code} ${src.name} (cohorte S1)`);
    }
    return masterRows.get(key);
  };
  const getProf = (raw) => {
    const hit = findProf(raw);
    if (hit) return hit.id;
    const clean = normAr(raw.split(/[/،]/)[0]);
    const r = run('INSERT INTO professor (full_name, is_demo, is_active) VALUES (?,0,1)', clean);
    profs.push({ id: Number(r.lastInsertRowid), full_name: clean });
    report.created.profs.push(clean);
    return Number(r.lastInsertRowid);
  };
  const getMod = (name) => {
    const hit = findMod(name);
    if (hit) return hit.id;
    const code = `MOD-${String(nextModCode++).padStart(3, '0')}`;
    const r = run('INSERT INTO module (code, name, is_demo) VALUES (?,?,0)', code, name.trim());
    mods.push({ id: Number(r.lastInsertRowid), name: name.trim() });
    report.created.modules.push(`${code} ${name.trim()}`);
    return Number(r.lastInsertRowid);
  };

  const masterCoord = {
    'قانون الاستثمار وآليات تدبير المنازعات': 'دة. جميلة العماري',
    'المنازعات العقدية والتكنولجيا الحديثة': 'دة. مريم الطاشي',
    'المنازعات المدنية والتجارية': 'دة. لبنى الغومرتي',
    'قانون المنازعات': 'د. الحسن الجماعي',
    'المساطر القانونية والوسائل البديلة لتسوية المنازعات': 'دة. سعاد حميدي',
    'قوانين التجارة والاعمال والتحول الرقمي': 'د. خالد بنتركي',
    'حقوق الإنسان والتقاضي الدولي': 'د. عبد القادر مساعد',
    'القانون والعلوم الإدارية والمالية للتنمية': 'د. محمد يحيا',
    'القانون المدني والأعمال والمعاملات الإئتمانية': 'د. أحمد الجباري',
    'الدراسات العقارية والتوثيق الرقمي': 'د. ايت الحاج',
    'المهن القانونية والقضائية والرقمية والتحولات الاقتصادية': 'دة. وداد العيدوني',
    'النظام الجمركي ومنازعات الاستثمار': 'د. عبد الله أشركي',
  };

  for (const e of plan) {
    try {
      if (e.day === null || !e.room || !e.mins) { report.errors.push(`ligne ignorée: ${e.module}`); continue; }
      const masterId = getMaster(e.master, masterCoord[e.master]);
      const profId = e.prof_id ?? getProf(e.prof_raw);
      const modId = e.module_id ?? getMod(e.module);
      const [s0, s1] = e.mins;
      const dur = s1 - s0;
      const dates = weekDates(e.day);
      // salle : celle demandée, sinon alternative libre sur TOUTES les dates
      let room = roomByName(e.room);
      if (!room) { report.errors.push(`salle inconnue ${e.room} (${e.module})`); continue; }
      if (!roomFree(room.id, dates, s0, s1)) {
        const alt = rooms
          .filter((r) => r.id !== room.id && roomFree(r.id, dates, s0, s1))
          .sort((a, b) => (a.capacity ?? 999) - (b.capacity ?? 999))[0];
        if (alt) {
          report.moved.push(`${e.module} : ${room.name} -> ${alt.name} (occupée)`);
          room = alt;
        } else {
          report.conflicts.push(`${e.module} : ${room.name} ${e.day} ${Math.floor(s0/60)}h — conflit non résolu`);
        }
      }
      if (q1('SELECT id FROM master_module WHERE master_id=? AND module_id=? AND professor_id=? AND semester_id=?',
        masterId, modId, profId, SEMESTER_S1)) continue; // déjà importé
      const mmr = run(
        `INSERT INTO master_module (master_id, module_id, semester_id, professor_id, student_group_id,
           volume_min, session_duration_min, planned_sessions, distribution_rule, sched_start, sched_end, is_fixed)
         VALUES (?,?,?,?,NULL,?,?,?,NULL,?,?,1)`,
        masterId, modId, SEMESTER_S1, profId, dur * dates.length, dur, dates.length, SCHED_START, SCHED_END,
      );
      report.mm++;
      const mmId = Number(mmr.lastInsertRowid);
      for (const d of dates) {
        run(
          `INSERT INTO session (master_module_id, professor_id, room_id, date, start_min, end_min, status, is_demo)
           VALUES (?,?,?,?,?,?,'PREVUE',0)`,
          mmId, profId, room.id, d, s0, s1,
        );
        addBusy(room.id, d, s0, s1, 'new-s1');
        addProfBusy(profId, d, s0, s1);
        report.sessions++;
      }
      // conflit prof ? (signalement seulement)
      const pb = (profBusy.get(profId) ?? []).filter((b) => dates.includes(b.date) && overlaps(s0, s1, b.s, b.e));
      const extra = pb.length - dates.length; // les siennes viennent d'être ajoutées
      if (extra > 0) report.conflicts.push(`prof ${profId} (${e.module}): ${extra} chevauchement(s) horaire`);
    } catch (err) {
      report.errors.push(`${e.module}: ${err.message}`);
    }
  }

  if (apply) { commit(); } else { db.exec('ROLLBACK'); }
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log(JSON.stringify({
  masters: report.created.masters.length,
  modules: report.created.modules.length,
  profs: report.created.profs,
  rooms: report.created.rooms,
  mm: report.mm, sessions: report.sessions,
  moved: report.moved, conflicts: report.conflicts, errors: report.errors,
}, null, 1));
db.close();
