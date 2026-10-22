/**
 * Connexion SQLite unique (AD-2) — `node:sqlite` DatabaseSync, WAL, FK ON.
 * Ce module n'importe pas Electron : le chemin `userData` est injecté par
 * `index.ts` via `resolveDbPath()`, ce qui permet les tests sur `:memory:`
 * ou fichier temporaire sans Electron.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface DbHandle {
  db: DatabaseSync;
  /** Chemin du fichier DB, ou ':memory:'. */
  path: string;
  isMemory: boolean;
}

let current: DbHandle | null = null;

/**
 * Résout le chemin de la base. Priorité : argument explicite >
 * `MASTERTIME_DB_PATH` > ':memory:' (fallback test — le main passe
 * toujours un chemin explicite `userData/mastertime.db`).
 */
export function resolveDbPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env.MASTERTIME_DB_PATH) return process.env.MASTERTIME_DB_PATH;
  return ':memory:';
}

/** Ouvre (ou crée) une base et applique les pragmas AD-2. */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Singleton de connexion — une seule connexion partagée dans le main (AD-2). */
export function getDb(dbPath?: string): DbHandle {
  if (current) return current;
  const resolved = resolveDbPath(dbPath);
  current = {
    db: openDatabase(resolved),
    path: resolved,
    isMemory: resolved === ':memory:',
  };
  return current;
}

/** Ferme le singleton (tests / quitter l'app). */
export function closeDb(): void {
  if (current) {
    try {
      current.db.close();
    } finally {
      current = null;
    }
  }
}

// --- Wrapper fin typé -------------------------------------------------------

export function all<T = Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...params);
}

/** Nombre de lignes d'une table (compteurs de statut/seed). */
export function countRows(db: DatabaseSync, table: string): number {
  const row = get<{ c: number }>(db, `SELECT count(*) AS c FROM "${table}"`);
  return row?.c ?? 0;
}
