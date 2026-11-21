/**
 * Référentiel Masters — CRUD + statut (ACTIF/ARCHIVE), groupes d'étudiants
 * et master-modules (le « quoi enseigner »), compteurs de suivi AD-7
 * (mêmes règles que les professeurs), suppression protégée BR-22
 * (refus chiffré + suggestion « Archiver ») et audit transactionnel
 * (AD-6, via `withAudit`).
 *
 * Compteurs AD-7 (statuts dérivés à la lecture, `today` injectable) :
 *   `nb_restantes`    = PREVUE avec date >= aujourd'hui
 *   `nb_non_realisees`= PREVUE avec date <  aujourd'hui
 *   `heures_enseignees_min` = Σ(actual_end-actual_start) des REALISEE,
 *   repli sur end-start si les colonnes actual_* sont NULL.
 *
 * BR-22 — `linkedCount` d'un master =
 *   student_group + master_module + sessions (via mm) + students (via groupes).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  DeleteResult,
  FieldError,
  GroupInput,
  MasterCounters,
  MasterDetail,
  MasterInput,
  MasterListFilter,
  MasterModuleInput,
  MasterModuleRow,
  MasterRow,
  MasterSession,
  StudentGroupRow,
} from '../../../shared/types';
import { apiErr, apiOk, MASTER_STATUSES } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';
import { isValidIsoDate, todayIso } from './date';

const SESSION_DURATION_MAX_MIN = 480;

// --- Lecture ----------------------------------------------------------------

const MASTER_LIST_SELECT = `
  SELECT m.id, m.code, m.name, m.filiere, m.department, m.responsible_name,
         m.academic_year_id, y.label AS academic_year_label,
         m.semester_id, sem.label AS semester_label,
         m.status, m.is_demo,
         (SELECT count(*) FROM master_module mm
            WHERE mm.master_id = m.id) AS nb_modules,
         (SELECT count(*) FROM student_group g
            WHERE g.master_id = m.id) AS nb_groupes,
         (SELECT count(*) FROM session s
            JOIN master_module mm2 ON mm2.id = s.master_module_id
            WHERE mm2.master_id = m.id AND s.status != 'ANNULEE') AS nb_seances,
         (SELECT COALESCE(sum(mm3.volume_min), 0) FROM master_module mm3
            WHERE mm3.master_id = m.id) AS volume_prevu_min,
         (SELECT count(*) FROM student_group g2 WHERE g2.master_id = m.id)
        + (SELECT count(*) FROM master_module mm4 WHERE mm4.master_id = m.id)
        + (SELECT count(*) FROM session s2
             JOIN master_module mm5 ON mm5.id = s2.master_module_id
             WHERE mm5.master_id = m.id)
        + (SELECT count(*) FROM student st
             JOIN student_group g3 ON g3.id = st.student_group_id
             WHERE g3.master_id = m.id) AS linkedCount
    FROM master m
    JOIN academic_year y ON y.id = m.academic_year_id
    LEFT JOIN semester sem ON sem.id = m.semester_id`;

/**
 * Liste des masters + compteurs. `filter.search` filtre sur code/name/
 * filiere (sous-chaîne littérale, jokers LIKE échappés), `filter.status`
 * sur 'ACTIF'/'ARCHIVE' ('TOUS'/omis = pas de filtre). Tri par nom.
 */
export function listMasters(
  db: DatabaseSync,
  filter?: MasterListFilter,
): MasterRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const status = filter?.status;
  if (status === 'ACTIF' || status === 'ARCHIVE') {
    clauses.push('m.status = ?');
    params.push(status);
  }
  const q = filter?.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      `(m.name LIKE ? ESCAPE '\\' OR m.code LIKE ? ESCAPE '\\'` +
        ` OR m.filiere LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return all<MasterRow>(
    db,
    `${MASTER_LIST_SELECT}${where} ORDER BY m.name COLLATE NOCASE`,
    ...params,
  );
}

function getMasterRow(db: DatabaseSync, id: number): MasterRow | undefined {
  return get<MasterRow>(db, `${MASTER_LIST_SELECT} WHERE m.id = ?`, id);
}

/** Compteurs de suivi AD-7 pour un master (séances via master_module). */
function masterCounters(
  db: DatabaseSync,
  masterId: number,
  today: string,
): MasterCounters {
  const row = get<MasterCounters>(
    db,
    `SELECT COALESCE(sum(CASE WHEN s.status = 'REALISEE' THEN 1 ELSE 0 END), 0)
              AS nb_realisees,
            COALESCE(sum(CASE WHEN s.status = 'PREVUE' AND s.date >= ?
                          THEN 1 ELSE 0 END), 0) AS nb_restantes,
            COALESCE(sum(CASE WHEN s.status = 'PREVUE' AND s.date < ?
                          THEN 1 ELSE 0 END), 0) AS nb_non_realisees,
            COALESCE(sum(CASE WHEN s.status = 'ANNULEE' THEN 1 ELSE 0 END), 0)
              AS nb_annulees,
            COALESCE(sum(CASE WHEN s.status = 'REPORTEE' THEN 1 ELSE 0 END), 0)
              AS nb_reportees,
            COALESCE(sum(CASE WHEN s.status = 'REALISEE'
                THEN COALESCE(s.actual_end_min - s.actual_start_min,
                              s.end_min - s.start_min)
                ELSE 0 END), 0) AS heures_enseignees_min
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
      WHERE mm.master_id = ?`,
    today,
    today,
    masterId,
  );
  return (
    row ?? {
      nb_realisees: 0,
      nb_restantes: 0,
      nb_non_realisees: 0,
      nb_annulees: 0,
      nb_reportees: 0,
      heures_enseignees_min: 0,
    }
  );
}

function listGroups(db: DatabaseSync, masterId: number): StudentGroupRow[] {
  return all<StudentGroupRow>(
    db,
    `SELECT g.id, g.master_id, g.name, g.size,
            (SELECT count(*) FROM master_module mm
               WHERE mm.student_group_id = g.id)
          + (SELECT count(*) FROM student st
               WHERE st.student_group_id = g.id)
          + (SELECT count(*) FROM session_group sg
               WHERE sg.student_group_id = g.id) AS linkedCount
       FROM student_group g
      WHERE g.master_id = ?
      ORDER BY g.name COLLATE NOCASE`,
    masterId,
  );
}

function getGroupRow(
  db: DatabaseSync,
  id: number,
): StudentGroupRow | undefined {
  return get<StudentGroupRow>(
    db,
    `SELECT g.id, g.master_id, g.name, g.size,
            (SELECT count(*) FROM master_module mm
               WHERE mm.student_group_id = g.id)
          + (SELECT count(*) FROM student st
               WHERE st.student_group_id = g.id)
          + (SELECT count(*) FROM session_group sg
               WHERE sg.student_group_id = g.id) AS linkedCount
       FROM student_group g
      WHERE g.id = ?`,
    id,
  );
}

function getMasterModuleRow(
  db: DatabaseSync,
  id: number,
): MasterModuleRow | undefined {
  return get<MasterModuleRow>(
    db,
    `SELECT mm.id, mm.master_id, mm.module_id,
            mo.code AS module_code, mo.name AS module_name,
            mm.semester_id, sem.label AS semester_label,
            mm.professor_id, p.full_name AS professor_name,
            mm.student_group_id, g.name AS group_name,
            mm.volume_min, mm.session_duration_min, mm.planned_sessions,
            mm.sched_start, mm.sched_end, mm.distribution_rule,
            (SELECT count(*) FROM session s
               WHERE s.master_module_id = mm.id
                 AND s.status != 'ANNULEE') AS nb_seances,
            (SELECT count(*) FROM session s
               WHERE s.master_module_id = mm.id) AS session_count
       FROM master_module mm
       JOIN module mo ON mo.id = mm.module_id
       JOIN semester sem ON sem.id = mm.semester_id
       JOIN professor p ON p.id = mm.professor_id
       LEFT JOIN student_group g ON g.id = mm.student_group_id
      WHERE mm.id = ?`,
    id,
  );
}

function listMasterModules(
  db: DatabaseSync,
  masterId: number,
): MasterModuleRow[] {
  return all<MasterModuleRow>(
    db,
    `SELECT mm.id, mm.master_id, mm.module_id,
            mo.code AS module_code, mo.name AS module_name,
            mm.semester_id, sem.label AS semester_label,
            mm.professor_id, p.full_name AS professor_name,
            mm.student_group_id, g.name AS group_name,
            mm.volume_min, mm.session_duration_min, mm.planned_sessions,
            mm.sched_start, mm.sched_end, mm.distribution_rule,
            (SELECT count(*) FROM session s
               WHERE s.master_module_id = mm.id
                 AND s.status != 'ANNULEE') AS nb_seances,
            (SELECT count(*) FROM session s
               WHERE s.master_module_id = mm.id) AS session_count
       FROM master_module mm
       JOIN module mo ON mo.id = mm.module_id
       JOIN semester sem ON sem.id = mm.semester_id
       JOIN professor p ON p.id = mm.professor_id
       LEFT JOIN student_group g ON g.id = mm.student_group_id
      WHERE mm.master_id = ?
      ORDER BY mo.name COLLATE NOCASE, sem.ordinal`,
    masterId,
  );
}

function listUpcomingSessions(
  db: DatabaseSync,
  masterId: number,
  today: string,
): MasterSession[] {
  return all<MasterSession>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
            mo.name AS module_name, m.name AS master_name,
            r.name AS room_name, p.full_name AS professor_name,
            g.name AS group_name
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN master m ON m.id = mm.master_id
       JOIN room r ON r.id = s.room_id
       JOIN professor p ON p.id = s.professor_id
       LEFT JOIN student_group g ON g.id = mm.student_group_id
      WHERE mm.master_id = ? AND s.date >= ?
      ORDER BY s.date, s.start_min
      LIMIT 20`,
    masterId,
    today,
  );
}

/** Fiche de suivi : master + groupes + master-modules + compteurs + 20 prochaines. */
export function getMasterDetail(
  db: DatabaseSync,
  id: number,
  today: string = todayIso(),
): ApiResult<MasterDetail> {
  const master = getMasterRow(db, id);
  if (!master) {
    return apiErr('Master introuvable.');
  }
  return apiOk({
    master: { ...master, ...masterCounters(db, id, today) },
    groups: listGroups(db, id),
    modules: listMasterModules(db, id),
    upcoming: listUpcomingSessions(db, id, today),
  });
}

// --- Validation CRUD ---------------------------------------------------------

function optionalString(
  v: unknown,
  field: string,
  label: string,
  errors: FieldError[],
): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') {
    errors.push({ field, message: `${label} invalide.` });
    return null;
  }
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function validateMaster(
  db: DatabaseSync,
  input: MasterInput,
  excludeId: number | null,
): FieldError[] {
  const errors: FieldError[] = [];
  // Payload IPC forgé possible : erreurs de champ propres, jamais de TypeError.
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code) {
    errors.push({ field: 'code', message: 'Le code du master est obligatoire.' });
  } else {
    const dup = get<{ id: number }>(
      db,
      'SELECT id FROM master WHERE code = ? COLLATE NOCASE AND id != ?',
      code,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({ field: 'code', message: 'Un master porte déjà ce code.' });
    }
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', message: 'Le nom du master est obligatoire.' });
  }
  optionalString(input.filiere, 'filiere', 'La filière', errors);
  optionalString(input.department, 'department', 'Le département', errors);
  optionalString(input.responsible_name, 'responsible_name', 'Le responsable', errors);

  const yearId = input.academic_year_id;
  if (!Number.isInteger(yearId) || (yearId as number) <= 0) {
    errors.push({
      field: 'academic_year_id',
      message: "L'année universitaire est obligatoire.",
    });
  } else {
    const year = get<{ id: number }>(
      db,
      'SELECT id FROM academic_year WHERE id = ?',
      yearId as number,
    );
    if (!year) {
      errors.push({
        field: 'academic_year_id',
        message: 'Année universitaire inexistante.',
      });
    }
  }
  if (input.semester_id != null) {
    const semId = input.semester_id;
    if (!Number.isInteger(semId) || semId <= 0) {
      errors.push({ field: 'semester_id', message: 'Semestre invalide.' });
    } else {
      const sem = get<{ academic_year_id: number }>(
        db,
        'SELECT academic_year_id FROM semester WHERE id = ?',
        semId,
      );
      if (!sem) {
        errors.push({ field: 'semester_id', message: 'Semestre inexistant.' });
      } else if (
        Number.isInteger(yearId) &&
        (yearId as number) > 0 &&
        sem.academic_year_id !== yearId
      ) {
        errors.push({
          field: 'semester_id',
          message: "Ce semestre n'appartient pas à l'année choisie.",
        });
      }
    }
  }
  if (
    input.status != null &&
    !MASTER_STATUSES.includes(input.status as MasterRow['status'])
  ) {
    errors.push({
      field: 'status',
      message: "Le statut doit être 'ACTIF' ou 'ARCHIVE'.",
    });
  }
  return errors;
}

export function createMaster(
  db: DatabaseSync,
  userId: number | null,
  input: MasterInput,
): ApiResult<MasterRow> {
  const errors = validateMaster(db, input, null);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(db, userId, 'CREATE', 'master', null, () =>
    Number(
      run(
        db,
        `INSERT INTO master (code, name, filiere, department, responsible_name,
           academic_year_id, semester_id, status, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        input.code.trim(),
        input.name.trim(),
        input.filiere?.trim() || null,
        input.department?.trim() || null,
        input.responsible_name?.trim() || null,
        input.academic_year_id,
        input.semester_id ?? null,
        input.status ?? 'ACTIF',
      ).lastInsertRowid,
    ),
  );
  return apiOk(getMasterRow(db, id!)!);
}

export function updateMaster(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: MasterInput,
): ApiResult<MasterRow> {
  if (!getMasterRow(db, id)) {
    return apiErr('Master introuvable.');
  }
  const errors = validateMaster(db, input, id);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  withAudit(db, userId, 'UPDATE', 'master', id, () => {
    run(
      db,
      `UPDATE master SET code = ?, name = ?, filiere = ?, department = ?,
         responsible_name = ?, academic_year_id = ?, semester_id = ?,
         status = COALESCE(?, status)
       WHERE id = ?`,
      input.code.trim(),
      input.name.trim(),
      input.filiere?.trim() || null,
      input.department?.trim() || null,
      input.responsible_name?.trim() || null,
      input.academic_year_id,
      input.semester_id ?? null,
      input.status ?? null,
      id,
    );
  });
  return apiOk(getMasterRow(db, id)!);
}

/** Bascule ACTIF ↔ ARCHIVE — les données liées restent intactes. */
export function setMasterStatus(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  status: string,
): ApiResult<MasterRow> {
  if (!getMasterRow(db, id)) {
    return apiErr('Master introuvable.');
  }
  if (!MASTER_STATUSES.includes(status as MasterRow['status'])) {
    return apiErr("Le statut doit être 'ACTIF' ou 'ARCHIVE'.");
  }
  withAudit(db, userId, 'UPDATE', 'master', id, () => {
    run(db, 'UPDATE master SET status = ? WHERE id = ?', status, id);
  });
  return apiOk(getMasterRow(db, id)!);
}

/**
 * Suppression (BR-22) : refusée si le master est lié à des groupes,
 * master-modules, séances ou étudiants — le refus est chiffré et suggère
 * l'archivage (`suggest: 'ARCHIVE'`).
 */
export function deleteMaster(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): DeleteResult {
  const master = getMasterRow(db, id);
  if (!master) {
    return { ok: false, error: 'Master introuvable.' };
  }
  if (master.linkedCount > 0) {
    return {
      ok: false,
      error:
        `Ce master est lié à ${master.linkedCount} donnée(s) ` +
        '(groupes, master-modules, séances ou étudiants) : ' +
        'suppression impossible. Vous pouvez l\'archiver.',
      linkedCount: master.linkedCount,
      suggest: 'ARCHIVE',
    };
  }
  withAudit(db, userId, 'DELETE', 'master', id, () => {
    run(db, 'DELETE FROM master WHERE id = ?', id);
  });
  return { ok: true, data: null };
}

// --- Groupes (student_group) --------------------------------------------------

function validateGroup(
  db: DatabaseSync,
  masterId: number,
  input: GroupInput,
  excludeId: number | null,
): FieldError[] {
  const errors: FieldError[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', message: 'Le nom du groupe est obligatoire.' });
  } else {
    const dup = get<{ id: number }>(
      db,
      `SELECT id FROM student_group
        WHERE master_id = ? AND name = ? COLLATE NOCASE AND id != ?`,
      masterId,
      name,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({
        field: 'name',
        message: 'Un groupe porte déjà ce nom dans ce master.',
      });
    }
  }
  if (input.size != null) {
    if (!Number.isInteger(input.size) || input.size <= 0) {
      errors.push({
        field: 'size',
        message: "L'effectif doit être un entier strictement positif.",
      });
    }
  }
  return errors;
}

export function addGroup(
  db: DatabaseSync,
  userId: number | null,
  masterId: number,
  input: GroupInput,
): ApiResult<StudentGroupRow> {
  if (!getMasterRow(db, masterId)) {
    return apiErr('Master introuvable.');
  }
  const errors = validateGroup(db, masterId, input, null);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(db, userId, 'CREATE', 'student_group', null, () =>
    Number(
      run(
        db,
        'INSERT INTO student_group (master_id, name, size) VALUES (?, ?, ?)',
        masterId,
        input.name.trim(),
        input.size ?? null,
      ).lastInsertRowid,
    ),
  );
  return apiOk(getGroupRow(db, id!)!);
}

export function renameGroup(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: GroupInput,
): ApiResult<StudentGroupRow> {
  const group = getGroupRow(db, id);
  if (!group) {
    return apiErr('Groupe introuvable.');
  }
  const errors = validateGroup(db, group.master_id, input, id);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  withAudit(db, userId, 'UPDATE', 'student_group', id, () => {
    run(
      db,
      `UPDATE student_group SET name = ?,
         size = COALESCE(?, size) WHERE id = ?`,
      input.name.trim(),
      input.size ?? null,
      id,
    );
  });
  return apiOk(getGroupRow(db, id)!);
}

/**
 * Suppression d'un groupe (BR-22) : refusée si des master-modules,
 * étudiants ou session_group y sont liés — refus chiffré.
 */
export function removeGroup(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): DeleteResult {
  const group = getGroupRow(db, id);
  if (!group) {
    return { ok: false, error: 'Groupe introuvable.' };
  }
  if (group.linkedCount > 0) {
    return {
      ok: false,
      error:
        `Ce groupe est lié à ${group.linkedCount} donnée(s) ` +
        '(master-modules, étudiants ou séances partagées) : ' +
        'suppression impossible.',
      linkedCount: group.linkedCount,
    };
  }
  withAudit(db, userId, 'DELETE', 'student_group', id, () => {
    run(db, 'DELETE FROM student_group WHERE id = ?', id);
  });
  return { ok: true, data: null };
}

// --- Master-modules (master_module) ------------------------------------------

function refExists(
  db: DatabaseSync,
  table: 'module' | 'semester' | 'professor',
  id: number,
): boolean {
  return !!get(db, `SELECT id FROM ${table} WHERE id = ?`, id);
}

function validateMasterModule(
  db: DatabaseSync,
  masterId: number,
  input: MasterModuleInput,
): FieldError[] {
  const errors: FieldError[] = [];
  if (!Number.isInteger(input.module_id) || input.module_id <= 0) {
    errors.push({ field: 'module_id', message: 'Le module est obligatoire.' });
  } else if (!refExists(db, 'module', input.module_id)) {
    errors.push({ field: 'module_id', message: 'Module inexistant.' });
  }
  if (!Number.isInteger(input.semester_id) || input.semester_id <= 0) {
    errors.push({
      field: 'semester_id',
      message: 'Le semestre est obligatoire.',
    });
  } else if (!refExists(db, 'semester', input.semester_id)) {
    errors.push({ field: 'semester_id', message: 'Semestre inexistant.' });
  }
  if (!Number.isInteger(input.professor_id) || input.professor_id <= 0) {
    errors.push({
      field: 'professor_id',
      message: 'Le professeur est obligatoire.',
    });
  } else if (!refExists(db, 'professor', input.professor_id)) {
    errors.push({ field: 'professor_id', message: 'Professeur inexistant.' });
  }
  if (input.student_group_id != null) {
    const g = get<{ master_id: number }>(
      db,
      'SELECT master_id FROM student_group WHERE id = ?',
      Number.isInteger(input.student_group_id) ? input.student_group_id : -1,
    );
    if (!Number.isInteger(input.student_group_id) || input.student_group_id <= 0) {
      errors.push({ field: 'student_group_id', message: 'Groupe invalide.' });
    } else if (!g) {
      errors.push({ field: 'student_group_id', message: 'Groupe inexistant.' });
    } else if (g.master_id !== masterId) {
      errors.push({
        field: 'student_group_id',
        message: "Ce groupe n'appartient pas à ce master.",
      });
    }
  }
  if (!Number.isInteger(input.volume_min) || input.volume_min <= 0) {
    errors.push({
      field: 'volume_min',
      message: 'Le volume prévu doit être un entier strictement positif.',
    });
  }
  if (
    !Number.isInteger(input.session_duration_min) ||
    input.session_duration_min <= 0 ||
    input.session_duration_min > SESSION_DURATION_MAX_MIN
  ) {
    errors.push({
      field: 'session_duration_min',
      message: `La durée de séance doit être un entier entre 1 et ${SESSION_DURATION_MAX_MIN} minutes.`,
    });
  }
  if (!Number.isInteger(input.planned_sessions) || input.planned_sessions <= 0) {
    errors.push({
      field: 'planned_sessions',
      message: 'Le nombre de séances prévues doit être un entier strictement positif.',
    });
  }
  const start =
    typeof input.sched_start === 'string' ? input.sched_start.trim() : '';
  const end = typeof input.sched_end === 'string' ? input.sched_end.trim() : '';
  if (!isValidIsoDate(start)) {
    errors.push({
      field: 'sched_start',
      message: 'Date de début invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (!isValidIsoDate(end)) {
    errors.push({
      field: 'sched_end',
      message: 'Date de fin invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (isValidIsoDate(start) && isValidIsoDate(end) && start >= end) {
    errors.push({
      field: 'sched_end',
      message: 'La date de début doit précéder la date de fin.',
    });
  }
  if (input.distribution_rule != null) {
    if (typeof input.distribution_rule !== 'string') {
      errors.push({
        field: 'distribution_rule',
        message: 'Règle de répartition invalide.',
      });
    } else if (input.distribution_rule.trim() !== '') {
      try {
        JSON.parse(input.distribution_rule);
      } catch {
        errors.push({
          field: 'distribution_rule',
          message: 'La règle de répartition doit être un JSON valide.',
        });
      }
    }
  }
  return errors;
}

function isConstraintViolation(err: unknown): boolean {
  return err instanceof Error && /constraint/i.test(err.message);
}

const DUPLICATE_MM_FIELDS: FieldError[] = [
  {
    field: 'module_id',
    message:
      'Ce module est déjà rattaché à ce master pour ce semestre et ce groupe.',
  },
];

export function attachModule(
  db: DatabaseSync,
  userId: number | null,
  masterId: number,
  input: MasterModuleInput,
): ApiResult<MasterModuleRow> {
  if (!getMasterRow(db, masterId)) {
    return apiErr('Master introuvable.');
  }
  const errors = validateMasterModule(db, masterId, input);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  let id: number | null;
  try {
    id = withAudit(db, userId, 'CREATE', 'master_module', null, () =>
      Number(
        run(
          db,
          `INSERT INTO master_module
             (master_id, module_id, semester_id, professor_id, student_group_id,
              volume_min, session_duration_min, planned_sessions,
              distribution_rule, sched_start, sched_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          masterId,
          input.module_id,
          input.semester_id,
          input.professor_id,
          input.student_group_id ?? null,
          input.volume_min,
          input.session_duration_min,
          input.planned_sessions,
          input.distribution_rule?.trim() || null,
          input.sched_start.trim(),
          input.sched_end.trim(),
        ).lastInsertRowid,
      ),
    );
  } catch (err) {
    // ux_master_module : doublon (master, module, semestre, groupe COALESCE)
    // converti en erreur de champ plutôt qu'en erreur interne.
    if (isConstraintViolation(err)) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        DUPLICATE_MM_FIELDS,
      );
    }
    throw err;
  }
  return apiOk(getMasterModuleRow(db, id!)!);
}

export function updateMasterModule(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: MasterModuleInput,
): ApiResult<MasterModuleRow> {
  const existing = getMasterModuleRow(db, id);
  if (!existing) {
    return apiErr('Master-module introuvable.');
  }
  const errors = validateMasterModule(db, existing.master_id, input);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  try {
    withAudit(db, userId, 'UPDATE', 'master_module', id, () => {
      run(
        db,
        `UPDATE master_module SET module_id = ?, semester_id = ?,
           professor_id = ?, student_group_id = ?, volume_min = ?,
           session_duration_min = ?, planned_sessions = ?,
           distribution_rule = ?, sched_start = ?, sched_end = ?
         WHERE id = ?`,
        input.module_id,
        input.semester_id,
        input.professor_id,
        input.student_group_id ?? null,
        input.volume_min,
        input.session_duration_min,
        input.planned_sessions,
        input.distribution_rule?.trim() || null,
        input.sched_start.trim(),
        input.sched_end.trim(),
        id,
      );
    });
  } catch (err) {
    if (isConstraintViolation(err)) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        DUPLICATE_MM_FIELDS,
      );
    }
    throw err;
  }
  return apiOk(getMasterModuleRow(db, id)!);
}

/**
 * Détachement (BR-22) : refusé si des séances référencent le master-module
 * — master_module n'a pas de statut : le message indique de supprimer
 * d'abord les séances liées.
 */
export function detachModule(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): DeleteResult {
  const mm = getMasterModuleRow(db, id);
  if (!mm) {
    return { ok: false, error: 'Master-module introuvable.' };
  }
  if (mm.session_count > 0) {
    return {
      ok: false,
      error:
        `Ce master-module est référencé par ${mm.session_count} séance(s) : ` +
        'détachement impossible — supprimez d\'abord les séances liées.',
      linkedCount: mm.session_count,
    };
  }
  withAudit(db, userId, 'DELETE', 'master_module', id, () => {
    run(db, 'DELETE FROM master_module WHERE id = ?', id);
  });
  return { ok: true, data: null };
}
