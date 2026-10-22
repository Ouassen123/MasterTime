/**
 * Runner de migrations (AD-8) — fichiers `NNNN_*.sql` ordonnés,
 * `schema_migrations(version)` pour l'idempotence, transaction par
 * migration, sauvegarde `PRE_MIGRATION` sur base existante non vide.
 *
 * Le runner accepte un `DatabaseSync` injecté : les tests peuvent donc
 * tourner sur `:memory:` ou fichier temporaire sans Electron.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { get } from './connection';

export interface MigrationSource {
  /** Numéro extrait du préfixe `NNNN_`. */
  version: number;
  /** Nom de fichier, ex. '0001_init.sql'. */
  name: string;
  sql: string;
}

export interface RunMigrationsOptions {
  migrations: MigrationSource[];
  /** Répertoire des sauvegardes (`userData/backups`). Omis → pas de backup. */
  backupDir?: string;
  /** Chemin fichier de la base — requis pour la copie de sauvegarde. */
  dbPath?: string;
}

export interface MigrationResult {
  /** Noms des migrations appliquées lors de cet appel. */
  applied: string[];
  /** Versions déjà présentes dans `schema_migrations` avant l'appel. */
  alreadyApplied: number[];
  /** Chemin de la sauvegarde PRE_MIGRATION, si créée. */
  backupPath?: string;
}

const MIGRATION_FILE_RE = /^(\d{4})_.*\.sql$/;

/** Liste les migrations d'un répertoire (utilisé par les tests / outils). */
export function loadMigrationsFromDir(dir: string): MigrationSource[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
  return files.map((name) => ({
    version: Number.parseInt(name.slice(0, 4), 10),
    name,
    sql: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}

/**
 * Migrations embarquées dans le bundle main via `import.meta.glob`
 * (pas de copie de fichiers nécessaire dans `out/`).
 * Tout `*.sql` dont le nom ne suit pas `NNNN_*.sql` est refusé.
 */
export function bundledMigrations(): MigrationSource[] {
  const modules = import.meta.glob('./migrations/*.sql', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;
  return Object.entries(modules)
    .map(([p, sql]) => {
      const name = path.basename(p);
      if (!MIGRATION_FILE_RE.test(name)) {
        throw new Error(
          `Fichier SQL non conforme au format NNNN_*.sql : '${name}'`,
        );
      }
      return { version: Number.parseInt(name.slice(0, 4), 10), name, sql };
    })
    .sort((a, b) => a.version - b.version);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = get<{ c: number }>(
    db,
    "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name = ?",
    name,
  );
  return (row?.c ?? 0) > 0;
}

function appliedVersions(db: DatabaseSync): Set<number> {
  if (!tableExists(db, 'schema_migrations')) return new Set();
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  return new Set(rows.map((r) => r.version));
}

/** Nombre de tables utilisateur (hors tables internes sqlite). */
export function userTableCount(db: DatabaseSync): number {
  const row = get<{ c: number }>(
    db,
    "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  return row?.c ?? 0;
}

/** Copie de sauvegarde PRE_MIGRATION + entrée `backup_history` si la table existe. */
function createPreMigrationBackup(
  db: DatabaseSync,
  backupDir: string,
): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pre-migration-${ts}.db`);
  // VACUUM INTO = snapshot atomique cohérent (WAL inclus), pas de copie de fichier.
  const escaped = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);

  if (tableExists(db, 'backup_history')) {
    const size = fs.statSync(backupPath).size;
    db.prepare(
      "INSERT INTO backup_history (path, size_bytes, kind) VALUES (?, ?, 'PRE_MIGRATION')",
    ).run(backupPath, size);
  }
  return backupPath;
}

/**
 * Refuse une migration contenant des ordres de contrôle de transaction
 * top-level (BEGIN/COMMIT/ROLLBACK) — ils court-circuiteraient le wrapper
 * transactionnel du runner. Les commentaires et littéraux sont exclus.
 */
function rejectTransactionControl(m: MigrationSource): void {
  const stripped = m.sql
    .replace(/--[^\n]*/g, ' ') // commentaires ligne
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // commentaires bloc
    .replace(/'(?:[^']|'')*'/g, "''"); // littéraux 'texte'
  if (/(^|;)\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(stripped)) {
    throw new Error(
      `Migration '${m.name}' invalide : instruction de contrôle de ` +
        'transaction (BEGIN/COMMIT/ROLLBACK) détectée — interdite, le runner ' +
        'gère la transaction.',
    );
  }
}

/**
 * Applique les migrations en attente, chacune dans sa transaction
 * (`BEGIN IMMEDIATE` / `COMMIT`, `ROLLBACK` en échec — erreur remontée).
 *
 * Si la base existante est non vide et qu'il reste des migrations à
 * appliquer, une sauvegarde `PRE_MIGRATION` est d'abord effectuée
 * (`backupDir` + `dbPath` fichier requis ; ignorée sur `:memory:`).
 */
export function runMigrations(
  db: DatabaseSync,
  opts: RunMigrationsOptions,
): MigrationResult {
  const applied = appliedVersions(db);
  const seen = new Set<number>();
  for (const m of opts.migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Version de migration dupliquée : ${m.version}`);
    }
    seen.add(m.version);
  }
  const pending = [...opts.migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  // Version en attente ≤ max déjà appliquée = migration "insérée" après coup
  // (hors ordre) — refusée pour préserver l'ordre strict des migrations.
  const maxApplied = applied.size > 0 ? Math.max(...applied) : 0;
  const outOfOrder = pending.find((m) => m.version <= maxApplied);
  if (outOfOrder) {
    throw new Error(
      `Migration hors ordre : '${outOfOrder.name}' (version ${outOfOrder.version}) ` +
        `≤ dernière version appliquée ${maxApplied}`,
    );
  }

  const result: MigrationResult = {
    applied: [],
    alreadyApplied: [...applied].sort((a, b) => a - b),
  };
  if (pending.length === 0) return result;

  const isFileBacked =
    !!opts.dbPath && opts.dbPath !== ':memory:' && fs.existsSync(opts.dbPath);
  if (isFileBacked && opts.backupDir && userTableCount(db) > 0) {
    result.backupPath = createPreMigrationBackup(db, opts.backupDir);
  }

  for (const m of pending) {
    try {
      rejectTransactionControl(m);
      db.exec('BEGIN IMMEDIATE;');
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
      ).run(m.version);
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // connexion possiblement hors transaction — l'erreur d'origine prime
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Échec de la migration ${m.name} : ${reason}`);
    }
    result.applied.push(m.name);
  }
  return result;
}
