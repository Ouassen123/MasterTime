/**
 * Présences étudiants (P9b — Module G : FR-39, BR-19) — saisie par séance
 * en deux modes :
 *
 * - **Comptage** (`session_attendance`) : present_count / absent_count /
 *   note libre — la voie simple quand le groupe n'a pas de registre.
 * - **Nominatif** (`student_attendance`) : une ligne par étudiant
 *   (PRESENT/ABSENT/JUSTIFIE) ; `setNominative` REMPLACE l'ensemble et
 *   recalcule les compteurs — un JUSTIFIE reste un absent comptablement
 *   (règle comptable v1, documentée) ; la note est conservée.
 *
 * Règles :
 * - La séance doit être REALISEE pour toute écriture (une présence n'a de
 *   sens que sur un cours tenu — BR-1) ; la lecture reste possible sur
 *   tout statut (une séance quittant REALISEE par correction conserve sa
 *   trace — deleteSession la purge déjà).
 * - `setCounts` refuse si des lignes nominatives existent (mode déjà
 *   nominatif → passer par setNominative ou clearAttendance).
 * - Groupes candidats du nominatif = `mm.student_group_id` ∪
 *   `session_group` (∪ tous les groupes du master si ni l'un ni l'autre —
 *   séance « master entier ») ; tout étudiant hors roster est refusé.
 * - Toute écriture via `withAudit` + audit explicite (pattern
 *   `setSessionGroups` : la table `session` n'est pas touchée — la ligne
 *   `audit_log` porte le JSON old/new des compteurs ou de la liste).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  AttendanceCountsInput,
  AttendanceDetail,
  AttendanceNominativeRow,
  AttendanceRosterRow,
  FieldError,
  NominativeItem,
  SessionStatus,
} from '../../../shared/types';
import { apiErr, apiOk, ATTENDANCE_STATUSES } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';

/** Plafond de la note libre (cohérent avec MAX_TEXT_LEN session-edit). */
const MAX_NOTE_LEN = 500;

/** Borne haute des compteurs (anti-payload aberrant, ~amphithéâtre ×10). */
const MAX_COUNT = 5000;

// --- Lecture ----------------------------------------------------------------

interface SessionCtx {
  id: number;
  status: SessionStatus;
  master_id: number;
  mm_group_id: number | null;
}

/** Séance + contexte de rattachement (master et groupe du master-module). */
function getSessionCtx(db: DatabaseSync, id: number): SessionCtx | undefined {
  return get<SessionCtx>(
    db,
    `SELECT s.id, s.status, mm.master_id,
            mm.student_group_id AS mm_group_id
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
      WHERE s.id = ?`,
    id,
  );
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Ids des groupes candidats de la séance : groupe du master-module ∪
 * `session_group` ; si aucun des deux (séance « master entier »), TOUS
 * les groupes du master — le nominatif peut alors viser tout le registre.
 */
export function candidateGroupIds(
  db: DatabaseSync,
  ctx: SessionCtx,
): number[] {
  const ids = new Set<number>();
  if (ctx.mm_group_id != null) ids.add(ctx.mm_group_id);
  for (const r of all<{ student_group_id: number }>(
    db,
    'SELECT student_group_id FROM session_group WHERE session_id = ?',
    ctx.id,
  )) {
    ids.add(r.student_group_id);
  }
  if (ids.size === 0) {
    for (const r of all<{ id: number }>(
      db,
      'SELECT id FROM student_group WHERE master_id = ?',
      ctx.master_id,
    )) {
      ids.add(r.id);
    }
  }
  return [...ids];
}

/**
 * Registre éligible au nominatif : étudiants des groupes candidats
 * (`out_of_roster = 0`) UNION étudiants ayant déjà une ligne
 * `student_attendance` sur la séance dont le groupe n'est plus candidat
 * (`out_of_roster = 1` — « orpheline », affichée « hors groupe » dans
 * l'UI et conservée au submit : pas d'effacement silencieux).
 */
function rosterRows(
  db: DatabaseSync,
  sessionId: number,
  groupIds: number[],
): AttendanceRosterRow[] {
  const candidateClause =
    groupIds.length > 0
      ? `st.student_group_id IN (${groupIds.map(() => '?').join(', ')})`
      : '0 = 1';
  const excludeClause =
    groupIds.length > 0
      ? ` AND st2.student_group_id NOT IN (${groupIds
          .map(() => '?')
          .join(', ')})`
      : '';
  return all<AttendanceRosterRow>(
    db,
    `SELECT * FROM (
        SELECT st.id AS student_id, st.full_name, g.name AS group_name,
               0 AS out_of_roster
          FROM student st
          JOIN student_group g ON g.id = st.student_group_id
         WHERE ${candidateClause}
        UNION
        SELECT st2.id, st2.full_name, g2.name, 1
          FROM student_attendance sa
          JOIN student st2 ON st2.id = sa.student_id
          JOIN student_group g2 ON g2.id = st2.student_group_id
         WHERE sa.session_id = ?${excludeClause}
      )
      ORDER BY group_name COLLATE NOCASE, full_name COLLATE NOCASE,
               student_id`,
    ...groupIds,
    sessionId,
    ...groupIds,
  );
}

function nominativeRows(
  db: DatabaseSync,
  sessionId: number,
): AttendanceNominativeRow[] {
  return all<AttendanceNominativeRow>(
    db,
    `SELECT sa.student_id, st.full_name, sa.status, g.name AS group_name
       FROM student_attendance sa
       JOIN student st ON st.id = sa.student_id
       JOIN student_group g ON g.id = st.student_group_id
      WHERE sa.session_id = ?
      ORDER BY g.name COLLATE NOCASE, st.full_name COLLATE NOCASE, sa.student_id`,
    sessionId,
  );
}

function countsRow(
  db: DatabaseSync,
  sessionId: number,
): AttendanceDetail['counts'] {
  return (
    get<AttendanceDetail['counts'] & object>(
      db,
      `SELECT present_count, absent_count, note
         FROM session_attendance WHERE session_id = ?`,
      sessionId,
    ) ?? null
  );
}

/**
 * État complet des présences d'une séance — `mode` déduit du stockage :
 * NOMINATIVE si des lignes nominatives existent, COUNT si des compteurs
 * existent, NONE sinon. Lisible sur tout statut (la trace survit à une
 * correction de statut).
 */
export function getAttendance(
  db: DatabaseSync,
  sessionId: number,
): ApiResult<AttendanceDetail> {
  const ctx = getSessionCtx(db, sessionId);
  if (!ctx) return apiErr('Séance introuvable.');
  const counts = countsRow(db, sessionId);
  const nominative = nominativeRows(db, sessionId);
  const roster = rosterRows(db, sessionId, candidateGroupIds(db, ctx));
  return apiOk({
    counts,
    nominative,
    roster,
    mode:
      nominative.length > 0 ? 'NOMINATIVE' : counts != null ? 'COUNT' : 'NONE',
  });
}

// --- Audit explicite ---------------------------------------------------------

/**
 * Ligne `audit_log` explicite dans la transaction `withAudit` en cours —
 * la table `session` n'étant pas touchée, le diff automatique de la ligne
 * pilote serait vide (pattern `setSessionGroups` / `absence_decision`).
 */
function auditLine(
  db: DatabaseSync,
  userId: number | null,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entity: string,
  entityId: number,
  oldValues: unknown,
  newValues: unknown,
): void {
  const oldJson = oldValues == null ? null : JSON.stringify(oldValues);
  const newJson = newValues == null ? null : JSON.stringify(newValues);
  // Pas de trace superflue pour une écriture sans effet.
  if (oldJson === newJson) return;
  run(
    db,
    `INSERT INTO audit_log
       (user_id, action, entity, entity_id, old_values, new_values)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    action,
    entity,
    entityId,
    oldJson,
    newJson,
  );
}

/** Garde commune des écritures : séance existante ET réalisée (BR-1). */
function requireRealisee(
  db: DatabaseSync,
  sessionId: number,
): SessionCtx | string {
  const ctx = getSessionCtx(db, sessionId);
  if (!ctx) return 'Séance introuvable.';
  if (ctx.status !== 'REALISEE') {
    return 'La saisie des présences exige une séance réalisée.';
  }
  return ctx;
}

// --- Mode comptage -----------------------------------------------------------

/**
 * Écrit les compteurs (`session_attendance`, upsert sur session_id) —
 * refusé si le mode nominatif est déjà engagé (effacer d'abord ou
 * repasser en nominatif : mélanger les deux modes serait illisible).
 */
export function setCounts(
  db: DatabaseSync,
  userId: number | null,
  sessionId: number,
  input: AttendanceCountsInput,
): ApiResult<null> {
  const ctx = requireRealisee(db, sessionId);
  if (typeof ctx === 'string') return apiErr(ctx);

  const errors: FieldError[] = [];
  const present = input?.present_count;
  const absent = input?.absent_count;
  if (
    !Number.isInteger(present) ||
    (present as number) < 0 ||
    (present as number) > MAX_COUNT
  ) {
    errors.push({
      field: 'present_count',
      message: `Le nombre de présents doit être un entier entre 0 et ${MAX_COUNT}.`,
    });
  }
  if (
    !Number.isInteger(absent) ||
    (absent as number) < 0 ||
    (absent as number) > MAX_COUNT
  ) {
    errors.push({
      field: 'absent_count',
      message: `Le nombre d’absents doit être un entier entre 0 et ${MAX_COUNT}.`,
    });
  }
  const note =
    input?.note == null
      ? null
      : typeof input.note === 'string'
        ? input.note.trim()
        : null;
  if (input?.note != null && typeof input.note !== 'string') {
    errors.push({ field: 'note', message: 'Note invalide.' });
  } else if (note != null && note.length > MAX_NOTE_LEN) {
    errors.push({
      field: 'note',
      message: `Note trop longue (${MAX_NOTE_LEN} caractères max).`,
    });
  }
  if (errors.length > 0) {
    return apiErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  const nominativeCount =
    get<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM student_attendance WHERE session_id = ?',
      sessionId,
    )?.n ?? 0;
  if (nominativeCount > 0) {
    return apiErr(
      'Des présences nominatives existent déjà : utilisez la saisie ' +
        'nominative ou effacez les présences.',
    );
  }

  const oldCounts = countsRow(db, sessionId);
  withAudit(db, userId, 'UPDATE', 'session', sessionId, () => {
    run(
      db,
      `INSERT INTO session_attendance
         (session_id, present_count, absent_count, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         present_count = excluded.present_count,
         absent_count = excluded.absent_count,
         note = excluded.note`,
      sessionId,
      present as number,
      absent as number,
      note === '' ? null : note,
    );
    auditLine(
      db,
      userId,
      oldCounts == null ? 'CREATE' : 'UPDATE',
      'session_attendance',
      sessionId,
      oldCounts,
      countsRow(db, sessionId),
    );
  });
  return apiOk(null);
}

// --- Mode nominatif ----------------------------------------------------------

interface NominativeStateItem {
  student_id: number;
  status: string;
}

function nominativeState(
  db: DatabaseSync,
  sessionId: number,
): NominativeStateItem[] {
  return all<NominativeStateItem>(
    db,
    `SELECT student_id, status FROM student_attendance
      WHERE session_id = ? ORDER BY student_id`,
    sessionId,
  );
}

/**
 * Remplace l'ensemble nominatif (DELETE + INSERT) puis recalcule
 * `session_attendance` : present = nb PRESENT, absent = nb ABSENT +
 * JUSTIFIE (un justifié reste un absent comptablement — la justification
 * garde sa valeur disciplinaire au niveau nominatif), note conservée.
 *
 * Chaque `student_id` doit appartenir au roster de la séance : groupes
 * candidats ∪ étudiants ayant déjà une ligne (orphelines — leur
 * conservation au submit n'efface pas la trace).
 * Liste vide après déduplication = purge complète : les deux tables sont
 * vidées (mode → NONE) plutôt qu'un résidu 0/0 non tracé.
 * Audit explicite : CREATE à la première saisie, UPDATE ensuite,
 * DELETE pour la purge.
 */
export function setNominative(
  db: DatabaseSync,
  userId: number | null,
  sessionId: number,
  items: NominativeItem[],
): ApiResult<null> {
  const ctx = requireRealisee(db, sessionId);
  if (typeof ctx === 'string') return apiErr(ctx);
  if (!Array.isArray(items)) {
    return apiErr('Paramètres invalides.');
  }

  // Validation du payload (IPC forgé possible) : ids et statuts
  // vérifiés séparément — messages dédiés ; dédupliqués par student_id
  // (le dernier fourni l'emporte).
  const byStudent = new Map<number, string>();
  for (const item of items) {
    if (
      item == null ||
      typeof item !== 'object' ||
      !isId((item as NominativeItem).student_id)
    ) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        [{ field: 'items', message: 'Identifiant étudiant invalide.' }],
      );
    }
    if (
      typeof item.status !== 'string' ||
      !(ATTENDANCE_STATUSES as readonly string[]).includes(item.status)
    ) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        [
          {
            field: 'items',
            message:
              'Statut de présence invalide (PRESENT, ABSENT ou JUSTIFIE attendu).',
          },
        ],
      );
    }
    byStudent.set(item.student_id, item.status);
  }

  // Chaque étudiant doit appartenir au roster : groupes candidats ∪
  // orphelines (lignes nominatives existantes — revue patch 2).
  const rosterIds = new Set(
    rosterRows(db, sessionId, candidateGroupIds(db, ctx)).map(
      (r) => r.student_id,
    ),
  );
  const outsiders = [...byStudent.keys()].filter((id) => !rosterIds.has(id));
  if (outsiders.length > 0) {
    return apiErr(
      'Validation impossible : corrigez les champs signalés.',
      [
        {
          field: 'items',
          message:
            `${outsiders.length} étudiant(s) n'appartiennent pas ` +
            'aux groupes de la séance.',
        },
      ],
    );
  }

  const entries = [...byStudent.entries()].sort((a, b) => a[0] - b[0]);
  const oldItems = nominativeState(db, sessionId);
  const oldCounts = countsRow(db, sessionId);

  // Liste vide = purge complète (revue patch 3) : nominatif ET compteurs
  // (note comprise) — mode résultant NONE, trace DELETE explicite.
  if (entries.length === 0) {
    if (oldItems.length === 0 && oldCounts == null) {
      return apiOk(null); // rien à purger — pas de trace superflue
    }
    withAudit(db, userId, 'DELETE', 'session', sessionId, () => {
      run(db, 'DELETE FROM student_attendance WHERE session_id = ?', sessionId);
      run(db, 'DELETE FROM session_attendance WHERE session_id = ?', sessionId);
      auditLine(
        db,
        userId,
        'DELETE',
        'student_attendance',
        sessionId,
        { items: oldItems, counts: oldCounts },
        null,
      );
    });
    return apiOk(null);
  }

  const presentCount = entries.filter(([, st]) => st === 'PRESENT').length;
  const absentCount = entries.length - presentCount; // ABSENT + JUSTIFIE

  withAudit(db, userId, 'UPDATE', 'session', sessionId, () => {
    run(db, 'DELETE FROM student_attendance WHERE session_id = ?', sessionId);
    const ins = db.prepare(
      `INSERT INTO student_attendance (session_id, student_id, status)
       VALUES (?, ?, ?)`,
    );
    for (const [studentId, status] of entries) {
      ins.run(sessionId, studentId, status);
    }
    // Recalcul des compteurs — la note existante est conservée (elle ne
    // figure pas dans le SET de l'upsert ; NULL au premier insert).
    run(
      db,
      `INSERT INTO session_attendance
         (session_id, present_count, absent_count, note)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         present_count = excluded.present_count,
         absent_count = excluded.absent_count`,
      sessionId,
      presentCount,
      absentCount,
    );
    auditLine(
      db,
      userId,
      oldItems.length === 0 ? 'CREATE' : 'UPDATE',
      'student_attendance',
      sessionId,
      { items: oldItems },
      { items: nominativeState(db, sessionId) },
    );
  });
  return apiOk(null);
}

/**
 * Purge les deux modes (compteurs + nominatif) d'une séance réalisée —
 * l'état purgé est tracé intégralement dans `old_values` (JSON).
 */
export function clearAttendance(
  db: DatabaseSync,
  userId: number | null,
  sessionId: number,
): ApiResult<null> {
  const ctx = requireRealisee(db, sessionId);
  if (typeof ctx === 'string') return apiErr(ctx);
  const oldCounts = countsRow(db, sessionId);
  const oldItems = nominativeState(db, sessionId);
  if (oldCounts == null && oldItems.length === 0) {
    return apiOk(null); // rien à purger — pas de trace superflue
  }
  withAudit(db, userId, 'DELETE', 'session', sessionId, () => {
    run(db, 'DELETE FROM student_attendance WHERE session_id = ?', sessionId);
    run(db, 'DELETE FROM session_attendance WHERE session_id = ?', sessionId);
    auditLine(
      db,
      userId,
      'DELETE',
      'session_attendance',
      sessionId,
      { counts: oldCounts, items: oldItems },
      null,
    );
  });
  return apiOk(null);
}
