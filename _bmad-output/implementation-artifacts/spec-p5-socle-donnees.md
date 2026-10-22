---
title: 'P5 — Socle Electron + base de données et migrations'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '_bmad-output/planning-artifacts/architecture/arch-master-time-tanger-2026-10-22/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/architecture/arch-master-time-tanger-2026-10-22/DATA-MODEL.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le projet n'a aucun code. La Phase 5 doit poser le socle technique de MasterTime Tanger : application Electron exécutable en dev, base SQLite (`node:sqlite`) créée au démarrage, schéma complet appliqué par migrations, et un jeu de démonstration marqué — fondation indispensable aux phases 6+ (CRUD, calendrier, génération).

**Approach:** Scaffold à la racine du workspace : Electron (main + preload) + React/TS/Vite (renderer minimal) + couche `db/` dans le main (connexion unique, runner de migrations, `0001_init.sql` repris de DATA-MODEL.md, seed `is_demo`). Vérification par tests Vitest sur base temporaire.

## Boundaries & Constraints

**Always:**
- `node:sqlite` `DatabaseSync`, une connexion unique dans le main, `PRAGMA journal_mode=WAL`, `foreign_keys=ON` (AD-2)
- Migrations = fichiers `NNNN_*.sql` ordonnés, `schema_migrations(version)`, appliquées au démarrage ; sauvegarde auto `PRE_MIGRATION` avant application sur base existante (AD-8)
- Le renderer n'a aucun accès DB ; `contextIsolation: true`, `nodeIntegration: false` ; `window.api` via contextBridge (AD-1)
- Données seed toutes marquées `is_demo=1`, insérées uniquement si la base est vide (AD-11)
- TypeScript strict ; chemins des fichiers : DB dans `app.getPath('userData')/mastertime.db`
- Versions épinglées : electron `44.9.x`, electron-vite `^5`, vite `^7`, react `^19`, antd `^5`, typescript `~5.9`, vitest `^3`

**Never:**
- Pas d'écran métier (Masters/profs/calendrier) — Phase 6+
- Pas de service métier ni de contrôle de conflits — Phase 6/7 (AD-3 s'appliquera alors)
- Pas de better-sqlite3, pas de packaging installateur (Phase 12)
- Aucune donnée réelle ; seed limité à : 3 salles (Amphi 7, Amphi 8, Salle 1 — données réelles autorisées car données de paramétrage initiales exigées par le brief), 1 année, 2 semestres, créneaux par défaut (Lun–Sam 08h–19h), 3 Masters DÉMO, ~8 professeurs DÉMO, quelques MasterModules/séances DÉMO

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Premier démarrage | Pas de fichier DB | DB créée, 0001 appliquée (23 tables), seed DÉMO inséré | N/A |
| Redémarrage | DB à jour | Aucune migration rejouée, données intactes | N/A |
| Migration échoue | SQL défectueux | Transaction rollback, sauvegarde `PRE_MIGRATION` conservée, erreur explicite remontée | Message erreur, app affiche état bloquant |
| Seed | Base non vide | Aucune insertion, pas de doublon | N/A |
| FK violée | Insert session orpheline | Exception remontée (foreign_keys=ON) | Erreur propagée au test |

</frozen-after-approval>

## Code Map

- `_bmad-output/.../DATA-MODEL.md` — source du DDL de `0001_init.sql` (recopier verbatim, ordre corrigé)
- `_bmad-output/.../ARCHITECTURE-SPINE.md` — arborescence seed à suivre (`electron/main`, `src`, `shared`, `tests`)
- Aucun code existant — tout est à créer à la racine de `{project-root}`

## Tasks & Acceptance

**Execution:**
- [x] `package.json` — scripts `dev` (electron-vite dev), `build`, `test` (vitest), deps épinglées ci-dessus
- [x] `electron.vite.config.ts` + `tsconfig.json` + `tsconfig.node.json` — build main/preload/renderer
- [x] `electron/main/db/connection.ts` — `getDb()` singleton : ouvre/crée `userData/mastertime.db` (fallback `:memory:` en test), WAL, FK, wrapper fin typé
- [x] `electron/main/db/migrations/0001_init.sql` — DDL verbatim de DATA-MODEL.md
- [x] `electron/main/db/migrate.ts` — runner : liste fichiers, lit `schema_migrations`, transaction par migration, backup `PRE_MIGRATION` si base existante non vide
- [x] `electron/main/db/seed-demo.ts` — insère le jeu DÉMO décrit dans Never si `master` vide ; idempotent
- [x] `electron/main/index.ts` — BrowserWindow, `app.getPath('userData')`, appelle migrate+seed au démarrage, garde l'erreur DB bloquante visible
- [x] `electron/main/preload.ts` — `contextBridge` expose `api.appInfo()` (versions, chemin DB) + `api.dbStatus()`
- [x] `shared/types.ts` — enums statuts (`PREVUE|REALISEE|ANNULEE|REPORTEE`, `NON_ENCORE_REALISEE` dérivé), types IPC `AppInfo`
- [x] `src/` — renderer minimal : `main.tsx`, `App.tsx` affichant statut DB (nb tables, chemin, nb de lignes seed) via `window.api`, `ConfigProvider` antd `fr_FR`, i18next stub `src/i18n/fr.json`, `index.html`
- [x] `tests/db.test.ts` — Vitest : migration sur DB temp → 23 tables + index ; seed → compteurs > 0, `is_demo=1` partout ; FK ON ; idempotence migrate+seed ; transaction rollback sur migration défectueuse
- [x] `AGENTS.md` — commandes dev/test/build du projet
- [x] `.gitignore` + `git init` — node_modules, dist, out, *.db (le brief exige Git dès le départ pour l'historique)

**Acceptance Criteria:**
- Étant donné un checkout frais, quand `npm install` puis `npm run dev`, alors Electron démarre et affiche le statut DB réel (23 tables, chemin userData)
- Étant donné la DB créée, quand l'app redémarre, alors `schema_migrations` contient `0001`, aucune re-application, données seed intactes
- Étant donné `npm test`, alors les tests migrations/seed/FK/idempotence/rollback passent
- Étant donné la DB seedée, quand on interroge `SELECT is_demo FROM master`, alors toutes les lignes = 1

## Implementation Notes

- **Correction post-subagent** : le seed initial créait des chevauchements (i=0/i=6, i=1/i=7 → même salle+date+créneau). Décalage d'une semaine ajouté + test anti-chevauchement permanent.
- **npm install** : le postinstall d'Electron n'a pas téléchargé le binaire — corrigé par `node node_modules/electron/install.js`.
- **Env quirk** : `ELECTRON_RUN_AS_NODE=1` dans le shell casse le lancement Electron ; unset requis.
- schema_migrations créé dans 0001 (DDL verbatim) ; runner détecte via sqlite_master.
- Backup ignoré sur `:memory:` (pas de fichier à copier) — choix assumé.
- npm audit : 3 vulnérabilités transitives non corrigées (audit fix --force = breaking).

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence / Route |
|---|---|---|
| status.ts masque startupError quand db non-null | high | Vérifié ligne 39-41 : ok:true/error:null quel que soit startupError; db assignée avant runMigrations. -> patch |
| CSP script-src self bloque react-refresh dev | high | index.html:8 ; preamble inline injecté par plugin-react en dev. -> patch unsafe-inline |
| seedDemo guard master-vide -> UNIQUE crash après purge DÉMO | medium | seed-demo.ts:35 ; room/module UNIQUE. -> patch flag setting.seed_done |
| bundledMigrations sans filtre NNNN_ (NaN version) | medium | migrate.ts:58-70 ; loadMigrationsFromDir filtre, pas le glob. -> patch |
| BEGIN IMMEDIATE hors try (migrate + seed) | low | erreur brute sans contexte. -> patch |
| Migration SQL contenant BEGIN/COMMIT -> rollback inefficace | medium | guard simple à ajouter. -> patch |
| wal_checkpoint non vérifié -> backup obsolète | medium | pragma retourne busy sans throw. -> patch (VACUUM INTO) |
| schedule_generation sans REFERENCES year/semester | medium | DDL inconsist. -> patch 0001 + DATA-MODEL |
| UNIQUE avec NULL inefficace (master_module, student) | medium | SQLite NULL distinct -> doublons groupe NULL. -> patch index COALESCE |
| CHECKs manquants (weekday, start<=end, format date) | low | durcissement cheap. -> patch 0001 |
| getDb ignore dbPath après init ; pas de busy_timeout | medium | connection.ts:44-53. -> patch throw + pragma |
| App.tsx IPC sans .catch -> spinner infini | medium | -> patch état erreur |
| Test gaps: collectDbStatus, resolveDbPath/getDb, effectiveSessionStatus | medium | verification-gap confirmé. -> patch tests |
| Seed: prof session != prof master_module (i=6,7) ; sched window hardcodée vs dates relatives | low | -> patch seed |
| engines Node >=22.13 absent ; AGENTS.md ne le mentionne pas | low | -> patch |
| setting defaults jamais insérés | low | -> patch dans seed |
| Collision backup même milliseconde | false(low rejeté) | inatteignable : une seule passe de migration par run, timestamp ms |
| runMigrations throw sur version dupliquée avant filtre applied | false | comportement défensif voulu |
| Date non paddée -> comparaison lexicale fausse | false | aucun writer ne produit de date non paddée ; CHECK ajouté en durcissement |
| Vendored .agents dans le commit, pas de ESLint/README/verrou mono-instance | defer | outillage/hygiène, hors intention P5 |
| Versions non contiguës (v2 après v3) | low->patch inclus | rejet pending <= max(applied) dans le même lot runner |


## Design Notes

- `migrate.ts` : `BEGIN IMMEDIATE` par migration ; en échec → `ROLLBACK` + copie du fichier DB dans `userData/backups/pre-migration-{ts}.db` + entrée `backup_history` (si table existe).
- Le runner accepte `DatabaseSync` injecté → tests sur `:memory:`/fichier temp sans Electron (`userData` résolu par fonction `resolveDbPath()` injectable).

## Verification

**Commands:**
- `npm install` -- expected: succès sans erreur de postinstall
- `npm test` (vitest) -- expected: tous les tests verts
- `npm run dev` -- expected: fenêtre Electron affiche « 23 tables » + chemin DB
- `npm run build` -- expected: build electron-vite sans erreur
