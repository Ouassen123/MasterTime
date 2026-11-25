/**
 * Tests P14 — feuille de présence imprimable
 * (`attendance-sheet.service.ts`) sur base `:memory:` : roster
 * (union mm.student_group_id ∪ session_group, dédoublonné, trié),
 * feuille blanche à 25 lignes quand aucun groupe, échappement HTML,
 * `dir="auto"`, bloc séance complet et nom de fichier proposé.
 * Aucun Electron — le canal `sessions:attendanceSheet` (printToPDF)
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
import {
  buildAttendanceSheetHtml,
  buildWeekSheetHtml,
  mondayOfWeek,
  resolveSheetRoster,
  weekSheetSessions,
} from '../electron/main/db/attendance-sheet.service';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

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
  /** mm sans groupe (séance « master entier »). */
  mmId: number;
  /** mm rattaché au groupe G1. */
  mmG1Id: number;
  profId: number;
  roomId: number;
}

/**
 * Référentiel minimal : 1 année/semestre/master/module/prof/salle,
 * 2 groupes (G1, G2) peuplés d'étudiants, 2 master-modules (un lié à
 * G1, un sans groupe).
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
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle T', 30)")
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
  // Étudiants : G1 (dont un nom à échapper), G2 — external_id
  // distincts (ux_student_group_ext est UNIQUE sur COALESCE(external_id)).
  const students: [number, string][] = [
    [g1Id, 'Yassine Amrani'],
    [g1Id, "Baba <script>alert('x')</script> & Cie"],
    [g1Id, 'Fatima Zahra'],
    [g2Id, 'Amina Ziani'],
    [g2Id, 'Karim Ouled'],
  ];
  const insStudent = db.prepare(
    `INSERT INTO student (student_group_id, external_id, full_name)
     VALUES (?, ?, ?)`,
  );
  students.forEach(([g, n], i) =>
    insStudent.run(g, `ETU-${String(i + 1).padStart(3, '0')}`, n),
  );

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
    mmId: mkMm(null),
    mmG1Id: mkMm(g1Id),
    profId,
    roomId,
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

/** Lignes du tableau de présence (corps) : une par <tr><td class="num">. */
function bodyRows(html: string): string[] {
  return html.match(/<tr><td class="num">\d+<\/td>/g) ?? [];
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

describe('P14 — resolveSheetRoster', () => {
  it('groupe du mm seul ; union avec session_group ; dédoublonnée, triée', () => {
    const db = freshDb();
    const f = seedFixture(db);

    // mm lié à G1 → roster = étudiants de G1, triés par full_name.
    const s1 = addSession(db, f, f.mmG1Id);
    expect(resolveSheetRoster(db, s1).students).toEqual([
      "Baba <script>alert('x')</script> & Cie",
      'Fatima Zahra',
      'Yassine Amrani',
    ]);

    // session_group ajoute G2 → union G1 ∪ G2, triée.
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      s1,
      f.g2Id,
    );
    const roster = resolveSheetRoster(db, s1).students;
    expect(roster).toEqual([
      'Amina Ziani',
      "Baba <script>alert('x')</script> & Cie",
      'Fatima Zahra',
      'Karim Ouled',
      'Yassine Amrani',
    ]);

    // session_group répétant le groupe du mm → aucun doublon.
    const s2 = addSession(db, f, f.mmG1Id, '2026-10-21');
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      s2,
      f.g1Id,
    );
    expect(resolveSheetRoster(db, s2).students).toHaveLength(3);

    // mm sans groupe + pas de session_group → liste vide (feuille blanche).
    const s3 = addSession(db, f, f.mmId, '2026-10-22');
    expect(resolveSheetRoster(db, s3).students).toEqual([]);
  });
});

describe('P14 — buildAttendanceSheetHtml', () => {
  it('document complet : en-tête FSJP, bloc séance, tableau, pied de signature', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmG1Id);
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sid,
      f.g2Id,
    );

    const res = buildAttendanceSheetHtml(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { html, suggestedName } = res.data;

    // Structure : autonome, charset utf-8, A4 portrait.
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('size: A4 portrait');

    // En-tête FSJP + titre.
    expect(html).toContain(
      'Faculté des Sciences Juridiques et Politiques — Tanger',
    );
    expect(html).toContain('Feuille de présence');

    // Bloc séance complet.
    expect(html).toContain('M-T — Master T');
    expect(html).toContain('MOD-T — Module T');
    expect(html).toContain('Prof Test');
    expect(html).toContain('Salle T');
    expect(html).toContain('mardi 20/10/2026');
    expect(html).toContain('08:00 – 09:30');
    expect(html).toContain('G1, G2');

    // Colonnes réglementaires.
    for (const th of ['N°', 'Nom et prénom', 'Présent', 'Absent', 'Observation']) {
      expect(html).toContain(th);
    }

    // Roster : 5 lignes numérotées, noms présents.
    const rows = bodyRows(html);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('>1<');
    expect(rows[4]).toContain('>5<');
    expect(html).toContain('Yassine Amrani');
    expect(html).toContain('Amina Ziani');

    // Pied de signature réglementaire.
    expect(html).toContain("Séance assurée par l'enseignant");
    expect(html).toContain('☐ Oui');
    expect(html).toContain('☐ Non');
    expect(html).toContain('Le Responsable du Master');
    expect(html).toContain('Fait à Tanger, le');

    // Nom de fichier suggéré.
    expect(suggestedName).toBe('feuille-presence-2026-10-20-M-T.pdf');
  });

  it('échappement HTML + dir="auto" sur les contenus saisis', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmG1Id);
    const res = buildAttendanceSheetHtml(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const html = res.data.html;

    // Le nom malveillant est échappé — jamais injecté tel quel.
    expect(html).not.toContain("<script>alert('x')</script>");
    expect(html).toContain(
      'Baba &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; Cie',
    );
    // dir="auto" sur les cellules de noms (arabe possible).
    expect(html).toContain('<td dir="auto">');
  });

  it('aucun étudiant → 25 lignes vides numérotées 1..25 + « Master entier »', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const sid = addSession(db, f, f.mmId); // mm sans groupe, pas de session_group
    const res = buildAttendanceSheetHtml(db, sid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const html = res.data.html;

    const rows = bodyRows(html);
    expect(rows).toHaveLength(25);
    expect(rows[0]).toContain('>1<');
    expect(rows[24]).toContain('>25<');
    // Cellules nom vides — la feuille se remplit à la main.
    expect(html).toContain('<td dir="auto"></td>');
    expect(html).toContain('Master entier');
    // Aucun nom d'étudiant.
    expect(html).not.toContain('Yassine Amrani');
  });

  it('séance inexistante → erreur ; audit intact', () => {
    const db = freshDb();
    seedFixture(db);
    const res = buildAttendanceSheetHtml(db, 9999);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/introuvable/);
    expect(all(db, 'SELECT id FROM audit_log')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P17 — Feuille de présence hebdomadaire par Master (A4 paysage)
// ---------------------------------------------------------------------------

describe('P17 — weekSheetSessions', () => {
  it('normalise au lundi ; borne la semaine ; exclut ANNULEE et les autres masters', () => {
    const db = freshDb();
    const f = seedFixture(db);

    // Semaine du lun 19/10/2026 : 20/10 (mmG1), 21/10 (ANNULEE — exclue),
    // 22/10 (mmId), 26/10 (semaine suivante — exclue).
    const s1 = addSession(db, f, f.mmG1Id, '2026-10-20');
    addSession(db, f, f.mmG1Id, '2026-10-21', 'ANNULEE');
    const s3 = addSession(db, f, f.mmId, '2026-10-22');
    addSession(db, f, f.mmG1Id, '2026-10-26');

    // Un autre master avec une séance la même semaine — jamais listé.
    const yearId = Number(
      get<{ id: number }>(
        db,
        'SELECT id FROM academic_year LIMIT 1',
      )!.id,
    );
    const master2 = Number(
      run(
        db,
        "INSERT INTO master (code, name, academic_year_id) VALUES ('M-U', 'Master U', ?)",
        yearId,
      ).lastInsertRowid,
    );
    const modId = Number(
      get<{ id: number }>(db, 'SELECT id FROM module LIMIT 1')!.id,
    );
    const semId = Number(
      get<{ id: number }>(db, 'SELECT id FROM semester LIMIT 1')!.id,
    );
    const mm2 = Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id, student_group_id,
            volume_min, session_duration_min, planned_sessions,
            sched_start, sched_end)
         VALUES (?, ?, ?, ?, NULL, 1200, 90, 10, '2026-09-01', '2027-01-31')`,
        master2,
        modId,
        semId,
        f.profId,
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, '2026-10-20', 480, 570, 'PREVUE')`,
      mm2,
      f.profId,
      f.roomId,
    );

    // week_start = jeudi 22/10 → normalisé au lundi 19/10.
    expect(mondayOfWeek('2026-10-22')).toBe('2026-10-19');
    expect(mondayOfWeek('2026-10-19')).toBe('2026-10-19');
    expect(mondayOfWeek('2026-10-25')).toBe('2026-10-19'); // dimanche

    const { monday, sessions } = weekSheetSessions(db, f.masterId, '2026-10-22');
    expect(monday).toBe('2026-10-19');
    expect(sessions.map((s) => s.id)).toEqual([s1, s3]);
  });
});

describe('P17 — buildWeekSheetHtml', () => {
  it('document paysage : colonnes séances, roster union dédoublonné, pied « Séances assurées »', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const s1 = addSession(db, f, f.mmG1Id, '2026-10-20');
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      s1,
      f.g2Id,
    );
    addSession(db, f, f.mmId, '2026-10-22');

    const res = buildWeekSheetHtml(db, f.masterId, '2026-10-20');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { html, suggestedName } = res.data;

    // A4 paysage + en-tête FSJP + titre master/semaine.
    expect(html).toContain('size: A4 landscape');
    expect(html).toContain(
      'Faculté des Sciences Juridiques et Politiques — Tanger',
    );
    expect(html).toContain('Feuille de présence — Master M-T');
    expect(html).toContain('semaine du 19/10/2026');
    expect(html).toContain('M-T — Master T');

    // Les deux séances figurent (en-têtes colonnes + pied attestation).
    expect(html.match(/<th><div class="d">/g)).toHaveLength(2);
    expect(html).toContain('Séances assurées par l\'enseignant');
    expect(html).toContain('☐ Oui');
    expect(html).toContain('☐ Non');
    expect(html).toContain('Prof Test');
    expect(html).toContain('Salle T');
    expect(html).toContain('MOD-T — Module T');

    // Roster union G1 ∪ session_group G2 : 5 lignes dédoublonnées triées.
    const rows = bodyRows(html);
    expect(rows).toHaveLength(5);
    expect(html).toContain('Yassine Amrani');
    expect(html).toContain('Amina Ziani');
    expect(html).toContain('Observation');

    // Pied réglementaire.
    expect(html).toContain('Le Responsable du Master');
    expect(html).toContain('Fait à Tanger, le');

    // Nom de fichier : <master>-S<semaine ISO> (19/10/2026 = S43).
    expect(suggestedName).toBe('feuille-presence-M-T-S43.pdf');
  });

  it('aucun étudiant impliqué → 25 lignes vides ; master inexistant → erreur', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // Semaine ne contenant qu'une séance « master entier » (sans groupe).
    addSession(db, f, f.mmId, '2026-10-22');
    const res = buildWeekSheetHtml(db, f.masterId, '2026-10-19');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(bodyRows(res.data.html)).toHaveLength(25);
    expect(res.data.html).not.toContain('Yassine Amrani');

    const missing = buildWeekSheetHtml(db, 9999, '2026-10-19');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/introuvable/);
  });

  it('plus de 8 séances → 8 colonnes + note « suite sur une 2e feuille »', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // 9 séances dans la semaine (mmG1) → cap 8.
    const days = [
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22',
      '2026-10-23', '2026-10-24', '2026-10-19', '2026-10-20',
      '2026-10-21',
    ];
    for (const d of days) addSession(db, f, f.mmG1Id, d);

    const res = buildWeekSheetHtml(db, f.masterId, '2026-10-19');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const html = res.data.html;
    expect(html.match(/<th><div class="d">/g)).toHaveLength(8);
    expect(html).toContain('suite sur une 2e feuille');
    // Le bloc d'attestation liste les 9 séances.
    expect(html.match(/☐ Oui/g)).toHaveLength(9);
  });
});
