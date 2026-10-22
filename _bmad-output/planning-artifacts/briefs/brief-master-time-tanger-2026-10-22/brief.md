---
title: "Cahier des charges — MasterTime Tanger"
status: draft
phase: "BMAD Phase 1 — Cadrage"
created: 2026-10-22
updated: 2026-10-22
---

# Cahier des charges — MasterTime Tanger

## 1. Contexte et enjeux

Le service administratif chargé des Masters de l'Université Abdelmalek Essaâdi (Tanger) gère aujourd'hui les emplois du temps de manière dispersée. **MasterTime Tanger** est une application desktop locale qui centralise la programmation, le suivi et le contrôle des emplois du temps de tous les Masters.

**Problème à résoudre :** absence d'outil unique pour générer les plannings sans conflit (salles, professeurs, Masters), suivre l'avancement pédagogique réel (séances faites / restantes / annulées / reportées), tracer les absences et produire des rapports fiables.

**Enjeu principal :** la fiabilité des données. Toute statistique affichée doit être calculée depuis la base locale — jamais saisie à la main. Une séance annulée n'est jamais comptée comme réalisée.

## 2. Acteurs

| Acteur | Rôle | Droits |
|---|---|---|
| **Administrateur** | Paramétrage global : salles, créneaux, jours fériés, utilisateurs, sauvegardes, restauration | Tout |
| **Gestionnaire** | Saisie et suivi quotidien : Masters, professeurs, séances, absences, reports, rapports | Tout sauf administration système |
| **Professeur** *(source de données)* | Déclare disponibilités et absences via le gestionnaire — pas d'accès direct prévu en v1 | — |
| **Responsable pédagogique** | Consultation des bilans d'avancement de son Master | Lecture (si compte créé) |

**Décidé (22/10/2026) :** application **mono-poste**, sans écran de connexion. Les rôles Admin/Gestionnaire sont conservés via un **sélecteur de profil** (attribution nominative dans l'audit, fonctions admin protégées). Le modèle `User` persiste en base pour permettre l'ajout ultérieur d'une authentification.

## 3. Périmètre fonctionnel

Modules obligatoires (détail des règles dans `addendum.md`) :

| # | Module | Résumé |
|---|---|---|
| A | Tableau de bord | Indicateurs calculés en direct : Masters, professeurs, modules, séances prévues/réalisées/restantes/annulées/reportées, absences, occupation des salles, prochaines séances, conflits |
| B | Gestion des Masters | CRUD + archivage ; modules rattachés avec volume horaire, professeur responsable, règles de répartition, dates de programmation, état d'avancement |
| C | Gestion des professeurs | Fiche complète : modules, Masters, disponibilités/indisponibilités, absences, compteurs de séances, heures enseignées ; suivi par semaine/mois/semestre/année |
| D | Emplois du temps | Vues hebdo globale, par Master, par professeur, par salle, mensuelle, annuelle ; filtres ; modification manuelle (déplacement, horaire, prof, salle, annulation) avec recalcul immédiat des conflits |
| E | Générateur automatique | Moteur de planification respectant 10 règles de contraintes ; prévisualisation + confirmation avant remplacement ; signalement explicite des séances non programmables et des contraintes incompatibles |
| F | Suivi des séances | Registre central ; statuts : Prévue / Réalisée / Non encore réalisée / Annulée / Reportée ; historique par séance ; distinction séance future vs passée non réalisée |
| G | Absences | Absences professeurs (séances impactées, décision : remplacement / report / annulation — jamais automatique) ; absences étudiants si registre disponible |
| H | Statistiques & rapports | 10 rapports obligatoires exportables PDF + Excel, filtrables par période et entité |
| I | Import / export | Import Excel/CSV avec aperçu, validation des champs, détection de doublons ; jamais d'écrasement silencieux ; export des données |
| J | Historique, sécurité, sauvegardes | Journal d'audit (qui/quand/quoi/anciennes-nouvelles valeurs) ; sauvegarde locale, restauration contrôlée, confirmations ; rôles admin / gestionnaire |

**Données initiales :** Amphithéâtre 7, Amphithéâtre 8, Salle 1 — configurables (ajout, désactivation, capacités).

## 4. Contraintes

- **100 % local** : Windows, aucune connexion Internet requise, aucun service cloud payant.
- **Stack retenue** : Electron + React + TypeScript + SQLite via **`node:sqlite`** (natif Node ≥ 22.5, aucune dépendance compilée) — *environnement vérifié* (Node 26.3, npm 11.5, Git 2.49). Spike de validation `node:sqlite`-dans-Electron prévu en Phase 3 avec `better-sqlite3` en repli.
- **Interface en français**, cible : personnel administratif non technique.
- **Installateur Windows** requis + mode développement.
- **Aucune donnée administrative réelle fictive** : uniquement des données de démonstration explicitement marquées jusqu'à l'import officiel.
- **Pas de planning « pretendument valide »** : si les contraintes dures sont incompatibles, le générateur le dit et propose des corrections.

## 5. Risques identifiés

| Risque | Impact | Mitigation |
|---|---|---|
| Compilation native de `better-sqlite3` sous Electron/Windows | Échec de build/install | Levé par le choix `node:sqlite` ; `better-sqlite3` reste le repli si le spike échoue |
| `node:sqlite` expérimental/incomplet dans la version Node d'Electron | Refonte accès DB | Spike Phase 3 (lecture/écriture/transactions dans Electron packagé) ; repli `better-sqlite3` |
| Génération automatique insatisfaisante (trop de séances non placées) | Rejet par les utilisateurs | Moteur itératif avec rapport d'échec détaillé ; prévisualisation obligatoire |
| Formats d'import officiels inconnus | Import bloqué en production | Gabarits Excel fournis par l'application ; mapping de colonnes configurable |
| ~~Données multi-utilisateurs~~ | — | Levé : décision mono-poste du 22/10/2026 |
| Mot de passe administrateur perdu (appli 100 % locale) | Blocage des fonctions admin | Procédure de réinitialisation locale documentée |
| Conflit non détecté lors d'une modification manuelle | Planning incohérent | Recalcul des conflits à chaque écriture + tests dédiés |

## 6. Critères d'acceptation (extraits — liste complète §10 du brief initial)

1. Démarrage Windows hors ligne ; persistance après redémarrage.
2. Import des données officielles avec validation et rapport d'erreurs.
3. Génération automatique respectant toutes les contraintes dures, ou refus explicite motivé.
4. Modifications manuelles avec détection de conflits immédiate.
5. Chaque séance : statut + historique complet.
6. Statistiques recalculées depuis les séances enregistrées (vérifié par tests).
7. Rapports PDF/Excel exploitables.
8. Sauvegarde et restauration testées.

## 7. Méthode et jalons

Méthode BMAD en 12 phases (Phase 1 = ce document ; Phase 12 = installateur + documentation). Passage à la phase suivante uniquement après validation des critères d'acceptation de la phase courante.

## 8. Décisions actées (22/10/2026)

| # | Décision | Choix |
|---|---|---|
| 1 | Usage | **Mono-poste** — SQLite local, pas de partage réseau |
| 2 | Driver SQLite | **`node:sqlite`** (repli : `better-sqlite3` si spike Electron concluant négatif) |
| 3 | Présence étudiants | **Périmètre v1** — `StudentAttendance` + écrans exposés |
| 4 | Authentification | **Mono-utilisateur** — pas de login ; rôles via sélecteur de profil (Admin/Gestionnaire), audit nominatif, modèle `User` conservé |

**Restent ouverts** (hypothèses `[ASSUMPTION]` appliquées en Phase 2 si non tranchés) : format des fichiers officiels d'import, jours ouvrables/durées de séance/plage horaire réels, bascule auto vs manuelle des séances non réalisées, impression directe des vues, arabe/RTL, politique de rétention des sauvegardes.
