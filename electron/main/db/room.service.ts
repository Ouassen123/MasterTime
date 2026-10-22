/**
 * Référentiel Salles — CRUD + protection de suppression (BR-22) +
 * désactivation (`is_active`) + audit transactionnel (AD-6, via `withAudit`).
 *
 * Validation serveur : `name` requis et unique, `capacity` > 0 si renseignée ;
 * les erreurs sont renvoyées sous forme `{ field, message }` mappées sur le
 * formulaire. Suppression refusée si des séances référencent la salle —
 * la désactivation reste possible (séances intactes).
 */
import { DatabaseSync } from 'node:sqlite';
import type { ApiResult, FieldError, Room, RoomInput } from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';

function getRoom(db: DatabaseSync, id: number): Room | undefined {
  return get<Room>(
    db,
    `SELECT r.id, r.name, r.capacity, r.is_active,
            (SELECT count(*) FROM session s WHERE s.room_id = r.id) AS sessionCount
       FROM room r WHERE r.id = ?`,
    id,
  );
}

export function listRooms(db: DatabaseSync): Room[] {
  return all<Room>(
    db,
    `SELECT r.id, r.name, r.capacity, r.is_active,
            (SELECT count(*) FROM session s WHERE s.room_id = r.id) AS sessionCount
       FROM room r ORDER BY r.name COLLATE NOCASE`,
  );
}

function validateRoom(
  db: DatabaseSync,
  input: RoomInput,
  excludeId: number | null,
): FieldError[] {
  const errors: FieldError[] = [];
  const name = (input.name ?? '').trim();
  if (!name) {
    errors.push({ field: 'name', message: 'Le nom de la salle est obligatoire.' });
  } else {
    const dup = get<{ id: number }>(
      db,
      'SELECT id FROM room WHERE name = ? AND id != ?',
      name,
      excludeId ?? -1,
    );
    if (dup) {
      errors.push({
        field: 'name',
        message: 'Une salle porte déjà ce nom.',
      });
    }
  }
  const cap = input.capacity;
  if (cap != null && (!Number.isInteger(cap) || cap <= 0)) {
    errors.push({
      field: 'capacity',
      message: 'La capacité doit être un entier strictement positif.',
    });
  }
  return errors;
}

export function createRoom(
  db: DatabaseSync,
  userId: number | null,
  input: RoomInput,
): ApiResult<Room> {
  const errors = validateRoom(db, input, null);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const name = input.name.trim();
  const capacity = input.capacity ?? null;
  const id = withAudit(db, userId, 'CREATE', 'room', null, () =>
    Number(
      run(db, 'INSERT INTO room (name, capacity, is_active) VALUES (?, ?, 1)', name, capacity)
        .lastInsertRowid,
    ),
  );
  return apiOk(getRoom(db, id!)!);
}

export function updateRoom(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: RoomInput,
): ApiResult<Room> {
  if (!getRoom(db, id)) {
    return apiErr('Salle introuvable.');
  }
  const errors = validateRoom(db, input, id);
  if (errors.length > 0) {
    return apiErr('Validation impossible : corrigez les champs signalés.', errors);
  }
  const name = input.name.trim();
  const capacity = input.capacity ?? null;
  withAudit(db, userId, 'UPDATE', 'room', id, () => {
    run(db, 'UPDATE room SET name = ?, capacity = ? WHERE id = ?', name, capacity, id);
  });
  return apiOk(getRoom(db, id)!);
}

/**
 * Suppression (BR-22) : refusée si des séances référencent la salle —
 * le message chiffre les données liées ; la désactivation est l'alternative.
 */
export function deleteRoom(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  const room = getRoom(db, id);
  if (!room) {
    return apiErr('Salle introuvable.');
  }
  if (room.sessionCount > 0) {
    return apiErr(
      `Cette salle est utilisée par ${room.sessionCount} séance(s) : ` +
        'suppression impossible. Vous pouvez la désactiver.',
    );
  }
  withAudit(db, userId, 'DELETE', 'room', id, () => {
    run(db, 'DELETE FROM room WHERE id = ?', id);
  });
  return apiOk(null);
}

/** Active / désactive la salle — les séances liées restent intactes. */
export function setRoomActive(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  active: boolean,
): ApiResult<Room> {
  if (!getRoom(db, id)) {
    return apiErr('Salle introuvable.');
  }
  withAudit(db, userId, 'UPDATE', 'room', id, () => {
    run(db, 'UPDATE room SET is_active = ? WHERE id = ?', active ? 1 : 0, id);
  });
  return apiOk(getRoom(db, id)!);
}
