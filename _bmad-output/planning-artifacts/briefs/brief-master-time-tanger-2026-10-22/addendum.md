---
title: "Addendum — Règles métier détaillées, modèle de données, inventaire technique"
parent: brief.md
created: 2026-10-22
---

# Addendum Phase 1 — MasterTime Tanger

## A. Règles métier détaillées

### A.1 Cycle de vie d'une séance

- Statuts : `PRÉVUE` → `RÉALISÉE` | `ANNULEE` | `REPORTÉE` ; une séance passée non réalisée = `NON_ENCORE_REALISEE` (calculé ou basculé explicitement — à trancher en Phase 2).
- `RÉALISÉE` : exige date réelle, heures réelles, confirmation. Peut différer de la programmation prévue.
- `ANNULEE` : exige date d'annulation, motif, auteur. Jamais comptée comme réalisée.
- `REPORTÉE` : conserve l'ancienne programmation (trace) + nouvelle date/créneau.
- Toute transition de statut écrit dans `SessionStatusHistory`.

### A.2 Absences professeur

- Une absence déclarée **n'annule pas automatiquement** les séances. Le gestionnaire choisit par séance impactée : remplacement (autre prof), report, ou annulation. État de résolution suivi sur l'absence.

### A.3 Contraintes du moteur de génération

**Dures (bloquantes) :**
1. Pas de chevauchement de salle. 2. Pas de chevauchement professeur. 3. Pas de chevauchement pour un même Master. 4. Respect des disponibilités/absences du professeur. 5. Créneaux autorisés uniquement. 6. Volumes horaires des modules respectés. 7. Capacité de salle si renseignée. 8. Exclusion jours fériés / périodes d'examen / jours non ouvrables.

**Souples (optimisation) :** préférences de programmation, répartition équilibrée, évitement des journées surchargées. Configurable : une préférence peut être promue en contrainte dure.

**Échec honnête :** si insoluble → liste des contraintes incompatibles + suggestions (assouplir disponibilité, ajouter créneau, changer salle, réduire volume). Aucune écriture en base.

### A.4 Import

- Aperçu obligatoire, validation des champs requis, rapport de doublons et d'erreurs ligne par ligne.
- Stratégie de conflit explicite par l'utilisateur (ignorer / fusionner / remplacer) — jamais d'écrasement silencieux.
- Gabarits Excel/CSV fournis par l'application.

### A.5 Audit, rôles, sauvegardes

- `AuditLog` : utilisateur, date/heure, action, entité, anciennes/nouvelles valeurs (quand pertinent).
- Rôles v1 : `administrateur`, `gestionnaire`. Fonctions admin protégées (paramètres, utilisateurs, restauration, suppression majeure).
- Sauvegarde = copie horodatée de la base ; restauration avec confirmation et journalisation ; rétention à définir.

## B. Modèle de données — inventaire (Phase 3 pour le schéma complet)

`AcademicYear`, `Semester`, `Master`, `Module`, `MasterModule` (volume horaire, prof responsable, nb/durée séances, règles de répartition, dates de programmation), `Professor`, `ProfessorAvailability`, `ProfessorAbsence`, `Room` (capacité, actif), `TimeSlot` (jours ouvrables, créneaux, pauses), `CalendarException` (fériés, examens), `Session` (statut courant + dates prévue/réelle + durées prévue/effective), `SessionStatusHistory`, `StudentGroup`, `StudentAttendance` (optionnel), `ScheduleGeneration` (paramètres, résultat, prévisualisation), `User`, `AuditLog`, `BackupHistory`.

Index prévisibles : `Session(date, roomId)`, `Session(professorId)`, `Session(masterId)`, `Session(status)`.

## C. Décisions Phase 1 actées (22/10/2026)

- **Mono-poste** : un seul PC, fichier SQLite dans `%APPDATA%/MasterTimeTanger/` (emplacement exact fixé en Phase 3). Pas de mode réseau.
- **`node:sqlite`** : driver retenu. Attention : API stabilisée Node ≥ 22.5 mais marquée expérimentale dans certaines versions ; vérifier la version Node de l'Electron cible (Electron ≥ 37 embarque Node 22+). Spike obligatoire Phase 3 : open/close, transactions, FK, WAL, dans un build packagé.
- **StudentAttendance en v1** : registre étudiants importable + feuilles de présence par séance (présents/absents/justifiés). Écrans inclus au planning.
- **Mono-utilisateur** : pas de login. Sélecteur de profil Admin/Gestionnaire ; `AuditLog.userId` rempli via le profil courant ; fonctions admin (paramètres système, utilisateurs, restauration, suppressions majeures) masquées/bloquées en profil Gestionnaire. Table `User` conservée pour évolutivité.

## D. Environnement vérifié (22/10/2026)

| Outil | Version | Verdict |
|---|---|---|
| Node.js | 26.3.0 | OK — inclut `node:sqlite` natif |
| npm | 11.5.2 | OK |
| Python | 3.13.2 | OK (outillage) |
| Git | 2.49.0 | OK |

Point d'attention : `better-sqlite3` requiert des binaires natifs pour la version Node embarquée dans Electron — prévoir un test de packaging dès la Phase 3, ou baser l'accès DB sur `node:sqlite` / un driver WASM.

## E. Données de démonstration (Phase 5+)

Jeu marqué `DÉMO` : 3 Masters fictifs, ~8 professeurs fictifs, 3 salles réelles (Amphi 7, Amphi 8, Salle 1), volumes horaires plausibles, disponibilités variées, au moins une absence et un report pour exercer les parcours.

## F. Informations manquantes relevées en Phase 1

1. Nombre réel de Masters / professeurs / modules à absorber en production.
2. Existence et format des fichiers sources officiels (Excel ? papier ?).
3. Organisation temporelle réelle : jours ouvrables (sam. ?), durées de séance usuelles, créneaux institutionnels, calendrier des examens.
4. Usage mono-poste ou simultané multi-agents.
5. Existence d'un registre étudiants exploitable pour les présences.
6. Politique de conservation des sauvegardes et de l'audit.
7. Un ou plusieurs départements/filières concernés (périmètre exact).
8. Besoin d'impression directe des emplois du temps affichés (vs export PDF).
