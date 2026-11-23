/**
 * Handlers IPC Registre étudiants (P9b — saisie manuelle minimale,
 * pré-import Phase I) — canaux `students:*`. Ouverts aux deux profils
 * (BR-24 : pas de `requireRole`). Guards stricts ; la validation métier
 * (nom obligatoire, unicité external_id, BR-22) vit dans
 * `student.service`.
 */
import { ipcMain } from 'electron';
import type { StudentInput } from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  addStudent,
  listByGroup,
  removeStudent,
} from '../db/student.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

export function registerStudentHandlers(getDb: DbGetter): void {
  ipcMain.handle('students:list', (_e, groupId: unknown) =>
    !isId(groupId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => listByGroup(db, groupId)),
  );

  ipcMain.handle('students:add', (_e, groupId: unknown, input: unknown) =>
    !isId(groupId) || !isObject(input)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          addStudent(
            db,
            currentUserId(db),
            groupId,
            input as unknown as StudentInput,
          ),
        ),
  );

  ipcMain.handle('students:remove', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => removeStudent(db, currentUserId(db), id)),
  );
}
