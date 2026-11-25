# Spec P17 — Feuille hebdomadaire par Master + saisie groupée

Complète la feuille par séance (P14) : une feuille par **Master ×
semaine** (moins de papier pour le coordonnateur) et une **saisie
groupée** au retour (marquer réalisée + présences en une passe).

## 1. Feuille hebdo `buildWeekSheetHtml(db, masterId, weekStart)`

- `weekSheetSessions(db, masterId, weekStart)` : séances non ANNULEE
  du master sur [lun, lun+6], triées date+start ; liste aussi leur
  union de groupes pour le roster.
- Roster = étudiants des **groupes du master** impliqués par ces
  séances (mm ∪ session_group), dédoublonnés, triés ; si aucun →
  25 lignes vides numérotées.
- HTML **A4 paysage** : en-tête FSJP + « Feuille de présence — Master
  X, semaine du JJ/MM/AAAA » ; colonnes = séances (en-tête rotaté ou
  compact : `dd/MM` + code module + salle) ; lignes = étudiants
  (N° | Nom et prénom | une case par séance | Observation).
  Cap : >8 séances → tronquer avec note « suite sur une 2e feuille »
  (v1 simple).
- Bloc bas de page : « Séances assurées par l'enseignant » — une
  ligne par séance (date, module, prof) avec ☐ Oui ☐ Non ; cadre
  « Le Responsable du Master : » + « Fait à Tanger, le …/…/…… ».
- `dir="auto"`, échappement, même style print que la feuille unitaire.
- IPC `sessions:weekSheet {master_id, week_start}` → PDF save
  (`feuille-presence-<master>-S<ww>.pdf`). Pas de requireRole.
- UI : bouton « Feuille de présence hebdo » sur **MastersPage** fiche
  (ou Emplois du temps vue Par Master) avec sélecteur de semaine
  (défaut : semaine courante).

## 2. Saisie groupée `recordAttendanceSheet`

`attendance.service.ts` (ou nouveau `sheet-entry.service.ts`) :
`recordAttendanceSheet(db, uid, sessionId, {actual_date?,
actual_start_min?, actual_end_min?, rows: {student_id, status}[]})`
— transaction unique :
1. Séance doit être PREVUE ou REPORTEE (sinon FieldError `status` —
   une REALISEE se corrige via l'onglet Présences existant).
2. `changeSessionStatus(REALISEE, motif='Saisie feuille de présence',
   actual_*)` — réutilise le service P7b (histoire + audit).
3. `setNominative`-équivalent pour les `rows` (P/A/J, bornes idem).
4. Audit récap + résultat `{session_id, realised, marked}`.
- IPC `sessions:recordSheet` (pas d'ADMIN — BR-24).
- UI `SessionDrawer` : bouton **« Saisir la feuille »** sur PREVUE/
  REPORTEE → Modal : info séance, « horaires réels » (optionnel,
  défaut créneau), tableau étudiants du roster avec radios
  P/A/J + « Tous présents », valider → appel, succès → drawer
  rechargé (statut REALISEE + présences remplies).
- Si la séance n'a pas d'étudiants → la modale propose juste le
  marquage Réalisée (comptage impossible → note).

## 3. Tests (`tests/sheet-entry.test.ts` + week sheet)

- `recordAttendanceSheet` : REALISEE + nominatif en une tx ;
  actual_* enregistrés ; refus sur REALISEE/ANNULEE ; audit +
  histoire ; JUSTIFIE compté absent (règle existante) ; séance sans
  étudiants → REALISEE seule.
- `weekSheetSessions` : uniquement le master ciblé, semaine bornée,
  ANNULEE exclues ; roster union + dedup + tri ; HTML contient
  toutes les séances + ligne « Séances assurées ».

## 4. Doc

`GUIDE-UTILISATEUR.md` : workflow complet « imprimer la feuille hebdo
→ le responsable coche → saisir la feuille par séance ».
