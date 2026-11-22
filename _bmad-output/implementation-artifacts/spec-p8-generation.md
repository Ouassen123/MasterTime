# Spec P8 — Génération automatique de l'emploi du temps

Statut : **draft** → in-progress → done
Phase : 8 (Module E — FR-24→29, BR-7→15)
Prérequis : P7b livré (`session-edit.service.ts`, `checkSessionPlacement`,
verrous REALISEE/ARCHIVE, anti-wedging `kinds`)

## 1. Périmètre

Moteur de génération + prévisualisation (diff vs planning existant) +
application après confirmation explicite + rapport d'échec détaillé BR-15.

**Hors périmètre** : interface de gestion des `calendar_exception` /
`time_slot` (administration → Phase « Paramètres ») ; optimisation globale
type solver (v1 = glouton heuristique + réparation locale) ; génération
multi-semestres en une passe ; échange de professeurs entre mm.

## 2. Données lues (existantes, aucune migration)

- `time_slot` — fenêtres autorisées par `weekday` (0=lun..6=dim). Le seed
  réel n'a qu'une fenêtre 08:00–18:00 par jour ouvré : le moteur la
  **subdivise** en créneaux de `session_duration_min` + `pause_min`.
- `master_module` — `session_duration_min`, `planned_sessions`,
  `sched_start`, `sched_end`, `student_group_id`, `professor_id`,
  `distribution_rule` (JSON libre ; v1 honore `{"weekday_prefs":[0..6]}`,
  `{"max_per_day":n}` s'ils sont présents, ignore le reste).
- `professor_availability` — DISPO/INDISPO par weekday avec fenêtre
  `effective_from/to` (BR-8). Sémantique P6b : une plage DISPO
  restreint ; sans aucune DISPO → toujours dispo ; INDISPO interdit.
- `professor_absence` — jours interdits (BR-8).
- `calendar_exception` — plages interdites (FERIE/FERMETURE/VACANCES) ;
  EXAMEN bloque aussi en v1 (décision : pas d'enseignement en examens).
- `room` (`is_active`, `capacity`), `professor` (`is_active`),
  `master` (`status != 'ARCHIVE'`).
- `session` existantes non-ANNULEE — occupent déjà (BR-7).
- `external_occupancy` — blocages Licence (même règle année que P7a/b).
- `session_group` — groupes supplémentaires des séances existantes.

## 3. API de génération — `generation.service.ts` (main)

```ts
generate(db, uid, params: GenerateParams, today?): ApiResult<GenerationResult>
applyGeneration(db, uid, generationId, today?): GenerationApplyResult
listGenerations(db, f): ApiResult<GenerationRow[]>
getGeneration(db, id): ApiResult<GenerationDetail>   // params+result
abandonGeneration(db, id): ApiResult<null>
generationCatalog(db, semesterId): ApiResult<GenerationCatalog>
```

`GenerationApplyResult` = `{ ok:true, data: ApplyResult } |
{ ok:false, error, fields?, conflicts?: PlacementConflict[] }` — les
conflits BR-10 retournés sont affichés en modal (même composant P7b).
`today` injectable (tests) pour le clamp temporel des deux modes.

```ts
interface GenerateParams {
  semester_id: number;
  master_module_ids?: number[];        // absent = tous mm du semestre
  mode: 'COMPLETE' | 'REGENERATE';     // cf. §4
  date_start: string;                  // intersecté avec sched_start/end
  date_end: string;
  pause_min: number;                   // défaut 0
  max_sessions_per_day_per_master?: number;  // défaut 2
  seed?: number;                       // reproductibilité (défaut: aléa)
}
```

`GenerationResult` = `generation_id` + `{placed: ProposedSession[],
unplaced: UnplacedItem[], warnings: string[], summary, replaced_ids,
replaced: ReplacedSession[]}`.
`ProposedSession` = mm, prof, salle, date, start, end + flag `replaces`
(REGENERATE : remplace des séances existantes). `ReplacedSession` =
séance existante remplacée + appariement explicite `replaced_by_index`
(index dans `placed[]`, null → « REMPLACÉE — non replacée »).
`UnplacedItem` = mm, nb séances manquantes, `reasons[]` explicites +
`suggestions[]` (BR-15).

### Modes

- **COMPLETE** : pour chaque mm, `manquantes = planned_sessions −
  nb sessions non-ANNULEE existantes` ; ne place que le manquant. Ne
  touche à rien d'existant. Cas d'usage réel : compléter un semestre,
  ou générer les M1 (planned renseigné, 0 séances). Le début effectif
  est clampé à `today` (warning si la plage demandée est amputée) —
  jamais de proposition dans le passé.
- **REGENERATE** : pour les mm ciblés, les séances **PREVUE futures
  dans la fenêtre** (`today <= date <= min(date_end, sched_end)`) sont
  marquées `replaces` dans le diff ; à l'application, elles passent
  `ANNULEE` (motif « Remplacé par génération #n ») et les nouvelles sont
  insérées. Séances passées, REALISEE, REPORTEE, ANNULEE, et PREVUE
  futures **hors fenêtre** : jamais touchées — le quota tient compte
  des séances conservées (`planned − conservées = à replacer`).

## 4. Moteur (algorithme v1)

1. **Charger** mm ciblés (refus silencieux : master ARCHIVE, prof ou
   aucun mm → erreur liste vide explicite).
2. **Grille candidate** : jours ouvrés dans `date_start..date_end` ∩
   `sched_start..sched_end`, hors `calendar_exception`, hors weekday
   sans `time_slot`. Chaque fenêtre `time_slot` est découpée en créneaux
   de `session_duration_min` séparés de `pause_min` (reste < durée →
   dernier créneau tronqué à la fenêtre).
3. **Faisabilité par créneau** (BR-7/8/9) : salle libre (sessions +
   `external_occupancy`) + `is_active` + capacité ≥ effectif
   (groupe → `student_group.size`, sinon NULL → non bloquant) ;
   prof libre + `is_active` + DISPO/INDISPO effectives + pas
   d'absence ; master/groupe libres.
4. **Ordonnancement** : sessions à placer triées par « degré de
   contrainte » (mm au prof le plus restreint = nb de créneaux DISPO
   effectifs, puis volume restant décroissant). Chaque séance →
   créneau+salle minimisant un score souple : dépassement
   `max_sessions_per_day_per_master`, écart à la répartition régulière
   (BR-13 : position cible = i × fenêtre/n), préférence weekday du
   `distribution_rule`, salle trop grande (gaspillage capacité).
   Premier candidat faisable de score minimal ; tie-break par `seed`.
5. **Occupation simulée en mémoire** (pas de SQL par candidat — NFR-7
   60 s : index `Map<date,Map<resource,interval[]>>`).
6. **Échec partiel** (BR-15) : séance non plaçable → `UnplacedItem`
   avec raisons agrégées (ex. « 0 salle libre compatible capacité sur
   28 créneaux ; prof indisponible lun–mer ») et suggestions
   (« augmenter la fenêtre », « activer Salle X », « ajouter des DISPO
   au professeur », « réduire le volume »).
7. **Écriture** : `schedule_generation` (status `PREVIEW`,
   `params_json`, `result_json`, `placed_count`) + audit GENERATE.
   Aucune séance écrite à ce stade (BR-14).

**applyGeneration** : re-lit la génération `PREVIEW` ; valide la **forme**
du `result_json` (ids entiers > 0, dates ISO calendaires,
`0 ≤ start < end ≤ 1440` → refus explicite) ; **rejoue les prédicats
durs par proposition** (même code que le moteur : créneau dans la grille
`time_slot`, jour hors `calendar_exception`, `date >= today`, prof
`is_active` + DISPO/INDISPO effectives + pas d'absence, salle
`is_active` + capacité ≥ effectif, master non `ARCHIVE` → refus
détaillé) ; **re-vérifie chaque séance proposée via
`checkSessionPlacement`** (le monde a pu changer depuis le preview —
refus si un conflit est apparu, liste détaillée retournée) ; transaction
unique : REGENERATE → ANNULEE des remplacées (history + motif), INSERT
des nouvelles `PREVUE` (history NULL→PREVUE, `session_group` = groupe
du mm s'il existe), status `APPLIED`, audit APPLY. Idempotent : un id
APPLIED/ABANDONED → refus.

## 5. IPC

`generation:run`, `generation:list`, `generation:get`,
`generation:apply`, `generation:abandon`, `generation:catalog` —
guards payload stricts (mêmes helpers que sessions.ts), **pas de
requireRole** (BR-24). `generation:catalog` sert le sélecteur UI :
master-modules éligibles du semestre + fenêtre sched globale (plage de
dates par défaut).
`generation:run` peut durer — lancer en synchrone est acceptable v1
(main mono-connexion ; la fenêtre reste responsive, requêtes lecture
bloquées le temps du calcul — documenter, pas de worker).

## 6. UI — `/generation` (sidebar `generation` → enabled)

Page en 3 zones :
1. **Paramètres** : semestre (défaut contexte), multi-select
   master_modules groupé par Master (défaut = tout le semestre), mode
   COMPLETE/REGENERATE, plage dates (défaut = sched global du
   semestre), pause, max/jour.
2. **Historique** : table des générations (date, auteur, mode, placées,
   non placées, statut PREVIEW/APPLIED/ABANDONED) → ouvre le détail.
3. **Détail/Preview** : résumé (compteurs, warnings) ; **diff** :
   table des séances proposées (marquées NOUVELLE / REMPLACE avec la
   séance remplacée en regard) + vue semaine calendrier en lecture sur
   les dates proposées (réutiliser les composants Timetable si
   raisonnable, sinon table) ; **panneau BR-15** : non placées avec
   raisons + suggestions ; boutons **Appliquer** (Popconfirm « écrire
   n séances, annuler m remplacées ») et **Abandonner**.
   Après apply : résultat (insérées/annulées) + lien « Voir dans
   l'emploi du temps ». Refus BR-10 à l'apply → modal de conflits
   (même composant que P7b).

## 7. Tests — `tests/generation.test.ts`

Fixture : année + semestre + 2 masters + 3 salles + 2 profs avec DISPO/
INDISPO/absence + 1 external_occupancy + sessions existantes.
- COMPLETE ne place que le manquant ; compte exact BR-12.
- BR-7 : jamais de chevauchement salle/prof/master/groupe produit.
- BR-8 : jamais pendant INDISPO/absence/exception/hors time_slot.
- BR-9 : capacité bloquante (petit groupe → grande salle évité).
- EXTERNAL : jamais sur un blocage Licence de la même année.
- REGENERATE : remplacées → ANNULEE au apply avec motif ; passées
  intactes ; quota respecte les conservées.
- BR-15 : mm impossible (prof sans DISPO) → unplaced avec raisons.
- Apply idempotent ; apply après conflit apparu → refus détaillé +
  rien d'écrit (atomicité).
- Reproductibilité : même `seed` → même résultat.
- Audit GENERATE + APPLY + lignes history par séance.
- Acceptation réelle : `seedReal` → COMPLETE sur semestre S3 →
  `unplaced` vide (tout est déjà planifié) sans écrire de doublon ;
  génération sur mm factice à volume connu → séances conformes.

## 8. Hors spec mais à noter

- `distribution_rule` JSON : v1 lit `weekday_prefs` + `max_per_day` ;
  le formulaire Masters ne les expose pas encore (édition JSON brute).
- La grille `time_slot` du seed (08–18 continue) produit des créneaux
  de 2h enchaînés : 8-10, 10-12, … — conforme à l'EDT réel.
- EXAMEN bloqué en v1 — à paramétrer si la fac programme en examens.

---

## Revue (3 couches) — patches exigés

1. REGENERATE : la sélection des remplacées est bornée à
   `date <= min(date_end, sched_end)` — les PREVUE futures hors fenêtre
   restent « conservées » (sinon annulation sans remplacement possible).
2. Diff complet : chaque remplacée figure — appariée (REMPLACE + la
   nouvelle en regard) ou non (ligne « REMPLACÉE — non replacée »).
   Bouton Appliquer actif dès `placed>0 || replaced>0` ; Popconfirm
   avertit explicitement du nombre de remplacées sans successeur.
3. Apply : re-vérification élargie — en plus de `checkSessionPlacement`,
   rejouer les prédicats durs par proposition : DISPO/INDISPO effectives,
   absence, `calendar_exception`, `time_slot` (le créneau doit toujours
   exister dans la grille), `room.is_active`, `professor.is_active`,
   `master.status != ARCHIVE`, capacité ≥ effectif. Tout échec → refus
   détaillé sans écriture.
4. COMPLETE : `gStart` clampé à `today` aussi (warning si la plage
   demandée est amputée) ; `applyGeneration` refuse toute proposition
   `date < today`.
5. Perf/robustesse : `external_occupancy` pré-indexée
   `Map<roomId|weekday, Interval[]>` ; plafond dur 400 jours sur la plage
   effective ; `sched_start/end`, `calendar_exception`, `effective_*`
   non-ISO filtrés au chargement + warning (évite RangeError/OOM).
6. `seed` non-entier → erreur de champ (au lieu d'un seed aléatoire
   silencieux).
7. Apply : validation de forme du `result_json` — `isId` sur chaque
   `master_module_id`/`professor_id`/`room_id`/`group_id`, dates ISO
   calendaires, `0 <= start < end <= 1440` → refus explicite.
8. Tests : EXTERNAL non vacuus (fixture où seule la salle bloquée est
   compatible) ; REGENERATE borné à la fenêtre ; COMPLETE passé clampé ;
   `seed` forgé ; apply avec INDISPO/exception/`is_active` apparue →
   refus ; proposition `date < today` refusée ; payload malformé refusé.
9. Spec §3/§5 à jour : `generation:catalog`, `GenerationApplyResult`
   (avec `conflicts?`), param `today` injectable, clamp today, borne
   REGENERATE.

Noté (différé) : `professor_absence.resolution` ignoré en v1 (Phase 9
filtrera `RESOLUE`) ; DISPO pas encore effective → « toujours dispo »
(sémantique P6b) ; EXAMEN bloqué non paramétrable.
