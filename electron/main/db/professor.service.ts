/**
 * Référentiel Professeurs — CRUD + compteurs de suivi (FR-9→15),
 * disponibilités et absences, suppression protégée (BR-22) +
 * désactivation (`is_active`, migration 0004) + audit transactionnel
 * (AD-6, via `withAudit`).
 *
 * Compteurs (AD-7 — statuts dérivés à la lecture) :
 *   `nb_restantes`    = PREVUE avec date >= aujourd'hui
 *   `nb_non_realisees`= PREVUE avec date <  aujourd'hui
 *   `heures_enseignees_min` = Σ(actual_end-actual_start) des REALISEE,
 *   repli sur end-start si les colonnes actual_* sont NULL.
 *
 * BR-17 : une absence ne déclenche JAMAIS d'annulation automatique de
 * séance — `addAbsence` calcule et retourne seulement les séances
 * PREVUE impactées (la résolution arrive en Phase 9).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  AbsenceInput,
  AbsenceRow,
  ApiResult,
  AvailabilityInput,
  AvailabilityRow,
  FieldError,
  ImpactedSession,
  ProfessorDetail,
  ProfessorInput,
  ProfessorRow,
  ProfessorTeaching,
} from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';
import { isValidIsoDate, todayIso } from './date';

export { todayIso };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProfessorSqlRow extends Omit<ProfessorRow, 'masters'> {
  masters: null;
}

const COUNTERS_SQL = `
      (SELECT count(*) FROM session s
        WHERE s.professor_id = p.id AND s.status = 'REALISEE') AS nb_realisees,
      (SELECT count(*) FROM session s
        WHERE s.professor_id = p.id AND s.status = 'PREVUE' AND s.date >= ?)
        AS nb_restantes,
      (SELECT count(*) FROM session s
        WHERE s.professor_id = p.id AND s.status = 'PREVUE' AND s.date < ?)
        AS nb_non_realisees,
      (SELECT count(*) FROM session s
        WHERE s.professor_id = p.id AND s.status = 'ANNULEE') AS nb_annulees,
      (SELECT count(*) FROM session s
        WHERE s.professor_id = p.id AND s.status = 'REPORTEE') AS nb_reportees,
      (SELECT COALESCE(sum(COALESCE(s.actual_end_min - s.actual_start_min,
                                    s.end_min - s.start_min)), 0)
         FROM session s
        WHERE s.professor_id = p.id AND s.status = 'REALISEE')
        AS heures_enseignees_min,
      (SELECT count(*) FROM professor_absence a
        WHERE a.professor_id = p.id) AS nb_absences,
      (SELECT count(*) FROM master_module mm WHERE mm.professor_id = p.id)
        + (SELECT count(*) FROM session s WHERE s.professor_id = p.id)
        + (SELECT count(*) FROM professor_absence a WHERE a.professor_id = p.id)
        + (SELECT count(*) FROM professor_availability v
             WHERE v.professor_id = p.id) AS linkedCount`;

/** Masters enseignés par professeur (distincts, mm + séances), triés. */
function mastersByProfessor(db: DatabaseSync): Map<number, string[]> {
  const rows = all<{ professor_id: number; name: string }>(
    db,
    `SELECT professor_id, name FROM (
         SELECT mm.professor_id AS professor_id, m.name AS name
           FROM master_module mm JOIN master m ON m.id = mm.master_id
          UNION
         SELECT s.professor_id, m.name
           FROM session s
           JOIN master_module mm ON mm.id = s.master_module_id
           JOIN master m ON m.id = mm.master_id
       ) ORDER BY name COLLATE NOCASE`,
  );
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const list = map.get(r.professor_id) ?? [];
    list.push(r.name);
    map.set(r.professor_id, list);
  }
  return map;
}

function hydrate(
  rows: ProfessorSqlRow[],
  masters: Map<number, string[]>,
): ProfessorRow[] {
  return rows.map((r) => ({ ...r, masters: masters.get(r.id) ?? [] }));
}

/**
 * Liste des professeurs + compteurs. `search` filtre sur nom, référence
 * interne et email (sous-chaîne, casse ignorée).
 */
export function listProfessors(
  db: DatabaseSync,
  search?: string,
  today: string = todayIso(),
): ProfessorRow[] {
  const q = search?.trim();
  // `%`, `_` et `\` échappés : la recherche est une sous-chaîne littérale,
  // pas un motif LIKE forgé depuis le renderer.
  const like = `%${(q ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = q
    ? all<ProfessorSqlRow>(
        db,
        `SELECT p.id, p.full_name, p.internal_ref, p.email, p.phone,
                p.is_active, p.is_demo,${COUNTERS_SQL}
           FROM professor p
          WHERE p.full_name LIKE ? ESCAPE '\\'
             OR p.internal_ref LIKE ? ESCAPE '\\'
             OR p.email LIKE ? ESCAPE '\\'
          ORDER BY p.full_name COLLATE NOCASE`,
        today,
        today,
        like,
        like,
        like,
      )
    : all<ProfessorSqlRow>(
        db,
        `SELECT p.id, p.full_name, p.internal_ref, p.email, p.phone,
                p.is_active, p.is_demo,${COUNTERS_SQL}
           FROM professor p
          ORDER BY p.full_name COLLATE NOCASE`,
        today,
        today,
      );
  return hydrate(rows, mastersByProfessor(db));
}

export function getProfessor(
  db: DatabaseSync,
  id: number,
  today: string = todayIso(),
): ProfessorRow | undefined {
  const row = get<ProfessorSqlRow>(
    db,
    `SELECT p.id, p.full_name, p.internal_ref, p.email, p.phone,
            p.is_active, p.is_demo,${COUNTERS_SQL}
       FROM professor p WHERE p.id = ?`,
    today,
    today,
    id,
  );
  return row ? hydrate([row], mastersByProfessor(db))[0] : undefined;
}

/** Fiche de suivi : enseignements, disponibilités, absences, 20 prochaines. */
export function getProfessorDetail(
  db: DatabaseSync,
  id: number,
  today: string = todayIso(),
): ApiResult<ProfessorDetail> {
  const professor = getProfessor(db, id, today);
  if (!professor) {
    return apiErr('Professeur introuvable.');
  }
  const teachings = all<ProfessorTeaching>(
    db,
    `SELECT master_code, master_name, module_name FROM (
         SELECT m.code AS master_code, m.name AS master_name,
                mo.name AS module_name
           FROM master_module mm
           JOIN master m ON m.id = mm.master_id
           JOIN module mo ON mo.id = mm.module_id
          WHERE mm.professor_id = ?
          UNION
         SELECT m.code, m.name, mo.name
           FROM session s
           JOIN master_module mm ON mm.id = s.master_module_id
           JOIN master m ON m.id = mm.master_id
           JOIN module mo ON mo.id = mm.module_id
          WHERE s.professor_id = ?
       ) ORDER BY master_name COLLATE NOCASE, module_name COLLATE NOCASE`,
    id,
    id,
  );
  const upcoming = all<ImpactedSession>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
            mo.name AS module_name, m.name AS master_name,
            r.name AS room_name
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN master m ON m.id = mm.master_id
       JOIN room r ON r.id = s.room_id
      WHERE s.professor_id = ? AND s.date >= ?
      ORDER BY s.date, s.start_min
      LIMIT 20`,
    id,
    today,
  );
  return apiOk({
    professor,
    teachings,
    availabilities: listAvailabilities(db, id),
    absences: listAbsences(db, id),
    upcoming,
  });
}

// --- Validation CRUD --------------------------------------------------------

function validateProfessor(
  db: DatabaseSync,
  input: ProfessorInput,
  excludeId: number | null,
): FieldError[] {
  const errors: FieldError[] = [];
  // Champs non-string possibles via un payload IPC forgé : erreurs de
  // champ propres, jamais de TypeError sur `.trim()`.
  const fullName =
    typeof input.full_name === 'string' ? input.full_name.trim() : '';
  if (!fullName) {
    errors.push({
      field: 'full_name',
      message: 'Le nom du professeur est obligatoire.',
    });
  } else {
    const dup = get<{ id: number }>(
      db,
      'SELECT id FROM professor WHERE full_name = ? COLLATE NOCASE AND id != ?',
      fullName,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({
        field: 'full_name',
        message: 'Un professeur porte déjà ce nom.',
      });
    }
  }
  if (input.internal_ref != null && typeof input.internal_ref !== 'string') {
    errors.push({
      field: 'internal_ref',
      message: 'Référence interne invalide.',
    });
  } else {
    const ref = input.internal_ref?.trim();
    if (ref) {
      const dupRef = get<{ id: number }>(
        db,
        'SELECT id FROM professor WHERE internal_ref = ? COLLATE NOCASE AND id != ?',
        ref,
        excludeId ?? -1,
      );
      if (dupRef) {
        errors.push({
          field: 'internal_ref',
          message: 'Cette référence interne est déjà utilisée.',
        });
      }
    }
  }
  if (input.email != null && typeof input.email !== 'string') {
    errors.push({ field: 'email', message: 'Email invalide.' });
  } else {
    const email = input.email?.trim();
    if (email && !EMAIL_RE.test(email)) {
      errors.push({ field: 'email', message: "Format d'email invalide." });
    }
  }
  if (input.phone != null && typeof input.phone !== 'string') {
    errors.push({ field: 'phone', message: 'Téléphone invalide.' });
  }
  return errors;
}

/** `false` strict → 0 ; défini → 1 ; omis → null (préserver à l'édition). */
function activeFlag(v: unknown): number | null {
  if (v === false) return 0;
  if (v == null) return null;
  return 1;
}

export function createProfessor(
  db: DatabaseSync,
  userId: number | null,
  input: ProfessorInput,
): ApiResult<ProfessorRow> {
  const errors = validateProfessor(db, input, null);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(db, userId, 'CREATE', 'professor', null, () =>
    Number(
      run(
        db,
        `INSERT INTO professor (full_name, internal_ref, email, phone, is_active, is_demo)
         VALUES (?, ?, ?, ?, ?, 0)`,
        input.full_name.trim(),
        input.internal_ref?.trim() || null,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        activeFlag(input.is_active) ?? 1,
      ).lastInsertRowid,
    ),
  );
  return apiOk(getProfessor(db, id!)!);
}

export function updateProfessor(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: ProfessorInput,
): ApiResult<ProfessorRow> {
  if (!getProfessor(db, id)) {
    return apiErr('Professeur introuvable.');
  }
  const errors = validateProfessor(db, input, id);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  withAudit(db, userId, 'UPDATE', 'professor', id, () => {
    run(
      db,
      `UPDATE professor SET full_name = ?, internal_ref = ?, email = ?,
         phone = ?, is_active = COALESCE(?, is_active) WHERE id = ?`,
      input.full_name.trim(),
      input.internal_ref?.trim() || null,
      input.email?.trim() || null,
      input.phone?.trim() || null,
      // is_active omis → valeur conservée (basculer passe par setActive).
      activeFlag(input.is_active),
      id,
    );
  });
  return apiOk(getProfessor(db, id)!);
}

/**
 * Suppression (BR-22) : refusée si le professeur est lié à des
 * master-modules, séances ou absences — le message chiffre les données
 * liées ; la désactivation est l'alternative.
 */
export function deleteProfessor(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  const prof = getProfessor(db, id);
  if (!prof) {
    return apiErr('Professeur introuvable.');
  }
  if (prof.linkedCount > 0) {
    return apiErr(
      `Ce professeur est lié à ${prof.linkedCount} donnée(s) ` +
        '(master-modules, séances, absences ou disponibilités) : ' +
        'suppression impossible. Vous pouvez le désactiver.',
    );
  }
  withAudit(db, userId, 'DELETE', 'professor', id, () => {
    run(db, 'DELETE FROM professor WHERE id = ?', id);
  });
  return apiOk(null);
}

/** Active / désactive le professeur — les données liées restent intactes. */
export function setProfessorActive(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  active: boolean,
): ApiResult<ProfessorRow> {
  if (!getProfessor(db, id)) {
    return apiErr('Professeur introuvable.');
  }
  withAudit(db, userId, 'UPDATE', 'professor', id, () => {
    run(db, 'UPDATE professor SET is_active = ? WHERE id = ?', active ? 1 : 0, id);
  });
  return apiOk(getProfessor(db, id)!);
}

// --- Disponibilités (professor_availability) --------------------------------

export function listAvailabilities(
  db: DatabaseSync,
  professorId: number,
): AvailabilityRow[] {
  return all<AvailabilityRow>(
    db,
    `SELECT id, professor_id, weekday, start_min, end_min, kind,
            effective_from, effective_to
       FROM professor_availability
      WHERE professor_id = ?
      ORDER BY weekday, start_min`,
    professorId,
  );
}

function validateAvailability(
  db: DatabaseSync,
  professorId: number,
  input: AvailabilityInput,
): FieldError[] {
  const errors: FieldError[] = [];
  if (
    !Number.isInteger(input.weekday) ||
    input.weekday < 0 ||
    input.weekday > 6
  ) {
    errors.push({
      field: 'weekday',
      message: 'Le jour doit être entre 0 (lundi) et 6 (dimanche).',
    });
  }
  if (
    !Number.isInteger(input.start_min) ||
    !Number.isInteger(input.end_min) ||
    input.start_min < 0 ||
    input.start_min >= input.end_min ||
    input.end_min > 1440
  ) {
    errors.push({
      field: 'end_min',
      message: "L'heure de début doit précéder l'heure de fin (≤ 24h00).",
    });
  }
  if (input.kind !== 'DISPO' && input.kind !== 'INDISPO') {
    errors.push({
      field: 'kind',
      message: "Le type doit être 'DISPO' ou 'INDISPO'.",
    });
  }
  const from =
    typeof input.effective_from === 'string'
      ? input.effective_from.trim() || null
      : null;
  const to =
    typeof input.effective_to === 'string'
      ? input.effective_to.trim() || null
      : null;
  if (input.effective_from != null && !isValidIsoDate(from ?? '')) {
    errors.push({
      field: 'effective_from',
      message: 'Date de début invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (input.effective_to != null && !isValidIsoDate(to ?? '')) {
    errors.push({
      field: 'effective_to',
      message: 'Date de fin invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (from && to && from > to) {
    errors.push({
      field: 'effective_to',
      message: 'La date de début doit précéder la date de fin.',
    });
  }
  // Chevauchement refusé à jour et type identiques SEULEMENT si les fenêtres
  // d'effet se coupent aussi (NULL = bornes infinies ; dispo S1 et S2 à la
  // même heure ne se chevauchent pas).
  if (errors.length === 0) {
    const overlap = get<{ id: number }>(
      db,
      `SELECT id FROM professor_availability
        WHERE professor_id = ? AND weekday = ? AND kind = ?
          AND start_min < ? AND end_min > ?
          AND (effective_from IS NULL OR ? IS NULL OR effective_from <= ?)
          AND (effective_to   IS NULL OR ? IS NULL OR effective_to   >= ?)`,
      professorId,
      input.weekday,
      input.kind,
      input.end_min,
      input.start_min,
      to,
      to,
      from,
      from,
    );
    if (overlap) {
      errors.push({
        field: 'start_min',
        message: `Cette plage chevauche une ${input.kind} existante ce jour.`,
      });
    }
  }
  return errors;
}

export function addAvailability(
  db: DatabaseSync,
  userId: number | null,
  professorId: number,
  input: AvailabilityInput,
): ApiResult<AvailabilityRow> {
  if (!getProfessor(db, professorId)) {
    return apiErr('Professeur introuvable.');
  }
  const errors = validateAvailability(db, professorId, input);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(
    db,
    userId,
    'CREATE',
    'professor_availability',
    null,
    () =>
      Number(
        run(
          db,
          `INSERT INTO professor_availability
             (professor_id, weekday, start_min, end_min, kind,
              effective_from, effective_to)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          professorId,
          input.weekday,
          input.start_min,
          input.end_min,
          input.kind,
          input.effective_from?.trim() || null,
          input.effective_to?.trim() || null,
        ).lastInsertRowid,
      ),
  );
  return apiOk(
    get<AvailabilityRow>(
      db,
      'SELECT * FROM professor_availability WHERE id = ?',
      id!,
    )!,
  );
}

export function removeAvailability(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  if (
    !get(db, 'SELECT id FROM professor_availability WHERE id = ?', id)
  ) {
    return apiErr('Disponibilité introuvable.');
  }
  withAudit(db, userId, 'DELETE', 'professor_availability', id, () => {
    run(db, 'DELETE FROM professor_availability WHERE id = ?', id);
  });
  return apiOk(null);
}

// --- Absences (professor_absence) -------------------------------------------

export function listAbsences(
  db: DatabaseSync,
  professorId: number,
): AbsenceRow[] {
  return all<AbsenceRow>(
    db,
    `SELECT id, professor_id, start_date, end_date, reason, resolution
       FROM professor_absence
      WHERE professor_id = ?
      ORDER BY start_date DESC`,
    professorId,
  );
}

/** Séances PREVUE du professeur dans la fenêtre d'absence (BR-17). */
function impactedSessions(
  db: DatabaseSync,
  professorId: number,
  startDate: string,
  endDate: string,
): ImpactedSession[] {
  return all<ImpactedSession>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
            mo.name AS module_name, m.name AS master_name,
            r.name AS room_name
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN master m ON m.id = mm.master_id
       JOIN room r ON r.id = s.room_id
      WHERE s.professor_id = ? AND s.status = 'PREVUE'
        AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.start_min`,
    professorId,
    startDate,
    endDate,
  );
}

/**
 * Déclare une absence et retourne les séances PREVUE impactées.
 * BR-17 : aucune séance n'est annulée automatiquement — la résolution
 * (remplacement/report/annulation) est traitée en Phase 9.
 */
export function addAbsence(
  db: DatabaseSync,
  userId: number | null,
  professorId: number,
  input: AbsenceInput,
): ApiResult<{ absence: AbsenceRow; impacted: ImpactedSession[] }> {
  if (!getProfessor(db, professorId)) {
    return apiErr('Professeur introuvable.');
  }
  const errors: FieldError[] = [];
  const startDate =
    typeof input.start_date === 'string' ? input.start_date.trim() : '';
  const endDate =
    typeof input.end_date === 'string' ? input.end_date.trim() : '';
  if (!isValidIsoDate(startDate)) {
    errors.push({
      field: 'start_date',
      message: 'Date de début invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (!isValidIsoDate(endDate)) {
    errors.push({
      field: 'end_date',
      message: 'Date de fin invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (errors.length === 0 && startDate > endDate) {
    errors.push({
      field: 'end_date',
      message: 'La date de début doit précéder la date de fin.',
    });
  }
  if (input.reason != null && typeof input.reason !== 'string') {
    errors.push({ field: 'reason', message: 'Motif invalide.' });
  }
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const id = withAudit(db, userId, 'CREATE', 'professor_absence', null, () =>
    Number(
      run(
        db,
        `INSERT INTO professor_absence (professor_id, start_date, end_date, reason)
         VALUES (?, ?, ?, ?)`,
        professorId,
        startDate,
        endDate,
        input.reason?.trim() || null,
      ).lastInsertRowid,
    ),
  );
  return apiOk({
    absence: get<AbsenceRow>(
      db,
      'SELECT * FROM professor_absence WHERE id = ?',
      id!,
    )!,
    impacted: impactedSessions(db, professorId, startDate, endDate),
  });
}

export function removeAbsence(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  if (!get(db, 'SELECT id FROM professor_absence WHERE id = ?', id)) {
    return apiErr('Absence introuvable.');
  }
  withAudit(db, userId, 'DELETE', 'professor_absence', id, () => {
    run(db, 'DELETE FROM professor_absence WHERE id = ?', id);
  });
  return apiOk(null);
}
