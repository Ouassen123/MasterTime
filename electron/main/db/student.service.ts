/**
 * Registre étudiants (P9b — saisie manuelle minimale, pré-import Phase I) :
 * `student` existe depuis la migration 0001 mais aucune saisie n'était
 * possible — ce service alimente le mini-CRUD de la fiche Master → onglet
 * Groupes et le roster de la saisie nominative des présences.
 *
 * - Unicité (groupe, external_id) : garantie par `ux_student_group_ext`
 *   (COALESCE external_id→'') — une violation UNIQUE est interceptée en
 *   erreur de champ. Comme l'index coalesce NULL→'', un `external_id`
 *   omis est matérialisé `MAN-<id>` : sinon deux étudiants sans
 *   identifiant dans le même groupe se heurteraient à l'unicité et le
 *   mini-CRUD serait inutilisable pour constituer un roster.
 * - Suppression (BR-22) : refusée si des `student_attendance` référencent
 *   l'étudiant — refus chiffré (`linkedCount`).
 * - Master ARCHIVE : gel identique aux groupes (le registre fait partie
 *   du référentiel du master).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  DeleteResult,
  FieldError,
  StudentInput,
  StudentRow,
} from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';

// --- Lecture ----------------------------------------------------------------

function getStudentRow(db: DatabaseSync, id: number): StudentRow | undefined {
  return get<StudentRow>(
    db,
    `SELECT st.id, st.student_group_id, st.full_name, st.external_id,
            (SELECT count(*) FROM student_attendance sa
               WHERE sa.student_id = st.id) AS linkedCount
       FROM student st
      WHERE st.id = ?`,
    id,
  );
}

/** Étudiants d'un groupe (tri nom) — chaque ligne porte son compteur BR-22. */
export function listByGroup(
  db: DatabaseSync,
  groupId: number,
): ApiResult<StudentRow[]> {
  const group = get<{ id: number }>(
    db,
    'SELECT id FROM student_group WHERE id = ?',
    groupId,
  );
  if (!group) return apiErr('Groupe introuvable.');
  return apiOk(
    all<StudentRow>(
      db,
      `SELECT st.id, st.student_group_id, st.full_name, st.external_id,
              (SELECT count(*) FROM student_attendance sa
                 WHERE sa.student_id = st.id) AS linkedCount
         FROM student st
        WHERE st.student_group_id = ?
        ORDER BY st.full_name COLLATE NOCASE, st.id`,
      groupId,
    ),
  );
}

// --- Écriture ----------------------------------------------------------------

/** Master gelé (ARCHIVE) : le registre étudiants suit le référentiel. */
const MASTER_ARCHIVED: FieldError[] = [
  {
    field: 'status',
    message:
      'Ce master est archivé : réactivez-le avant toute modification.',
  },
];

function groupContext(
  db: DatabaseSync,
  groupId: number,
): { group_id: number; master_status: string } | undefined {
  return get<{ group_id: number; master_status: string }>(
    db,
    `SELECT g.id AS group_id, m.status AS master_status
       FROM student_group g
       JOIN master m ON m.id = g.master_id
      WHERE g.id = ?`,
    groupId,
  );
}

function isUniqueViolation(err: unknown): boolean {
  // Seule l'unicité signale un doublon métier (ux_student_group_ext) —
  // une violation FK/CHECK inattendue doit remonter en erreur interne.
  return err instanceof Error && /unique/i.test(err.message);
}

const DUPLICATE_EXT_FIELDS: FieldError[] = [
  {
    field: 'external_id',
    message: 'Un étudiant porte déjà cet identifiant dans ce groupe.',
  },
];

/**
 * Ajout manuel : `full_name` obligatoire, `external_id` optionnel (clé
 * d'import Phase I — aucune contrainte de format). External_id omis →
 * généré `MAN-<id>` (voir en-tête : l'index d'unicité coalesce NULL→'').
 */
export function addStudent(
  db: DatabaseSync,
  userId: number | null,
  groupId: number,
  input: StudentInput,
): ApiResult<StudentRow> {
  const ctx = groupContext(db, groupId);
  if (!ctx) return apiErr('Groupe introuvable.');
  if (ctx.master_status === 'ARCHIVE') {
    return apiErr(MASTER_ARCHIVED[0].message, MASTER_ARCHIVED);
  }
  const errors: FieldError[] = [];
  const name = typeof input?.full_name === 'string' ? input.full_name.trim() : '';
  if (!name) {
    errors.push({
      field: 'full_name',
      message: 'Le nom de l’étudiant est obligatoire.',
    });
  }
  let externalId: string | null = null;
  if (input?.external_id != null) {
    if (typeof input.external_id !== 'string') {
      errors.push({ field: 'external_id', message: 'Identifiant invalide.' });
    } else {
      externalId = input.external_id.trim() || null;
    }
  }
  if (errors.length > 0) {
    return apiErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  let id: number | null;
  try {
    id = withAudit(db, userId, 'CREATE', 'student', null, () => {
      const rowId = Number(
        run(
          db,
          `INSERT INTO student (student_group_id, external_id, full_name)
           VALUES (?, ?, ?)`,
          groupId,
          externalId,
          name,
        ).lastInsertRowid,
      );
      if (externalId == null) {
        // `ux_student_group_ext` coalesce NULL→'' : un identifiant
        // synthétique garantit l'unicité par groupe sans imposer de
        // format à la saisie manuelle.
        run(
          db,
          'UPDATE student SET external_id = ? WHERE id = ?',
          `MAN-${rowId}`,
          rowId,
        );
      }
      return rowId;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        DUPLICATE_EXT_FIELDS,
      );
    }
    throw err;
  }
  return apiOk(getStudentRow(db, id!)!);
}

/**
 * Suppression (BR-22) : refusée si des lignes `student_attendance`
 * référencent l'étudiant — refus chiffré (`linkedCount` dans le message
 * et la donnée structurée).
 */
export function removeStudent(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): DeleteResult {
  const student = getStudentRow(db, id);
  if (!student) {
    return { ok: false, error: 'Étudiant introuvable.' };
  }
  const ctx = groupContext(db, student.student_group_id);
  if (ctx?.master_status === 'ARCHIVE') {
    return {
      ok: false,
      error: MASTER_ARCHIVED[0].message,
      fields: MASTER_ARCHIVED,
    };
  }
  if (student.linkedCount > 0) {
    return {
      ok: false,
      error:
        `Cet étudiant est référencé par ${student.linkedCount} ` +
        'présence(s) nominative(s) : suppression impossible.',
      linkedCount: student.linkedCount,
    };
  }
  withAudit(db, userId, 'DELETE', 'student', id, () => {
    run(db, 'DELETE FROM student WHERE id = ?', id);
  });
  return { ok: true, data: null };
}
