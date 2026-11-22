/**
 * Handlers IPC Décisions d'absence (P9a) — canaux `absences:*`.
 * Lecture (`absences:list`, `absences:get`) et écriture
 * (`absences:decide`) ouvertes aux deux profils (BR-24 : pas de
 * `requireRole`). Guards stricts sur les payloads ; la validation métier
 * vit dans `absence.service`.
 */
import { ipcMain } from 'electron';
import type { AbsenceDecisionInput } from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  decideSession,
  getAbsence,
  listAbsences,
} from '../db/absence.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

export function registerAbsenceHandlers(getDb: DbGetter): void {
  ipcMain.handle('absences:list', (_e, professorId: unknown) =>
    professorId !== undefined && !isId(professorId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) =>
          listAbsences(db, isId(professorId) ? professorId : undefined),
        ),
  );

  ipcMain.handle('absences:get', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => {
          const detail = getAbsence(db, id);
          return detail ?? apiErr('Absence introuvable.');
        }),
  );

  ipcMain.handle(
    'absences:decide',
    (_e, absenceId: unknown, sessionId: unknown, input: unknown) =>
      !isId(absenceId) || !isId(sessionId) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(getDb, (db) =>
            decideSession(
              db,
              currentUserId(db),
              absenceId,
              sessionId,
              input as unknown as AbsenceDecisionInput,
            ),
          ),
  );
}
