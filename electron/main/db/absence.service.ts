/**
 * Décisions d'absence (P9a — BR-17/18, FR-36→38) : pour chaque séance
 * impactée par une absence de professeur, une décision explicite
 * (REMPLACEMENT / REPORT / ANNULATION) est enregistrée dans
 * `absence_decision` DANS LA MÊME transaction que la mutation de séance.
 *
 * - `listAbsences` : absence + nb_impacted (séances encore ouvertes
 *   PREVUE/REPORTEE dans la fenêtre) + nb_decisions + résolution stockée.
 * - `getAbsence` : absence + impacted[] (PREVUE **et** REPORTEE — une
 *   REPORTEE occupe aussi le créneau) + décision jointe par séance.
 * - `decideSession` : la séance doit être encore impactée (même requête)
 *   et sans décision ; la mutation délègue aux planificateurs internes
 *   de `session-edit.service` (planSessionMove / planStatusChange —
 *   `withAudit` n'imbrique pas), écrits avec `applySessionPlan` dans
 *   une SEULE transaction auditée englobant aussi la ligne
 *   `absence_decision` (audit_log explicite, pattern setSessionGroups)
 *   et le recalcul de `resolution` (stockée — auditée explicitement).
 *   Échec de la mutation (conflit BR-10) → rien n'est écrit.
 * - Résolution : 0 décision → A_TRAITER ; toutes les séances encore
 *   ouvertes décidées → RESOLUE ; sinon PARTIELLE. Une séance décidée
 *   puis remise en cause garde sa décision tracée ; la résolution se
 *   recalcule au prochain événement (comportement documenté, pas de
 *   watcher).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  AbsenceDecisionInput,
  AbsenceDecisionRow,
  AbsenceDetail,
  AbsenceDetailSession,
  AbsenceListRow,
  AbsenceResolution,
  FieldError,
  ImpactedSession,
  SessionEditResult,
} from '../../../shared/types';
import { ABSENCE_DECISIONS } from '../../../shared/types';
import { all, get, run } from './connection';
import { todayIso } from './date';
import { withAudit } from './audit.service';
import { loadProfConstraints, profBlock, weekdayOf } from './availability';
import {
  applySessionPlan,
  planSessionMove,
  planStatusChange,
  type SessionMutationPlan,
  type SessionPlanResult,
} from './session-edit.service';

/** Plafond des textes libres (note) — même borne que session-edit. */
const MAX_TEXT_LEN = 500;

const DEFAULT_REASON = 'Absence du titulaire';

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function decideErr(
  error: string,
  fields?: FieldError[],
): SessionEditResult {
  return fields && fields.length > 0
    ? { ok: false, error, fields }
    : { ok: false, error };
}

// --- Séances impactées (requête unique, partagée) -----------------------------

/**
 * Ids des séances du professeur ENCORE OUVERTES dans la fenêtre d'absence :
 * PREVUE **et** REPORTEE — une REPORTEE reste attribuée au titulaire et
 * occupe son (nouveau) créneau : elle est impactée comme une PREVUE.
 */
function openImpactedIds(
  db: DatabaseSync,
  absenceId: number,
): number[] {
  return all<{ id: number }>(
    db,
    `SELECT s.id FROM session s
       JOIN professor_absence a ON a.id = ?
      WHERE s.professor_id = a.professor_id
        AND s.status IN ('PREVUE','REPORTEE')
        AND s.date BETWEEN a.start_date AND a.end_date`,
    absenceId,
  ).map((r) => r.id);
}

// --- Lecture -----------------------------------------------------------------

const ABSENCE_SELECT = `
  SELECT a.id, a.professor_id, a.start_date, a.end_date, a.reason,
         a.resolution, p.full_name AS professor_name,
         (SELECT count(*) FROM session s
           WHERE s.professor_id = a.professor_id
             AND s.status IN ('PREVUE','REPORTEE')
             AND s.date BETWEEN a.start_date AND a.end_date) AS nb_impacted,
         (SELECT count(*) FROM absence_decision d
           WHERE d.absence_id = a.id) AS nb_decisions
    FROM professor_absence a
    JOIN professor p ON p.id = a.professor_id`;

/** Liste des absences (+ compteurs) — `professorId` optionnel. */
export function listAbsences(
  db: DatabaseSync,
  professorId?: number,
): AbsenceListRow[] {
  if (isId(professorId)) {
    return all<AbsenceListRow>(
      db,
      `${ABSENCE_SELECT} WHERE a.professor_id = ?
        ORDER BY a.start_date DESC, a.id DESC`,
      professorId,
    );
  }
  return all<AbsenceListRow>(
    db,
    `${ABSENCE_SELECT} ORDER BY a.start_date DESC, a.id DESC`,
  );
}

/** Détail d'une absence : séances impactées + décision éventuelle. */
export function getAbsence(
  db: DatabaseSync,
  id: number,
): AbsenceDetail | null {
  const absence = get<AbsenceListRow>(
    db,
    `${ABSENCE_SELECT} WHERE a.id = ?`,
    id,
  );
  if (!absence) return null;
  const impacted = all<
    ImpactedSession & {
      decision_id: number | null;
      decision: AbsenceDecisionRow['decision'] | null;
      substitute_professor_id: number | null;
      substitute_name: string | null;
      decided_at: string | null;
      decided_by: number | null;
      decided_by_name: string | null;
      note: string | null;
    }
  >(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
            mo.name AS module_name, m.name AS master_name,
            r.name AS room_name,
            d.id AS decision_id, d.decision, d.substitute_professor_id,
            sp.full_name AS substitute_name, d.decided_at, d.decided_by,
            u.display_name AS decided_by_name, d.note
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN module mo ON mo.id = mm.module_id
       JOIN master m ON m.id = mm.master_id
       JOIN room r ON r.id = s.room_id
       LEFT JOIN absence_decision d
         ON d.absence_id = ? AND d.session_id = s.id
       LEFT JOIN professor sp ON sp.id = d.substitute_professor_id
       LEFT JOIN app_user u ON u.id = d.decided_by
      WHERE s.professor_id = ? AND s.status IN ('PREVUE','REPORTEE')
        AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.start_min, s.id`,
    absence.id,
    absence.professor_id,
    absence.start_date,
    absence.end_date,
  );
  const sessions: AbsenceDetailSession[] = impacted.map((r) => ({
    id: r.id,
    date: r.date,
    start_min: r.start_min,
    end_min: r.end_min,
    status: r.status,
    module_name: r.module_name,
    master_name: r.master_name,
    room_name: r.room_name,
    decision:
      r.decision_id != null
        ? {
            id: r.decision_id,
            absence_id: absence.id,
            session_id: r.id,
            decision: r.decision!,
            substitute_professor_id: r.substitute_professor_id,
            substitute_name: r.substitute_name,
            decided_at: r.decided_at!,
            decided_by: r.decided_by,
            decided_by_name: r.decided_by_name,
            note: r.note,
          }
        : null,
  }));
  return { absence, impacted: sessions };
}

// --- Résolution (stockée, recalculée dans la TX de la décision) ----------------

/**
 * Recalcule `professor_absence.resolution` : 0 décision → A_TRAITER ;
 * toutes les séances encore ouvertes (PREVUE/REPORTEE dans la fenêtre)
 * décidées → RESOLUE ; sinon PARTIELLE. Appelé DANS la transaction de
 * `decideSession` — si la résolution change, l'UPDATE est tracé par une
 * ligne audit_log explicite (même transaction).
 */
function recalcResolutionTx(
  db: DatabaseSync,
  userId: number | null,
  absenceId: number,
): void {
  const current = get<{ resolution: AbsenceResolution }>(
    db,
    'SELECT resolution FROM professor_absence WHERE id = ?',
    absenceId,
  );
  if (!current) return;
  const openIds = openImpactedIds(db, absenceId);
  const totalDecisions =
    get<{ c: number }>(
      db,
      'SELECT count(*) AS c FROM absence_decision WHERE absence_id = ?',
      absenceId,
    )?.c ?? 0;
  let next: AbsenceResolution;
  if (totalDecisions === 0) {
    next = 'A_TRAITER';
  } else {
    const undecidedOpen = openIds.filter(
      (sid) =>
        get<{ id: number }>(
          db,
          `SELECT id FROM absence_decision
            WHERE absence_id = ? AND session_id = ?`,
          absenceId,
          sid,
        ) == null,
    );
    next = undecidedOpen.length === 0 ? 'RESOLUE' : 'PARTIELLE';
  }
  if (next === current.resolution) return;
  run(
    db,
    'UPDATE professor_absence SET resolution = ? WHERE id = ?',
    next,
    absenceId,
  );
  // Audit explicite : withAudit ne trace que l'entité pilote ('session') —
  // les écritures adjacentes portent leur propre ligne (setSessionGroups).
  run(
    db,
    `INSERT INTO audit_log
       (user_id, action, entity, entity_id, old_values, new_values)
     VALUES (?, 'UPDATE', 'professor_absence', ?, ?, ?)`,
    userId,
    absenceId,
    JSON.stringify({ resolution: current.resolution }),
    JSON.stringify({ resolution: next }),
  );
}

// --- Décision -----------------------------------------------------------------

/**
 * Enregistre une décision sur une séance impactée :
 *
 * - la séance doit être encore impactée par cette absence (même requête
 *   que `getAbsence` : PREVUE/REPORTEE dans la fenêtre) et SANS décision
 *   existante — sinon refus (« déjà traitée ») ;
 * - REMPLACEMENT : remplaçant ≠ titulaire, existant, `is_active`, et
 *   disponible sur le créneau (DISPO/INDISPO/absence via les prédicats
 *   partagés de `availability.ts`) ; mutation = changement de
 *   professeur via `planSessionMove` (seul `professor_id` change → la
 *   garde BR-10 ne re-check que kinds=['PROFESSOR'], anti-wedging) ;
 * - REPORT : délègue à `planStatusChange` REPORTEE (motif + nouveau
 *   créneau obligatoires, motif pré-rempli « Absence du titulaire ») ;
 * - ANNULATION : `planStatusChange` ANNULEE, motif idem.
 *
 * Mutation + `absence_decision` + recalcul de résolution écrits dans
 * UNE SEULE transaction auditée (`withAudit` sur 'session' pilote ;
 * la décision et la résolution portent des lignes audit_log explicites).
 * Échec de la mutation (BR-10) → aucune décision écrite, conflits
 * remontés à l'UI.
 *
 * @param today Date 'YYYY-MM-DD' des bornes temporelles (injectable).
 */
export function decideSession(
  db: DatabaseSync,
  userId: number | null,
  absenceId: number,
  sessionId: number,
  input: AbsenceDecisionInput,
  today: string = todayIso(),
): SessionEditResult {
  const absence = get<{
    id: number;
    professor_id: number;
    start_date: string;
    end_date: string;
  }>(
    db,
    `SELECT id, professor_id, start_date, end_date
       FROM professor_absence WHERE id = ?`,
    absenceId,
  );
  if (!absence) return decideErr('Absence introuvable.');
  // La séance doit être encore impactée (même requête que getAbsence) —
  // sinon « déjà traitée » ou hors fenêtre.
  const session = get<{ id: number; date: string; start_min: number; end_min: number }>(
    db,
    `SELECT id, date, start_min, end_min FROM session
      WHERE id = ? AND professor_id = ?
        AND status IN ('PREVUE','REPORTEE')
        AND date BETWEEN ? AND ?`,
    sessionId,
    absence.professor_id,
    absence.start_date,
    absence.end_date,
  );
  if (!session) {
    return decideErr(
      'Séance non impactée par cette absence (déjà traitée ou hors fenêtre).',
    );
  }
  if (
    get<{ id: number }>(
      db,
      'SELECT id FROM absence_decision WHERE absence_id = ? AND session_id = ?',
      absenceId,
      sessionId,
    )
  ) {
    return decideErr('Cette séance a déjà fait l’objet d’une décision.');
  }
  const decision = input?.decision;
  if (
    typeof decision !== 'string' ||
    !(ABSENCE_DECISIONS as readonly string[]).includes(decision)
  ) {
    return decideErr('Décision invalide (REMPLACEMENT, REPORT ou ANNULATION).', [
      { field: 'decision', message: 'Choisissez une décision.' },
    ]);
  }
  const note = isNonEmptyStr(input.note) ? input.note.trim() : null;
  if (note != null && note.length > MAX_TEXT_LEN) {
    return decideErr('Validation impossible : corrigez les champs signalés.', [
      { field: 'note', message: 'Note trop longue (500 caractères max).' },
    ]);
  }
  const reason = note ?? DEFAULT_REASON;

  // --- Plan de mutation (validation + garde BR-10, aucune écriture) ----
  let planRes: SessionPlanResult;
  if (decision === 'REMPLACEMENT') {
    const subId = input.substitute_professor_id;
    if (!isId(subId)) {
      return decideErr('Validation impossible : corrigez les champs signalés.', [
        { field: 'substitute_professor_id', message: 'Remplaçant invalide.' },
      ]);
    }
    if (subId === absence.professor_id) {
      return decideErr(
        'Validation impossible : corrigez les champs signalés.',
        [
          {
            field: 'substitute_professor_id',
            message: 'Le remplaçant doit être différent du titulaire.',
          },
        ],
      );
    }
    const sub = get<{ id: number; is_active: number }>(
      db,
      'SELECT id, is_active FROM professor WHERE id = ?',
      subId,
    );
    if (!sub) {
      return decideErr(
        'Validation impossible : corrigez les champs signalés.',
        [
          {
            field: 'substitute_professor_id',
            message: 'Remplaçant inexistant.',
          },
        ],
      );
    }
    if (sub.is_active !== 1) {
      return decideErr(
        'Validation impossible : corrigez les champs signalés.',
        [
          {
            field: 'substitute_professor_id',
            message: 'Le remplaçant est désactivé.',
          },
        ],
      );
    }
    // DISPO/INDISPO/absence du remplaçant sur le créneau — mêmes
    // prédicats que le générateur (module partagé availability.ts).
    const warnings: string[] = [];
    const cons = loadProfConstraints(db, [subId], warnings).get(subId)!;
    const block = profBlock(
      cons,
      session.date,
      weekdayOf(session.date),
      session.start_min,
      session.end_min,
    );
    if (block != null) {
      return decideErr(
        'Validation impossible : corrigez les champs signalés.',
        [
          {
            field: 'substitute_professor_id',
            message:
              block === 'absent'
                ? 'Le remplaçant est absent ce jour.'
                : 'Le remplaçant est indisponible sur ce créneau.',
          },
        ],
      );
    }
    // Changement de professeur seul → la garde BR-10 ne re-check que
    // kinds=['PROFESSOR'] (anti-wedging du planificateur P7b).
    planRes = planSessionMove(db, sessionId, {
      professor_id: subId,
      reason,
    });
  } else if (decision === 'REPORT') {
    planRes = planStatusChange(
      db,
      sessionId,
      {
        status: 'REPORTEE',
        reason,
        date: input.new_date,
        start_min: input.new_start,
        end_min: input.new_end,
      },
      today,
    );
  } else {
    // ANNULATION
    planRes = planStatusChange(
      db,
      sessionId,
      { status: 'ANNULEE', reason },
      today,
    );
  }
  if (!planRes.ok) return planRes;
  const plan: SessionMutationPlan = planRes.plan;

  // --- Écriture : mutation + décision + résolution dans UNE transaction --
  try {
    withAudit(db, userId, 'UPDATE', 'session', sessionId, () => {
      applySessionPlan(db, userId, plan);
      const decisionId = Number(
        run(
          db,
          `INSERT INTO absence_decision
             (absence_id, session_id, decision, substitute_professor_id,
              decided_by, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          absenceId,
          sessionId,
          decision,
          decision === 'REMPLACEMENT'
            ? (input.substitute_professor_id as number)
            : null,
          userId,
          note,
        ).lastInsertRowid,
      );
      // Audit explicite de la décision (pattern setSessionGroups) : la
      // ligne pilote 'session' ne porte que le diff de la séance.
      const decRow = get<Record<string, unknown>>(
        db,
        'SELECT * FROM absence_decision WHERE id = ?',
        decisionId,
      );
      run(
        db,
        `INSERT INTO audit_log
           (user_id, action, entity, entity_id, old_values, new_values)
         VALUES (?, 'CREATE', 'absence_decision', ?, NULL, ?)`,
        userId,
        decisionId,
        JSON.stringify(decRow),
      );
      recalcResolutionTx(db, userId, absenceId);
    });
  } catch (err) {
    // Contrainte UNIQUE course-conditionnelle → refus propre ; autre
    // erreur SQLite propagée au guard IPC (mutation + décision rollbackées).
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      return decideErr('Cette séance a déjà fait l’objet d’une décision.');
    }
    throw err;
  }
  return { ok: true, data: { sessionId } };
}
