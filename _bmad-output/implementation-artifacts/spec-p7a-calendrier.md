# Spec P7a — Emplois du temps : vues calendrier + détection de conflits

**Story** : en tant que gestionnaire ou admin, je consulte l'emploi du temps
par semaine (tous Masters, par Master, par professeur, par salle), par mois
et à l'année, avec les statuts colorés, et je vois la liste persistante des
conflits réels détectés dans les données (FR-15→22, BR-11).
Statut : approuvé → in-progress.

## Périmètre — lecture seule (aucune écriture séance)

### 1. Service `electron/main/db/session.service.ts` (requêtes)

- `listSessionsWeek(db, {weekStart, masterId?, professorId?, roomId?,
  moduleId?, statuses?})` → `SessionRow[]` enrichi : id, date, start_min,
  end_min, status, comment, master{id,code,name}, module{id,code,name},
  professor{id,full_name}, room{id,name,capacity}, group_name (via
  mm.student_group_id + session_group agrégé GROUP_CONCAT si présent),
  `effective_status` (AD-7 : PREVUE+date<today → NON_ENCORE_REALISEE).
  `weekStart` = lundi ISO valide → plage [weekStart, weekStart+6].
  Tri (date, start_min). LIKE non utilisé (filtres par ids + status IN).
- `listSessionsMonth(db, {year, month, filtres idem})` → même shape sur
  [monthStart, monthEnd] (les séances réelles, pas juste des compteurs —
  le renderer agrège par jour).
- `listAnnual(db, {academicYearId})` → lignes `{masterId, masterCode,
  masterName, weekStart, count, parStatut:{prevue,realisee,annulee,
  reportee}}` groupées par master × semaine ISO (semaine = date du lundi).
- `getSessionDetail(db, id)` → row complet + historique statuts
  (session_status_history trié desc) — pour le popover/drawer séance.
- `external_occupancy` : `listOccupancyWeek(db, {weekStart, roomId?})` →
  blocages Licence affichés en gris dans la vue salle (distincts des
  séances). Shape : id, label/programme, weekday, start_min, end_min,
  room_name. NOTE : occupation hebdomadaire récurrente (weekday), pas
  datée — afficher sur chaque jour correspondant de la semaine.

### 2. Service `electron/main/db/conflict.service.ts` (détection BR-11)

`detectConflicts(db, {dateFrom?, dateTo?} = {})` → `ConflictItem[]` :
`{kind, date, startMin, endMin, entityLabel, sessions:[{id, label,
  masterName, moduleName}], detail}` avec kinds :
- `ROOM` : ≥2 séances non-ANNULEE même salle, même date, chevauchement
  strict (`a.start < b.end AND b.start < a.end`).
- `PROFESSOR` : idem sur professor_id.
- `MASTER` : idem sur le master du mm (via mm.master_id).
- `GROUP` : via session_group — deux séances différentes partageant un
  groupe sur chevauchement. (Table vide aujourd'hui : implémenter la
  requête, testée par fixture.)
- `EXTERNAL` : séance non-ANNULEE chevauchant une external_occupancy sur
  la même salle (weekday occupancy ↔ date.weekday) — entityLabel =
  « Licence — <programme> ».
Comparaison par paires en SQL (self-join sur date + overlap) ; exclure
les paires miroir (a.id < b.id). Tri (date, kind).
Les séances ANNULEE ne produisent jamais de conflit.
`conflictSummary(db)` → `{total, byKind}` pour le tableau de bord.

### 3. IPC + preload + types
`electron/main/ipc/timetable.ts` : canaux `timetable:week`, `:month`,
`:annual`, `:conflicts`, `sessions:get`, `timetable:occupancy`.
Lecture → pas de requireRole (tous profils). `preload.ts` `api.timetable.*`
+ `api.sessions.get`. `shared/types.ts` : `SessionRow`, `SessionDetail`,
`OccupancyRow`, `ConflictItem`, `ConflictKind`, `AnnualRow`,
`SessionFilter`, `ApiResult<T>` déjà existant.

### 4. UI `src/pages/TimetablePage.tsx`

- **Tabs de portée** : Semaine · Master · Professeur · Salle · Mois ·
  Année (icônes). Select d'entité sur Master/Prof/Salle (options =
  listes existantes via api.masters.list / professors.list / rooms.list).
- **Vue semaine** : grille temps — colonnes Lun→Dim (header date +
  weekday i18n), axe vertical 07:00→20:00, `SessionBlock` positionné
  absolument (top = (start-420)*h/60, height = durée*h/60).
  `SessionBlock` : heure début–fin, intitulé module (dir=auto), salle,
  prof — couleur = palette statuts DESIGN.md (PREVUE bleu / REALISEE
  vert / NON_ENCORE_REALISEE orange / ANNULEE gris barré / REPORTEE
  violet). Bloc EXTERNAL gris foncé « Licence » dans la vue Salle.
  Clic bloc → Drawer détail séance (tous champs FR-21 + historique
  statuts + groupes session_group).
- **Navigateur semaine** : ‹ › Aujourd'hui + label « Semaine du … ».
- **Vue mois** : `Calendar` antd mode month, `cellRender` = badges
  comptage par statut (dot coloré + n) ; clic jour → bascule semaine.
- **Vue année** : tableau lignes = masters, colonnes = semaines ISO
  (du sched min à sched max), cellule = nb séances (tooltip détail
  statuts) ; clic cellule → semaine correspondante.
- **Panneau conflits** : volet droit collapsible (pas un toast — UX),
  groupé par kind avec icône, chaque item : date, créneau, entité,
  séances ; clic → naviguer semaine + surligner les blocs (className
  conflict). Badge compteur dans le titre du volet.
- Filtres : statuts multi-select + (sur Semaine) module.
- États : skeleton, vide « Aucune séance cette semaine », erreur IPC.
- Route `/emplois-du-temps`, nav 'timetable' enabled + `CalendarOutlined`.
- i18n `timetable.*`, `conflicts.*` FR.

### 5. Tableau de bord (petit ajout)
Carte « Conflits à résoudre » (FR-4) : `conflictSummary` + lien vers
/emplois-du-temps. Réutiliser KpiCard existant.

### 6. Tests `tests/calendrier.test.ts` (~20)
- listSessionsWeek : bornes lundi/dimanche incluses, enrichissements
  (jointures), filtres master/prof/salle/statuts, tri, effective_status
  dérivé (fixture hier/aujourd'hui/demain), group_name agrégé.
- month : bornes mois, même enrichissement.
- annual : regroupement par semaine ISO, parStatut exact.
- conflicts : ROOM/PROFESSOR/MASTER détectés sur fixtures à chevauche-
  ment ; paires miroir dédupliquées ; ANNULEE ignorée ; EXTERNAL sur
  occupancy weekday ; GROUP via session_group ; summary exact ; plage
  vide → [] ; dates réelles FSJP : rejouer le cas Salle 6 samedi 12–14
  (deux masters réels) et vérifier détection.
- sessions:get : historique trié, inexistant → erreur.

## Hors périmètre
Aucune écriture : création/déplacement/annulation séances (P7b),
drag&drop (P7b), génération (Phase 8), `session_group` remplissage (P7b).

## Vérification
`npx vitest run` vert · `npm run typecheck` clean · `npm run build` OK ·
sur la base réelle : `conflictSummary` retourne les conflits importés
connus (≥6 Master↔Master, ≥10 EXTERNAL).
