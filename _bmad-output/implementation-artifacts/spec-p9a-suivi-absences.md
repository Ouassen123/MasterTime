# Spec P9a — Registre des séances + décisions d'absence

Statut : **draft** → in-progress → done
Phase : 9a (Module F : FR-30, FR-35 ; Module G : FR-36→38, BR-17/18)
Prérequis : P7b (`changeSessionStatus`, `moveSession`, garde BR-10) ;
P6b (`addAbsence` + `impactedSessions`, résolution non gérée)

## 1. Périmètre

A. **Registre central** `/seances` (FR-30, FR-35) : toutes les séances,
filtres combinés, retard en jours, reste à effectuer par MasterModule.
FR-31/32/33/34 déjà couverts par le drawer + actions P7b — le registre
**réutilise** les mêmes composants, aucune nouvelle logique de mutation.

B. **Décisions d'absence** (BR-17/18, FR-36→38) : pour chaque séance
impactée par une absence, une décision explicite ; `resolution` dérivée.

**Hors périmètre** : présences étudiants (P9b) ; suppression d'absence
existante (P6b) ; gestion des exceptions calendrier (Paramètres).

## 2. Migration `0006_absence_decision.sql`

```sql
CREATE TABLE absence_decision (
  id INTEGER PRIMARY KEY,
  absence_id INTEGER NOT NULL REFERENCES professor_absence(id),
  session_id INTEGER NOT NULL REFERENCES session(id),
  decision TEXT NOT NULL
    CHECK(decision IN ('REMPLACEMENT','REPORT','ANNULATION')),
  substitute_professor_id INTEGER REFERENCES professor(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES app_user(id),
  note TEXT,
  UNIQUE(absence_id, session_id));
CREATE INDEX ix_decision_absence ON absence_decision(absence_id);
```

Une décision par (absence, séance). REMPLACEMENT exige un remplaçant.

## 3. Service — `absence.service.ts` (nouveau)

```
listAbsences(db, filter?) → absence + nb_impacted + nb_decisions +
                            resolution dérivée
getAbsence(db, id) → absence + impacted[] (PREVUE **et REPORTEE** dans
                     la fenêtre — REPORTEE occupe aussi) + decision
                     éventuelle par séance
decideSession(db, uid, absenceId, sessionId, input) :
  input = {decision, substitute_professor_id?, new_date?, new_start?,
           new_end?, note?}
  - séance doit être impactée par cette absence (même requête) et
    encore PREVUE ou REPORTEE ; sinon refus (« déjà traitée »).
  - REMPLACEMENT : remplaçant ≠ prof absent, `is_active`, existe ;
    `moveSession` partiel professor_id (garde kinds=[PROFESSOR] via le
    param `kinds` P7b) + vérif DISPO/INDISPO/absence du remplaçant sur
    la date (mêmes prédicats que le générateur — les réutiliser :
    extraire `profBlock`/`loadProfConstraints` de generation.service
    dans un module partagé `plausibility.ts` ou les dupliquer — choix
    libre, mais pas de code mort).
  - REPORT : délègue à `changeSessionStatus` REPORTEE (motif +
    nouveau créneau obligatoires — déjà garantis) ; le motif est
    pré-rempli « Absence du titulaire » si absent de l'input.
  - ANNULATION : `changeSessionStatus` ANNULEE, motif idem.
  - La décision est enregistrée dans `absence_decision` dans la MÊME
    transaction que la mutation de séance (avecAudit englobant les
    deux — avecAudit n'imbrique pas : appeler les services internes,
    pas les wrappers ; ou écrire la décision dans le même fn).
  - Échec de la mutation (conflit BR-10) → aucune décision écrite,
    conflits remontés à l'UI.
  - Audit : la ligne `absence_decision` est tracée (INSERT + audit
    explicite façon setSessionGroups).
recalcResolution : résolution dérivée — 0 décision → A_TRAITER ;
  toutes les séances impactées *encore ouvertes* décidées → RESOLUE ;
  sinon PARTIELLE. Recalculée après chaque décision ET exposée en
  lecture (colonne `resolution` mise à jour — stockée, pas dérivée à
  la volée, car le schéma la porte déjà ; documenter).
  Séance décidée puis remise en cause (ex. réactivation) : la décision
  reste tracée ; la résolution se recalcule au prochain événement —
  comportement documenté, pas de watcher.
```

## 4. Registre — `session-registry.service.ts` ou extension `session.service.ts`

```
listSessions(db, filter, page) → lignes jointes (date, horaires, master,
  module, prof, salle, groupe(s), statut stocké + statut effectif,
  retard_jours = max(0, today − date) si PREVUE passée)
filter : {date_from?, date_to?, master_id?, professor_id?, room_id?,
  module_id?, status_effectif?, search?} — status_effectif accepte
  PREVUE (réellement future), NON_ENCORE_REALISEE, REALISEE, ANNULEE,
  REPORTEE ; traduit en SQL (PREVUE passée vs future via `today`
  injectable). search sur module/master/prof (LIKE échappé).
remaining(db, master_module_id) → {planned, scheduled_non_cancelled,
  remaining} (FR-35).
```

## 5. IPC + UI

IPC `registry:list`, `registry:remaining` ; `absences:list`,
`absences:get`, `absences:decide` — même guard, pas de requireRole.

**Page `/seances`** (sidebar `sessions` → enabled) : table paginée
du registre, filtres en barre (plage de dates, Master, prof, salle,
statut effectif, recherche), colonne Retard (tag rouge « J+n »),
clic → même drawer de détail + mêmes actions que TimetablePage
(extraire le drawer dans un composant partagé si raisonnable —
sinon dupliquer strictement nécessaire). Compteurs d'en-tête :
résultats, réalisées, non réalisées, en retard.

**Page Professeurs** (fiche, onglet Absences) : pour chaque absence,
badge résolution (A_TRAITER orange / PARTIELLE bleue / RESOLUE verte),
séances impactées listées avec leur décision ; bouton « Décider » par
séance ouvrant une modale : Remplacer (Select prof actif ≠ titulaire,
avec DISPO affichées ? non — simple Select + garde serveur) /
Reporter (date+créneau) / Annuler. Refus BR-10 → modal conflits P7b.
Après décision : refresh impacted + résolution.

## 6. Tests — `tests/absences-decisions.test.ts` + registre

- impacted couvre PREVUE + REPORTEE dans la fenêtre, pas hors.
- REMPLACEMENT : succès (prof changé + décision tracée + résolution
  PARTIELLE→RESOLUE) ; remplaçant = titulaire refusé ; inactif refusé ;
  remplaçant INDISPO/absent ce jour refusé ; remplaçant en conflit
  refusé (conflits remontés).
- REPORT : via changeSessionStatus → REPORTEE + history + motif
  auto « Absence du titulaire ».
- ANNULATION : ANNULEE + motif.
- Résolution : A_TRAITER→PARTIELLE→RESOLUE au fil des décisions ;
  décision sur séance non impactée / déjà traitée refusée.
- Transaction : échec BR-10 → 0 décision écrite, séance inchangée.
- Audit : ligne absence_decision + mutation séance dans même TX.
- Registre : filtres combinés, `status_effectif` (PREVUE future ≠
  NON_ENCORE_REALISEE), retard_jours, `remaining` FR-35, pagination.
- Migration 0006 : table + index + UNIQUE (absence,session).

## 7. Noté / différé

- Séance REPORTEE hors fenêtre d'absence : pas impactée — la REPORTEE
  occupe le NOUVEAU créneau, c'est le comportement voulu.
- Décision « ignorer » non prévue : une séance impactée peut rester
  ouverte volontairement — résolution PARTIELLE assumée.
- `student`/`session_attendance`/`student_attendance` → P9b.
