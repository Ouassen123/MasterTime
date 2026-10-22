---
title: "EXPERIENCE — MasterTime Tanger"
status: draft
created: 2026-10-22
updated: 2026-10-22
---

# EXPERIENCE — MasterTime Tanger

## Foundation

Application desktop Windows pleine fenêtre, mono-poste, 100 % hors ligne. UI system : **Ant Design v5** `[ASSUMPTION]` (locale `fr_FR`, `dayjs` en français) — les tokens DESIGN.md s'appliquent via `theme` AntD ; cette spec ne couvre que le delta comportemental. Toutes les chaînes passent par i18next (fr).

## Information Architecture

Sidebar fixe, 13 entrées dans l'ordre du brief. La topbar porte : profil actif (sélecteur Admin/Gestionnaire), année universitaire + semestre courants (contexte global filtrant), bandeau DÉMO ambre si des données `is_demo` existent.

```
Dashboard ─ Masters ─ Professeurs ─ Modules ─ Salles ─ Emplois du temps
─ Génération automatique ─ Séances ─ Absences ─ Statistiques & rapports
─ Import/Export ─ Paramètres ─ Sauvegardes & historique
```

| Surface | Contenu | Livre |
|---|---|---|
| Dashboard | KPI calculés, occupation salles, prochaines séances, **panneau Conflits** | UJ-5 |
| Masters / Professeurs / Modules / Salles | table + drawer formulaire + fiche détail | CU-01…04 |
| Emplois du temps | onglets : Semaine·Master·Prof·Salle·Mois·Année + filtres ; drag&drop séances | UJ-4 |
| Génération | assistant 3 étapes : paramètres → calcul → **prévisualisation diff** → confirmer | UJ-1 |
| Séances | registre filtrable + drawer détail (statut, historique, actions) | CU-05…08 |
| Absences | liste + écran de résolution par séance impactée | UJ-2 |
| Rapports | 10 rapports, filtres période/entité, export PDF·Excel | CU-15 |
| Import/Export | assistant 4 étapes : fichier → aperçu+validation → stratégie doublons → résultat | UJ-3 |
| Paramètres | créneaux, jours ouvrables, fériés/examens, profils — **Admin only** | CU-17,18 |
| Sauvegardes & historique | BackupHistory + AuditLog filtrable — Admin | CU-19…21 |

Clôture de surface : chaque besoin du PRD a une surface ; chaque surface a un UJ/CU qui y atterrit. Aucun écran orphelin.

## Voice and Tone

Français administratif clair, phrases complètes, vouvoiement implicite. Erreurs = **cause + action possible** : « Salle occupée par M1-INFO/Algorithmique 10:00–12:00 — choisissez un autre créneau ou une autre salle. » Jamais de jargon technique (« FK violation » → « impossible : données liées existantes »). Confirmations destructives nomment la conséquence chiffrée (« 12 séances seront supprimées »).

## Component Patterns (comportementaux)

- **Table+Drawer** : liste à gauche/toute largeur, édition en drawer droit ; création = même drawer vide. Suppression en ligne = icône + modale de conséquence.
- **Filtres persistants** : chaque vue mémorise ses filtres par session applicative ; le contexte année/semestre de la topbar s'y compose.
- **Badge statut** `{components.badge-status}` avec label texte — couleur jamais seule.
- **Sélecteur de profil** : topbar ; passer Admin→Gestionnaire masque immédiatement les entrées Paramètres/Sauvegardes et désactive les actions réservées (BR-24).

## State Patterns

- **Chargement** : skeleton sur tableaux/calendrier ; jamais d'écran blanc.
- **Vide** : illustration neutre non — texte d'état + action primaire (« Créer un Master », « Lancer l'import »).
- **Erreur conflit** : panneau latéral persistant listant chaque conflit avec la séance en cause cliquable ; le toast seul est interdit (disparaît = perte d'info).
- **Hors-ligne** : non applicable (toujours local) — mais état « base verrouillée / échec disque » prévu : banner erreur + bouton réessayer.
- **DÉMO** : bandeau ambre tant que `is_demo>0` ; action « Purger les données de démonstration » dans Paramètres (Admin, confirmation).

## Interaction Primitives

- **Drag & drop calendrier** (UJ-4) : déposer = tentative d'écriture réelle ; succès → animation courte ; conflit → retour visuel + panneau motif. Pas de mode « brouillon » silencieux.
- **Double clic** sur un bloc séance → drawer détail ; clic droit → menu contextuel (déplacer, réaliser, reporter, annuler).
- **Confirmation modale** obligatoire : annulation séance (motif requis), application d'une génération, restauration, purge DÉMO, suppression avec données liées.
- **Annulation saisie** : fermer un drawer modifié → « Abandonner les modifications ? ».

## Accessibility Floor

- Navigation clavier complète : focus visible, tableau navigable, modale piège le focus, Échap ferme.
- Contraste ≥ AA (le code statut est fond 12% + texte foncé ; annulée garde le label texte, pas juste le gris).
- Statut toujours doublé d'un label texte/icône — jamais couleur seule.
- Cible interactive ≥ 32px ; densité compacte sauf zone tactile (non concernée v1).
- `[ASSUMPTION]` pas de lecteur d'écran certifié en v1 ; structure sémantique propre exigée quand même.

## Key Flows

**UJ-1 — Génération (climax : le diff).** Paramètres → barre de progression → page de résultat : « 128/134 séances placées », liste des 6 non placées **avec motif par séance** et suggestion (« Assouplir la disponibilité du Pr. B » ou « ajouter un créneau samedi »). Onglet Diff : ajouts/déplacements/suppressions vs planning actuel. Bouton « Appliquer » inactif tant que la confirmation explicite n'est pas cochée. Échec global → aucune écriture, rapport d'incompatibilités exportable.

**UJ-2 — Absence (climax : la liste à trancher).** Fiche absence → panneau « 6 séances impactées » ; chaque ligne : séance + 3 boutons Remplacer/Reporter/Annuler ; remplacement propose uniquement les profs disponibles. Jauge de résolution ; l'absence passe `RESOLUE` quand toutes sont traitées.

**UJ-3 — Import (climax : la validation).** Fichier → aperçu table annotée (erreurs rouges ligne/colonne, doublons surlignés) → choix de stratégie par type de doublon → rapport final « 42 créés, 4 ignorés, 2 erreurs ». Aucun import partiel silencieux.

**UJ-4 — Drag & drop (climax : le refus motivé).** Glisser → si conflit : bloc revient + panneau « Conflit : Pr. A enseigne M2-GL 09:00–11:00 ». Jamais de refus muet.

**UJ-5 — Bilan (climax : le chiffre fiable).** Dashboard → filtrer Master → KPI + export PDF « Bilan d'avancement » en 2 clics.

**UJ-6 — Restauration (climax : la confirmation à double détente).** Liste des sauvegardes horodatées → « Restaurer » → modale : date de la sauvegarde, « les données actuelles seront remplacées », case de confirmation + bouton rouge. Journalisé.

## Wireframes de référence (spine-only sauf besoin)

Dashboard, calendrier hebdo et prévisualisation de génération méritent des maquettes HTML en Phase 4 si demandé ; les autres surfaces découlent des patterns Table+Drawer ci-dessus. *(Key-screen mocks : non rendus en Fast path — disponibles sur demande.)*

```
Calendrier hebdo (esquisse)
┌─────────┬─────────┬─────────┬─────────┐
│ Lun 05  │ Mar 06  │ Mer 07  │ Jeu 08  │
│ 08┌───┐ │         │ 08┌───┐ │         │
│   │M1 │ │         │   │M2 │ │         │
│ 10└───┘ │ 10┌───┐ │ 10└───┘ │         │
│         │   │M3▒│ │         │  ← ▒=non réalisée
│ 14┌───┐ │ 14└───┘ │ 14┌╌╌╌┐ │         │
│   │M1 │ │         │   │ann│ │  ← barré=annulée
│ 16└───┘ │         │ 16└╌╌╌┘ │         │
└─────────┴─────────┴─────────┴─────────┘
```
