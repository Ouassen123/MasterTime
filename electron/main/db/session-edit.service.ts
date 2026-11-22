/**
 * Édition des séances (P7b) — mutations historisées : création manuelle,
 * déplacement, changement de statut, rattachement de groupes, suppression.
 *
 * Règles :
 * - BR-10 : chaque écriture qui place une séance est précédée de la garde
 *   `checkSessionPlacement` — un conflit dur (ROOM/PROFESSOR/MASTER/
 *   GROUP/EXTERNAL) refuse l'opération, rien n'est écrit.
 * - AD-6 : chaque mutation est tracée par `withAudit` (old/new JSON).
 * - AD-7 : `session_status_history` n'est alimentée que via ce module
 *   (`changeSessionStatus` est le point d'entrée unique des transitions ;
 *   `moveSession` réutilise le même écrivain interne).
 * - AD-7 temps : `isValidIsoDate` (calendaire, rejette 2026-02-30) et
 *   bornes 0 ≤ start < end ≤ 1440 vérifiées à l'écriture.
 * - REPORTEE : la séance bascule sur le NOUVEAU créneau ; l'historique
 *   conserve l'ancien créneau + motif (DATA-MODEL / BR-3).
 * - REALISEE : verrouillée — sortie refusée sauf correction
 *   `{ corrective: true, reason }` ; suppression toujours refusée.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  FieldError,
  PlacementConflict,
  PlacementQuery,
  SessionCreateInput,
  SessionEditResult,
  SessionMoveInput,
  SessionStatus,
  SessionStatusInput,
} from '../../../shared/types';
import { SESSION_STATUSES } from '../../../shared/types';
import { all, get, run } from './connection';
import { isValidIsoDate } from './date';
import { withAudit } from './audit.service';
import { checkSessionPlacement } from './conflict.service';

// --- Helpers de lecture ------------------------------------------------------

/** Séance brute + master/groupe du master-module (tout ce dont les gardes ont besoin). */
interface SessionDb {
  id: number;
  master_module_id: number;
  professor_id: number;
  room_id: number;
  date: string;
  start_min: number;
  end_min: number;
  status: SessionStatus;
  actual_date: string | null;
  actual_start_min: number | null;
  actual_end_min: number | null;
  comment: string | null;
  master_id: number;
  mm_group_id: number | null;
}

function getSession(db: DatabaseSync, id: number): SessionDb | undefined {
  return get<SessionDb>(
    db,
    `SELECT s.id, s.master_module_id, s.professor_id, s.room_id,
            s.date, s.start_min, s.end_min, s.status,
            s.actual_date, s.actual_start_min, s.actual_end_min, s.comment,
            mm.master_id, mm.student_group_id AS mm_group_id
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
      WHERE s.id = ?`,
    id,
  );
}

/** Ensemble COMPLET des groupes d'une séance : mm.student_group_id ∪ session_group. */
function sessionGroupIds(
  db: DatabaseSync,
  sessionId: number,
  mmGroupId: number | null,
): number[] {
  const ids = new Set<number>();
  if (mmGroupId != null) ids.add(mmGroupId);
  for (const r of all<{ student_group_id: number }>(
    db,
    'SELECT student_group_id FROM session_group WHERE session_id = ?',
    sessionId,
  )) {
    ids.add(r.student_group_id);
  }
  return [...ids];
}

// --- Guards ------------------------------------------------------------------

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validation créneau : date calendaire + 0 ≤ start < end ≤ 1440. */
function validateSlot(
  date: unknown,
  start: unknown,
  end: unknown,
): FieldError[] {
  const errors: FieldError[] = [];
  if (typeof date !== 'string' || !isValidIsoDate(date.trim())) {
    errors.push({
      field: 'date',
      message: 'Date invalide (AAAA-MM-JJ, date calendaire attendue).',
    });
  }
  if (!isInt(start) || start < 0) {
    errors.push({
      field: 'start_min',
      message: 'Heure de début invalide (minutes ≥ 0).',
    });
  }
  if (!isInt(end) || end > 1440) {
    errors.push({
      field: 'end_min',
      message: 'Heure de fin invalide (minutes ≤ 1440).',
    });
  }
  if (errors.length === 0 && (start as number) >= (end as number)) {
    errors.push({
      field: 'end_min',
      message: 'La fin doit être postérieure au début.',
    });
  }
  return errors;
}

function editOk(sessionId: number): SessionEditResult {
  return { ok: true, data: { sessionId } };
}

function editErr(
  error: string,
  fields?: FieldError[],
  conflicts?: PlacementConflict[],
): SessionEditResult {
  return { ok: false, error, fields, conflicts };
}

/**
 * Garde BR-10 : lance `checkSessionPlacement` ; si la requête échoue
 * (ne devrait pas arriver après validation des refs) l'erreur est
 * propagée comme refus sans détail de conflits.
 */
function placementGuard(
  db: DatabaseSync,
  q: PlacementQuery,
): PlacementConflict[] | string {
  const res = checkSessionPlacement(db, q);
  if (!res.ok) return res.error;
  return res.data;
}

/**
 * Vérifie que `groupIds` existent et appartiennent tous au master donné.
 * Retourne les ids dédupliqués, ou un message d'erreur.
 */
function validateGroupIds(
  db: DatabaseSync,
  masterId: number,
  groupIds: unknown,
): number[] | string {
  if (groupIds == null) return [];
  if (!Array.isArray(groupIds) || groupIds.some((g) => !isId(g))) {
    return 'Groupes invalides.';
  }
  const ids = [...new Set(groupIds)];
  for (const gid of ids) {
    const g = get<{ master_id: number }>(
      db,
      'SELECT master_id FROM student_group WHERE id = ?',
      gid,
    );
    if (!g) return `Groupe inexistant (id ${gid}).`;
    if (g.master_id !== masterId) {
      return 'Un groupe ne peut être rattaché que s’il appartient au master de la séance.';
    }
  }
  return ids;
}

// --- Écrivain unique (AD-7) --------------------------------------------------

interface SessionChange {
  status: SessionStatus;
  date: string;
  start_min: number;
  end_min: number;
  room_id: number;
  professor_id: number;
  actual_date: string | null;
  actual_start_min: number | null;
  actual_end_min: number | null;
  /** Raison consignée dans l'historique (null pour un déplacement sans motif). */
  reason: string | null;
}

/**
 * Écrivain unique de la mutation séance + historique — appelé dans la TX
 * `withAudit`. Trace `session_status_history` systématiquement pour un
 * changement de statut, et seulement si le créneau change pour un
 * déplacement (old_status = new_status = statut courant).
 */
function applySessionChange(
  db: DatabaseSync,
  userId: number | null,
  before: SessionDb,
  after: SessionChange,
): void {
  run(
    db,
    `UPDATE session
        SET status = ?, date = ?, start_min = ?, end_min = ?,
            room_id = ?, professor_id = ?,
            actual_date = ?, actual_start_min = ?, actual_end_min = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    after.status,
    after.date,
    after.start_min,
    after.end_min,
    after.room_id,
    after.professor_id,
    after.actual_date,
    after.actual_start_min,
    after.actual_end_min,
    before.id,
  );
  const slotChanged =
    after.date !== before.date ||
    after.start_min !== before.start_min ||
    after.end_min !== before.end_min;
  if (after.status !== before.status || slotChanged) {
    run(
      db,
      `INSERT INTO session_status_history
         (session_id, old_status, new_status, changed_by, reason,
          old_date, old_start_min, old_end_min,
          new_date, new_start_min, new_end_min)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      before.id,
      before.status,
      after.status,
      userId,
      after.reason,
      before.date,
      before.start_min,
      before.end_min,
      after.date,
      after.start_min,
      after.end_min,
    );
  }
}

// --- Mutations ---------------------------------------------------------------

/**
 * Création manuelle (status 'PREVUE') : refs vérifiées, garde BR-10
 * bloquante, puis INSERT + historique initiale + session_group — le tout
 * dans une seule transaction auditée.
 */
export function createSession(
  db: DatabaseSync,
  userId: number | null,
  input: SessionCreateInput,
): SessionEditResult {
  const errors: FieldError[] = [];
  const mm = isId(input?.master_module_id)
    ? get<{
        id: number;
        master_id: number;
        professor_id: number;
        student_group_id: number | null;
      }>(
        db,
        `SELECT id, master_id, professor_id, student_group_id
           FROM master_module WHERE id = ?`,
        input.master_module_id,
      )
    : undefined;
  if (!mm) {
    errors.push({
      field: 'master_module_id',
      message: 'Master-module inexistant.',
    });
  }
  const professorId = input.professor_id ?? mm?.professor_id;
  if (!isId(professorId)) {
    errors.push({
      field: 'professor_id',
      message: 'Professeur invalide.',
    });
  } else if (
    !get(db, 'SELECT id FROM professor WHERE id = ?', professorId)
  ) {
    errors.push({ field: 'professor_id', message: 'Professeur inexistant.' });
  }
  if (!isId(input?.room_id)) {
    errors.push({ field: 'room_id', message: 'Salle invalide.' });
  } else if (!get(db, 'SELECT id FROM room WHERE id = ?', input.room_id)) {
    errors.push({ field: 'room_id', message: 'Salle inexistante.' });
  }
  errors.push(
    ...validateSlot(input?.date, input?.start_min, input?.end_min),
  );
  const groupCheck = mm
    ? validateGroupIds(db, mm.master_id, input.group_ids)
    : [];
  if (typeof groupCheck === 'string') {
    errors.push({ field: 'group_ids', message: groupCheck });
  }
  const comment = input.comment != null ? String(input.comment).trim() : '';
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  const groupIds = groupCheck as number[];
  const profId = professorId as number;
  const candidate = new Set<number>(groupIds);
  if (mm!.student_group_id != null) candidate.add(mm!.student_group_id);
  const guardRes = placementGuard(db, {
    date: input.date.trim(),
    startMin: input.start_min,
    endMin: input.end_min,
    roomId: input.room_id,
    professorId: profId,
    masterId: mm!.master_id,
    groupIds: [...candidate],
  });
  if (typeof guardRes === 'string') return editErr(guardRes);
  if (guardRes.length > 0) {
    return editErr(
      'Placement refusé : la séance entrerait en conflit.',
      undefined,
      guardRes,
    );
  }
  const sessionId = withAudit(db, userId, 'CREATE', 'session', null, () => {
    const id = Number(
      run(
        db,
        `INSERT INTO session
           (master_module_id, professor_id, room_id, date, start_min,
            end_min, status, comment, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PREVUE', ?, datetime('now'))`,
        mm!.id,
        profId,
        input.room_id,
        input.date.trim(),
        input.start_min,
        input.end_min,
        comment === '' ? null : comment,
      ).lastInsertRowid,
    );
    run(
      db,
      `INSERT INTO session_status_history
         (session_id, old_status, new_status, changed_by, reason)
       VALUES (?, NULL, 'PREVUE', ?, 'Création manuelle')`,
      id,
      userId,
    );
    for (const gid of groupIds) {
      run(
        db,
        `INSERT INTO session_group (session_id, student_group_id)
         VALUES (?, ?)`,
        id,
        gid,
      );
    }
    return id;
  });
  return editOk(sessionId!);
}

/**
 * Déplacement (date/heure/salle/prof) : le statut est INCHANGÉ —
 * déplacement ≠ report (REPORTEE est un statut explicite). Si le créneau
 * change, l'historique consigne old/new date+mins. Garde BR-10 avec
 * exclusion de soi-même.
 */
export function moveSession(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: SessionMoveInput,
): SessionEditResult {
  const s = getSession(db, id);
  if (!s) return editErr('Séance introuvable.');
  if (s.status === 'REALISEE') {
    return editErr(
      'Une séance réalisée ne peut pas être déplacée ' +
        '(historique pédagogique).',
    );
  }
  const errors: FieldError[] = [];
  const date = input.date !== undefined ? input.date : s.date;
  const start = input.start_min !== undefined ? input.start_min : s.start_min;
  const end = input.end_min !== undefined ? input.end_min : s.end_min;
  errors.push(...validateSlot(date, start, end));
  const roomId = input.room_id !== undefined ? input.room_id : s.room_id;
  if (!isId(roomId) || !get(db, 'SELECT id FROM room WHERE id = ?', roomId)) {
    errors.push({ field: 'room_id', message: 'Salle inexistante.' });
  }
  const professorId =
    input.professor_id !== undefined ? input.professor_id : s.professor_id;
  if (
    !isId(professorId) ||
    !get(db, 'SELECT id FROM professor WHERE id = ?', professorId)
  ) {
    errors.push({ field: 'professor_id', message: 'Professeur inexistant.' });
  }
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  // Une séance ANNULEE n'occupe pas de ressource : garde inutile.
  if (s.status !== 'ANNULEE') {
    const guardRes = placementGuard(db, {
      date: (date as string).trim(),
      startMin: start,
      endMin: end,
      roomId,
      professorId,
      masterId: s.master_id,
      excludeSessionId: id,
      groupIds: sessionGroupIds(db, id, s.mm_group_id),
    });
    if (typeof guardRes === 'string') return editErr(guardRes);
    if (guardRes.length > 0) {
      return editErr(
        'Déplacement refusé : la séance entrerait en conflit.',
        undefined,
        guardRes,
      );
    }
  }
  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    applySessionChange(db, userId, s, {
      status: s.status,
      date: (date as string).trim(),
      start_min: start,
      end_min: end,
      room_id: roomId,
      professor_id: professorId,
      actual_date: s.actual_date,
      actual_start_min: s.actual_start_min,
      actual_end_min: s.actual_end_min,
      reason: isNonEmptyStr(input.reason) ? input.reason.trim() : null,
    });
  });
  return editOk(id);
}

/**
 * Transitions autorisées hors correction (REALISEE → * toujours refusé
 * sans `{corrective:true, reason}`). REPORTEE→REPORTEE = re-report sur un
 * autre créneau (nouveau motif + nouveau créneau obligatoires).
 */
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  PREVUE: ['REALISEE', 'ANNULEE', 'REPORTEE'],
  REPORTEE: ['PREVUE', 'REALISEE', 'ANNULEE', 'REPORTEE'],
  ANNULEE: ['PREVUE', 'REALISEE'],
  REALISEE: [],
};

/**
 * Point d'entrée UNIQUE des transitions de statut (AD-7) — valide la
 * transition, applique la garde BR-10 quand le statut recrée une
 * occupation (REPORTEE sur le nouveau créneau, ANNULEE→PREVUE sur le
 * créneau conservé), écrit l'historique et l'audit.
 *
 * - → REALISEE : actual_* par défaut = créneau planifié.
 * - → ANNULEE : motif obligatoire.
 * - → REPORTEE : motif + nouveau créneau (date/start/end) obligatoires ;
 *   la séance bascule sur le nouveau créneau, l'historique conserve
 *   l'ancien (BR-3).
 * - → PREVUE : réactivation depuis ANNULEE (ou REPORTEE) avec re-check
 *   conflits sur le créneau conservé.
 * - REALISEE → autre : refusé sauf `corrective:true` + motif (correction
 *   admin, tracée en audit).
 */
export function changeSessionStatus(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: SessionStatusInput,
): SessionEditResult {
  const s = getSession(db, id);
  if (!s) return editErr('Séance introuvable.');
  const newStatus = input?.status;
  if (
    typeof newStatus !== 'string' ||
    !(SESSION_STATUSES as readonly string[]).includes(newStatus)
  ) {
    return editErr('Statut invalide.');
  }
  const reason = isNonEmptyStr(input.reason) ? input.reason.trim() : null;
  const corrective = input.corrective === true;
  const reReport = newStatus === 'REPORTEE' && s.status === 'REPORTEE';
  if (newStatus === s.status && !reReport) {
    return editErr('La séance est déjà dans ce statut.');
  }
  if (s.status === 'REALISEE') {
    if (!corrective || reason == null) {
      return editErr(
        'Séance réalisée verrouillée : correction avec motif obligatoire.',
      );
    }
    // Correction : REALISEE → tout autre statut autorisé.
  } else if (!ALLOWED_TRANSITIONS[s.status].includes(newStatus)) {
    return editErr(
      `Transition ${s.status} → ${newStatus} non autorisée.`,
    );
  }

  // Nouveau créneau (REPORTEE) : la séance bascule dessus.
  const newSlot = newStatus === 'REPORTEE';
  const date = newSlot ? input.date : s.date;
  const start = newSlot ? input.start_min : s.start_min;
  const end = newSlot ? input.end_min : s.end_min;
  const errors: FieldError[] = [];

  if (newStatus === 'ANNULEE' || newStatus === 'REPORTEE') {
    if (reason == null) {
      errors.push({ field: 'reason', message: 'Le motif est obligatoire.' });
    }
  }
  if (newSlot) {
    if (input.date === undefined || input.start_min === undefined ||
        input.end_min === undefined) {
      errors.push({
        field: 'date',
        message: 'Un nouveau créneau (date + horaire) est obligatoire.',
      });
    } else {
      errors.push(...validateSlot(date, start, end));
    }
  }

  // Actualisation REALISEE : défaut = créneau planifié.
  let actualDate: string | null = null;
  let actualStart: number | null = null;
  let actualEnd: number | null = null;
  if (newStatus === 'REALISEE') {
    actualDate =
      input.actual_date !== undefined ? input.actual_date : s.date;
    actualStart =
      input.actual_start_min !== undefined
        ? input.actual_start_min
        : s.start_min;
    actualEnd =
      input.actual_end_min !== undefined ? input.actual_end_min : s.end_min;
    if (typeof actualDate !== 'string' || !isValidIsoDate(actualDate.trim())) {
      errors.push({
        field: 'actual_date',
        message: 'Date de réalisation invalide (AAAA-MM-JJ).',
      });
    }
    if (
      !isInt(actualStart) ||
      !isInt(actualEnd) ||
      actualStart < 0 ||
      actualStart >= actualEnd ||
      actualEnd > 1440
    ) {
      errors.push({
        field: 'actual_start_min',
        message: 'Horaire de réalisation invalide (0 ≤ début < fin ≤ 24h00).',
      });
    }
  }
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }

  // Garde BR-10 : REPORTEE occupe le NOUVEAU créneau ; ANNULEE→PREVUE
  // recrée une occupation sur le créneau conservé — re-check obligatoire.
  const needsCheck =
    newStatus === 'REPORTEE' ||
    (newStatus === 'PREVUE' && s.status === 'ANNULEE');
  if (needsCheck) {
    const guardRes = placementGuard(db, {
      date: (date as string).trim(),
      startMin: start as number,
      endMin: end as number,
      roomId: s.room_id,
      professorId: s.professor_id,
      masterId: s.master_id,
      excludeSessionId: id,
      groupIds: sessionGroupIds(db, id, s.mm_group_id),
    });
    if (typeof guardRes === 'string') return editErr(guardRes);
    if (guardRes.length > 0) {
      return editErr(
        newStatus === 'REPORTEE'
          ? 'Report refusé : le nouveau créneau est en conflit.'
          : 'Réactivation refusée : le créneau est désormais en conflit.',
        undefined,
        guardRes,
      );
    }
  }

  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    applySessionChange(db, userId, s, {
      status: newStatus,
      date: (date as string).trim(),
      start_min: start as number,
      end_min: end as number,
      room_id: s.room_id,
      professor_id: s.professor_id,
      actual_date: actualDate,
      actual_start_min: actualStart,
      actual_end_min: actualEnd,
      reason,
    });
  });
  return editOk(id);
}

/**
 * Remplace les groupes rattachés (`session_group`) — les groupes doivent
 * appartenir au master de la séance. Re-check des conflits GROUP sur le
 * créneau actuel : seuls les conflits de groupe peuvent être CAUSÉS par
 * cette mutation (les autres kinds sont inchangés).
 */
export function setSessionGroups(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  groupIds: unknown,
): SessionEditResult {
  const s = getSession(db, id);
  if (!s) return editErr('Séance introuvable.');
  const check = validateGroupIds(db, s.master_id, groupIds);
  if (typeof check === 'string') {
    return editErr('Validation impossible : corrigez les champs signalés.', [
      { field: 'group_ids', message: check },
    ]);
  }
  if (s.status !== 'ANNULEE') {
    const candidate = new Set<number>(check);
    if (s.mm_group_id != null) candidate.add(s.mm_group_id);
    const guardRes = placementGuard(db, {
      date: s.date,
      startMin: s.start_min,
      endMin: s.end_min,
      roomId: s.room_id,
      professorId: s.professor_id,
      masterId: s.master_id,
      excludeSessionId: id,
      groupIds: [...candidate],
    });
    if (typeof guardRes === 'string') return editErr(guardRes);
    const groupConflicts = guardRes.filter((c) => c.kind === 'GROUP');
    if (groupConflicts.length > 0) {
      return editErr(
        'Rattachement refusé : conflit(s) de groupe détecté(s).',
        undefined,
        groupConflicts,
      );
    }
  }
  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    run(db, 'DELETE FROM session_group WHERE session_id = ?', id);
    for (const gid of check) {
      run(
        db,
        `INSERT INTO session_group (session_id, student_group_id)
         VALUES (?, ?)`,
        id,
        gid,
      );
    }
    run(db, "UPDATE session SET updated_at = datetime('now') WHERE id = ?", id);
  });
  return editOk(id);
}

/**
 * Suppression définitive (l'audit trace old_values) — refusée pour une
 * séance REALISEE (historique pédagogique). Les lignes filles
 * (session_group, historique, attendances) sont supprimées dans la même
 * transaction (FK sans CASCADE).
 */
export function deleteSession(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): SessionEditResult {
  const s = getSession(db, id);
  if (!s) return editErr('Séance introuvable.');
  if (s.status === 'REALISEE') {
    return editErr(
      'Une séance réalisée ne peut pas être supprimée ' +
        '(historique pédagogique).',
    );
  }
  withAudit(db, userId, 'DELETE', 'session', id, () => {
    run(db, 'DELETE FROM session_group WHERE session_id = ?', id);
    run(db, 'DELETE FROM session_status_history WHERE session_id = ?', id);
    run(db, 'DELETE FROM session_attendance WHERE session_id = ?', id);
    run(db, 'DELETE FROM student_attendance WHERE session_id = ?', id);
    run(db, 'DELETE FROM session WHERE id = ?', id);
  });
  return editOk(id);
}
