/**
 * Saisie groupée de la feuille de présence (P17 — `sessions:recordSheet`):
 * au retour de la feuille papier cochée, la séance est marquée REALISEE
 * ET les présences nominatives sont écrites EN UNE SEULE transaction
 * auditée — jamais de séance réalisée à moitié saisie.
 *
 * Règles :
 * - la séance doit être PREVUE ou REPORTEE (FieldError `status` sinon —
 *   une REALISEE se corrige via l'onglet Présences existant, qui relève
 *   de `attendance:setNominative`/`setCounts`) ;
 * - le changement de statut délègue à `planStatusChange` +
 *   `applySessionPlan` (P7b/P9a : validation, historique
 *   `session_status_history`, audit) — `withAudit` n'imbrique pas, les
 *   deux écritures vivent dans la transaction du plan ;
 * - les `rows` (P/A/J) sont bornées comme `setNominative` : ids valides,
 *   statuts `ATTENDANCE_STATUSES`, chaque étudiant dans le roster
 *   (groupes candidats ∪ orphelines) ; JUSTIFIE reste un absent
 *   comptablement (règle comptable v1) ;
 * - `rows` vide (ou séance sans étudiants) = marquage réalisée simple ;
 * - audit explicite `student_attendance` (récap items + compteurs) dans
 *   la même transaction, pattern `setSessionGroups`.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  SheetEntryInput,
  SheetEntryResult,
  SessionStatus,
  StudentAttendanceStatus,
} from '../../../shared/types';
import { apiErr, apiOk, ATTENDANCE_STATUSES } from '../../../shared/types';
import { get, run } from './connection';
import { todayIso } from './date';
import { withAudit } from './audit.service';
import {
  applySessionPlan,
  planStatusChange,
} from './session-edit.service';
import {
  auditLine,
  candidateGroupIds,
  countsRow,
  nominativeState,
  rosterRows,
} from './attendance.service';

/** Motif consigné dans l'historique de statut (traçabilité du flux). */
const SHEET_REASON = 'Saisie feuille de présence';

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

interface SheetSessionCtx {
  id: number;
  status: SessionStatus;
  master_id: number;
  mm_group_id: number | null;
}

/**
 * Marque la séance REALISEE et enregistre les présences nominatives
 * en une seule transaction.
 * @param input `{actual_date?, actual_start_min?, actual_end_min?, rows}`
 *   — actual_* optionnels (défaut : créneau planifié, règle P7b) ;
 *   `rows` vide = marquage réalisée seul.
 * @param today Date 'YYYY-MM-DD' des bornes temporelles (injectable).
 */
export function recordAttendanceSheet(
  db: DatabaseSync,
  userId: number | null,
  sessionId: number,
  input: SheetEntryInput,
  today: string = todayIso(),
): ApiResult<SheetEntryResult> {
  const ctx = get<SheetSessionCtx>(
    db,
    `SELECT s.id, s.status, mm.master_id,
            mm.student_group_id AS mm_group_id
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
      WHERE s.id = ?`,
    sessionId,
  );
  if (!ctx) return apiErr('Séance introuvable.');
  if (ctx.status !== 'PREVUE' && ctx.status !== 'REPORTEE') {
    return apiErr('Validation impossible : corrigez les champs signalés.', [
      {
        field: 'status',
        message:
          'La saisie de la feuille exige une séance prévue ou reportée ' +
          "— une séance réalisée se corrige via l'onglet Présences.",
      },
    ]);
  }

  // --- Validation des lignes nominatives (mêmes bornes que setNominative) --
  if (input?.rows !== undefined && !Array.isArray(input.rows)) {
    return apiErr('Paramètres invalides.');
  }
  const byStudent = new Map<number, StudentAttendanceStatus>();
  for (const item of input?.rows ?? []) {
    if (item == null || typeof item !== 'object' || !isId(item.student_id)) {
      return apiErr(
        'Validation impossible : corrigez les champs signalés.',
        [{ field: 'rows', message: 'Identifiant étudiant invalide.' }],
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
            field: 'rows',
            message:
              'Statut de présence invalide (PRESENT, ABSENT ou JUSTIFIE attendu).',
          },
        ],
      );
    }
    // Dédupliqué par student_id — le dernier fourni l'emporte.
    byStudent.set(item.student_id, item.status);
  }
  // Chaque étudiant doit appartenir au roster : groupes candidats ∪
  // orphelines (lignes nominatives existantes — même règle que
  // setNominative : pas d'effacement silencieux).
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
          field: 'rows',
          message:
            `${outsiders.length} étudiant(s) n'appartiennent pas ` +
            'aux groupes de la séance.',
        },
      ],
    );
  }

  // --- Plan de mutation (validation + transitions P7b, aucune écriture) ---
  const planRes = planStatusChange(
    db,
    sessionId,
    {
      status: 'REALISEE',
      reason: SHEET_REASON,
      actual_date: input?.actual_date,
      actual_start_min: input?.actual_start_min,
      actual_end_min: input?.actual_end_min,
    },
    today,
  );
  if (!planRes.ok) {
    return apiErr(planRes.error, planRes.fields);
  }

  const entries = [...byStudent.entries()].sort((a, b) => a[0] - b[0]);
  const presentCount = entries.filter(([, st]) => st === 'PRESENT').length;
  const absentCount = entries.length - presentCount; // ABSENT + JUSTIFIE
  const oldItems = nominativeState(db, sessionId);
  const oldCounts = countsRow(db, sessionId);

  // --- Écriture : statut + nominatif dans UNE transaction auditée ---------
  withAudit(db, userId, 'UPDATE', 'session', sessionId, () => {
    applySessionPlan(db, userId, planRes.plan);
    if (entries.length === 0) {
      // Marquage réalisée simple (séance sans étudiants ou feuille
      // non nominative) — aucune ligne de présence à écrire ; la
      // ligne pilote 'session' suffit à l'audit.
      return;
    }
    run(db, 'DELETE FROM student_attendance WHERE session_id = ?', sessionId);
    const ins = db.prepare(
      `INSERT INTO student_attendance (session_id, student_id, status)
       VALUES (?, ?, ?)`,
    );
    for (const [studentId, status] of entries) {
      ins.run(sessionId, studentId, status);
    }
    // Compteurs recalculés — note existante conservée (upsert sans
    // colonne note, comme setNominative).
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
    // Audit récap explicite : la ligne pilote 'session' ne porte que
    // le diff de la séance — la feuille saisie est tracée ici.
    auditLine(
      db,
      userId,
      oldItems.length === 0 ? 'CREATE' : 'UPDATE',
      'student_attendance',
      sessionId,
      { items: oldItems, counts: oldCounts },
      {
        items: nominativeState(db, sessionId),
        counts: countsRow(db, sessionId),
        marked: entries.length,
      },
    );
  });
  return apiOk({
    session_id: sessionId,
    realised: true,
    marked: entries.length,
  });
}
