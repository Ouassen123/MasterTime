---
title: "Addendum PRD — Catalogue des cas d'utilisation et contraintes détaillées"
parent: prd.md
created: 2026-10-22
---

# Addendum Phase 2 — MasterTime Tanger

## A. Catalogue des cas d'utilisation (CU)

Format : acteur / déclencheur / flux nominal / flux alternatif / erreur. UJ-1…UJ-6 du PRD sont les parcours phares ; ce catalogue est exhaustif par acteur.

### Acteur : Gestionnaire (toutes les opérations courantes)

| CU | Nom | Flux nominal | Alternatif / erreur |
|---|---|---|---|
| CU-01 | Créer un Master | Saisie code+nom, filière, semestre, responsable → modules rattachés avec volumes | Code dupliqué → refus ; champ requis manquant → erreur champ |
| CU-02 | Définir un MasterModule | Choix module + prof responsable, volume, durée séance, nb séances, fenêtre | Volume incompatible avec nb×durée → avertissement de cohérence |
| CU-03 | Fiche professeur | CRUD + disponibilités hebdo + indisponibilités datées | Disponibilités vides → séances jamais plaçables (signalé en génération) |
| CU-04 | Gérer salles | CRUD Amphi 7/8/Salle 1…, capacité, actif/inactif | Désactiver une salle avec séances futures → confirmation + séances listées à replacer |
| CU-05 | Saisir séance réalisée | Sélection séance → date/heures réelles → confirmer | Séance déjà annulée → refus ; heures incohérentes → alerte |
| CU-06 | Annuler une séance | Motif obligatoire → statut ANNULÉE + historique | — |
| CU-07 | Reporter une séance | Choix nouveau créneau → contrôle conflits → REPORTÉE + nouvelle programmation | Conflit dur → refus motivé (BR-10) |
| CU-08 | Déplacer une séance (calendrier) | Drag & drop ou édition → contrôle conflits immédiat | Idem CU-07 |
| CU-09 | Déclarer absence professeur | Dates + motif → liste des séances impactées | Absence sans séance impactée → enregistrée quand même |
| CU-10 | Résoudre séances impactées | Par séance : remplacer (choix prof dispo) / reporter / annuler | Remplaçant indisponible → refus ; absence clôturée quand toutes traitées |
| CU-11 | Saisir présence étudiants | Séance réalisée → nb présents/absents ou liste nominative | Effectif > inscrits → alerte |
| CU-12 | Générer planning auto | Paramètres → lancer → prévisualiser diff → confirmer | Insoluble → rapport d'incompatibilités ; partiel → non placées expliquées |
| CU-13 | Filtrer les vues EDT | Hebdo globale / Master / prof / salle / mois / année + filtres | Aucune donnée → état vide explicite |
| CU-14 | Importer fichier officiel | Fichier → aperçu → erreurs/doublons → stratégie → valider | Colonnes manquantes → mapping manuel proposé |
| CU-15 | Exporter rapport | Choix rapport + filtres période/entité → PDF ou Excel | Rapport vide → export quand même avec mention « aucune donnée » |
| CU-16 | Consulter tableau de bord | Indicateurs temps réel + conflits + prochaines séances | — |

### Acteur : Administrateur (en plus du rôle gestionnaire)

| CU | Nom | Spécificité |
|---|---|---|
| CU-17 | Configurer créneaux/pauses/jours ouvrables | Grille de TimeSlots + exceptions calendaires (fériés, examens, vacances) |
| CU-18 | Gérer profils utilisateurs | Créer/désactiver profils Admin/Gestionnaire (pas de mdp en v1) |
| CU-19 | Sauvegarder la base | Copie horodatée + BackupHistory |
| CU-20 | Restaurer | Avertissement fort + confirmation + audit |
| CU-21 | Consulter AuditLog | Filtres par date/profil/action/entité |
| CU-22 | Purger les données DÉMO | Confirmation ; impossible si mélangées à des données officielles importées non distinguables — d'où marquage à la source |
| CU-23 | Archiver année universitaire | Fige les données passées hors génération |

## B. Matrice des contraintes du générateur

| Contrainte | Type | Source | Violation détectée par |
|---|---|---|---|
| Chevauchement salle | Dure | BR-7 | contrôle à l'écriture + moteur |
| Chevauchement professeur | Dure | BR-7 | idem |
| Chevauchement Master/groupe | Dure | BR-7 | idem |
| Disponibilité professeur | Dure | BR-8 | idem |
| Absence professeur | Dure | BR-8 | idem |
| Créneaux autorisés | Dure | BR-8 | idem |
| Exceptions calendaires | Dure | BR-8 | idem |
| Capacité salle | Dure si renseignée | BR-9 | idem |
| Volume horaire module | Dure (tolérance param.) | BR-12 | bilan de génération |
| Préférences programmation | Souple (promotable) | BR-13 | score d'optimisation |
| Charge max/jour | Souple | BR-13 | score d'optimisation |
| Répartition équilibrée | Souple | BR-13 | score d'optimisation |

## C. Décisions et hypothèses reportées de Phase 1

- Mono-poste ; `node:sqlite` ; StudentAttendance v1 ; profils sans login — actés 22/10/2026.
- Assumptions Q1–Q8 du PRD §9 à lever au plus tard en Phase 3 (architecture) pour Q1/Q2, Phase 5 (données) pour Q3.

## D. Trace vers les tests obligatoires (Phase 11)

| Exigence test | Règle couverte |
|---|---|
| Chevauchements salle/prof/Master | BR-7 |
| Disponibilités + absences | BR-8, BR-17 |
| Heures réalisées, séances restantes | BR-1, BR-2, BR-6 |
| Annulations et reports | BR-2, BR-3, BR-5 |
| Génération auto + échec honnête | BR-12→BR-15 |
| Modifications manuelles | BR-10, BR-11 |
| Import/export | BR-21 |
| Sauvegarde/restauration | BR-23 |
