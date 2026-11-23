# Spec P9b — Présences étudiants

Statut : **draft** → in-progress → done
Phase : 9b (Module G : FR-39, BR-19)
Prérequis : P9a (SessionDrawer partagé, deleteSession nettoie les
attendances), tables `student`, `session_attendance`,
`student_attendance` (0001)

## 1. Périmètre

Saisie des présences par séance : mode **comptage** (présents/absents +
note) et mode **nominatif** (par étudiant : PRESENT/ABSENT/JUSTIFIE)
quand le groupe de la séance a des étudiants au registre.

**Hors périmètre** : import du registre étudiants (Phase I — la table
`student` sera remplie alors ; en attendant un mini-CRUD manuel dans la
fiche Master → Groupes permet de tester) ; statistiques de présence
(Module H) ; justification globale d'une absence.

## 2. Service — `attendance.service.ts` (nouveau)

```
getAttendance(db, sessionId) → {
  counts: {present_count, absent_count, note} | null,
  nominative: {student_id, full_name, status, group_name}[],
  roster: {student_id, full_name, group_name}[],   // étudiants éligibles
  mode: 'COUNT' | 'NOMINATIVE' | 'NONE'
}
setCounts(db, uid, sessionId, {present_count, absent_count, note})
setNominative(db, uid, sessionId, items: {student_id, status}[])
clearAttendance(db, uid, sessionId)
```

Règles :
- Séance doit être **REALISEE** (une présence n'a de sens que sur un
  cours tenu — BR-1). Refus explicite sinon.
- `present_count`/`absent_count` ≥ 0 entiers ; `note` ≤ 500.
- Mode nominatif : `student_id` doivent appartenir à un groupe de la
  séance — groupes candidats = `master_module.student_group_id` ∪
  `session_group` (∪ tous les groupes du master si ni l'un ni l'autre —
  séance master entier). Statuts ∈ PRESENT/ABSENT/JUSTIFIE ; un
  étudiant absent de la liste = PRESENT par défaut à l'init UI mais le
  service n'écrit que les lignes fournies ; `setNominative` remplace
  l'ensemble (DELETE+INSERT des lignes de la séance) et **recalcule**
  `session_attendance` : present = nb PRESENT, absent =
  nb ABSENT+JUSTIFIE (un justifié reste un absent comptablement —
  documenté), note conservée.
- `setCounts` refuse si des lignes nominatives existent (mode déjà
  nominatif → passer par setNominative ou clear).
- Toute écriture via `withAudit` + audit explicite (old/new JSON des
  compteurs ou de la liste — pattern `setSessionGroups`, le diff de la
  ligne `session` ne suffirait pas puisqu'on ne touche pas `session`).
- Séance quittant REALISEE (correction) : les attendances restent
  (décision : on conserve la trace ; deleteSession les nettoie déjà).

## 3. Registre étudiants (minimal, pré-import)

`student` existe mais aucune saisie n'est possible avant Phase I.
Ajout minimal dans **fiche Master → onglet Groupes** : sous chaque
groupe, liste des étudiants + « Ajouter » (nom obligatoire,
`external_id` optionnel) + suppression (refusée si des
`student_attendance` référencent — BR-22, message chiffré).
Service `student.service.ts` : `listByGroup`, `addStudent`,
`removeStudent`. IPC `students:list|add|remove`. Unicité
(groupe, external_id) déjà garantie par `ux_student_group_ext` →
violation UNIQUE interceptée en erreur de champ.

## 4. UI — `SessionDrawer` (partagé Timetable/Séances)

Onglet/section « Présences » visible uniquement si
`session.status === 'REALISEE'` :
- Pas d'étudiants au registre → formulaire comptage : présents /
  absents (InputNumber ≥0) + note + enregistrer/effacer.
- Étudiants présents → tableau nominatif : une ligne par étudiant
  (nom `dir="auto"`, groupe), segmented P/A/J ; boutons « Tous
  présents » / « Tous absents » ; compteur live ; enregistrer.
- Si des lignes nominatives existent déjà, ouvrir en mode nominatif ;
  sinon comptage par défaut, lien « passer en nominatif ».

## 5. IPC

`attendance:get|setCounts|setNominative|clear`, `students:*` —
guards habituels (`isId`, `isObject`, tableaux stricts), pas de
requireRole (BR-24).

## 6. Tests — `tests/presences.test.ts`

- getAttendance : modes NONE/COUNT/NOMINATIVE, roster multi-groupes
  (session_group + mm group).
- setCounts : écrit + relit ; refuse sur non-REALISEE, négatifs,
  note > 500, mode nominatif existant.
- setNominative : remplace l'ensemble, statuts valides, étudiants
  hors groupes refusés, counts recalculés (JUSTIFIE → absent),
  idempotent.
- clear : purge counts + nominatif, audit.
- students : add/list/remove, unicité external_id, suppression
  refusée si student_attendance lié (BR-22 chiffré).
- Audit explicite par mutation ; `withAudit` TX.

## 7. Noté / différé

- `JUSTIFIE` compté absent dans `absent_count` (règle comptable v1 —
  un justifié n'est pas présent ; la justification garde sa valeur
  disciplinaire au niveau nominatif).
- `student.external_id` = clé d'import Phase I ; pas de contrainte
  de format en saisie manuelle.
