---
title: "Architecture Spine — MasterTime Tanger"
status: draft
created: 2026-10-22
updated: 2026-10-22
---

# Architecture Spine — MasterTime Tanger

## Paradigme

**Desktop monolithique à deux processus** : un processus principal Electron possède la base SQLite et toute la logique métier ; le renderer React est un client mince qui ne parle que par IPC typé. Le renderer **n'écrit jamais** la base directement.

```
┌─ Renderer (React+TS, client mince) ─┐   ┌─ Main (Node, propriétaire données) ─┐
│  pages / vues / formulaires       │   │  services métier ── engine (pur TS) │
│  état local = cache de lecture    │◄─►│  repositories ── node:sqlite (WAL)  │
│  api.* via contextBridge          │IPC│  audit + conflits dans la même TX   │
└───────────────────────────────────┘   │  import/export, PDF, sauvegardes    │
                                        └─────────────────────────────────────┘
```

## Invariants (AD)

- **AD-1** — Séparation des processus. *Lie :* renderer ↔ main. *Empêche :* accès DB depuis l'UI, contournement des règles. *Règle :* toute donnée passe par `window.api.*` exposé via contextBridge ; handlers IPC typés dans `main/ipc/` ; `nodeIntegration: false`, `contextIsolation: true`.
- **AD-2** — Persistance unique. *Lie :* toute lecture/écriture. *Empêche :* drivers hétérogènes, bases multiples. *Règle :* `node:sqlite` `DatabaseSync`, un fichier unique `userData/mastertime.db`, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, une seule connexion partagée dans le main. Electron **≥ 38** (node:sqlite actif sans flag). Repli documenté : `better-sqlite3` derrière la même interface `Database` (wrapper).
- **AD-3** — Frontière d'écriture unique. *Lie :* toutes les mutations métier. *Empêche :* conflits insérés hors contrôle. *Règle :* toute écriture de Séance (création, déplacement, report, génération appliquée) passe par `SessionService` qui exécute les contrôles BR-7→BR-10 **dans la même transaction** que l'INSERT/UPDATE. Violation de contrainte dure ⇒ `ROLLBACK` + erreur motivée.
- **AD-4** — Moteur de génération pur. *Lie :* `engine/`. *Empêche :* couplage moteur↔I/O, tests impossibles. *Règle :* aucun import Electron/SQLite/fs dans `engine/` ; entrées = objets domaine + paramètres ; sortie = `{ placed[], unscheduled[{reasons}] }` ; appliqué par `ScheduleGenerationService` après confirmation (BR-14).
- **AD-5** — Machine à états des séances. *Lie :* tout changement de statut. *Empêche :* statut incohérent sans trace. *Règle :* transitions uniquement via `changeSessionStatus()` (valide transition, écrit SessionStatusHistory, met à jour statut courant) ; UPDATE direct de `session.status` interdit.
- **AD-6** — Audit transactionnel. *Lie :* services mutants. *Empêche :* action sans trace / trace sans action. *Règle :* AuditLog inséré dans la même transaction que la mutation ; porte profil courant, action, entité, valeurs avant/après (JSON).
- **AD-7** — Modèle du temps. *Lie :* schéma + engine + UI. *Empêche :* comparaisons d'heures bancales, bugs de fuseau. *Règle :* dates = TEXT `YYYY-MM-DD` ; heures = INTEGER minutes depuis minuit ; durées = INTEGER minutes ; chevauchement ⇔ `a.startMin < b.endMin AND a.endMin > b.startMin` (même date). `NON_ENCORE_RÉALISÉE` = dérivé à la lecture (PRÉVUE et date < aujourd'hui) — jamais stocké.
- **AD-8** — Migrations uniquement. *Lie :* évolution du schéma. *Empêche :* dérive schéma/données. *Règle :* fichiers `migrations/NNNN_*.sql` ordonnés, `schema_migrations(version)` appliqué au démarrage avant ouverture des services ; sauvegarde auto pré-migration.
- **AD-9** — Outils de fichier bornés. *Lie :* modules I/H/J. *Empêche :* empilement de libs. *Règle :* Excel ⇔ SheetJS `xlsx` ; PDF ⇔ `pdfmake` ; installateur ⇔ `electron-builder` cible NSIS. Exécution dans le main (renderer reçoit un chemin/blob).
- **AD-10** — i18n dès le départ. *Lie :* toute chaîne UI. *Empêche :* refactor douloureux pour l'arabe. *Règle :* i18next, namespace `fr` seul en v1 ; aucune chaîne littérale dans les composants.
- **AD-11** — Démonstration marquée. *Lie :* seed/tests. *Empêche :* confusion démo/officiel. *Règle :* données seed portent `is_demo=1` ; purge DÉMO = suppression filtrée + confirmation ; jamais de fausse donnée réelle.

## Seed (structure initiale — la code s'approprie ensuite)

```
mastertime-tanger/
├─ electron/main/
│  ├─ index.ts, preload.ts
│  ├─ db/            (connection.ts, migrations/, schema_migrations)
│  ├─ services/      (session, master, professor, absence, generation,
│  │                 import, export-pdf|excel, backup, audit, stats)
│  ├─ engine/        (generate.ts, constraints.ts, score.ts — PUR)
│  └─ ipc/           (handlers typés, whitelist des canaux)
├─ src/              (renderer React)
│  ├─ pages/         (dashboard, masters, professors, modules, rooms,
│  │                 schedule, generator, sessions, absences, reports,
│  │                 import-export, settings, backups-audit)
│  ├─ components/    (tables, filters, calendar, forms, dialogs)
│  ├─ api/           (client window.api typé)
│  └─ i18n/fr.json
├─ shared/           (types + contrats IPC partagés main↔renderer)
├─ tests/            (vitest: engine, conflicts, stats, import, backup)
└─ data-model.md / docs
```

## Différé

- Librairie de composants UI (recommandation : Ant Design — tranchée en Phase 4 avec les maquettes).
- Politique exacte du moteur (greedy + réparation locale vs solver CP) — le module pur permet de changer sans toucher l'architecture ; choix à l'implémentation Phase 8.
- Notifications/exports planifiés : hors v1.
- Format d'archive des sauvegardes (copie fichier vs zip) — rotation 10 assumée.

## Questions ouvertes (bloquantes résolues)

- Q1/Q2/Q3 PRD : actées — bascule `NON_ENCORE_RÉALISÉE` calculée (AD-7), pas d'override de conflit en v1 (AD-3), défauts calendrier paramétrables.
