# Spec P11 — Import / Export des données

Statut : **draft** → in-progress → done
Phase : 11 (Module I — FR-45→49, BR-21)
Prérequis : tous les référentiels CRUD (P6a–c, P9b) ; `reportCsv`
quoting dispo pour les exports.

## 1. Périmètre

Page `/import-export` (sidebar `importExport` → enabled) :
- **Import CSV** (FR-45/46/47, BR-21) pour 5 types : `salles`,
  `professeurs`, `modules`, `masters`, `etudiants` — aperçu ligne
  par ligne (OK / doublon / erreur de champ), stratégie de conflit
  explicite (`IGNORER` / `FUSIONNER` / `REMPLACER`), import
  transactionnel par lot avec rapport final.
- **Export CSV** (FR-48) : dump par entité — salles, professeurs,
  modules, masters (+master_modules), étudiants, **séances** (toutes
  les colonnes jointes lisibles : master, module, prof, salle, date,
  horaires, statut, actual_*) — réutilise le save-dialog des rapports.
- **Gabarits** (FR-49) : bouton « Télécharger le gabarit » par type —
  CSV d'en-têtes + 1 ligne d'exemple, généré depuis les specs de
  colonnes ci-dessous (source unique).

**Hors périmètre** : import XLSX natif, import des séances et
disponibilités (mapping master_module/multi-entités — phase ultérieure,
documenté), import `external_occupancy` (données Licence déjà seedées),
annulation d'un import (l'audit trace chaque ligne importée —
rollback global si une écriture échoue ; les doublons « ignorés » ne
sont pas des échecs).

## 2. Colonnes par type (en-têtes FR exacts, `;` ou `,` auto-détecté)

- `salles` : `nom*` ; `capacite` ; `actif(0/1)`
- `professeurs` : `nom_complet*` ; `email` ; `actif(0/1)`
- `modules` : `code*` ; `nom*`
- `masters` : `code*` ; `nom*` ; `filiere` ; `departement` ;
  `responsable` ; `semestre`(ordinal → semester de l'année courante)
- `etudiants` : `groupe*` (nom exact du groupe — le master est porté
  par `master_code`*) ; `master_code*` ; `nom_complet*` ; `external_id`

Parsing : BOM autorisé, délimiteur `;` ou `,` (détecté sur l'en-tête),
quoting `"` standard, lignes vides ignorées, en-tête obligatoire et
validé (noms exacts, ordre libre, colonnes inconnues → warning
non-bloquant listé). Max 10 000 lignes.

## 3. `import.service.ts` (main)

```
previewImport(db, type, csvText) → ApiResult<{
  columns: string[], unknownColumns: string[],
  rows: ImportRow[]   // {n, raw, parsed, status: OK|DOUBLON|ERREUR,
                      //  errors: FieldError[], match_id?}
}>
applyImport(db, uid, type, csvText, strategy) → ApiResult<{
  inserted, merged, ignored, errors: {n, message}[]
}>
exportEntity(db, type) → ApiResult<Report-like columns/rows>
   (CSV produit côté renderer via reportCsv, ou main — au choix)
```

Doublons (par type) :
- salles/profs/modules/masters : unicité **NOCASE** sur nom/code
  (cohérent avec les services P6a) → `match_id` de l'existant.
- étudiants : (groupe via master_code+groupe, `external_id` si fourni
  sinon `full_name` NOCASE).
- stratégie : `IGNORER` → ligne sautée (`ignored++`) ; `FUSIONNER` →
  UPDATE des champs fournis non vides (`merged++`) ; `REMPLACER` →
  UPDATE de tous les champs fournis (vides → NULL là où permis).
- Ligne ERREUR → jamais insérée, listée avec messages (FR-46).
- Écritures : services existants si raisonnable, sinon INSERT/UPDATE
  direct **mais toujours** avec les mêmes validations de champ +
  `withAudit` par lot entier (une seule transaction — un plantage
  milieu = rollback complet) + audit `IMPORT` par ligne (ou audit
  résumé `IMPORT` sur l'entité avec `{inserted,merged,ignored}` —
  choisir le résumé + detail dans `new_values`, les lignes sont
  traçables par audit_log par entité). Le plus simple conforme
  BR-20 : une ligne audit_log par entité modifiée (CREATE/UPDATE
  existant) + une ligne récap `IMPORT` par lot.
- `is_demo = 0` sur tout import réel.

## 4. UI — `src/pages/ImportExportPage.tsx`

Deux onglets :
- **Importer** : Select type → sélection fichier (`Upload.Dragger`
  lecture texte UTF-8) → table preview (statuts taggés, erreurs par
  ligne, nb par statut) → Radio stratégie → bouton Importer (désactivé
  si 0 ligne OK/DOUBLON) → résultat (compteurs + erreurs restantes).
- **Exporter** : liste des entités + bouton CSV par entité (même
  save-dialog que les rapports).
- Gabarits : bouton par type dans l'en-tête de l'onglet Importer.
- L'import se fait en une seule requête IPC avec le texte lu —
  le fichier peut peser plusieurs Mo : borne 5 Mo côté UI, 10 000
  lignes côté service.

## 5. IPC

`import:preview`, `import:apply`, `import:template`,
`export:entity` (→ save dialog + write, même pattern reports) —
guards stricts, **requireRole('ADMIN')** sur import:apply uniquement
(import massif = administration ; preview/exports/templates libres
pour les deux profils — décision, documenter).

## 6. Tests — `tests/import-export.test.ts`

- Parsing : `;` vs `,` auto, BOM, quoting, ligne vide, en-tête
  invalide/colonne inconnue, >10k lignes refusé.
- Preview par type : OK, DOUBLON nocase (`Amphi 7` vs `amphi 7`),
  ERREUR champ requis/type (`capacite` non entier, groupe inconnu,
  master_code inconnu).
- Apply : IGNORER ne touche rien ; FUSIONNER met à jour les champs
  fournis ; REMPLACER remet les vides à NULL ; erreurs isolées n'ont
  pas bloqué le lot (elles ne sont simplement pas importées) ;
  atomicité (échec simulé → 0 écriture) ; audit par entité + récap.
- Étudiants : création dans le bon groupe, external_id généré si vide
  (règle P9b MAN-* ou auto — cohérent).
- Export entité : colonnes + compte de lignes exacts.
- Gabarits : en-têtes exacts par type.
- is_demo=0 sur tout.

## 7. Noté / différé

- XLSX : `exceljs` évalué et reporté — CSV `;` natif Excel FR.
- Séances/disponibilités : l'import EDT (volumineux, mapping
  mm×prof×salle) mérite son propre spec avec preview de conflits.
- Stratégie par ligne (pas par lot) : BR-21 dit « par lot » —
  conforme, pas de mixte en v1.

---

## Revue (3 couches) — patches exigés

1. **Doublons non-ASCII** : `dupKey`/`findMatch`/`uniquenessViolation`
   doivent comparer en JS via `toLowerCase()` (fold Unicode) — charger
   les candidats et comparer en code, plus de `COLLATE NOCASE` seul
   (ASCII-only → `ÉMILE`/`émile` passait en doublon réel). Unifier
   intra-fichier et base-existante.
2. **Fusion masters** : `semester_id` résolu dans
   `master.academic_year_id` de l'existant à l'UPDATE (pas l'année
   courante) — préserver la cohérence (année, semestre).
3. **Étudiants REMPLACER** : `external_id` vide → régénérer `MAN-<id>`
   au lieu de NULL ; insert+update en SAVEPOINT par ligne (un échec
   d'UPDATE ne laisse pas d'orphelin NULL).
4. **Export séances** : `groupe` = noms du `mm.student_group_id` ∪
   `session_group` (jointure groupée), séparés par « + ».
5. **Quote non fermée** : `inQuotes` vrai en fin de fichier → la ligne
   devient ERREUR « guillemet non fermé » (pas un champ géant avalé).
6. **Encodage** : `\uFFFD` détecté dans `parseCsv` → erreur globale
   « fichier probablement non UTF-8 (Latin-1) ».
7. **is_demo** : tout UPDATE écrivant au moins un champ force
   `is_demo=0` (donnée réelle fusionnée dans une ligne démo).
8. Petits : `merged++` uniquement si l'UPDATE a réellement changé ;
   colonne d'en-tête dupliquée → `unknownColumns` warning ; `capacite`
   strict `/^\d+$/` ; `full_name`/`external_id`/`nom`/`code` ≤ 200 ;
   récap IMPORT sauté si 0 ligne importable ; UI : `error`/`result`
   vidés au changement de type ; champ `n` documenté = rang non-vide.
9. Tests : `ÉMILE`/`émile` intra-fichier et base-vs-fichier ; fusion
   master cross-année ; REMPLACER external_id ; SAVEPOINT orphelin ;
   export seances groupe union ; quote non fermée ; `\uFFFD` ;
   is_demo fusion ; capacite '1e2' refusée.
