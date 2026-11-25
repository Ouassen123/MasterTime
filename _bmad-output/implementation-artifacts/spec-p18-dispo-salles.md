# Spec P18 — Grille des salles disponibles

Nouvelle vue dans `/emplois-du-temps` : « Dispo salles » — grille
semaine (jours × créneaux candidats) où chaque case liste les salles
**libres** pour tout le créneau ; clic sur une salle → modal de
création pré-rempli (salle + date + heures).

## 1. Service `free-rooms.service.ts`

`freeRoomsGrid(db, weekStart, {durationMin})` :
- `weekStart` = lundi ISO ; `durationMin ∈ {60,90,120,180}` (défaut
  120, forgé → FieldError).
- Créneaux candidats : fenêtre `time_slot` du weekday découpée en pas
  de `durationMin` (8h–18h @120 → 08-10,10-12,12-14,14-16,16-18) ;
  un créneau doit tenir **entier** dans une fenêtre `time_slot` du
  jour (même règle que la génération — hors grille = non planifiable).
- Par (jour, créneau) : salles `is_active=1` sans séance non-ANNULEE
  chevauchant [start,end] ET sans `external_occupancy` du weekday
  chevauchant (toutes années — acad_year NULL ou année du jour).
- Jour en `calendar_exception` → la case est marquée
  `closed: 'FERIE'|…` au lieu de salles (planification bloquée de
  toute façon).
- Retour : `{days: [{date, closed}], slots: [{start_min,end_min}],
  cells: {"<date>|<start>": [{room_id,name,capacity}]}}` trié capacité
  croissante puis nom — l'utilisateur choisit la plus adaptée.
- IPC `timetable:freeRooms {week_start, duration_min}` — pas de
  requireRole (lecture ; la création garde BR-10 à l'apply).

## 2. UI `TimetablePage` — vue « Dispo salles »

- 5e entrée dans le sélecteur de vue (Semaine | Mois | Année |
  **Dispo salles**), à côté des filtres entité (masquer les selects
  Master/Prof/Salle dans cette vue — non pertinents).
- Même navigation semaine (◀ Aujourd'hui ▶).
- Select durée : `2h` (défaut) / `1h30` / `1h` / `3h`.
- Table : lignes = créneaux (`08h–10h`…), colonnes = jours ;
  case = `Tag` par salle libre (`Salle 5`, `Amphi 1`, tooltip
  capacité) ; case fermée → tag gris « Fermé — <type> » ;
  case sans salle libre → « — ».
- **Clic sur un Tag salle** → `openCreateAt` étendu : pré-remplit
  `room_id` en plus de `date`/`start`/`end` (le formulaire de
  création a déjà un champ salle — passer la valeur initiale ;
  vérifier que `openCreateAt`/`createForm.setFieldsValue` accepte
  `room_id`).

## 3. Tests (`tests/free-rooms.test.ts`)

- Salle occupée par une séance au créneau → absente ; autre créneau
  → présente. Séance ANNULEE n'occupe pas.
- `external_occupancy` du weekday → salle exclue.
- `is_active=0` → jamais listée.
- Créneau hors `time_slot` → pas de ligne pour ce slot.
- Jour en exception → `closed` + pas de salles.
- durationMin forgé → FieldError ; ordre capacité croissante.

## 4. Doc

`GUIDE-UTILISATEUR.md` §emplois du temps : décrire la vue « Dispo
salles » (chercher un trou → clic → planifier).
