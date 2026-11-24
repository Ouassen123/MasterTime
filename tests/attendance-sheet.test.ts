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
import { all, openDatabase, run } from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import { ensureProfiles } from '../electron/main/db/profile.service';
import {
  buildAttendanceSheetHtml,
  resolveSheetRoster,
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
): number {
  return Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, ?, 480, 570, 'PREVUE')`,
      mmId,
      f.profId,
      f.roomId,
      date,
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
