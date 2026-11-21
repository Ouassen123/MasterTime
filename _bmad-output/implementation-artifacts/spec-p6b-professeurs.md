---
title: "P6b — Professeurs : CRUD, disponibilités, absences, suivi individuel"
status: in-review
date: 2026-11-21
phase: "6b"
---

# P6b — Professeurs

## Objectif
Page Professeurs fonctionnelle de bout en bout, réutilisant les patterns P6a
(`CrudTable`, `EntityDrawer`, services + `withAudit`, IPC typé). Données réelles
déjà en base (149 profs, 1164 séances S3 2026/2027).

## Exigences (PRD Module C : FR-9→FR-15, BR-17)

### 1. Service `electron/main/db/professor.service.ts`
- `list(search?)` : id, full_name, internal_ref, email, phone, is_active,
  compteurs calculés par professeur :
  - `nb_realisees` : sessions `REALISEE`
  - `nb_restantes` : `PREVUE` avec date >= aujourd'hui
  - `nb_non_realisees` : `PREVUE` avec date < aujourd'hui (statut dérivé AD-7)
  - `nb_annulees`, `nb_reportees`
  - `heures_enseignees_min` : Σ(actual_end-actual_start) des REALISEE
    (fallback end-start si actual_* NULL)
  - `nb_absences` : lignes professor_absence
- `getDetail(id)` : fiche + masters/modules enseignés (via master_module +
  session distincts), disponibilités, absences, 20 prochaines séances
- `create/update` : validation — full_name requis unique NOCASE, email format
  simple si renseigné ; erreurs `{field, message}[]` en français
- `remove` : refusé si lié à master_module/session/absence (BR-22) — proposer
  désactivation (`is_active=0`) ; suppression réelle sinon
- `setActive(id, active)`
- Audit transactionnel `withAudit` sur toute mutation (AD-6)

### 1bis. Migration `0004_professor_active.sql`
`ALTER TABLE professor ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`
(la table `professor` n'a pas de colonne active — requis pour le pattern
désactivation BR-22).

### 2. Disponibilités (`professor_availability`)
DDL réel : weekday CHECK 0-6, start_min/end_min, `kind IN ('DISPO','INDISPO')`,
effective_from/to. CRUD par professeur (add/remove/list), validation :
weekday 0-6, start<end, chevauchements **même kind** refusés, effective_from <=
effective_to si les deux.
Persister via `professors:availability:add/remove`.

### 3. Absences (`professor_absence`)
DDL réel : start_date, end_date, reason, `resolution IN
('A_TRAITER','PARTIELLE','RESOLUE')` (défaut A_TRAITER).
CRUD : dates ISO, start<=end (CHECK existe — valider côté service quand même).
À la création : calculer et retourner les **séances impactées** (sessions
PREVUE du prof dans la fenêtre + chevauchement weekday/heure si granularité
horaire existe — sinon par plage de dates).
**BR-17 : ne jamais annuler automatiquement** — la résolution arrive Phase 9.
Persister via `professors:absence:add/remove/list`.

### 4. IPC (`electron/main/ipc/` + `shared/types.ts`)
Handlers `professors:list|get|create|update|remove|setActive|availability:*|
absence:*` via `guard` existant. Admin-only : create/update/remove/setActive
(la seam `requireRole: 'ADMIN'` existe — l'utiliser). Types partagés
`ProfessorRow`, `ProfessorDetail`, `ProfessorCounters`, `AvailabilityRow`,
`AbsenceRow`, `ImpactedSession`.

### 5. UI `src/pages/ProfessorsPage.tsx`
- `CrudTable` : Nom, Masters enseignés (chips, ≤2 + « +n »), Séances
  réalisées/restantes/annulées, Heures enseignées (format `h:mm`), Actif
- Recherche (nom/réf/email), filtre actif, pagination (existant)
- `EntityDrawer` : full_name*, internal_ref, email, phone, is_active —
  `dir="auto"` sur le champ nom (données arabes)
- Clic ligne → **drawer "Fiche de suivi"** : onglets `Séances` (prochaines,
  statut coloré) / `Disponibilités` (liste + ajout weekday plage + suppression)
  / `Absences` (liste + ajout dates + motif + séances impactées affichées) /
  `Compteurs` (KpiCards)
- Suppression : refus si liée → propose désactivation (pattern Rooms)

### 6. Activation nav
Sidebar : entrée « Professeurs » activée (icône TeamOutlined/UserOutlined),
route `/professeurs`, ordre du brief conservé.

## Hors périmètre
Résolution d'absence (remplacement/report/annulation → Phase 9), vue
calendaire professeur (Phase 7), import/export (Phase 10).

## Tests (`tests/professeurs.test.ts`)
- CRUD : create ok/doublon NOCASE/update/remove liée refusée/remove libre ok/
  setActive
- Compteurs : fixture sessions REALISEE/PREVUE passée+future/ANNULEE/REPORTEE
  → valeurs exactes ; annulée JAMAIS comptée réalisée ; heures = actual
- Disponibilités : add ok, chevauchement refusé, weekday invalide refusé
- Absences : add ok, dates invalides refusées, séances impactées listées,
  AUCUNE session annulée automatiquement (assert status reste PREVUE)
- IPC guards : payload invalides rejetés, requireRole admin

## Critères d'acceptation
`npm test` vert, `npm run typecheck` clean, `npm run build` OK, page visible
et fonctionnelle sous `npm run dev`.
