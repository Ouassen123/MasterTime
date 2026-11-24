/**
 * Tests P11 — import / export CSV (`import.service`) sur base `:memory:`.
 *
 * Couvre (§6) :
 * - parsing : `;` vs `,` auto-détecté, BOM, quoting `"` (séparateur et
 *   saut de ligne quotés, `""`), lignes vides, en-tête invalide,
 *   colonne inconnue (warning non bloquant), refus > 10 000 lignes ;
 * - preview : OK / DOUBLON NOCASE (`Amphi 7` vs `amphi 7`) avec
 *   `match_id` / ERREUR (requis, `capacite` non entier, groupe et
 *   master_code inconnus, semestre inexistant) ;
 * - apply : IGNORER / FUSIONNER (champs non vides) / REMPLACER (vides →
 *   NULL), erreurs isolées non bloquantes, atomicité (trigger de
 *   plantage → rollback intégral, 0 écriture ni audit), audit par
 *   entité + récap IMPORT, `is_demo = 0` ;
 * - étudiants : bon groupe, `external_id` généré `MAN-<id>` si vide ;
 * - export par entité : colonnes + compte de lignes exacts, CSV `;`+BOM ;
 * - gabarits : en-têtes exacts par type ;
 * - payload forgé : type / stratégie / texte non-string refusés.
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
import {
  ensureProfiles,
  listProfiles,
} from '../electron/main/db/profile.service';
import {
  applyImport,
  entityCsv,
  exportEntity,
  previewImport,
  templateCsv,
} from '../electron/main/db/import.service';
import type { ImportPreview } from '../shared/types';

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

function adminId(db: DatabaseSync): number {
  const admin = listProfiles(db).find((p) => p.role === 'ADMIN');
  expect(admin).toBeDefined();
  return admin!.id;
}

interface Fixture {
  yearId: number;
  semId: number;
  masterId: number;
  groupId: number;
  roomId: number;
  profId: number;
  moduleId: number;
  studentId: number;
}

/** Référentiel minimal : année courante 2026-2027 + S3, master MID/G1. */
function seedFixture(db: DatabaseSync): Fixture {
  const yearId = Number(
    run(
      db,
      `INSERT INTO academic_year (label, start_date, end_date, is_current)
       VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)`,
    ).lastInsertRowid,
  );
  const semId = Number(
    run(
      db,
      `INSERT INTO semester (academic_year_id, label, ordinal)
       VALUES (?, 'S3', 3)`,
      yearId,
    ).lastInsertRowid,
  );
  const masterId = Number(
    run(
      db,
      `INSERT INTO master (code, name, academic_year_id, semester_id)
       VALUES ('MID', 'Master Info', ?, ?)`,
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const groupId = Number(
    run(
      db,
      `INSERT INTO student_group (master_id, name, size)
       VALUES (?, 'G1', 25)`,
      masterId,
    ).lastInsertRowid,
  );
  const roomId = Number(
    run(
      db,
      `INSERT INTO room (name, capacity) VALUES ('Amphi 7', 240)`,
    ).lastInsertRowid,
  );
  const profId = Number(
    run(
      db,
      `INSERT INTO professor (full_name, email)
       VALUES ('Prof Un', 'prof@univ.ma')`,
    ).lastInsertRowid,
  );
  const moduleId = Number(
    run(
      db,
      `INSERT INTO module (code, name) VALUES ('MOD-T', 'Génie logiciel')`,
    ).lastInsertRowid,
  );
  const studentId = Number(
    run(
      db,
      `INSERT INTO student (student_group_id, external_id, full_name)
       VALUES (?, 'E1', 'Etudiant Un')`,
      groupId,
    ).lastInsertRowid,
  );
  return { yearId, semId, masterId, groupId, roomId, profId, moduleId, studentId };
}

function previewOk(
  db: DatabaseSync,
  type: Parameters<typeof previewImport>[1],
  csv: string,
): ImportPreview {
  const res = previewImport(db, type, csv);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

interface AuditRow {
  action: string;
  entity: string;
  entity_id: number | null;
  old_values: string | null;
  new_values: string | null;
}

const auditRows = (db: DatabaseSync): AuditRow[] =>
  all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY id');

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

// --- Parsing ------------------------------------------------------------------

describe('parsing CSV', () => {
  it('délimiteur « ; » détecté sur l’en-tête', () => {
    const db = freshDb();
    const p = previewOk(db, 'salles', 'nom;capacite;actif(0/1)\nSalle X;30;1');
    expect(p.columns).toEqual(['nom', 'capacite', 'actif(0/1)']);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].status).toBe('OK');
    expect(p.rows[0].parsed).toMatchObject({
      nom: 'Salle X',
      capacite: '30',
      'actif(0/1)': '1',
    });
  });

  it('délimiteur « , » auto quand l’en-tête n’a pas de « ; »', () => {
    const db = freshDb();
    const p = previewOk(db, 'salles', 'nom,capacite\nSalle Y,40');
    expect(p.columns).toEqual(['nom', 'capacite']);
    expect(p.rows[0].status).toBe('OK');
    expect(p.rows[0].parsed.capacite).toBe('40');
  });

  it('BOM UTF-8 accepté', () => {
    const db = freshDb();
    const p = previewOk(db, 'salles', '﻿nom;capacite\nSalle B;10');
    expect(p.columns).toEqual(['nom', 'capacite']);
    expect(p.rows[0].status).toBe('OK');
  });

  it('quoting « " » : séparateur, guillemets doublés et saut de ligne quotés', () => {
    const db = freshDb();
    const csv =
      'nom;capacite\n"Salle; A";30\n"Salle ""B""" ;20';
    const p = previewOk(db, 'salles', csv);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].parsed.nom).toBe('Salle; A');
    expect(p.rows[1].parsed.nom).toBe('Salle "B"');
    // Ligne avec saut de ligne à l'intérieur des guillemets.
    const q = previewOk(
      db,
      'professeurs',
      'nom_complet;email\n"Prof\nX";p@u.ma',
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].parsed.nom_complet).toBe('Prof\nX');
    expect(q.rows[0].status).toBe('OK');
  });

  it('lignes vides ignorées (y compris « ;;; »)', () => {
    const db = freshDb();
    const p = previewOk(
      db,
      'salles',
      'nom;capacite\n\nSalle A;10\n;;;\nSalle B;20\n',
    );
    expect(p.rows).toHaveLength(2);
    expect(p.rows.map((r) => r.n)).toEqual([1, 2]);
  });

  it('en-tête invalide : colonne obligatoire absente → erreur', () => {
    const db = freshDb();
    const res = previewImport(db, 'salles', 'nomen;capacite\nX;10');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nom/);
  });

  it('colonne inconnue : warning listé, non bloquant', () => {
    const db = freshDb();
    const p = previewOk(db, 'salles', 'nom;truc;capacite\nSalle C;x;30');
    expect(p.unknownColumns).toEqual(['truc']);
    expect(p.columns).toEqual(['nom', 'capacite']);
    expect(p.rows[0].status).toBe('OK');
  });

  it('plus de 10 000 lignes refusé', () => {
    const db = freshDb();
    const lines = ['nom;capacite'];
    for (let i = 0; i < 10_001; i++) lines.push(`Salle ${i};10`);
    const res = previewImport(db, 'salles', lines.join('\n'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/10 000|10000/);
  });

  it('fichier vide → erreur propre', () => {
    const db = freshDb();
    expect(previewImport(db, 'salles', '').ok).toBe(false);
    expect(previewImport(db, 'salles', '  \n\n').ok).toBe(false);
  });
});

// --- Preview par type -------------------------------------------------------------

describe('preview par type', () => {
  it('DOUBLON NOCASE salles : « amphi 7 » vs « Amphi 7 » → match_id', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const p = previewOk(db, 'salles', 'nom;capacite\namphi 7;100');
    expect(p.rows[0].status).toBe('DOUBLON');
    expect(p.rows[0].match_id).toBe(f.roomId);
  });

  it('ERREUR : capacite non entier, nom requis vide', () => {
    const db = freshDb();
    const p = previewOk(
      db,
      'salles',
      'nom;capacite\nSalle E;abc\n;10',
    );
    expect(p.rows[0].status).toBe('ERREUR');
    expect(p.rows[0].errors.map((e) => e.field)).toContain('capacity');
    expect(p.rows[1].status).toBe('ERREUR');
    expect(p.rows[1].errors.map((e) => e.field)).toContain('name');
  });

  it('DOUBLON modules sur code NOCASE ; nom pris par un tiers → ligne OK reste OK en preview', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const p = previewOk(db, 'modules', 'code;nom\nmod-t;Nouveau nom\nNEW;Génie logiciel');
    expect(p.rows[0].status).toBe('DOUBLON');
    expect(p.rows[0].match_id).toBe(f.moduleId);
    // « NEW » ne matche aucun code — la collision de nom est détectée à l'apply.
    expect(p.rows[1].status).toBe('OK');
  });

  it('professeurs : email invalide → ERREUR, actif hors 0/1 → ERREUR', () => {
    const db = freshDb();
    const p = previewOk(
      db,
      'professeurs',
      'nom_complet;email;actif(0/1)\nProf A;pas-un-mail;1\nProf B;ok@u.ma;2',
    );
    expect(p.rows[0].errors.map((e) => e.field)).toContain('email');
    expect(p.rows[1].errors.map((e) => e.field)).toContain('is_active');
  });

  it('etudiants : groupe inconnu et master_code inconnu → ERREUR', () => {
    const db = freshDb();
    seedFixture(db);
    const p = previewOk(
      db,
      'etudiants',
      'groupe;master_code;nom_complet;external_id\n' +
        'G9;MID;Alain;E2\nG1;XXX;Bruno;E3\nG1;MID;Chloé;E4',
    );
    expect(p.rows[0].errors.map((e) => e.field)).toContain('group');
    expect(p.rows[1].errors.map((e) => e.field)).toContain('master_code');
    expect(p.rows[2].status).toBe('OK');
  });

  it('etudiants : DOUBLON par external_id NOCASE dans le groupe', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const p = previewOk(
      db,
      'etudiants',
      'groupe;master_code;nom_complet;external_id\nG1;MID;Autre Nom;e1',
    );
    expect(p.rows[0].status).toBe('DOUBLON');
    expect(p.rows[0].match_id).toBe(f.studentId);
  });

  it('etudiants : DOUBLON par nom NOCASE quand external_id vide', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const p = previewOk(
      db,
      'etudiants',
      'groupe;master_code;nom_complet\nG1;MID;etudiant un',
    );
    expect(p.rows[0].status).toBe('DOUBLON');
    expect(p.rows[0].match_id).toBe(f.studentId);
  });

  it('masters : semestre ordinal → résolu, inexistant → ERREUR', () => {
    const db = freshDb();
    seedFixture(db);
    const p = previewOk(
      db,
      'masters',
      'code;nom;semestre\nM2;Master Deux;3\nM3;Master Trois;9',
    );
    expect(p.rows[0].status).toBe('OK');
    expect(p.rows[1].status).toBe('ERREUR');
    expect(p.rows[1].errors.map((e) => e.field)).toContain('semester');
  });
});

// --- Apply ------------------------------------------------------------------------

describe('applyImport', () => {
  it('payload forgé : type, stratégie ou texte invalides refusés', () => {
    const db = freshDb();
    const uid = adminId(db);
    expect(
      applyImport(db, uid, 'sallesX', 'nom\nX', 'IGNORER').ok,
    ).toBe(false);
    expect(
      applyImport(db, uid, 'salles', 'nom\nX', 'MERGE').ok,
    ).toBe(false);
    expect(
      applyImport(db, uid, 'salles', 42, 'IGNORER').ok,
    ).toBe(false);
    // Idem côté preview.
    expect(previewImport(db, 'trucs', 'nom\nX').ok).toBe(false);
    expect(previewImport(db, 'salles', null).ok).toBe(false);
  });

  it('INSERT salles : is_demo n/a (room sans colonne), audit CREATE + récap IMPORT', () => {
    const db = freshDb();
    const uid = adminId(db);
    const res = applyImport(
      db,
      uid,
      'salles',
      'nom;capacite;actif(0/1)\nSalle N;50;1',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ inserted: 1, merged: 0, ignored: 0 });
    const room = get<{ name: string; capacity: number; is_active: number }>(
      db,
      "SELECT * FROM room WHERE name = 'Salle N'",
    );
    expect(room).toMatchObject({ capacity: 50, is_active: 1 });
    const log = auditRows(db);
    const create = log.find((r) => r.action === 'CREATE' && r.entity === 'room');
    expect(create).toBeDefined();
    const recap = log.find((r) => r.action === 'IMPORT');
    expect(recap).toBeDefined();
    expect(recap!.entity).toBe('room');
    expect(JSON.parse(recap!.new_values!)).toMatchObject({
      inserted: 1,
      merged: 0,
      ignored: 0,
      strategy: 'IGNORER',
    });
  });

  it('IGNORER : les doublons ne sont pas touchés', () => {
    const db = freshDb();
    seedFixture(db);
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite;actif(0/1)\namphi 7;10;0\nSalle Neuve;30;1',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ inserted: 1, ignored: 1, merged: 0 });
    const room = get<{ capacity: number; is_active: number }>(
      db,
      "SELECT * FROM room WHERE name = 'Amphi 7'",
    );
    expect(room).toMatchObject({ capacity: 240, is_active: 1 });
  });

  it('FUSIONNER : seuls les champs fournis non vides sont mis à jour', () => {
    const db = freshDb();
    seedFixture(db);
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite;actif(0/1)\namphi 7;80;',
      'FUSIONNER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ inserted: 0, merged: 1, ignored: 0 });
    const room = get<{ capacity: number; is_active: number }>(
      db,
      "SELECT * FROM room WHERE name = 'amphi 7' COLLATE NOCASE",
    );
    // capacité mise à jour, actif vide → conservé (1) ; le nom reprend
    // la casse du fichier (« amphi 7 »).
    expect(room).toMatchObject({ capacity: 80, is_active: 1 });
    const upd = auditRows(db).find((r) => r.action === 'UPDATE' && r.entity === 'room');
    expect(upd).toBeDefined();
    expect(JSON.parse(upd!.old_values!).capacity).toBe(240);
    expect(JSON.parse(upd!.new_values!).capacity).toBe(80);
  });

  it('REMPLACER : les champs fournis vides passent à NULL (ou défaut)', () => {
    const db = freshDb();
    seedFixture(db);
    run(db, "UPDATE room SET is_active = 0 WHERE name = 'Amphi 7'");
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite;actif(0/1)\namphi 7;;',
      'REMPLACER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.merged).toBe(1);
    const room = get<{ capacity: number | null; is_active: number }>(
      db,
      "SELECT * FROM room WHERE name = 'amphi 7' COLLATE NOCASE",
    );
    // capacite vide → NULL ; actif vide → défaut 1 (colonne NOT NULL).
    expect(room).toMatchObject({ capacity: null, is_active: 1 });
  });

  it('REMPLACER professeur : email vide → NULL ; FUSIONNER le conserve', () => {
    const db = freshDb();
    seedFixture(db);
    // FUSIONNER : email vide fourni → conservé.
    applyImport(
      db,
      adminId(db),
      'professeurs',
      'nom_complet;email\nprof un;',
      'FUSIONNER',
    );
    expect(
      get<{ email: string }>(
        db,
        "SELECT email FROM professor WHERE full_name = 'prof un'",
      )!.email,
    ).toBe('prof@univ.ma');
    // REMPLACER : email vide → NULL.
    const res = applyImport(
      db,
      adminId(db),
      'professeurs',
      'nom_complet;email\nprof un;',
      'REMPLACER',
    );
    expect(res.ok).toBe(true);
    expect(
      get<{ email: string | null }>(
        db,
        "SELECT email FROM professor WHERE full_name = 'prof un'",
      )!.email,
    ).toBeNull();
  });

  it('erreurs isolées : la ligne en erreur n’est pas importée, le lot continue', () => {
    const db = freshDb();
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite\nSalle OK;30\nSalle KO;abc\nSalle OK2;40',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.inserted).toBe(2);
    expect(res.data.errors).toHaveLength(1);
    expect(res.data.errors[0].n).toBe(2);
    expect(res.data.errors[0].message).toMatch(/capacité/);
    expect(
      all<{ name: string }>(db, 'SELECT name FROM room ORDER BY name'),
    ).toEqual([{ name: 'Salle OK' }, { name: 'Salle OK2' }]);
  });

  it('atomicité : échec simulé en milieu de lot → 0 écriture, 0 audit', () => {
    const db = freshDb();
    run(
      db,
      `CREATE TRIGGER fail_room AFTER INSERT ON room
        WHEN NEW.name = 'Boom'
        BEGIN SELECT RAISE(ABORT, 'boom simulé'); END`,
    );
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite\nSalle Avant;10\nBoom;20\nSalle Apres;30',
      'IGNORER',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/aucune donnée/i);
    // Rollback complet : ni la 1re salle ni aucune trace d'audit.
    expect(get(db, "SELECT id FROM room WHERE name = 'Salle Avant'")).toBeUndefined();
    expect(auditRows(db)).toHaveLength(0);
  });

  it('doublon intra-fichier : la 2e occurrence est gérée par la stratégie', () => {
    const db = freshDb();
    const res = applyImport(
      db,
      adminId(db),
      'salles',
      'nom;capacite\nSalle Dup;10\nsalle dup;99',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ inserted: 1, ignored: 1 });
    expect(
      all<{ name: string }>(db, 'SELECT name FROM room'),
    ).toHaveLength(1);
  });

  it('is_demo = 0 sur tout import (modules, masters, professeurs, étudiants)', () => {
    const db = freshDb();
    seedFixture(db);
    const uid = adminId(db);
    for (const [type, csv] of [
      ['modules', 'code;nom\nMOD-X;Stats'],
      ['professeurs', 'nom_complet;email\nProf Neuf;n@u.ma'],
      ['masters', 'code;nom;semestre\nMX;Master X;3'],
      ['etudiants', 'groupe;master_code;nom_complet;external_id\nG1;MID;Nadia;E9'],
    ] as const) {
      const res = applyImport(db, uid, type, csv, 'IGNORER');
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.inserted).toBe(1);
    }
    const demos = [
      ['module', "code = 'MOD-X'"],
      ['professor', "full_name = 'Prof Neuf'"],
      ['master', "code = 'MX'"],
      ['student', "full_name = 'Nadia'"],
    ] as const;
    for (const [table, cond] of demos) {
      const row = get<{ is_demo: number }>(
        db,
        `SELECT is_demo FROM ${table} WHERE ${cond}`,
      );
      expect(row?.is_demo).toBe(0);
    }
  });

  it('masters : année courante + semestre résolus à l’insert', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = applyImport(
      db,
      adminId(db),
      'masters',
      'code;nom;filiere;semestre\nM-NEW;Master Neuf;Info;3',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    const m = get<{
      academic_year_id: number;
      semester_id: number;
      filiere: string;
      status: string;
    }>(db, "SELECT * FROM master WHERE code = 'M-NEW'")!;
    expect(m.academic_year_id).toBe(f.yearId);
    expect(m.semester_id).toBe(f.semId);
    expect(m.filiere).toBe('Info');
    expect(m.status).toBe('ACTIF');
  });
});

// --- Étudiants ---------------------------------------------------------------------

describe('import étudiants', () => {
  it('création dans le bon groupe, external_id généré MAN-<id> si vide', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = applyImport(
      db,
      adminId(db),
      'etudiants',
      'groupe;master_code;nom_complet\nG1;MID;Nadia Amrani',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.inserted).toBe(1);
    const st = get<{
      student_group_id: number;
      external_id: string;
      full_name: string;
    }>(db, "SELECT * FROM student WHERE full_name = 'Nadia Amrani'")!;
    expect(st.student_group_id).toBe(f.groupId);
    expect(st.external_id).toMatch(/^MAN-\d+$/);
  });

  it('doublon intra-groupe uniquement : même external_id dans un autre groupe → OK', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const g2 = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')",
        f.masterId,
      ).lastInsertRowid,
    );
    const p = previewOk(
      db,
      'etudiants',
      'groupe;master_code;nom_complet;external_id\nG2;MID;Autre;e1',
    );
    expect(p.rows[0].status).toBe('OK');
    const res = applyImport(
      db,
      adminId(db),
      'etudiants',
      'groupe;master_code;nom_complet;external_id\nG2;MID;Autre;e1',
      'IGNORER',
    );
    expect(res.ok && res.data.inserted).toBe(1);
    expect(
      get(db, 'SELECT id FROM student WHERE student_group_id = ? AND external_id = ?', g2, 'e1'),
    ).toBeDefined();
  });
});

// --- Export -------------------------------------------------------------------------

describe('exportEntity / entityCsv', () => {
  it('salles : colonnes d’import exactes + compte de lignes exact', () => {
    const db = freshDb();
    seedFixture(db);
    const res = exportEntity(db, 'salles');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columns.map((c) => c.label)).toEqual([
      'nom',
      'capacite',
      'actif(0/1)',
    ]);
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]).toMatchObject({
      nom: 'Amphi 7',
      capacite: 240,
      actif: 1,
    });
    const csv = entityCsv(res.data);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('nom;capacite;actif(0/1)');
    expect(lines[1]).toBe('Amphi 7;240;1');
  });

  it('type inconnu refusé', () => {
    const db = freshDb();
    expect(exportEntity(db, 'trucs').ok).toBe(false);
  });

  it('séances : colonnes jointes lisibles + statut dérivé', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const mmId = Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id,
            volume_min, session_duration_min, planned_sessions,
            sched_start, sched_end)
         VALUES (?, ?, ?, ?, 600, 120, 5, '2026-09-01', '2027-01-31')`,
        f.masterId,
        f.moduleId,
        f.semId,
        f.profId,
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min,
          status)
       VALUES (?, ?, ?, '2026-10-05', 480, 600, 'PREVUE')`,
      mmId,
      f.profId,
      f.roomId,
    );
    const res = exportEntity(db, 'seances', '2026-11-15');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columns.map((c) => c.key)).toEqual([
      'date',
      'debut',
      'fin',
      'statut',
      'master_code',
      'master',
      'module_code',
      'module',
      'groupe',
      'professeur',
      'salle',
      'date_reelle',
      'debut_reel',
      'fin_reel',
      'commentaire',
    ]);
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0]).toMatchObject({
      date: '2026-10-05',
      debut: '08:00',
      fin: '10:00',
      statut: 'Non réalisée', // PREVUE passée — dérivée (AD-7)
      master_code: 'MID',
      module_code: 'MOD-T',
      professeur: 'Prof Un',
      salle: 'Amphi 7',
    });
  });

  it('etudiants / masters / master_modules : comptes de lignes exacts', () => {
    const db = freshDb();
    seedFixture(db);
    const st = exportEntity(db, 'etudiants');
    expect(st.ok && st.data.rows).toHaveLength(1);
    expect(st.ok && st.data.rows[0]).toMatchObject({
      groupe: 'G1',
      master_code: 'MID',
      nom_complet: 'Etudiant Un',
      external_id: 'E1',
    });
    const ma = exportEntity(db, 'masters');
    expect(ma.ok && ma.data.rows).toHaveLength(1);
    expect(ma.ok && ma.data.rows[0]).toMatchObject({
      code: 'MID',
      semestre: 3,
      statut: 'ACTIF',
    });
    expect(exportEntity(db, 'master_modules').ok).toBe(true);
  });
});

// --- Gabarits -------------------------------------------------------------------------

describe('templateCsv', () => {
  it('en-têtes exacts par type + BOM + 1 ligne d’exemple', () => {
    const expected: Record<string, string> = {
      salles: 'nom;capacite;actif(0/1)',
      professeurs: 'nom_complet;email;actif(0/1)',
      modules: 'code;nom',
      masters:
        'code;nom;filiere;departement;responsable;semestre;temps_amenage(0/1)',
      etudiants: 'groupe;master_code;nom_complet;external_id',
    };
    for (const [type, header] of Object.entries(expected)) {
      const csv = templateCsv(type as Parameters<typeof templateCsv>[0]);
      expect(csv.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.slice(1).split('\r\n');
      expect(lines[0]).toBe(header);
      expect(lines).toHaveLength(2); // en-tête + exemple
      expect(lines[1].split(';')).toHaveLength(header.split(';').length);
    }
  });

  it('le gabarit complété est directement importable', () => {
    const db = freshDb();
    const csv = templateCsv('salles');
    const p = previewOk(db, 'salles', csv);
    expect(p.unknownColumns).toEqual([]);
    // La ligne d'exemple est valide.
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].status).toBe('OK');
  });
});

// --- Revue (3 couches) — correctifs ----------------------------------------------

describe('revue — correctifs', () => {
  it('doublon base-vs-fichier Unicode : « ÉMILE » en base vs « émile » au fichier', () => {
    const db = freshDb();
    const profId = Number(
      run(
        db,
        "INSERT INTO professor (full_name) VALUES ('Émile Dupont')",
      ).lastInsertRowid,
    );
    // COLLATE NOCASE (ASCII-only) aurait raté ce doublon — le fold JS le voit.
    const p = previewOk(
      db,
      'professeurs',
      'nom_complet;email\némile dupont;e@u.ma',
    );
    expect(p.rows[0].status).toBe('DOUBLON');
    expect(p.rows[0].match_id).toBe(profId);
  });

  it('doublon intra-fichier Unicode : « ÉMILE » puis « émile » → DOUBLON', () => {
    const db = freshDb();
    const p = previewOk(
      db,
      'professeurs',
      'nom_complet\nÉMILE TEST\némile test',
    );
    expect(p.rows[0].status).toBe('OK');
    expect(p.rows[1].status).toBe('DOUBLON');
    // Même fold à l'apply : la 2e occurrence est ignorée, 1 seul INSERT.
    const res = applyImport(
      db,
      adminId(db),
      'professeurs',
      'nom_complet\nÉMILE TEST\némile test',
      'IGNORER',
    );
    expect(res.ok && res.data).toMatchObject({ inserted: 1, ignored: 1 });
    expect(
      all<{ id: number }>(
        db,
        "SELECT id FROM professor WHERE full_name LIKE '%TEST%'",
      ),
    ).toHaveLength(1);
  });

  it('fusion master cross-année : semestre résolu dans l’année de l’existant', () => {
    const db = freshDb();
    // Master MID dans l'ANCIENNE année (non courante), avec son S3.
    const oldYearId = Number(
      run(
        db,
        `INSERT INTO academic_year (label, start_date, end_date, is_current)
         VALUES ('2025-2026', '2025-09-01', '2026-08-31', 0)`,
      ).lastInsertRowid,
    );
    const oldSemId = Number(
      run(
        db,
        `INSERT INTO semester (academic_year_id, label, ordinal)
         VALUES (?, 'S3', 3)`,
        oldYearId,
      ).lastInsertRowid,
    );
    const masterId = Number(
      run(
        db,
        `INSERT INTO master (code, name, academic_year_id, semester_id)
         VALUES ('MID', 'Master Info', ?, ?)`,
        oldYearId,
        oldSemId,
      ).lastInsertRowid,
    );
    // Année COURANTE avec un S3 différent (même ordinal, autre id) :
    // une résolution dans l'année courante prendrait ce semestre-ci.
    const curYearId = Number(
      run(
        db,
        `INSERT INTO academic_year (label, start_date, end_date, is_current)
         VALUES ('2026-2027', '2026-09-01', '2027-08-31', 1)`,
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO semester (academic_year_id, label, ordinal)
       VALUES (?, 'S3', 3)`,
      curYearId,
    );
    const res = applyImport(
      db,
      adminId(db),
      'masters',
      'code;nom;semestre\nmid;Master Info Fusionné;3',
      'FUSIONNER',
    );
    expect(res.ok && res.data.merged).toBe(1);
    const m = get<{ academic_year_id: number; semester_id: number }>(
      db,
      'SELECT * FROM master WHERE id = ?',
      masterId,
    )!;
    expect(m.academic_year_id).toBe(oldYearId);
    expect(m.semester_id).toBe(oldSemId); // année de l'existant, pas courante
  });

  it('REMPLACER étudiant : external_id vide → MAN-<id> régénéré, jamais NULL', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const res = applyImport(
      db,
      adminId(db),
      'etudiants',
      'groupe;master_code;nom_complet;external_id\nG1;MID;etudiant un;',
      'REMPLACER',
    );
    expect(res.ok && res.data.merged).toBe(1);
    const st = get<{ external_id: string }>(
      db,
      'SELECT external_id FROM student WHERE id = ?',
      f.studentId,
    )!;
    expect(st.external_id).toBe(`MAN-${f.studentId}`);
  });

  it('SAVEPOINT : échec de l’UPDATE MAN-* → pas d’orphelin external_id NULL', () => {
    const db = freshDb();
    const f = seedFixture(db);
    // « Bloqueur » occupe MAN-3 — le prochain INSERT obtiendra id = 3
    // (fixture : id 1, bloqueur : id 2), puis l'UPDATE MAN-3 violera
    // ux_student_group_ext.
    run(
      db,
      `INSERT INTO student (student_group_id, external_id, full_name)
       VALUES (?, 'MAN-3', 'Bloqueur')`,
      f.groupId,
    );
    const res = applyImport(
      db,
      adminId(db),
      'etudiants',
      'groupe;master_code;nom_complet;external_id\n' +
        'G1;MID;Orpheline;\nG1;MID;Karim B;E7',
      'IGNORER',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Erreur isolée : le lot continue, la ligne en échec est rapportée.
    expect(res.data.errors).toHaveLength(1);
    expect(res.data.errors[0].n).toBe(1);
    expect(res.data.inserted).toBe(1); // Karim
    // SAVEPOINT : l'INSERT d'Orpheline a été défait — aucun orphelin.
    expect(
      get(db, 'SELECT id FROM student WHERE external_id IS NULL'),
    ).toBeUndefined();
    expect(
      all<{ id: number }>(
        db,
        'SELECT id FROM student WHERE student_group_id = ?',
        f.groupId,
      ),
    ).toHaveLength(3);
  });

  it('export séances : groupe = union mm.student_group_id ∪ session_group', () => {
    const db = freshDb();
    const f = seedFixture(db);
    const g2 = Number(
      run(
        db,
        "INSERT INTO student_group (master_id, name) VALUES (?, 'G2')",
        f.masterId,
      ).lastInsertRowid,
    );
    const mmId = Number(
      run(
        db,
        `INSERT INTO master_module
           (master_id, module_id, semester_id, professor_id,
            student_group_id, volume_min, session_duration_min,
            planned_sessions, sched_start, sched_end)
         VALUES (?, ?, ?, ?, ?, 600, 120, 5, '2026-09-01', '2027-01-31')`,
        f.masterId,
        f.moduleId,
        f.semId,
        f.profId,
        f.groupId,
      ).lastInsertRowid,
    );
    const sId = Number(
      run(
        db,
        `INSERT INTO session
           (master_module_id, professor_id, room_id, date, start_min, end_min,
            status)
         VALUES (?, ?, ?, '2026-10-05', 480, 600, 'PREVUE')`,
        mmId,
        f.profId,
        f.roomId,
      ).lastInsertRowid,
    );
    // session_group ajoute G2 — et re-déclare G1 (union DISTINCT attendue).
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sId,
      f.groupId,
    );
    run(
      db,
      'INSERT INTO session_group (session_id, student_group_id) VALUES (?, ?)',
      sId,
      g2,
    );
    const res = exportEntity(db, 'seances', '2026-10-01');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.rows[0].groupe).toBe('G1 + G2');
  });

  it('guillemet non fermé : la ligne tronquée est ERREUR, pas avalée', () => {
    const db = freshDb();
    const p = previewOk(
      db,
      'salles',
      'nom;capacite\nSalle A;10\n"Salle B;20\nSalle C;30',
    );
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].status).toBe('OK');
    expect(p.rows[1].status).toBe('ERREUR');
    expect(p.rows[1].errors.map((e) => e.message).join(' ')).toMatch(
      /guillemet non fermé/i,
    );
  });

  it('encodage non UTF-8 : U+FFFD → erreur globale explicite', () => {
    const db = freshDb();
    const res = previewImport(
      db,
      'salles',
      'nom;capacite\nSalle �;10',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/UTF-8|Latin-1/i);
  });

  it('fusion sur ligne démo → is_demo forcé à 0', () => {
    const db = freshDb();
    const f = seedFixture(db);
    run(db, 'UPDATE module SET is_demo = 1 WHERE id = ?', f.moduleId);
    const res = applyImport(
      db,
      adminId(db),
      'modules',
      'code;nom\nmod-t;Nouveau Génie',
      'FUSIONNER',
    );
    expect(res.ok && res.data.merged).toBe(1);
    expect(
      get<{ is_demo: number; name: string }>(
        db,
        'SELECT is_demo, name FROM module WHERE id = ?',
        f.moduleId,
      ),
    ).toMatchObject({ is_demo: 0, name: 'Nouveau Génie' });
  });

  it('capacite « 1e2 » refusée : entier strict uniquement', () => {
    const db = freshDb();
    const p = previewOk(db, 'salles', 'nom;capacite\nSalle Sci;1e2');
    expect(p.rows[0].status).toBe('ERREUR');
    expect(p.rows[0].errors.map((e) => e.field)).toContain('capacity');
  });
});
