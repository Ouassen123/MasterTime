# Spec P14 — Ajout rapide, feuille de présence, temps aménagé

Trois demandes utilisateur : création de séance par clic sur la grille,
feuille de présence imprimable par séance, marquage des Masters
« temps aménagé » (payants — traitement économique différé).

## 1. Migration `0008_master_temps_amenage.sql`

```sql
ALTER TABLE master ADD COLUMN temps_amenage INTEGER NOT NULL DEFAULT 0;
```

- `master.service.ts` : champ `temps_amenage` dans `MasterInput`/
  `MasterRow` (0/1, forgé → FieldError) ; exposé à la lecture.
- UI Masters : checkbox « Temps aménagé (payant) » dans le form
  création/édition ; `Tag` bleu « Temps aménagé » dans la liste et la
  fiche (à côté du statut).
- Import `masters` : colonne optionnelle `temps_amenage` (0/1) ;
  export : colonne ajoutée en fin (réimportable, unknownColumns
  tolérés à l'import).
- Commentaire : « traitement service économique / paiement —
  rapport dédié en phase ultérieure ; le flag prépare le filtrage ».

## 2. Clic-création sur la grille semaine (`TimetablePage`)

- Sur une colonne-jour de la vue **Semaine**, clic sur zone vide
  (pas sur un bloc séance/occupation — vérifier `e.target` =
  conteneur ou marquer les blocs et ignorer) :
  `start_min = DAY_START + offsetY` (1 px = 1 min), **snap 15 min**,
  `end_min = start + 120` borné à `DAY_END`.
- Ouvre le modal de création existant pré-rempli : `date` = jour
  cliqué, `start`/`end` calculés ; si vue « Par Master » avec un
  master sélectionné → `master_id` pré-rempli (module à choisir) ;
  sinon master libre.
- Curseur `cell` + title « Cliquer pour créer une séance » sur les
  zones vides. Pas de création sur clic dans le passé si le service
  la refuse déjà (laisser la validation serveur).
- Les `SessionBlock`/`OccupancyBlock` gardent leur onClick —
  `stopPropagation` où nécessaire.

## 3. Feuille de présence imprimable (par séance)

Document A4 portrait généré en PDF via le chemin existant
`printToPDF` (hidden BrowserWindow, même pattern `reports:exportPdf`).

- IPC `sessions:attendanceSheet {id}` (canal `session:` ou
  `reports:` — choisir cohérent ; **pas** d'exigence ADMIN : le
  gestionnaire imprime aussi) → `{pdfBytes}` + save-dialog
  `feuille-presence-<date>-<master>.pdf`.
- Contenu :
  - En-tête : « Faculté des Sciences Juridiques et Politiques —
    Tanger » + « **Feuille de présence** ».
  - Bloc séance : Master (code + nom), module, enseignant, salle,
    date (format FR), horaire, groupes.
  - Tableau : `N° | Nom et prénom | Présent | Absent | Observation`,
    lignes = étudiants de **l'union** `mm.student_group_id ∪
    session_group` (dédoublonnés, triés `full_name`), `dir=auto`.
    Si aucun étudiant enregistré → **25 lignes vides numérotées**
    (feuille blanche remplie à la main).
  - Pied : « Séance assurée par l'enseignant : ☐ Oui ☐ Non » +
    « Le Responsable du Master : » + cadre signature + « Fait à
    Tanger, le …/…/…… ».
  - CSS print propre (bordures tableau, pas de fond, polices
    système — réutiliser le style des rapports PDF si factorisable).
- UI : bouton « Feuille de présence » dans le `SessionDrawer`
  (toutes les séances — la feuille sert *pendant* la séance).
- Service `attendance-sheet.service.ts` (ou fonction dans
  `report.service.ts`) : `buildAttendanceSheetHtml(db, sessionId)`
  testable sans Electron (HTML string) + résolution du roster
  `resolveSheetRoster(db, sessionId)` → `{students: string[]}`
  triés dédoublonnés.

## 4. Tests (`tests/attendance-sheet.test.ts` + extension masters)

- Roster : union mm.group ∪ session_group dédoublonnée, tri alpha ;
  séance sans groupe → liste vide → 25 lignes vides ; échappement
  HTML `<>&"` dans les noms ; `dir="auto"` présent ; infos séance
  complètes dans le HTML.
- `temps_amenage` : insert/update/refus valeur forgée, export
  masters contient la colonne, import colonne optionnelle ok/absente ok.
- Migration 0008 : colonne ajoutée, défaut 0 sur l'existant.

## 5. Docs

`GUIDE-UTILISATEUR.md` : section « Feuille de présence » (workflow :
imprimer → le responsable coche → saisie dans l'onglet Présences +
marquer la séance Réalisée) + « Temps aménagé » (signification,
paiement différé) + « Clic-création » sur la grille.

## Non-goals

Rapport de paiement service économique (différé — le flag pose la
donnée) ; feuille de présence multi-séances (par semaine/master) ;
signature électronique ; scan OCR de la feuille.
