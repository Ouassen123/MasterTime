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
 * - REPORTEE : la séance bascule sur le NOUVEAU créneau (>= aujourd'hui) ;
 *   l'historique conserve l'ancien créneau + motif (DATA-MODEL / BR-3).
 * - REALISEE : verrouillée — sortie refusée sauf correction
 *   `{ corrective: true, reason }` ; suppression toujours refusée ;
 *   `actual_date` ne peut pas être dans le futur.
 * - Anti-wedging : `moveSession` ne re-check que les kinds affectés par
 *   les champs modifiés — un conflit pré-existant orthogonal ne bloque
 *   plus une retouche partielle.
 * - Ressources : salle/professeur `is_active = 0` refusés à la création
 *   et au déplacement (sauf valeur inchangée au move) ; master `ARCHIVE`
 *   refusé à la création.
 * - P9a : `planSessionMove` / `planStatusChange` / `applySessionPlan`
 *   exposent la mutation en deux phases (validation + garde BR-10, puis
 *   écriture) SANS `withAudit` — `absence.service` peut ainsi écrire la
 *   mutation de séance ET la ligne `absence_decision` dans une seule
 *   transaction auditée (withAudit n'imbrique pas).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ConflictKind,
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
import { isValidIsoDate, todayIso } from './date';
import { withAudit } from './audit.service';
import { checkSessionPlacement } from './conflict.service';

// --- Helpers de lecture ------------------------------------------------------

/** Séance brute + master/groupe du master-module (tout ce dont les gardes ont besoin). */
export interface SessionDb {
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

/** Plafond des textes libres (comment / reason) — intégrité du journal. */
const MAX_TEXT_LEN = 500;

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

/** Bras d'échec commun à `SessionEditResult` et `SessionPlanResult`. */
export interface SessionMutationError {
  ok: false;
  error: string;
  fields?: FieldError[];
  conflicts?: PlacementConflict[];
}

function editErr(
  error: string,
  fields?: FieldError[],
  conflicts?: PlacementConflict[],
): SessionMutationError {
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

export interface SessionChange {
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
 * Mutation de séance validée (garde BR-10 passée), prête à être écrite
 * par `applySessionPlan` dans la transaction de l'appelant.
 */
export interface SessionMutationPlan {
  before: SessionDb;
  change: SessionChange;
}

/**
 * Résultat d'une planification (`planSessionMove`/`planStatusChange`) :
 * succès → plan prêt à appliquer ; échec → mêmes bras d'erreur que
 * `SessionEditResult` (validation `fields`, refus BR-10 `conflicts`).
 */
export type SessionPlanResult =
  | { ok: true; plan: SessionMutationPlan }
  | SessionMutationError;

/**
 * Phase d'écriture unique (P9a) : appelle `applySessionChange` —
 * à invoquer DANS la transaction (`withAudit` ou BEGIN IMMEDIATE) de
 * l'appelant. Jamais hors transaction : pas d'UPDATE sans audit.
 */
export function applySessionPlan(
  db: DatabaseSync,
  userId: number | null,
  plan: SessionMutationPlan,
): void {
  applySessionChange(db, userId, plan.before, plan.change);
}

/**
 * Écrivain unique de la mutation séance + historique — appelé dans la TX
 * `withAudit`. Trace `session_status_history` systématiquement pour un
 * changement de statut, si le créneau change, ou si un motif est fourni
 * (old_status = new_status = statut courant pour un déplacement ou une
 * correction REALISEE→REALISEE).
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
  if (after.status !== before.status || slotChanged || after.reason != null) {
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
        master_status: string;
      }>(
        db,
        `SELECT mm.id, mm.master_id, mm.professor_id, mm.student_group_id,
                m.status AS master_status
           FROM master_module mm
           JOIN master m ON m.id = mm.master_id
          WHERE mm.id = ?`,
        input.master_module_id,
      )
    : undefined;
  if (!mm) {
    errors.push({
      field: 'master_module_id',
      message: 'Master-module inexistant.',
    });
  } else if (mm.master_status === 'ARCHIVE') {
    errors.push({
      field: 'master_module_id',
      message: 'Master archivé : création de séance impossible.',
    });
  }
  const professorId = input.professor_id ?? mm?.professor_id;
  const prof = isId(professorId)
    ? get<{ id: number; is_active: number }>(
        db,
        'SELECT id, is_active FROM professor WHERE id = ?',
        professorId,
      )
    : undefined;
  if (!isId(professorId)) {
    errors.push({
      field: 'professor_id',
      message: 'Professeur invalide.',
    });
  } else if (!prof) {
    errors.push({ field: 'professor_id', message: 'Professeur inexistant.' });
  } else if (prof.is_active !== 1) {
    errors.push({ field: 'professor_id', message: 'Professeur désactivé.' });
  }
  const room = isId(input?.room_id)
    ? get<{ id: number; is_active: number }>(
        db,
        'SELECT id, is_active FROM room WHERE id = ?',
        input.room_id,
      )
    : undefined;
  if (!isId(input?.room_id)) {
    errors.push({ field: 'room_id', message: 'Salle invalide.' });
  } else if (!room) {
    errors.push({ field: 'room_id', message: 'Salle inexistante.' });
  } else if (room.is_active !== 1) {
    errors.push({ field: 'room_id', message: 'Salle désactivée.' });
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
  if (comment.length > MAX_TEXT_LEN) {
    errors.push({
      field: 'comment',
      message: 'Commentaire trop long (500 caractères max).',
    });
  }
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  // Groupe implicite du mm : déjà porté par la séance — dédup silencieuse.
  const groupIds = (groupCheck as number[]).filter(
    (g) => g !== mm!.student_group_id,
  );
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
 * déplacement ≠ report (REPORTEE est un statut explicite). L'historique
 * consigne old/new date+mins si le créneau change, et le motif dès qu'il
 * est fourni. Garde BR-10 ANTI-WEDGING : seuls les kinds affectés par
 * les champs modifiés sont re-vérifiés (date/heure → tous ; salle →
 * ROOM+EXTERNAL ; prof → PROFESSOR ; rien changé → pas de check), de
 * sorte qu'un conflit pré-existant orthogonal ne bloque plus une
 * retouche partielle. Une séance REPORTEE exige un motif (re-report) ;
 * salle/prof désactivés refusés sauf valeur inchangée.
 */
export function moveSession(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: SessionMoveInput,
): SessionEditResult {
  const res = planSessionMove(db, id, input);
  if (!res.ok) return res;
  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    applySessionPlan(db, userId, res.plan);
  });
  return editOk(id);
}

/**
 * Phase 1 du déplacement (P9a) : mêmes validations et garde BR-10 que
 * `moveSession` mais AUCUNE écriture — retourne un plan à appliquer par
 * `applySessionPlan` dans la transaction de l'appelant (`absence.service`
 * écrit ainsi mutation + `absence_decision` en une seule TX).
 */
export function planSessionMove(
  db: DatabaseSync,
  id: number,
  input: SessionMoveInput,
): SessionPlanResult {
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
  const room = isId(roomId)
    ? get<{ id: number; is_active: number }>(
        db,
        'SELECT id, is_active FROM room WHERE id = ?',
        roomId,
      )
    : undefined;
  if (!isId(roomId) || !room) {
    errors.push({ field: 'room_id', message: 'Salle inexistante.' });
  } else if (roomId !== s.room_id && room.is_active !== 1) {
    // Valeur inchangée : une salle désactivée après coup n'interdit pas
    // de retoucher la séance ; la CHANGER vers une salle inactive, si.
    errors.push({ field: 'room_id', message: 'Salle désactivée.' });
  }
  const professorId =
    input.professor_id !== undefined ? input.professor_id : s.professor_id;
  const prof = isId(professorId)
    ? get<{ id: number; is_active: number }>(
        db,
        'SELECT id, is_active FROM professor WHERE id = ?',
        professorId,
      )
    : undefined;
  if (!isId(professorId) || !prof) {
    errors.push({ field: 'professor_id', message: 'Professeur inexistant.' });
  } else if (professorId !== s.professor_id && prof.is_active !== 1) {
    errors.push({ field: 'professor_id', message: 'Professeur désactivé.' });
  }
  const reason = isNonEmptyStr(input.reason) ? input.reason.trim() : null;
  // Déplacer une séance REPORTEE = re-report : motif obligatoire.
  if (s.status === 'REPORTEE' && reason == null) {
    errors.push({
      field: 'reason',
      message: 'Le motif est obligatoire pour déplacer une séance reportée.',
    });
  }
  if (reason != null && reason.length > MAX_TEXT_LEN) {
    errors.push({
      field: 'reason',
      message: 'Motif trop long (500 caractères max).',
    });
  }
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }
  // Anti-wedging : seuls les kinds affectés par les champs modifiés sont
  // re-vérifiés — un conflit pré-existant orthogonal (ex. PROFESSOR déjà
  // présent en base) ne bloque plus une retouche de salle/heure.
  const slotChanged =
    (date as string).trim() !== s.date ||
    start !== s.start_min ||
    end !== s.end_min;
  const kinds = new Set<ConflictKind>();
  if (slotChanged) {
    for (const k of ['ROOM', 'PROFESSOR', 'MASTER', 'GROUP', 'EXTERNAL'] as ConflictKind[]) {
      kinds.add(k);
    }
  } else {
    if (roomId !== s.room_id) {
      kinds.add('ROOM');
      kinds.add('EXTERNAL');
    }
    if (professorId !== s.professor_id) kinds.add('PROFESSOR');
  }
  // Une séance ANNULEE n'occupe pas de ressource : garde inutile ; rien
  // de changé → rien à re-checker non plus.
  if (s.status !== 'ANNULEE' && kinds.size > 0) {
    const guardRes = placementGuard(db, {
      date: (date as string).trim(),
      startMin: start,
      endMin: end,
      roomId,
      professorId,
      masterId: s.master_id,
      excludeSessionId: id,
      groupIds: sessionGroupIds(db, id, s.mm_group_id),
      kinds: [...kinds],
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
  return {
    ok: true,
    plan: {
      before: s,
      change: {
        status: s.status,
        date: (date as string).trim(),
        start_min: start,
        end_min: end,
        room_id: roomId,
        professor_id: professorId,
        actual_date: s.actual_date,
        actual_start_min: s.actual_start_min,
        actual_end_min: s.actual_end_min,
        reason,
      },
    },
  };
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
 *   le nouveau créneau doit être >= aujourd'hui ; la séance bascule
 *   dessus, l'historique conserve l'ancien (BR-3).
 * - → PREVUE : réactivation depuis ANNULEE (ou REPORTEE) avec re-check
 *   conflits sur le créneau conservé.
 * - REALISEE → autre : refusé sauf `corrective:true` + motif (correction
 *   admin, tracée en audit). REALISEE→REALISEE avec `corrective:true` +
 *   motif = retouche des `actual_*` seuls (créneau inchangé).
 * @param today Date 'YYYY-MM-DD' des bornes temporelles (injectable —
 *   défaut `todayIso()`).
 */
export function changeSessionStatus(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: SessionStatusInput,
  today: string = todayIso(),
): SessionEditResult {
  const res = planStatusChange(db, id, input, today);
  if (!res.ok) return res;
  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    applySessionPlan(db, userId, res.plan);
  });
  return editOk(id);
}

/**
 * Phase 1 du changement de statut (P9a) : mêmes validations, transitions
 * et garde BR-10 que `changeSessionStatus` mais AUCUNE écriture —
 * retourne un plan à appliquer par `applySessionPlan` dans la
 * transaction de l'appelant.
 * @param today Date 'YYYY-MM-DD' des bornes temporelles (injectable).
 */
export function planStatusChange(
  db: DatabaseSync,
  id: number,
  input: SessionStatusInput,
  today: string = todayIso(),
): SessionPlanResult {
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
  // REALISEE→REALISEE : retouche des actual_* (correction), pas un
  // no-op — soumise au même verrou corrective + motif.
  const correctiveRealisee =
    s.status === 'REALISEE' && newStatus === 'REALISEE';
  if (newStatus === s.status && !reReport && !correctiveRealisee) {
    return editErr('La séance est déjà dans ce statut.');
  }
  if (s.status === 'REALISEE') {
    if (!corrective || reason == null) {
      return editErr(
        correctiveRealisee
          ? 'La séance est déjà dans ce statut.'
          : 'Séance réalisée verrouillée : correction avec motif obligatoire.',
      );
    }
    // Correction : REALISEE → tout statut autorisé (motif tracé en audit).
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

  if (reason != null && reason.length > MAX_TEXT_LEN) {
    errors.push({
      field: 'reason',
      message: 'Motif trop long (500 caractères max).',
    });
  }
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
      const slotErrors = validateSlot(date, start, end);
      errors.push(...slotErrors);
      // Un report ne vise jamais le passé.
      if (
        !slotErrors.some((e) => e.field === 'date') &&
        (date as string).trim() < today
      ) {
        errors.push({
          field: 'date',
          message: 'Le nouveau créneau ne peut pas être dans le passé.',
        });
      }
    }
  }

  // Actualisation REALISEE : défaut = actual_* existants (correction
  // REALISEE→REALISEE) sinon créneau planifié.
  let actualDate: string | null = null;
  let actualStart: number | null = null;
  let actualEnd: number | null = null;
  if (newStatus === 'REALISEE') {
    actualDate =
      input.actual_date !== undefined
        ? input.actual_date
        : (s.actual_date ?? s.date);
    actualStart =
      input.actual_start_min !== undefined
        ? input.actual_start_min
        : (s.actual_start_min ?? s.start_min);
    actualEnd =
      input.actual_end_min !== undefined
        ? input.actual_end_min
        : (s.actual_end_min ?? s.end_min);
    if (typeof actualDate !== 'string' || !isValidIsoDate(actualDate.trim())) {
      errors.push({
        field: 'actual_date',
        message: 'Date de réalisation invalide (AAAA-MM-JJ).',
      });
    } else if (actualDate.trim() > today) {
      errors.push({
        field: 'actual_date',
        message: 'La réalisation ne peut pas être datée dans le futur.',
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
    if (typeof actualDate === 'string') actualDate = actualDate.trim();
  }
  if (errors.length > 0) {
    return editErr(
      'Validation impossible : corrigez les champs signalés.',
      errors,
    );
  }

  // Garde BR-10 : REPORTEE occupe le NOUVEAU créneau ; toute sortie
  // d'ANNULEE vers un statut occupant (PREVUE ou REALISEE) recrée une
  // occupation sur le créneau conservé — re-check obligatoire.
  const needsCheck =
    newStatus === 'REPORTEE' ||
    (s.status === 'ANNULEE' &&
      (newStatus === 'PREVUE' || newStatus === 'REALISEE'));
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

  return {
    ok: true,
    plan: {
      before: s,
      change: {
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
      },
    },
  };
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
  if (s.status === 'REALISEE') {
    return editErr(
      'Une séance réalisée est verrouillée : rattachement de groupes ' +
        'impossible.',
    );
  }
  const check = validateGroupIds(db, s.master_id, groupIds);
  if (typeof check === 'string') {
    return editErr('Validation impossible : corrigez les champs signalés.', [
      { field: 'group_ids', message: check },
    ]);
  }
  // Groupe implicite du mm : déjà porté par la séance — dédup silencieuse.
  const gids = check.filter((g) => g !== s.mm_group_id);
  if (s.status !== 'ANNULEE') {
    const candidate = new Set<number>(gids);
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
      kinds: ['GROUP'],
    });
    if (typeof guardRes === 'string') return editErr(guardRes);
    if (guardRes.length > 0) {
      return editErr(
        'Rattachement refusé : conflit(s) de groupe détecté(s).',
        undefined,
        guardRes,
      );
    }
  }
  // Audit explicite : le diff `updated_at` de la ligne session peut être
  // vide (même seconde) — la trace porte les listes de group_ids
  // avant/après dans la même transaction.
  const oldGroupIds = all<{ student_group_id: number }>(
    db,
    `SELECT student_group_id FROM session_group
      WHERE session_id = ? ORDER BY student_group_id`,
    id,
  ).map((r) => r.student_group_id);
  withAudit(db, userId, 'UPDATE', 'session', id, () => {
    run(db, 'DELETE FROM session_group WHERE session_id = ?', id);
    for (const gid of gids) {
      run(
        db,
        `INSERT INTO session_group (session_id, student_group_id)
         VALUES (?, ?)`,
        id,
        gid,
      );
    }
    const oldJson = JSON.stringify({ group_ids: oldGroupIds });
    const newJson = JSON.stringify({
      group_ids: [...gids].sort((a, b) => a - b),
    });
    // Pas de trace superflue pour un rattachement identique.
    if (oldJson !== newJson) {
      run(
        db,
        `INSERT INTO audit_log
           (user_id, action, entity, entity_id, old_values, new_values)
         VALUES (?, 'UPDATE', 'session', ?, ?, ?)`,
        userId,
        id,
        oldJson,
        newJson,
      );
    }
  });
  return editOk(id);
}

/**
 * Suppression définitive (l'audit trace old_values) — refusée pour une
 * séance REALISEE (historique pédagogique) ou passée (une
 * NON_ENCORE_REALISEE doit être ANNULEE, pas effacée). Les lignes filles
 * (session_group, historique, attendances) sont supprimées dans la même
 * transaction (FK sans CASCADE).
 * @param today Date 'YYYY-MM-DD' de la borne « passé » (injectable —
 *   défaut `todayIso()`).
 */
export function deleteSession(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  today: string = todayIso(),
): SessionEditResult {
  const s = getSession(db, id);
  if (!s) return editErr('Séance introuvable.');
  if (s.status === 'REALISEE') {
    return editErr(
      'Une séance réalisée ne peut pas être supprimée ' +
        '(historique pédagogique).',
    );
  }
  if (s.date < today) {
    return editErr(
      'Une séance passée ne peut pas être supprimée : annulez-la ou ' +
        'marquez-la réalisée.',
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
