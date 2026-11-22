# Spec P7b — Modification manuelle des séances + garde conflits à l'écriture

**Story** : en tant qu'admin, je déplace une séance (date/heure/salle/prof),
je change son statut (réalisée, reportée, annulée) avec motif, je peux créer
une séance manuelle et rattacher des groupes — chaque écriture est bloquée
par les conflits durs (BR-7→BR-10) et historisée (AD-6).
Statut : approuvé → in-progress.

## Périmètre

### 1. `electron/main/db/conflict.service.ts` — garde d'écriture

`checkSessionPlacement(db, {date, startMin, endMin, roomId, professorId,
 masterId, excludeSessionId?, groupIds?})` → `PlacementConflict[]`
(même shape `ConflictItem`, kind ∈ ROOM|PROFESSOR|MASTER|GROUP|EXTERNAL).
Réutilise les mêmes requêtes que `detectConflicts` mais ciblées sur un
candidat unique (pas un full-scan) :
- séances non-ANNULEE (id ≠ excludeSessionId) chevauchant [start,end)
- EXTERNAL : occupancy même salle, weekday(date), année compatible
- GROUP : via mm.student_group_id UNION session_group des deux côtés
Retour vide = placement autorisé.

### 2. `electron/main/db/session-edit.service.ts` — mutations (withAudit)

- `createSession(db, uid, input)` : {master_module_id, professor_id (défaut
  = mm.professor_id), room_id, date ISO valide, start_min, end_min,
  group_ids?: number[]} → vérif refs + `checkSessionPlacement` → refus
  `{ok:false, conflicts:PlacementConflict[]}` (BR-10 bloquant) sinon
  INSERT status='PREVUE' + history initiale + session_group rows + audit.
- `moveSession(db, uid, id, {date?, start_min?, end_min?, room_id?,
  professor_id?})` : même garde (exclude soi-même) ; audit UPDATE ;
  si date/heure changées → history via changeSessionStatus avec
  old/new date+mins (report implicite si status reste PREVUE ? NON —
  décision : déplacement ≠ report ; REPORTEE est un statut explicite.
  Le déplacement met à jour la séance + écrit une ligne history
  `old_date→new_date` sans changer le statut).
- `changeStatus(db, uid, id, newStatus, {reason?, actual_date?,
  actual_start_min?, actual_end_min?})` via le point d'entrée unique
  `changeSessionStatus()` (AD-7 — vérifier où il vit : probablement dans
  session.service ou à créer ici) :
  - → REALISEE : actual_* requis (défaut = planifié), confirm UI
  - → ANNULEE : reason obligatoire
  - → REPORTEE : reason + nouvelle date/heure → la séance garde son
    créneau actuel ? NON — modèle : REPORTEE marque l'ancienne ; la
    nouvelle programmation = nouvelle date via champs actual_* ? Vérifier
    DATA-MODEL : report = old/new date+mins dans l'historique + déplacer
    la séance. Implémentation : status REPORTEE + move simultané
    (date/start/end deviennent le nouveau créneau, historique conserve
    l'ancien) + garde conflits sur le nouveau créneau.
  - PREVUE → PREVUE (réactivation depuis ANNULEE ? autoriser ANNULEE→
    PREVUE avec re-check conflits ; REALISEE → verrouillée sauf admin
    correctif avec reason obligatoire).
- `setSessionGroups(db, uid, id, groupIds[])` : remplace les rows
  session_group (valide que les groupes appartiennent au master du mm) ;
  re-check GROUP conflicts après changement.
- `deleteSession` : refus si status=REALISEE (historique pédagogique) ;
  sinon DELETE + audit (soft ? non — vrai delete, l'audit trace).

Toutes : `isValidIsoDate`, bornes `0 ≤ start < end ≤ 1440`, date verrouillée
calendairement (corrige le trou GLOB P7a-M5 côté écriture). **BR-24** :
pas de requireRole sur les mutations séances — le GESTIONNAIRE gère l'EDT
au quotidien, ADMIN ne réserve que les référentiels système.

### 3. IPC `electron/main/ipc/sessions.ts`
Canaux : `sessions:create|move|setStatus|setGroups|remove` (mutations),
`sessions:checkPlacement` (pré-validation UI, lecture). Guards stricts
(isId/isObject/dates/mins). requireRole : aucun (BR-24 — les deux profils écrivent).
Preload `api.sessions.*` (extend existant `sessions:get`).

### 4. UI — dans `TimetablePage.tsx` (extension du drawer existant)
- Drawer séance : boutons actions (Admin visible) — **Modifier**
  (form date+TimePicker+salle Select+prof), **Statut** (menu :
  Marquer réalisée / Reporter / Annuler / Remettre prévue), **Groupes**
  (multi-select groupes du master), **Supprimer** (avec confirm, refusé
  si REALISEE).
- Réalisée : mini-form actual_date + actual_start/end (défaut planifié).
- Annulée/Reportée : Modal avec motif obligatoire (reportée : +
  nouvelle date/heure).
- Conflit refusé (BR-10) : Modal/Alert listant les PlacementConflict
  détaillés (kind, entité, séance adverse) — pas de toast seul.
- Drag & drop : reporter à plus tard si coûteux — form suffit v1.
  (Noter l'écart UX dans les notes.)
- Après mutation : reload semaine + panneau conflits (BR-11).

### 5. Tests `tests/edition-seances.test.ts` (~18)
- checkPlacement : chaque kind (fixture chevauchements), excludeSelf,
  EXTERNAL weekday, adjacence non-conflit.
- createSession : refs invalides, date non-calendaire (2026-02-30),
  start≥end, end>1440, conflit refusé → rien inséré + 0 audit ;
  succès → history initiale + session_group + audit CREATE.
- moveSession : conflit bloqué (0 écriture), succès → history
  old/new date+mins, statut inchangé.
- changeStatus : transitions illégales refusées ; REALISEE sans
  actual → défaut planifié ; ANNULEE sans reason refusée ; REPORTEE
  avec nouveau créneau → historique conserve ancien + garde conflits ;
  ANNULEE→PREVUE re-check ; REALISEE→autre : règle spec appliquée.
- setSessionGroups : groupe d'un autre master refusé, re-check GROUP.
- deleteSession : REALISEE refusée, PREVUE ok + audit.
- pas de requireRole (BR-24, les deux profils écrivent) ; audit old/new JSON corrects + changed_by.

## Hors périmètre
Drag & drop, génération (P8), absences→décisions par séance (Phase 9),
attendance (Phase 9).

## Vérification
`npx vitest run` vert · typecheck · build · sur copie base réelle :
déplacer une séance Salle 6 samedi → conflit refusé affiché.

---

## Revue (3 couches) — patches exigés

1. `changeSessionStatus` : `needsCheck` étendu — toute sortie de `ANNULEE`
   vers statut occupant (PREVUE **ou REALISEE**) re-check les conflits.
2. `setSessionGroups` : refusé si `status='REALISEE'` ; audit explicite
   (ligne `audit_log` avec old/new `group_ids` JSON — le diff `updated_at`
   seul est insuffisant et peut produire 0 ligne).
3. Refus ressources inactives : `room.is_active=0` et `professor.is_active=0`
   refusés dans createSession/moveSession (sauf valeur inchangée au move) ;
   Selects UI filtrés `is_active` (sauf valeur courante).
4. `createSession` refusé si le master du mm est `ARCHIVE`.
5. Anti-wedging : `checkSessionPlacement` accepte `kinds?: ConflictKind[]` ;
   moveSession ne re-check que les kinds affectés par les champs modifiés
   (date/heure → tous ; room → ROOM+EXTERNAL ; professor → PROFESSOR ;
   inchangé → pas de check). Un conflit pré-existant orthogonal ne bloque
   plus une retouche partielle — documenté.
6. `REALISEE→REALISEE` corrective : autorisée avec `corrective:true` +
   reason → met à jour `actual_*` seuls (pas de nouveau créneau).
7. `actual_date` trimée au stockage ; `reason` de moveSession écrite dans
   l'historique même sans changement de créneau.
8. `applyEditResult` : mapper `res.fields` sur les Forms (`setFields`)
   pour surligner le champ fautif.
9. UI : groupe implicite du mm exclu des options Groupes/Création ;
   service ignore `mm.student_group_id` dans `group_ids` (dédup silencieuse).
10. `moveSession` sur REPORTEE exige `reason` (cohérent re-report).
11. UI : boutons Modifier/Supprimer désactivés sur REALISEE.
12. `comment`/`reason` plafonnés à 500 caractères côté service.
13. `checkPlacement` IPC : `groupIds` non-array → `apiErr`.
14. Bornes temporelles : `REPORTEE` nouveau créneau `>= today` refusé sinon ;
    `actual_date > today` refusée ; `deleteSession` refusée si `date < today`
    (une NON_ENCORE_REALISEE doit être ANNULEE, pas effacée).
15. Tests : ANNULEE→REALISEE bloquée sur créneau occupé + OK si libre ;
    REPORTEE→REPORTEE ; REPORTEE passé refusée ; actual futur refusée ;
    inactive room/prof ; ARCHIVE master ; corrective REALISEE→REALISEE ;
    uid GESTIONNAIRE écrit (BR-24) ; move partiel non bloqué par conflit
    orthogonal ; setGroups REALISEE refusé ; bornes 0/1440 acceptées ;
    not-found des 4 mutations.

Décision : corrective accessible aux deux profils (BR-24 littéral —
le gestionnaire gère l'EDT au quotidien ; « correction admin » du spec
désigne le mécanisme, pas un rôle).

Différé/noté : `sessions:checkPlacement` IPC non câblé (pré-validation
live future) ; drag&drop toujours hors périmètre.
