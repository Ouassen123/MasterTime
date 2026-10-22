---
title: 'P6a — Socle applicatif + référentiels Salles & Modules (CRUD)'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '89e11e79072241480fd58fa2ed52014b65bb3414'
context:
  - '_bmad-output/planning-artifacts/architecture/arch-master-time-tanger-2026-10-22/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/ux/ux-master-time-tanger-2026-10-22/EXPERIENCE.md'
  - '_bmad-output/planning-artifacts/ux/ux-master-time-tanger-2026-10-22/DESIGN.md'
  - '_bmad-output/planning-artifacts/prds/prd-master-time-tanger-2026-10-22/prd.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** L'app a une DB et un shell minimal, mais aucune gestion métier. Il faut le socle applicatif complet (navigation 13 entrées, profil Admin/Gestionnaire, audit transactionnel) et les deux premiers référentiels CRUD (Salles, Modules) qui valident le pattern Table+Drawer de bout en bout — avant les entités plus complexes (Professeurs, Masters).

**Approach:** Main : `audit.service.ts` (AD-6, écrit dans la TX de la mutation via callback), `profile.service.ts` (profil courant persisté dans `setting`, seed de 2 profils par défaut), `crud` services `room.service.ts`/`module.service.ts` (validation, suppression protégée BR-22, `is_active` pour désactivation). IPC typé : `rooms:*`, `modules:*`, `profile:*`. Renderer : react-router, AppShell (sidebar 13 entrées, entrées non implémentées désactivées, topbar profil+contexte année/semestre, bandeau DÉMO), pages `RoomsPage`/`ModulesPage` génériques via un composant `CrudTable` + drawer `Form`.

## Boundaries & Constraints

**Always:**
- Toute écriture passe par le service main ; `audit_log` inséré dans la même transaction (AD-6) avec `old_values`/`new_values` JSON, `user_id` = profil courant
- Suppression refusée si des données liées existent (BR-22) → message « N séances/modules liés » ; pour `room`, proposer la désactivation (`is_active=0`)
- Validation serveur : `room.name` requis unique, `capacity` > 0 si renseignée ; `module.code`/`name` requis uniques ; erreurs = `{ field, message }` renvoyées au formulaire
- UI : antd Table (recherche, pagination, filtres), Drawer 480px formulaire, `Modal.confirm` destructif avec conséquence chiffrée, bandeau ambre si `is_demo` présent, toutes chaînes via i18next `fr.json`, sélecteur de profil en topbar (Admin/Gestionnaire applique BR-24 : Paramètres/Sauvegardes masqués en Gestionnaire)
- Profils seedés : « Administrateur » (ADMIN) + « Gestionnaire » (GESTIONNAIRE) dans `app_user` si table vide ; profil courant dans `setting.current_profile_id`
- TypeScript strict ; zéro accès DB depuis le renderer (AD-1)

**Never:**
- Pas de Professeurs/Masters/Emplois du temps/Génération — pages désactivées dans la sidebar (P6b/P6c+)
- Pas de contrôle de conflits de séances, pas de statistiques
- Pas de mot de passe, pas de nouvelle migration si inutile (schéma 0001 suffit ; ajouter `0002` UNIQUEMENT si nécessaire)

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Créer une salle | nom « Salle 2 », capacité 30 | INSERT + audit CREATE ; ligne en table | N/A |
| Doublon | nom « Amphi 7 » existant | refus, erreur champ name | Erreur formulaire, pas d'écriture |
| Modifier capacité | 240 → 200 | UPDATE + audit UPDATE old/new | N/A |
| Supprimer salle liée | salle avec séances | refus « utilisée par N séances », suggère désactiver | Modal erreur |
| Désactiver salle | is_active=0 | salle grisée/inactive, séances intactes + audit | N/A |
| Changer profil | Admin → Gestionnaire | topbar MAJ, entrées admin masquées, audit non requis | N/A |
| Champ vide requis | name vide | erreur champ sans INSERT | Erreur formulaire |

</frozen-after-approval>

## Code Map

- `electron/main/index.ts` — y brancher les nouveaux handlers IPC (`ipc/`)
- `electron/main/db/connection.ts` (`all/get/run`), `db/audit.service.ts` (nouveau), `db/profile.service.ts` (nouveau)
- `electron/main/ipc/` — handlers typés par domaine (nouveau dossier per spine)
- `electron/main/preload.ts` — exposer `api.rooms`, `api.modules`, `api.profile`, `api.audit` (liste lecture)
- `shared/types.ts` — ajouter DTOs `Room`, `Module`, `AppUser`, `ProfileRole`, `FieldError`, `ApiResult<T>`
- `src/` — `main.tsx` (router), `App.tsx` (AppShell), `components/CrudTable.tsx`, `components/EntityDrawer.tsx`, `pages/RoomsPage.tsx`, `pages/ModulesPage.tsx`, `pages/PlaceholderPage.tsx`, `api/client.ts` (typé), `i18n/fr.json` (toutes chaînes)
- `tests/` — `tests/referentiels.test.ts` : services sur DB temporaire (CRUD + audit + protections)

## Tasks & Acceptance

**Execution:**
- [x] `shared/types.ts` — DTOs + `ApiResult<T> = {ok:true,data}|{ok:false,error,fields?}` + `WindowApi` étendu
- [x] `electron/main/db/audit.service.ts` — `withAudit(db, userId, action, entity, entityId, fn)` : wrap transaction, capture old/new JSON, insère audit_log
- [x] `electron/main/db/profile.service.ts` — seed 2 profils si vide ; `getCurrentProfile()`, `setCurrentProfile(id)`, `listProfiles()`
- [x] `electron/main/db/room.service.ts` — list/create/update/delete/setActive ; validations ; protection suppression (séances liées) ; audit via `withAudit`
- [x] `electron/main/db/module.service.ts` — idem pour module (liés via master_module)
- [x] `electron/main/ipc/index.ts` + handlers domaine — canaux `rooms:list|create|update|remove|setActive`, `modules:*`, `profile:list|current|set`
- [x] `electron/main/preload.ts` — `window.api` étendu typé
- [x] `src/api/client.ts` + `src/api.d.ts` — client typé `window.api`
- [x] `src/App.tsx` + `src/components/AppShell.tsx` — Layout antd : sidebar 13 entrées (actives : Dashboard placeholder, Salles, Modules ; autres désactivées), topbar profil+année courante, `Alert` ambre si `is_demo` (via dbStatus counts)
- [x] `src/components/CrudTable.tsx` — Table antd : recherche, pagination 15, tri, colonnes paramétrées, boutons éditer/désactiver/supprimer
- [x] `src/components/EntityDrawer.tsx` — Drawer+Form antd avec mapping erreurs serveur → champs
- [x] `src/pages/RoomsPage.tsx`, `src/pages/ModulesPage.tsx`, `src/pages/PlaceholderPage.tsx`
- [x] `src/main.tsx` — react-router routes + ConfigProvider fr
- [x] `src/i18n/fr.json` — toutes les chaînes UI nouvelles
- [x] `tests/referentiels.test.ts` — Vitest : CRUD salle+module, doublon refusé, suppression liée refusée, audit écrit avec old/new, profils seedés, `setCurrentProfile`

**Acceptance Criteria:**
- Étant donné l'app lancée, quand je crée « Salle 2 » capacité 30, alors elle apparaît dans la table et `audit_log` contient CREATE avec new_values JSON
- Étant donné « Amphi 7 » liée à des séances DÉMO, quand je clique Supprimer, alors refus avec compte de séances et proposition de désactivation
- Étant donné profil Gestionnaire actif, alors les entrées Paramètres et Sauvegardes sont masquées ; en Admin elles apparaissent
- Étant donné un doublon de nom, quand je valide le formulaire, alors l'erreur s'affiche sur le champ sans écriture en base
- `npm test` et `npm run typecheck` verts ; `npm run dev` navigable

## Implementation Notes

- Revue 3 couches : ~22 findings patchés (voir Review Triage Log). Points notables : db=null après échec init, COLLATE NOCASE doublons, reset drawer corrigé, migration 0002 index perf, flag seam requireRole (BR-24) ajouté au guard IPC.
- Migration 0002 appliquera automatiquement au prochain démarrage (PRE_MIGRATION backup).
- api.audit.list exposé sans consommateur (page audit = phase Sauvegardes/Historique).

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Route |
|---|---|---|
| db non-null après init échouée -> mutations sur schéma cassé | high | patch: null db + guard startupError |
| EntityDrawer reset saisie au re-render parent | high | patch: dep primitive/memo initialValues |
| Doublons insensibles casse (room.name, module.code/name) | high | patch: COLLATE NOCASE validation |
| Régression affichage erreur dashboard (catch discard) | medium | patch: état erreur visible |
| Profils inactifs listés/getCurrentProfile ignore is_active | medium | patch: filtre + fallback |
| Seed app_user non atomique ; aucun ADMIN garanti | medium | patch: transaction + ensure ADMIN actif |
| rooms:setActive arg non booléen -> désactivation silencieuse | medium | patch: validation type |
| counts.demo sans student.is_demo | medium | patch: ajouter student |
| Bandeau DÉMO promet purge inexistante | medium | patch: reformuler i18n |
| Double modale suppression liée (count>0 connu client) | medium | patch: court-circuit vers refus/désactivation |
| Aucune seam de rôle dans guard IPC (BR-24) | medium | patch: option requireRole + commentaire |
| Audit UPDATE no-op (old==new) | low | patch: skip insert si identique |
| guard fuit err.message brut en UI | medium | patch: message générique + log serveur |
| withAudit: fn void sans rowid pour CREATE ; tx imbriquée | medium | patch: assert id + assert !isTransaction |
| listAuditLog sans plafond | low | patch: clamp 1000 |
| Pagination CrudTable non reset après recherche | medium | patch: reset page on search |
| switchProfile sans try/catch | low | patch |
| Index manquants pour counts corrélés | medium | patch: migration 0002 (ix_session_room, ix_mm_module) |
| @ant-design/icons v6 vs antd5 bundle | low | patch: pin ^5 |
| form.setFields as never masque erreurs champ inconnu | low | patch: fallback globalError |
| Tests manquants (appContext, counts.demo, auditLog, guard, currentUserId, not-found) | medium | patch tests |
| api.audit.list sans consommateur | defer | par design, consommé plus tard |
| Bandeau DÉMO stale après suppression demo | defer | mineur, refetch au prochain rendu |


## Design Notes

- `withAudit(db, userId, action, entity, entityId, fn)`: `BEGIN IMMEDIATE` → `old = SELECT` → `fn()` → `new = SELECT` → `INSERT audit_log` → COMMIT ; rollback propage l'erreur.
- Sidebar : ordre exact du brief (Dashboard, Masters, Professeurs, Modules, Salles, Emplois du temps, Génération, Séances, Absences, Rapports, Import/Export, Paramètres, Sauvegardes). Non implémenté = item désactivé avec tooltip « Phase ultérieure ».
- Les compteurs `dbStatus.counts` existants servent à détecter la présence de données DÉMO pour le bandeau.

## Verification

**Commands:**
- `npm test` -- expected: tous verts (db.test.ts + referentiels.test.ts)
- `npm run typecheck` -- expected: clean
- `npm run dev` -- expected: sidebar/navigable, CRUD salles fonctionnel en clics, bandeau DÉMO visible
