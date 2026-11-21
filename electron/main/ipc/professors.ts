/**
 * Handlers IPC du référentiel Professeurs — canaux `professors:*`
 * (CRUD, fiche de suivi, disponibilités, absences).
 * Mutations structurantes réservées ADMIN (BR-24) : create/update/remove/
 * setActive. Disponibilités et absences : ouvertes aux deux profils.
 */
import { ipcMain } from 'electron';
import type {
  AbsenceInput,
  AvailabilityInput,
  ProfessorInput,
  ProfessorRow,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  addAbsence,
  addAvailability,
  createProfessor,
  deleteProfessor,
  getProfessorDetail,
  listAbsences,
  listAvailabilities,
  listProfessors,
  removeAbsence,
  removeAvailability,
  setProfessorActive,
  updateProfessor,
} from '../db/professor.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

export function registerProfessorHandlers(getDb: DbGetter): void {
  ipcMain.handle('professors:list', (_e, search?: string) =>
    search !== undefined && typeof search !== 'string'
      ? apiErr<ProfessorRow[]>('Paramètre invalide.')
      : guard(getDb, (db) => listProfessors(db, search)),
  );

  ipcMain.handle('professors:get', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => getProfessorDetail(db, id)),
  );

  ipcMain.handle(
    'professors:create',
    (_e, input: ProfessorInput) =>
      !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(getDb, (db) => createProfessor(db, currentUserId(db), input), {
            requireRole: 'ADMIN',
          }),
  );

  ipcMain.handle(
    'professors:update',
    (_e, id: number, input: ProfessorInput) =>
      !isId(id) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(
            getDb,
            (db) => updateProfessor(db, currentUserId(db), id, input),
            { requireRole: 'ADMIN' },
          ),
  );

  ipcMain.handle('professors:remove', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => deleteProfessor(db, currentUserId(db), id), {
          requireRole: 'ADMIN',
        }),
  );

  ipcMain.handle('professors:setActive', (_e, id: number, active: boolean) =>
    // L'arg arrive sérialisé depuis le renderer — vérifie le type réel.
    !isId(id) || typeof active !== 'boolean'
      ? apiErr<ProfessorRow>('Paramètre invalide.')
      : guard(
          getDb,
          (db) => setProfessorActive(db, currentUserId(db), id, active),
          { requireRole: 'ADMIN' },
        ),
  );

  // --- Disponibilités -------------------------------------------------------

  ipcMain.handle('professors:availability:list', (_e, professorId: number) =>
    !isId(professorId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => listAvailabilities(db, professorId)),
  );

  ipcMain.handle(
    'professors:availability:add',
    (_e, professorId: number, input: AvailabilityInput) =>
      !isId(professorId) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(getDb, (db) =>
            addAvailability(db, currentUserId(db), professorId, input),
          ),
  );

  ipcMain.handle('professors:availability:remove', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => removeAvailability(db, currentUserId(db), id)),
  );

  // --- Absences -------------------------------------------------------------

  ipcMain.handle('professors:absence:list', (_e, professorId: number) =>
    !isId(professorId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => listAbsences(db, professorId)),
  );

  ipcMain.handle(
    'professors:absence:add',
    (_e, professorId: number, input: AbsenceInput) =>
      !isId(professorId) || !isObject(input)
        ? apiErr('Paramètres invalides.')
        : guard(getDb, (db) =>
            addAbsence(db, currentUserId(db), professorId, input),
          ),
  );

  ipcMain.handle('professors:absence:remove', (_e, id: number) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => removeAbsence(db, currentUserId(db), id)),
  );
}
