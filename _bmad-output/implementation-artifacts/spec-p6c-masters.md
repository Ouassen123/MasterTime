# Spec P6c — Masters, modules rattachés et groupes

**Story** : en tant qu'administrateur, je gère les Masters (formation), leurs
modules rattachés (`master_module` = le « quoi enseigner ») et leurs groupes
d'étudiants, afin que la génération et le calendrier disposent du référentiel
complet. Statut : approuvé → in-progress.

## Périmètre

### 1. Migration `0005_session_group.sql`
```sql
CREATE TABLE session_group (
  session_id INTEGER NOT NULL REFERENCES session(id),
  student_group_id INTEGER NOT NULL REFERENCES student_group(id),
  PRIMARY KEY (session_id, student_group_id));
CREATE INDEX ix_sg_group ON session_group(student_group_id);
```
Séances partagées multi-groupes (constat analyse Licence : une même séance
réunissant plusieurs groupes/filières ne doit pas compter comme N occupations
de salle). Table exposée en types ; remplie par génération/édition (Phase 7+).
Mettre à jour `DATA-MODEL.md` et les attentes `db.test.ts` (tables 25, index 16).

### 2. Service `electron/main/db/master.service.ts`

- `listMasters(db, opts)` : lignes = master + `nb_modules` (master_module
  distinct), `nb_groupes`, `nb_seances` (sessions via master_module, toutes
  statuts sauf ANNULEE), `volume_prevu_min` (Σ volume_min), `status`.
  Filtres : `search` (name/code/filiere LIKE échappé), `status` (ACTIF/ARCHIVE/
  tous). Tri name.
- `getMasterDetail(db, id)` : fiche = master + groupes (id/name/size) +
  master_modules joints (module code/name, professor full_name, semester
  label, student_group name, volume_min, session_duration_min,
  planned_sessions, sched_start/end, nb séances planifiées réelles) +
  compteurs séances (mêmes règles AD-7 que professeurs : restantes /
  non_réalisées / réalisées / annulées, heures enseignées) + `linkedCount`.
- `createMaster / updateMaster` : champs code (oblig., unique NOCASE
  service-level), name (oblig.), filiere, department, responsible_name,
  academic_year_id (oblig., existe), semester_id (optionnel, existe),
  status dans ('ACTIF','ARCHIVE'). Erreurs `{field,message}[]` FR.
- `setMasterStatus(db, uid, id, status)` : ACTIF ↔ ARCHIVE, audit UPDATE.
- `deleteMaster` : refus BR-22 si `linkedCount > 0` (student_group +
  master_module + sessions + students via groupes) → `{ok:false, linkedCount,
  suggest:'ARCHIVE'}` ; suppression réelle sinon. withAudit DELETE.
- **Groupes** : `addGroup(db, uid, masterId, {name, size?})` (unique
  master+name NOCASE, size entier >0 ou null), `renameGroup`,
  `removeGroup` (refus si lié : master_module.student_group_id, students,
  session_group → même pattern BR-22 + suggest).
- **MasterModule** : `attachModule(db, uid, masterId, input)` et
  `updateMasterModule / detachModule`. Champs : module_id, semester_id,
  professor_id, student_group_id? (doit appartenir au master si fourni),
  volume_min >0, session_duration_min >0 (≤ 480), planned_sessions >0,
  sched_start/end dates ISO valides `start < end`, distribution_rule JSON
  libre (null). Unicité (master,module,semester,group COALESCE) via
  ux_master_module — SQLITE_CONSTRAINT → erreur de champ `module_id`
  « déjà rattaché ». detach : refus si des sessions référencent le
  master_module (BR-22) → suggest archive? (master_module n'a pas de
  statut → message explicite « supprimez d'abord les N séances liées »).

Toutes les mutations : `withAudit`, `requireRole:'ADMIN'` côté IPC, erreurs
de validation typées, IDs validés, dates via `isValidIsoDate` (réutiliser
l'implémentation P6b — l'extraire dans `db/date.ts` partagé), todayIso local.

### 3. IPC + preload + types
- `electron/main/ipc/masters.ts` : canaux `masters:list|get|create|update|
  setStatus|remove|addGroup|renameGroup|removeGroup|attachModule|
  updateModule|detachModule` ; guards isObject/isId ; requireRole ADMIN sur
  toutes mutations ; enregistré dans `ipc/index.ts`.
- `preload.ts` : `api.masters.*` typé. `shared/types.ts` : `MasterRow`,
  `MasterDetail`, `MasterInput`, `MasterModuleRow`, `MasterModuleInput`,
  `GroupInput`, résultats `{ok, fields?, error?, linkedCount?, suggest?}`.
- Refs nécessaires côté renderer : `api.masters` + existants
  `modules.list`, `professors.list`, `context` (années/semestres — vérifier
  ce que `api.context` expose déjà ; sinon ajouter `context:semesters`).

### 4. UI `src/pages/MastersPage.tsx` (pattern P6b)
- Table : code, name (dir=auto), filiere, nb_modules, nb_groupes,
  nb_seances, volume prévu (fmtHM), statut (Tag), actions (modifier,
  archiver/activer, supprimer) — deleteConfirm double modale BR-22 avec
  suggest « Archiver ».
- Drawer création/édition (EntityDrawer + Form).
- Drawer « fiche » (clic ligne) 760px, `key={master.id}`, Tabs :
  **Infos**, **Modules** (liste des master_modules + bouton rattacher :
  Select module/prof/semestre/groupe, volumes, période — actions éditer/
  détacher), **Groupes** (liste + ajout/renommer/supprimer), **Séances**
  (20 prochaines, StatusTag, mini-table comme onglet prof).
- Filtres : recherche, statut. `dir="auto"` noms arabes partout.
- Route `/masters`, nav 'masters' enabled:true (AppShell), icône
  `BankOutlined` ou `BookOutlined`.
- i18n : clés `masters.*`, `groups.*`, `masterModules.*` FR.

### 5. Tests `tests/masters.test.ts`
Fixture : freshDb + seedFixture minimale (année, semestre, profs, modules,
master, groupe, master_module, sessions). Couvrir :
- list : compteurs corrects (nb_modules/groupes/seances, Σ volume), filtre
  recherche/statut, ordre.
- CRUD : champs obligatoires, unicité code NOCASE, refs inexistantes rejetées,
  update no-op sans ligne audit, setStatus audit UPDATE.
- delete : lié → refus + suggest ARCHIVE + linkedCount exact ; non lié →
  suppression + audit DELETE.
- groupes : doublon NOCASE refusé, rename, remove lié refusé (via
  master_module.student_group_id puis via session_group), size invalide.
- master_module : attach OK + audit ; doublon (même module même semestre
  même groupe) → erreur champ ; groupe d'un autre master refusé ;
  sched_start >= sched_end refusé ; volume/duration/planned ≤ 0 refusés ;
  detach lié à des sessions refusé ; update partiel.
- getMasterDetail : jointures, compteurs AD-7 (y.c. borne date==today),
  master inexistant → erreur.
- requireRole sur les 4+ mutations.

## Hors périmètre
Remplissage de `session_group` (Phase 7 édition séances), import registre
étudiants (Phase 10), génération (Phase 8), vues calendrier (Phase 7).

## Vérification
`npx vitest run` tout vert · `npm run typecheck` clean · `npm run build` OK ·
migration 0005 vérifiée sur copie de la base réelle.
