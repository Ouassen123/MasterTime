/**
 * Handlers IPC Génération (P8) — canaux `generation:*`.
 *
 * BR-24 : AUCUN `requireRole` — ADMIN et GESTIONNAIRE génèrent tous les
 * deux. Guards stricts (`isId`/`isObject`) sur chaque payload ; la
 * validation métier (`fields`) vit dans `generation.service`.
 *
 * `generation:run` est SYNCHRONE (main mono-connexion AD-2) : le calcul
 * peut durer quelques secondes ; la fenêtre reste responsive mais les
 * requêtes lecture sont bloquées le temps du run — accepté en v1, pas de
 * worker (spec §5).
 */
import { ipcMain } from 'electron';
import type {
  GenerateParams,
  GenerationListFilter,
} from '../../../shared/types';
import { apiErr } from '../../../shared/types';
import {
  abandonGeneration,
  applyGeneration,
  generate,
  generationCatalog,
  getGeneration,
  listGenerations,
} from '../db/generation.service';
import { currentUserId, guard, isId, isObject, type DbGetter } from './helpers';

export function registerGenerationHandlers(getDb: DbGetter): void {
  ipcMain.handle('generation:run', (_e, params: unknown) =>
    !isObject(params)
      ? apiErr('Paramètres invalides.')
      : guard(getDb, (db) =>
          generate(
            db,
            currentUserId(db),
            params as unknown as GenerateParams,
          ),
        ),
  );

  ipcMain.handle('generation:list', (_e, filter?: unknown) =>
    filter !== undefined && !isObject(filter)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) =>
          listGenerations(db, filter as unknown as GenerationListFilter),
        ),
  );

  ipcMain.handle('generation:get', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => getGeneration(db, id)),
  );

  ipcMain.handle('generation:apply', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => applyGeneration(db, currentUserId(db), id)),
  );

  ipcMain.handle('generation:abandon', (_e, id: unknown) =>
    !isId(id)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => abandonGeneration(db, currentUserId(db), id)),
  );

  ipcMain.handle('generation:catalog', (_e, semesterId: unknown) =>
    !isId(semesterId)
      ? apiErr('Paramètre invalide.')
      : guard(getDb, (db) => generationCatalog(db, semesterId)),
  );
}
