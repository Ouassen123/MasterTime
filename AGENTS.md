# MasterTime Tanger — Guide agent

Application de gestion des emplois du temps des Masters (Electron + React + SQLite `node:sqlite`).

## Prérequis

- **Node ≥ 22.13.0** — requis pour `node:sqlite` `DatabaseSync` actif sans flag (utilisé par le main et par les tests Vitest). Épinglé dans `package.json` `engines`.

## Commandes

| Commande | Effet |
|---|---|
| `npm install` | Installe les dépendances (Electron ~150 Mo, attendu) |
| `npm run dev` | Lance l'app Electron en mode dev (electron-vite, HMR renderer) |
| `npm test` | Tests Vitest (migrations, seed, FK, rollback) sur bases temporaires |
| `npm run build` | Build production electron-vite → `out/` |
| `npm run typecheck` | Vérification TypeScript stricte (renderer + main/tests) |
| `npm run pack` | Build + packaging non compressé → `release/win-unpacked/` |
| `npm run dist` | Build + installateur NSIS (per-user, sans admin) → `release/` |

## Structure

- `electron/main/` — processus principal (propriétaire de la DB) : `index.ts`, `preload.ts`, `db/` (connexion unique `DatabaseSync` WAL + FK, runner de migrations, seed DÉMO)
- `electron/main/db/migrations/` — fichiers `NNNN_*.sql` ordonnés, appliqués au démarrage
- `src/` — renderer React/TS (client mince, aucun accès DB ; `window.api` via contextBridge)
- `shared/` — types/contrats IPC partagés main ↔ renderer
- `tests/` — Vitest (injecte `DatabaseSync` sur `:memory:`/fichier temp)

## Invariants clés (voir ARCHITECTURE-SPINE.md)

- DB unique `userData/mastertime.db`, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`
- Migrations seules autorisées à faire évoluer le schéma ; sauvegarde `PRE_MIGRATION` sur base existante
- Données de démonstration toutes `is_demo=1`, insérées uniquement si la base est vide
- Temps : dates `TEXT 'YYYY-MM-DD'`, heures/durées `INTEGER` minutes
