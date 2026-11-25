# Spec P16 — Résolution assistée des conflits de salle

Objectif : résorber les conflits ROOM + EXTERNAL (occupation Licence)
par **réaffectation automatique de salle** au même créneau — aucune
séance ne change de date/heure/prof/master. Conflits PROFESSOR et
MASTER exclus (décision humaine : changer l'horaire impacte les
étudiants).

## 1. `conflict-resolve.service.ts` (nouveau)

- `previewReassignment(db)` : pour chaque séance impliquée dans un
  conflit ROOM ou EXTERNAL (non ANNULEE), propose `new_room_id` =
  salle active **libre au créneau** (aucune séance non annulée qui
  chevauche, aucune `external_occupancy` du weekday qui chevauche)
  ET `capacity >= effectif` si effectif connu (Σ tailles des groupes
  mm ∪ session_group ; inconnu → pas de contrainte capacité BR-9).
  Choix déterministe : capacité suffisante **la plus proche** de
  l'effectif (sinon la plus petite), tie-break id.
  Renvoie `{proposals: [{session_id, date, start_min, end_min,
  old_room, new_room, kinds}], skipped: [{session_id, reason}]}` —
  `skipped` = pas de salle compatible.
  Calcul en mémoire : occupation salle indexée (date|room) +
  licence indexée (weekday|room) ; appliquer les propositions **en
  séquence** — une salle attribuée devient occupée pour les
  propositions suivantes (pas de nouveau conflit créé).
- `applyReassignment(db, uid)` : rejoue `previewReassignment` dans
  une transaction `BEGIN IMMEDIATE` ; pour chaque proposition
  re-vérifie que la salle cible est toujours libre (checkSessionPlacement
  kinds ROOM+EXTERNAL sur le créneau de la séance avec la nouvelle
  salle — si échec → `skipped` dans le résultat, pas d'écriture).
  UPDATE `session.room_id` + audit explicite par séance
  (`UPDATE session`, old/new room) — motif « Réaffectation salle —
  résolution de conflit ». Retourne `{moved, skipped}`.
- La collision récurrente : propositions calculées séance par
  séance — chaque semaine d'un créneau récurrent est indépendante.

## 2. IPC + UI

- `conflicts:reassignPreview` / `conflicts:reassignApply` (pas de
  requireRole — BR-24 : gestion des EDT ; documenter).
- `TimetablePage` panneau Conflits : bouton **« Réaffecter les
  salles »** → Modal aperçu : compteurs « N séances peuvent être
  déplacées de salle » + table (séance, ancienne → nouvelle salle,
  type de conflit) + liste des non-résolubles si >0 → bouton
  Appliquer → résultat + rechargement conflits + grille.
- Types dans `shared/types.ts` : `RoomReassignProposal`,
  `RoomReassignPreview`, `RoomReassignResult`.

## 3. Tests (`tests/conflict-resolve.test.ts`)

- Collision 2 séances 1 salle → l'une bouge vers salle libre
  compatible ; la proposition choisit la capacité la plus proche.
- Collision Licence → la séance Master sort de la salle occupée.
- Pas de salle compatible (toutes occupées) → `skipped` avec raison.
- Séquence : 3 séances, 2 salles libres → aucune proposition ne
  crée de nouveau conflit (vérifié via `checkSessionPlacement`).
- Apply : UPDATE + audit + `skipped` si le monde a changé (insérer
  une séance concurrente entre preview et apply → recalculé).
- Capacité : salle trop petite écartée ; effectif inconnu → libre.

## 4. Application réelle

Après implémentation : appliquer sur la base réelle (audit +
sauvegarde préalable via le mécanisme backup existant ou script).
Conflits attendus après : ~60 (36 PROFESSOR + 24 MASTER — à traiter
manuellement, documentés comme collisions récurrentes de la source
officielle).
