/**
 * Handlers IPC du référentiel Salles — canaux `rooms:*`.
 * Toute mutation passe par le service (audit + BR-22 dans la même TX).
 */
import { ipcMain } from 'electron';
import type { RoomInput } from '../../../shared/types';
import {
  createRoom,
  deleteRoom,
  listRooms,
  setRoomActive,
  updateRoom,
} from '../db/room.service';
import { currentUserId, guard, type DbGetter } from './helpers';

export function registerRoomHandlers(getDb: DbGetter): void {
  ipcMain.handle('rooms:list', () => guard(getDb, (db) => listRooms(db)));

  ipcMain.handle('rooms:create', (_e, input: RoomInput) =>
    guard(getDb, (db) => createRoom(db, currentUserId(db), input)),
  );

  ipcMain.handle('rooms:update', (_e, id: number, input: RoomInput) =>
    guard(getDb, (db) => updateRoom(db, currentUserId(db), id, input)),
  );

  ipcMain.handle('rooms:remove', (_e, id: number) =>
    guard(getDb, (db) => deleteRoom(db, currentUserId(db), id)),
  );

  ipcMain.handle('rooms:setActive', (_e, id: number, active: boolean) =>
    guard(getDb, (db) => setRoomActive(db, currentUserId(db), id, active)),
  );
}
