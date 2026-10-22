---
title: "PRD — MasterTime Tanger"
status: draft
phase: "BMAD Phase 2 — Règles métier, contraintes, cas d'utilisation"
created: 2026-10-22
updated: 2026-10-22
---

# PRD : MasterTime Tanger

## 0. Objet du document

Ce PRD est destiné aux phases BMAD suivantes (architecture, UX, épics/stories, développement). Il fixe le vocabulaire (§3 Glossaire — à employer verbatim), les règles métier numérotées **BR-n**, les exigences fonctionnelles **FR-n** regroupées par module, les exigences non fonctionnelles **NFR-n**, et les cas d'utilisation **UJ-n**. Il s'appuie sur le cahier des charges Phase 1 (`planning-artifacts/briefs/brief-master-time-tanger-2026-10-22/`) sans le dupliquer.

## 1. Vision

MasterTime Tanger est une application desktop Windows, 100 % locale, qui permet au service administratif des Masters de l'Université Abdelmalek Essaâdi de **générer, modifier, suivre et auditer** les emplois du temps de tous les Masters depuis un seul outil. La promesse centrale : **un planning sans conflit, un suivi honnête**. Le générateur ne produit jamais de planning prétendument valide ; une séance annulée n'est jamais comptée comme réalisée ; chaque modification laisse une trace.

## 2. Utilisateurs cibles

### 2.1 Jobs To Be Done

- *« Quand le semestre démarre, je veux générer les emplois du temps de tous les Masters sans conflit de salle ni de professeur, au lieu de les assembler à la main. »*
- *« Quand un professeur signale une absence, je veux voir immédiatement les séances impactées et décider : remplacement, report ou annulation. »*
- *« Quand un responsable me demande où en est un Master, je veux un chiffre fiable : séances faites, restantes, heures enseignées. »*
- *« Quand je modifie une séance à la main, je veux être bloqué si cela crée un conflit — pas le découvrir plus tard. »*

### 2.2 Non-utilisateurs (v1)

- **Professeurs** : pas d'accès direct ; leurs disponibilités/absences sont saisies par le gestionnaire.
- **Étudiants** : pas d'accès ; présences saisies par le gestionnaire (registre importable).
- **Autres établissements / niveaux** (Licence, Doctorat) : hors périmètre v1.

### 2.3 Cas d'utilisation clés (UJ)

**UJ-1. Fatima génère les emplois du temps du semestre.**
Fatima, gestionnaire, profil Admin actif. Elle a importé Masters, professeurs, modules et disponibilités. Elle ouvre *Génération automatique*, vérifie les paramètres (année, semestre, créneaux, jours fériés), lance la génération. Le moteur produit un planning prévisualisé : 94 % des séances placées, 3 non programmables avec explications (« Prof. X indisponible sur tous les créneaux du module M »). Elle ajuste une disponibilité, relance, obtient 100 %, prévisualise le diff, confirme le remplacement. → Réalise FR génération + prévisualisation. *Cas limite :* une contrainte dure insoluble → liste des incompatibilités affichée, **aucune écriture** en base.

**UJ-2. Fatima traite l'absence d'un professeur.**
Le Prof. B signale une absence de 2 semaines. Fatima l'enregistre : l'écran liste les 6 séances impactées. Pour chacune elle décide : 2 remplacées par le Prof. C, 3 reportées (nouveau créneau proposé sans conflit), 1 annulée avec motif. L'absence passe à l'état « résolue ». Les compteurs du professeur se mettent à jour : annulée ≠ réalisée. *Cas limite :* report sur un créneau déjà occupé → conflit signalé, proposition refusée.

**UJ-3. Karim importe les données officielles.**
Karim, gestionnaire, reçoit le fichier Excel officiel des modules. Il l'importe : aperçu affiché, 2 erreurs de champs obligatoires et 4 doublons signalés ligne par ligne. Il corrige, choisit « ignorer les doublons », valide. Rien d'existant n'a été écrasé sans son choix explicite.

**UJ-4. Fatima déplace une séance à la main.**
Sur la vue hebdomadaire, elle glisse une séance du mardi au jeudi. Le recalcul de conflits est immédiat : salle libre, professeur disponible → déplacement accepté, historique mis à jour. *Cas limite :* chevauchement détecté → refus avec motif précis.

**UJ-5. Le responsable consulte l'avancement de son Master.**
Fin de mois : tableau de bord filtré sur son Master — séances prévues/réalisées/restantes, heures enseignées par module, séances reportées. Il exporte le bilan PDF pour la réunion pédagogique.

**UJ-6. Fatima restaure une sauvegarde après une erreur.**
Une série de suppressions erronées. Elle ouvre *Sauvegardes*, choisit la copie de la veille, lit l'avertissement « les données actuelles seront remplacées », confirme. Restauration journalisée dans l'audit.

## 3. Glossaire

- **Master** — Formation de niveau Master identifiée par code + nom, rattachée à filière/département, semestre(s) et année universitaire. Archivable, jamais supprimée si des séances existent.
- **Module** — Unité d'enseignement. Rattaché à un ou plusieurs Masters via **MasterModule**.
- **MasterModule** — Association Master↔Module portant : professeur responsable, volume horaire prévu, durée de séance, nombre de séances prévues, règles de répartition, dates de début/fin de programmation.
- **Séance** — Occurrence planifiée d'un MasterModule : Master + module + professeur + salle + date + heure début/fin + statut + commentaire.
- **Créneau (TimeSlot)** — Plage horaire autorisée un jour ouvrable (ex. lundi 08:00–10:00). Une Séance occupe un ou plusieurs créneaux contigus.
- **Statut de Séance** — `PRÉVUE`, `RÉALISÉE`, `NON_ENCORE_RÉALISÉE`, `ANNULÉE`, `REPORTÉE`. Statut courant sur la Séance ; historique complet dans SessionStatusHistory.
- **Conflit** — Violation d'une contrainte dure (chevauchement salle/professeur/Master, indisponibilité, capacité). Détecté à chaque écriture.
- **Disponibilité** — Plage où un professeur peut enseigner ; **Indisponibilité** = l'inverse ; **Absence** = période datée avec motif, distincte de l'indisponibilité récurrente.
- **Exception calendaire** — Jour férié, période d'examen, jour non ouvrable ponctuel : aucune Séance ne peut y être placée.
- **Préférence** — Règle souple du générateur (répartition, charge max/jour, préférences de programmation). Promotable en contrainte dure par configuration.
- **Génération** — Exécution du moteur produisant un planning candidat en prévisualisation, jamais appliqué sans confirmation.
- **Profil** — Rôle applicatif : `ADMINISTRATEUR` ou `GESTIONNAIRE`, sélectionné sans mot de passe (décision Phase 1). Attribue les actions dans l'AuditLog.
- **Donnée DÉMO** — Toute donnée de démonstration, marquée et filtrable, purgable d'un geste avant l'import officiel.

## 4. Règles métier

### 4.1 Cycle de vie des Séances

- **BR-1** — Une Séance `RÉALISÉE` exige : date réelle, heures réelles, confirmation explicite. Les heures réelles peuvent différer des heures prévues ; les statistiques utilisent les heures **réelles**.
- **BR-2** — Une Séance `ANNULÉE` exige : date d'annulation, motif, auteur. Elle ne compte **jamais** comme réalisée ni dans les heures enseignées.
- **BR-3** — Une Séance `REPORTÉE` conserve la trace de l'ancienne programmation et porte la nouvelle date/créneau. Le report est une transition historisée, pas une nouvelle séance.
- **BR-4** — Une Séance passée sans confirmation devient `NON_ENCORE_RÉALISÉE`. *[ASSUMPTION : bascule calculée automatiquement à la lecture (date prévue < aujourd'hui et statut = PRÉVUE), sans job nocturne — application desktop. À confirmer.]*
- **BR-5** — Toute transition de statut écrit une ligne SessionStatusHistory (ancien statut, nouveau, date, auteur, motif, anciennes/nouvelles valeurs de programmation).
- **BR-6** — « Non encore réalisée » ≠ « prévue » : les compteurs les distinguent (retard affiché en jours).

### 4.2 Conflits — contraintes dures

- **BR-7** — Deux Séances non annulées ne peuvent pas se chevaucher sur : même salle, même professeur, même Master (ni même groupe d'étudiants si groupes utilisés).
- **BR-8** — Une Séance doit tenir dans les disponibilités du professeur, hors absences, hors exceptions calendaires, dans des créneaux autorisés.
- **BR-9** — Si une capacité de salle est renseignée et l'effectif du groupe/Master connu, elle est bloquante.
- **BR-10** — Les modifications manuelles subissent les mêmes contrôles que le générateur : un conflit dur **bloque** l'écriture (pas d'avertissement contournable en v1). *[ASSUMPTION : pas d'override admin — à confirmer.]*
- **BR-11** — Les conflits sont recalculés immédiatement après toute écriture sur une Séance et reflétés au tableau de bord.

### 4.3 Génération automatique

- **BR-12** — Le moteur respecte les volumes horaires : Σ durées planifiées d'un MasterModule = volume prévu (tolérance 0 en v1, paramétrable).
- **BR-13** — Équilibre recherché : répartition régulière dans la fenêtre [début, fin de programmation], charge max par jour paramétrable. Les préférences sont optimisées, jamais au détriment des contraintes dures.
- **BR-14** — Résultat = prévisualisation (diff vs planning existant) ; remplacement uniquement après confirmation explicite.
- **BR-15** — Séances non programmables listées avec explication par séance (contrainte(s) responsable(s)) + suggestions correctives. Si le planning est insoluble globalement, incompatibilités affichées, rien n'est écrit.
- **BR-16** — Une Génération est tracée (paramètres, date, auteur, résultat : placées/non placées/appliquée ou non).

### 4.4 Absences

- **BR-17** — Une Absence professeur n'annule jamais automatiquement. Chaque Séance impactée reçoit une décision : remplacement / report / annulation, par le gestionnaire.
- **BR-18** — L'Absence porte un état de résolution (à traiter / partielle / résolue) dérivé des décisions sur ses Séances impactées.
- **BR-19** — Présences étudiants : par Séance, nombre présents/absents + liste nominative facultative issue du registre importé ; justification individuelle possible.

### 4.5 Intégrité et audit

- **BR-20** — Toute création/modification/suppression métier écrit dans AuditLog : profil, date/heure, action, entité, anciennes/nouvelles valeurs.
- **BR-21** — Aucun écrasement silencieux à l'import : conflits présentés, stratégie choisie (ignorer/fusionner/remplacer) par lot.
- **BR-22** — Archivage ≠ suppression : un Master/archivable reste lisible et hors génération. Suppression réelle = confirmée + refusée si des Séances existent.
- **BR-23** — Sauvegarde = copie horodatée de la base + entrée BackupHistory. Restauration : avertissement, confirmation, journalisation. *[ASSUMPTION : rétention des 10 dernières sauvegardes, rotation automatique — à confirmer.]*
- **BR-24** — Fonctions réservées au profil ADMINISTRATEUR : paramètres système (créneaux, fériés, salles au sens administratif), gestion des profils, sauvegarde/restauration, purges. Le GESTIONNAIRE gère tout le reste.

## 5. Exigences fonctionnelles

*Regroupées par module ; identifiants FR-n globaux et stables.*

**Module A — Tableau de bord** — FR-1 afficher les compteurs Masters/professeurs/modules/séances (prévues, réalisées, restantes, annulées, reportées) et absences, calculés depuis la base. FR-2 occupation par salle. FR-3 prochaines séances. FR-4 conflits à résoudre. FR-5 filtres année/semestre/Master.

**Module B — Masters** — FR-6 CRUD + recherche + archivage. FR-7 gérer les MasterModules (prof responsable, volume horaire, durée/nb de séances, règles de répartition, fenêtre de programmation). FR-8 état d'avancement pédagogique calculé. FR-9 groupes d'étudiants par MasterModule si nécessaire.

**Module C — Professeurs** — FR-10 fiche CRUD : coordonnées facultatives, identifiant interne facultatif. FR-11 disponibilités/indisponibilités. FR-12 absences déclarées. FR-13 compteurs : réalisées/restantes/annulées/reportées + heures réellement enseignées. FR-14 fiche de suivi par semaine/mois/semestre/année.

**Module D — Emplois du temps** — FR-15 vue hebdomadaire tous Masters. FR-16 vue par Master. FR-17 vue par professeur. FR-18 vue par salle. FR-19 vue mensuelle/calendrier. FR-20 vue annuelle. FR-21 chaque Séance affiche : Master, module, professeur, salle, date, début/fin, durée, statut, commentaire. FR-22 filtres : année, semestre, Master, professeur, module, salle, statut. FR-23 modification manuelle : déplacer, horaire, professeur, salle, annuler — avec contrôle BR-10 et historisation.

**Module E — Générateur** — FR-24 générer tous Masters ou sous-ensemble. FR-25 respecter BR-7→BR-15. FR-26 configurer créneaux, pauses, jours ouvrables, fériés, périodes d'examen, indisponibilités. FR-27 prévisualisation + diff + confirmation. FR-28 rapport d'échec détaillé (BR-15). FR-29 génération équilibrée (BR-13).

**Module F — Suivi des séances** — FR-30 registre central filtrable des Séances avec statut. FR-31 historique par Séance. FR-32 saisie « réalisée » avec date/heures réelles + confirmation. FR-33 annulation avec motif/auteur. FR-34 report avec trace d'ancienne programmation. FR-35 calcul du retard et du reste à effectuer.

**Module G — Absences** — FR-36 enregistrer absence professeur (date, durée, motif) + lister Séances impactées. FR-37 décision par Séance : remplacer/reporter/annuler (BR-17). FR-38 état de résolution de l'absence. FR-39 présences étudiants par Séance (effectifs, liste nominative, justifications).

**Module H — Statistiques & rapports** — FR-40 produire les 10 rapports obligatoires (EDT hebdo/Master, global salles, programme prof, bilan heures prévues/effectuées, séances non réalisées, annulées/reportées, absences, avancement Master, occupation salles semaine/mois, conflits + restant à programmer). FR-41 export PDF. FR-42 export Excel. FR-43 filtres période + entité. FR-44 toutes statistiques calculées, jamais saisies.

**Module I — Import/export** — FR-45 import Excel/CSV : Masters, professeurs, modules, volumes, EDT existants, disponibilités, étudiants. FR-46 aperçu + validation champs requis + doublons + erreurs par ligne. FR-47 stratégie de conflit explicite (BR-21). FR-48 export données et emplois du temps. FR-49 gabarits téléchargeables.

**Module J — Historique, sécurité, sauvegardes** — FR-50 journal AuditLog consultable. FR-51 sauvegarde locale horodatée. FR-52 restauration contrôlée. FR-53 confirmation avant suppression majeure. FR-54 sélecteur de profil Admin/Gestionnaire appliquant BR-24.

## 6. Exigences non fonctionnelles

- **NFR-1** Fonctionnement 100 % hors ligne, données dans un fichier SQLite local. — **NFR-2** Persistance garantie après fermeture/redémarrage. — **NFR-3** Interface 100 % française. — **NFR-4** Stack : Electron + React + TypeScript + `node:sqlite` (repli `better-sqlite3`). — **NFR-5** Installateur Windows + mode développement. — **NFR-6** Détection de conflits immédiate à l'écriture (perçue < 1 s). — **NFR-7** Génération ≤ *[ASSUMPTION : 60 s pour un semestre complet]*. — **NFR-8** Tests automatisés couvrant les 12 familles du §7 brief. — **NFR-9** Aucune donnée réelle fictive ; DÉMO marqué et purgable. — **NFR-10** Aucun service cloud/compte/payant requis.

## 7. Indicateurs de succès

- Planning semestriel généré sans conflit dur résiduel ; 0 séance placée en violation de BR-7→BR-9 (vérifié par tests).
- 100 % des transitions de statut historisées ; statistiques recalculables depuis les Séances seules.
- Import officiel réussi sans perte silencieuse ; restauration de sauvegarde éprouvée.

## 8. Hors périmètre v1

Multi-poste/réseau, accès professeur ou étudiant, notifications (mail/SMS), authentification par mot de passe, EDT Licences/Doctorats, emplois du temps d'examens.

## 9. Questions ouvertes

| # | Question | Hypothèse appliquée si non tranché |
|---|---|---|
| Q1 | Bascule `NON_ENCORE_RÉALISÉE` automatique ? | Oui, calculée à la lecture (BR-4) |
| Q2 | Override admin d'un conflit dur ? | Non en v1 (BR-10) |
| Q3 | Jours ouvrables, horaires, durées usuelles ? | Lun–Sam, 08h–19h, séances 1h30/2h/3h — paramétrables |
| Q4 | Format des fichiers officiels ? | Gabarits Excel/CSV fournis + mapping |
| Q5 | Rétention sauvegardes ? | 10 dernières, rotation auto (BR-23) |
| Q6 | Impression directe des vues ? | Non, export PDF suffit |
| Q7 | Arabe / RTL ? | Non v1 ; i18n non bloquée par le design |
| Q8 | Périodes sans cours (vacances) distinctes des fériés ? | Oui, via exceptions calendaires |
