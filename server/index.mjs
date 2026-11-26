/**
 * Entrée autonome du portail web — déploiement serveur faculté.
 *
 *   DB_PATH=/chemin/mastertime.db PORT=8080 node server/index.mjs
 *
 * Défauts : DB dans `mastertime.db` à côté du projet, PORT 8080.
 * Applique les migrations manquantes avant d'ouvrir la base (même
 * répertoire `electron/main/db/migrations` que l'app desktop).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHandler } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH ?? path.join(root, 'mastertime.db');
const port = Number(process.env.PORT ?? 8080);

// Migrations partagées avec l'app desktop (idempotentes).
const migDir = path.join(root, 'electron', 'main', 'db', 'migrations');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA foreign_keys=ON');
db.exec(
  `CREATE TABLE IF NOT EXISTS schema_migrations
   (version INTEGER PRIMARY KEY, applied_at TEXT)`,
);
const applied = new Set(
  db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
);
for (const f of fs.readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
  const v = Number(f.slice(0, 4));
  if (applied.has(v)) continue;
  console.log(`[web] migration ${f}`);
  db.exec('BEGIN');
  try {
    db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime(\'now\'))').run(v);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
db.close();

const handler = createHandler({ dbPath });
http.createServer(handler).listen(port, () => {
  console.log(`[web] Portail MasterTime → http://localhost:${port}`);
});
