# Spec P15 — Rapport « Heures temps aménagé » (service économique)

Nouveau rapport #11 destiné au traitement de paiement : les Masters
`temps_amenage=1` sont rémunérés — le service économique a besoin des
heures **réellement assurées par chaque intervenant** (le remplaçant
est payé, pas le titulaire déclaré — différence clé vs
`bilan_heures`).

## 1. `report.service.ts`

- `REPORT_TITLES` : `heures_temps_amenage:
  'Heures temps aménagé (service économique)'`.
- Fonction `reportHeuresTempsAmenage(db, f: NormFilter)` :
  - Source : `session s JOIN master_module mm JOIN master m
    (m.temps_amenage = 1) JOIN module mo JOIN professor p
    (p = s.professor_id — intervenant RÉEL)`.
  - Ne compter QUE `s.status = 'REALISEE'`, bornes `from`/`to` sur
    `s.date` (obligatoires si `resolvePeriod` l'exige — suivre le
    pattern des autres rapports), `semesterId`, `masterId`,
    `professorId` (sur `s.professor_id`).
  - Groupement `(p.id, m.id, mo.id)` : `nb_realisees`, `realise_min`
    (paire `actual_*` complète sinon fallback créneau planifié —
    même règle que `bilan_heures`), `prevu_min` des réalisées.
  - Colonnes : `professeur`, `master` (`code — name`), `module`,
    `nb_realisees` « Séances réalisées », `realise_min`
    « Heures réalisées (min) », `realise_hhmm` « Heures réalisées »
    format `H h MM` (ex. `12 h 30` — calculé en JS), `prevu_min`
    « Heures planifiées (min) ».
  - Récap : `total_realise_min` (+ format h) et
    `nb_intervenants` (COUNT DISTINCT p).
  - Tri : `p.full_name COLLATE NOCASE, m.code, mo.code`.
- Dispatcher : `case 'heures_temps_amenage'` dans le switch.
- `shared/types.ts` : ajouter `'heures_temps_amenage'` à `ReportId`.

## 2. UI `ReportsPage.tsx`

- `REPORT_DEFS` : ajouter dans le groupe « Suivi » (avec
  `bilan_heures`) ; `FILTERS`: `{ period: true, master: true,
  professor: true }` — le Select Master doit pouvoir être limité
  aux `temps_amenage` si la liste le permet (option : filtrer les
  options `master.temps_amenage === 1` quand ce rapport est choisi —
  si `MastersRow` l'expose ; sinon laisser tous les masters, le
  rapport filtre de toute façon).
- Exports CSV/PDF : automatiques via les boutons existants (nom de
  fichier `heures-temps-amenage-<date>.csv/pdf`).

## 3. Tests (`tests/reports.test.ts` — nouveau describe)

- Master `temps_amenage=0` exclu ; flag 1 inclus.
- Intervenant réel : séance REALISEE avec `s.professor_id` =
  remplaçant → heures au remplaçant, pas au titulaire mm.
- `actual_*` complet utilisé, partiel → fallback planifié.
- Filtres période/master/prof.
- Récap totaux.
- CSV : exporte (déjà couvert globalement — vérifier au moins que le
  nouveau type passe par `export:entity`-like path si applicable).

## 4. Doc

`GUIDE-UTILISATEUR.md` §Rapports : décrire « Heures temps aménagé »
— usage service économique, heures comptées à l'intervenant réel.
