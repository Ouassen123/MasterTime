# MasterTime Tanger — Guide utilisateur

Gestion des emplois du temps des Masters — FSJP Tanger
(Université Abdelmalek Essaâdi).

---

## 1. Installation

1. Récupérez l'installateur `MasterTime Tanger Setup x.y.z.exe`.
2. Double-cliquez : l'installation se fait **dans votre compte
   utilisateur, sans droits administrateur**. Vous pouvez changer le
   dossier d'installation à l'écran proposé.
3. Des raccourcis sont créés sur le **Bureau** et dans le **menu
   Démarrer** (« MasterTime Tanger »).

La désinstallation passe par *Paramètres Windows → Applications*.

## 2. Premier lancement

Au premier démarrage, l'application crée sa base de données dans
`%APPDATA%\MasterTime Tanger\mastertime.db` et y charge
**automatiquement les données réelles FSJP** : salles, Masters du
semestre, professeurs, modules, séances de la programmation officielle
et occupations des salles par les Licences. Aucune saisie initiale
n'est nécessaire.

> **Bases dev et installée séparées** — l'application installée et la
> version de développement n'utilisent pas le même dossier de données.
> Pour transférer vos données : *Sauvegardes* → nouvelle sauvegarde →
> copiez le fichier `.db` → restaurez-le dans l'autre environnement
> (voir §10).

### Bandeau DÉMO

Si un bandeau « DÉMO » apparaît, la base contient des données de
démonstration (marqueur interne `is_demo`). En usage normal cela ne se
produit pas sur une installation fraîche.

## 3. Profils et droits

En haut à droite, un sélecteur permet de choisir le profil actif
(**sans mot de passe**) :

| Profil | Droits |
|---|---|
| **GESTIONNAIRE** | Consultation, référentiels, séances, génération, absences, présences, rapports, export CSV |
| **ADMIN** | Tout le GESTIONNAIRE **+** import CSV, Paramètres, Sauvegardes/Restauration |

Les droits sont vérifiés côté application (processus principal), pas
seulement dans l'interface : un gestionnaire ne peut pas contourner les
restrictions. Les pages *Paramètres* et *Sauvegardes* sont masquées en
profil gestionnaire ; l'import est refusé côté serveur.

Le sélecteur d'**année universitaire + semestre** en haut de
l'écran fixe le contexte affiché par les écrans (génération, registre,
rapports).

## 4. Navigation

| Menu | Contenu |
|---|---|
| Dashboard | État de la base, compteurs du référentiel |
| Masters | Référentiel des Masters (groupes, modules rattachés) |
| Professeurs | Référentiel + fiche de suivi (séances, disponibilités, absences) |
| Modules | Catalogue des modules |
| Salles | Salles et capacités |
| Emplois du temps | Calendrier en lecture (semaine/mois/année) + conflits |
| Génération | Génération automatique, historique, previews |
| Séances | Registre central paginé de toutes les séances |
| Rapports | 10 rapports + exports CSV/PDF |
| Import/Export | Import CSV avec aperçu, export CSV des entités |
| Paramètres *(admin)* | Créneaux horaires, exceptions, rétention |
| Sauvegardes *(admin)* | Sauvegarde, restauration, historique |

## 5. Référentiels

### Masters

Table avec recherche (code, nom, filière), filtre par statut et
compteurs. Clic sur une ligne → fiche à onglets :

- **Infos** : compteurs (séances prévues/réalisées…) ;
- **Modules** : rattacher un module du catalogue (professeur titulaire,
  nombre de séances planifiées, fenêtre de programmation, quota/jour) —
  c'est ce rattachement qui rend le module « génératable » ;
- **Groupes** : ajouter/renommer/supprimer les groupes d'étudiants
  (les étudiants se gèrent depuis la fiche du groupe / l'import CSV) ;
- **Séances** : les 20 prochaines séances du master.

La suppression d'un master est **protégée** : si des données y sont
rattachées, le refus chiffré propose l'**archivage** à la place.

### Professeurs

Table avec recherche (nom, référence, email), filtre actif/inactif et
compteurs de suivi. Clic → **fiche de suivi** à onglets :

- **Séances** : les 20 prochaines séances du professeur ;
- **Disponibilités** : créneaux DISPO / INDISPO déclarés (pris en
  compte par la génération et le blocage de conflits) ;
- **Absences** : déclaration et suivi (voir §8) ;
- **Compteurs** : synthèse chiffrée.

La suppression est protégée : en cas de données liées, le refus propose
la **désactivation** (`is_active=0` — le professeur reste dans
l'historique mais n'est plus proposé).

### Modules et Salles

Tables + formulaires classiques. Les salles ont une capacité et un
drapeau actif ; la suppression protégée propose la désactivation.

## 6. Emplois du temps

Lecture seule, plusieurs vues :

- **Semaine** : grille Lun→Dim, 07:00→20:00, tous les masters ou
  filtrée par Master / Professeur / Salle. Les séances qui se
  chevauchent sont affichées en voies côte à côte. Les séances sont
  colorées par **statut effectif** : prévue, réalisée, annulée,
  reportée, *non encore réalisée* (prévue mais dont la date est
  passée).
- **Mois** et **Année** : synthèses par semaine/master.
- Vue **Salle** : les **occupations Licence** (occupations externes,
  saisies en référentiel) apparaissent en gris — elles bloquent la
  génération et l'édition tout comme un cours.

**Panneau de conflits** (volet droit repliable) : liste persistante
des chevauchements restés en base (ex. collisions présentes dans les
documents officiels). Cliquez une séance → **fiche de détail** (drawer)
avec toutes les informations et les actions d'édition.

## 7. Génération automatique

Menu **Génération** — trois zones :

1. **Paramètres** : semestre (défaut = contexte), sélection des
   master-modules (vide = tout le semestre), mode, plage de dates
   (défaut = fenêtre de programmation commune), pause entre créneaux,
   séances max/jour par master.
2. **Historique** : toutes les générations (date, auteur, mode, séances
   placées / non placées, statut) — un clic rouvre le détail.
3. **Preview** : la génération n'écrit **jamais rien tant que vous
   n'appliquez pas** — résumé chiffré, avertissements, liste des
   séances proposées, échecs partiels expliqués (raisons +
   suggestions : salle trop petite, indisponibilité, fenêtre trop
   courte…).

### Modes

- **COMPLETE** : propose des séances pour combler le reliquat de chaque
  module (séances planifiées − déjà en base). N'annule rien.
- **REGENERATE** : repropose **toutes** les séances des modules
  sélectionnés sur la plage — chaque proposition montre la séance
  existante qu'elle remplacerait (diff complet). À l'application, les
  anciennes séances passent à *annulée* (jamais supprimées : motif
  tracé, audit).

### Modules fixés

Dans la fiche d'un master (onglet Modules) ou la liste de génération,
un master-module peut être **fixé** (badge « Fixé ») :

- `REGENERATE` **ignore** totalement un module fixé (ses séances sont
  gelées) ;
- `COMPLETE` continue de le traiter s'il reste des séances à placer.

Usage typique : vous avez ajusté manuellement un module → fixez-le
avant de régénérer le reste du semestre.

### Application et conflits

- **Appliquer** insère les séances (statut *prévue*) — une Popconfirm
  rappelle les chiffres. Si le monde a changé depuis la preview
  (séance créée entre-temps…), l'application est **refusée** et une
  modale liste les conflits détaillés : relancez une preview à jour.
- **Abandonner** clôt la preview sans rien écrire.

## 8. Séances, modification manuelle et conflits

### Registre (menu Séances)

Table paginée côté serveur, filtres combinables : plage de dates,
master, professeur, salle, module, statut effectif, recherche libre.
Compteurs d'en-tête (résultats, réalisées, non réalisées, en retard) et
colonne **Retard** « J+n » pour les séances passées non réalisées.
Quand un master est filtré, le panneau **« Reste à effectuer »** montre
le reliquat par module (planifié − placé).

### Édition (drawer de séance)

Depuis le registre ou l'emploi du temps :

- **Créer / déplacer** une séance : date, heures, salle, professeur,
  groupes supplémentaires ;
- **Changer le statut** : prévue → réalisée (avec heures réelles si
  différentes), annulée ou reportée — **motif obligatoire** pour
  annuler/reporter (tracé dans le journal). Passer une séance
  *réalisée* à un autre statut est une correction réservée et motivée ;
- **Supprimer** : confirmée, tracée.

**Blocage des conflits** : toute écriture vérifie les chevauchements
(salle, professeur, master, groupes, occupations externes,
indisponibilités déclarées, exceptions calendrier). En cas de refus, la
modale détaille chaque séance adverse — il n'y a **jamais** de
notification seule : vous voyez exactement ce qui bloque et pouvez
ajuster.

## 9. Absences des professeurs

Déclaration depuis la **fiche professeur → onglet Absences**
(période + motif). L'application liste immédiatement les **séances
impactées** (prévues/reportées dans la fenêtre) — **aucune annulation
automatique** : chaque séance attend une décision.

Pour chaque séance impactée, décidez :

| Décision | Effet |
|---|---|
| **Remplacement** | Choix d'un remplaçant — vérifié : actif, ≠ titulaire, disponible (pas d'indisponibilité ni d'absence ni de conflit sur le créneau) |
| **Report** | Nouveau créneau obligatoire — la séance bascule dessus (statut *reportée*, motif auto « Absence du titulaire ») |
| **Annulation** | La séance passe *annulée* avec le motif |

Chaque décision est tracée (qui, quand, quoi). L'absence passe de
*À traiter* → *Partielle* → *Résolue* au fil des décisions. Un échec
(conflit du remplaçant par ex.) n'écrit **rien** : ni mutation, ni
décision — corrigez puis réessayez.

## 10. Présences

Sur une séance **réalisée** (drawer de séance → volet présences) :

- **Compteurs** : nombre de présents / absents (rapide) ;
- **Nominatif** : liste des étudiants du/des groupe(s), statut
  présent/absent par étudiant + note, raccourcis « tous présents » /
  « tous absents », compteur en direct ;
- **Effacer** remet la saisie à zéro.

## 11. Rapports

Menu **Rapports** : 10 rapports calculés à la demande en SQL (aucune
donnée stockée) — emploi du temps hebdo d'un master, planning des
salles, programme d'un professeur, bilan d'heures, séances non
réalisées, annulées/reportées, absences, avancement, occupation des
salles, conflits restants.

- Filtres contextuels : période, master, professeur, salle, semestre,
  semaine (obligatoire pour l'emploi du temps hebdo) ;
- **Export CSV** (UTF-8 BOM, séparateur `;` — s'ouvre directement dans
  Excel) et **export PDF** (mise en page d'impression) via boîte
  d'enregistrement ;
- Au-delà de 50 000 lignes le résultat est tronqué — un avertissement
  invite à préciser les filtres.

## 12. Import / Export CSV

### Export

Bouton par entité : salles, professeurs, modules, masters, étudiants,
master-modules, séances (dump complet). Fichier UTF-8 BOM, `;`, via
boîte d'enregistrement.

### Import *(réservé ADMIN)*

1. Choisissez le type d'entité, téléchargez le **gabarit** (en-têtes
   français + ligne d'exemple) ;
2. Déposez le CSV (UTF-8, ≤ 5 Mo / 10 000 lignes) ;
3. **Aperçu ligne à ligne** : chaque ligne est taggée OK / Doublon /
   Erreur avec le détail des erreurs et les colonnes inconnues
   signalées — rien n'est écrit à ce stade ;
4. Choisissez la **stratégie de conflit** (par lot, sur les doublons) :
   - **IGNORER** : les doublons sont sautés ;
   - **FUSIONNER** : les champs vides en base sont complétés ;
   - **REMPLACER** : la ligne importée écrase la fiche ;
5. **Importer** → résultat chiffré (insérées, ignorées, erreurs).

## 13. Paramètres *(réservé ADMIN)*

Trois onglets :

- **Créneaux horaires** : plages autorisées par jour de semaine
  (début, fin, libellé) — la génération ne propose que dans ces
  fenêtres. Un badge signale les chevauchements (autorisés mais
  visibles) ;
- **Exceptions calendrier** : périodes bloquées (jour férié, examen,
  fermeture, vacances) — aucune séance n'y est générée ni placée ;
- **Sauvegarde** : **rétention** = nombre de sauvegardes
  manuelles/automatiques conservées (1–100) ; les plus anciennes au-delà
  perdent leur fichier (la ligne d'historique reste).

## 14. Sauvegardes et restauration *(réservé ADMIN)*

Menu **Sauvegardes** : historique avec date, type, taille et chemin.

- **Nouvelle sauvegarde** : copie instantanée cohérente de la base
  (`sauvegarde-*.db` dans `userData\backups`) + rotation selon la
  rétention ;
- Types : **MANUEL** (bouton), **AUTO** (ex. avant une restauration),
  **PRE_MIGRATION** (prise automatiquement avant chaque migration de
  schéma — jamais supprimée ni tournée : référence historique) ;
- **Restaurer** : confirmation explicite — l'application prend d'abord
  une sauvegarde de sécurité `avant-restauration-*.db`, remplace la
  base puis **redémarre**. La ligne restaurée porte le badge
  « restaurée » ;
- **Ouvrir le dossier** montre les fichiers ; **Supprimer** retire une
  sauvegarde (refusé pour les PRE_MIGRATION) ;
- Une sauvegarde dont le **fichier a disparu** (déplacé/supprimé à la
  main) apparaît grisée « fichier absent » — restauration impossible.

### Récupérer les données d'un autre environnement

1. Dans l'environnement source : *Sauvegardes* → nouvelle sauvegarde →
   *Ouvrir le dossier* → copiez le `sauvegarde-*.db` (clé USB…) ;
2. Dans l'environnement cible : copiez le fichier dans le dossier
   `backups` (ou faites une restauration pointant dessus — la liste ne
   montre que les fichiers du dossier : placez-y d'abord le `.db` puis
   rechargez la page pour qu'il soit repris dans l'historique via une
   nouvelle sauvegarde, ou utilisez la ligne correspondante).

> En pratique : le dossier `backups` se trouve dans
> `%APPDATA%\MasterTime Tanger\backups`. Déposez-y le fichier avant de
> lancer une restauration.

## 15. Dépannage

| Problème | Solution |
|---|---|
| **Base corrompue** (écran d'erreur bloquant au démarrage) | Menu *Sauvegardes* → restaurer la dernière sauvegarde saine (une sauvegarde de sécurité est prise avant remplacement). Si l'app ne démarre plus : copiez manuellement un `sauvegarde-*.db` sur `mastertime.db` dans `%APPDATA%\MasterTime Tanger\` |
| **Sauvegarde « fichier absent »** | Le `.db` a été déplacé/supprimé hors de l'app — la ligne est grisée, restauration impossible. Remettez le fichier à son chemin exact ou supprimez la ligne |
| **Import refusé** | Passez en profil ADMIN ; vérifiez le gabarit et l'aperçu (lignes en erreur listées) |
| **Génération incomplète** | Le panneau d'échec liste raisons + suggestions : élargissez la plage, ajoutez des créneaux/salles, vérifiez les indisponibilités et exceptions, ou baissez le quota |
| **Modification refusée** | La modale de conflits nomme chaque séance adverse — déplacez l'une des deux |
| **Récupérer les données dev** | Sauvegarde manuelle en dev → copie → restauration dans l'installée (§14) |
| **Logs** | Console du processus principal (lancement en terminal) + journal d'audit consultable en base ; les erreurs bloquantes s'affichent au démarrage |

## 16. Réinstallation / remise à zéro

Désinstallez puis supprimez `%APPDATA%\MasterTime Tanger\` (contient la
base **et** les sauvegardes — exportez d'abord ce que vous voulez
garder). Au lancement suivant, la base est recréée et les données
réelles FSJP rechargées.
