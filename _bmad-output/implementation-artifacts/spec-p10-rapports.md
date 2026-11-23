# Spec P10 — Rapports & statistiques

Statut : **draft** → in-progress → done
Phase : 10 (Module H — FR-40→44)
Prérequis : tout le métier (P5→P9b). FR-44 : toutes les statistiques
sont **calculées** en SQL côté main — aucune valeur saisie/stockée.

## 1. Périmètre

Page `/rapports` (sidebar `reports` → enabled) : 10 rapports
obligatoires (FR-40) présentés en tableaux + export **CSV** (compatible
Excel : séparateur `;`, BOM UTF-8, en-têtes FR — détail au §5) et
export **PDF** via `webContents.printToPDF` (FR-41). Filtres par
rapport : période `date_from/date_to` + entité (master/prof/salle) —
FR-43.

**Hors périmètre** : export XLSX natif (dépendance `exceljs` —
à décider plus tard ; le CSV ouvre directement dans Excel) ;
planification de rapports automatiques ; graphiques (v1 = tableaux,
les compteurs suffisent).

## 2. Service — `report.service.ts` (nouveau)

Une fonction par rapport, toutes `(db, filter, today?)` avec
`filter = {date_from?, date_to?, master_id?, professor_id?, room_id?,
semester_id?}` et `today` injectable. Retour `ApiResult<Report>` où
`Report = {id, title, columns: {key,label}[], rows: Record[]}` —
générique pour rendre l'UI et le CSV sans duplication.

1. **`edt_hebdo`** — EDT hebdomadaire : param `week` (lundi ISO) +
   `master_id` obligatoire → lignes jour×créneau (date, heure, module,
   prof, salle, statut). Sans master_id → tous les masters (groupé).
2. **`salles_planning`** — occupation globale des salles sur la période
   : par salle × jour : créneaux occupés (sessions + blocages Licence)
   vs créneaux `time_slot`.
3. **`prof_programme`** — par professeur : séances de la période
   (date, master, module, salle, horaires, statut).
4. **`bilan_heures`** — prévu vs effectué : par MasterModule :
   `planned_min` = `end-start` des non-ANNULEE, `done_min` = `actual_*`
   des REALISEE (défaut planifié si actual NULL — règle P7b), écart.
5. **`non_realisees`** — séances `PREVUE` passées (dérivation
   NON_ENCORE_REALISEE) : retard en jours, master, module, prof, salle.
6. **`annulees_reportees`** — statuts ANNULEE + REPORTEE avec motif
   (dernier history), date d'origine pour REPORTEE (old_* du history).
7. **`absences`** — `professor_absence` : période intersectée, motif,
   résolution, nb séances impactées/décidées.
8. **`avancement`** — par Master : séances réalisées / prévues
   (non-ANNULEE), %, restant, modules à l'heure/en retard.
9. **`occupation_salles`** — par salle : heures réservées sur la
   période vs heures ouvrables (somme des `time_slot` ∩ jours) → taux
   % ; inclure `external_occupancy` dans les heures utilisées
   (indicateur séparé Master vs Licence).
10. **`conflits_restes`** — `detectConflicts` groupé par kind +
    `remainingSessions` par MasterModule (FR-35).

## 3. Export CSV

`reportCsv(report) → string` (main) : en-têtes `columns[].label`,
séparateur `;`, quoting `"…"` si `;"'` ou retour ligne, préfixe BOM
`\uFEFF`. IPC `reports:exportCsv` → `dialog.showSaveDialog` (filtre
`.csv`, nom suggéré `rapport-<id>-<date>.csv`) → `fs.writeFileSync`
UTF-8+BOM. Retourne `{path}` ou `cancelled:true`.

## 4. Export PDF

IPC `reports:exportPdf` : le renderer envoie `{report_id, html}` —
HTML autonome généré côté renderer à partir des mêmes `columns/rows`
(table stylée print + en-tête Master/logo texte + date d'édition +
période). Main : `BrowserWindow` hors écran (`show:false`), charge
`data:text/html`, `webContents.printToPDF({printBackground:true})`,
`dialog.showSaveDialog`, écrit le buffer, ferme la fenêtre.
Pas de dépendance. Documenter : RTL des noms arabes conservé
(`dir="auto"` dans le HTML).

## 5. UI — `src/pages/ReportsPage.tsx`

- Select de rapport (groupé : Emplois du temps / Suivi / Occupation) ;
- filtres contextuels (période RangePicker, entité Select selon le
  rapport, `week` DatePicker semaine pour `edt_hebdo`) ;
- `Table` des `columns/rows` (scroll, `dir="auto"` cellules) ;
- boutons **Exporter CSV** / **Exporter PDF** (spinner pendant
  l'export ; chemin affiché après succès) ;
- cartes récap en haut quand le rapport a un `summary` (ex. taux
  d'occupation moyen, nb conflits par kind).

## 6. IPC + types

`reports:run` (id + filter → Report), `reports:exportCsv`,
`reports:exportPdf` — guards habituels, pas de requireRole (BR-24).
Types `ReportId`, `ReportFilter`, `Report` dans shared/types.

## 7. Tests — `tests/rapports.test.ts`

Fixture minimale (1 année, 1 semestre, 1 master, 1 mm, prof, 2 salles,
external_occupancy, sessions mixtes PREVUE passée/future/REALISEE avec
actual/ANNULEE/REPORTEE + absence + décision) :
- Chacun des 10 rapports : colonnes + lignes attendues, chiffres
  exacts (heures, taux, retards).
- Filtres : période borne incluse/exclue, entité.
- `reportCsv` : BOM, `;`, quoting, échappement `"`, accents UTF-8.
- FR-44 : aucune écriture — `run` ne modifie rien (audit vide).
- Acceptation réelle : `seedReal` → `conflits_restes` cohérent avec
  `conflictSummary` (336 à la louche ou recalculé), `avancement`
  14 masters.

## 8. Noté / différé

- PDF : la page HTML est produite par le renderer (pas de template
  main) — permet la mise en page print CSS et le `dir="auto"`.
- `time_slot` couvre 08–18 → taux d'occupation salles réaliste.
- Rapport `conflits_restes` réutilise `detectConflicts` existant —
  pas de nouvelle logique de détection.
