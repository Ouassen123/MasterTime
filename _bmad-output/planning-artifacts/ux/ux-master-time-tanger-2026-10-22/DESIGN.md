---
title: "DESIGN — MasterTime Tanger"
status: draft
created: 2026-10-22
updated: 2026-10-22
colors:
  primary: "#1D4ED8"          # bleu institutionnel
  primary-hover: "#1E40AF"
  success: "#16A34A"
  warning: "#D97706"
  error: "#DC2626"
  info: "#0284C7"
  bg-app: "#F4F5F7"
  bg-surface: "#FFFFFF"
  text-primary: "#111827"
  text-secondary: "#4B5563"
  border: "#E5E7EB"
  status-prevue: "#2563EB"
  status-realisee: "#16A34A"
  status-non-realisee: "#D97706"
  status-annulee: "#9CA3AF"
  status-reportee: "#7C3AED"
typography:
  family: "Segoe UI, system-ui, sans-serif"
  size-xs: "11px"   # badges, méta
  size-sm: "12px"   # tableaux compacts
  size-md: "14px"   # corps, formulaires
  size-lg: "18px"   # titres de section
  size-xl: "24px"   # titres de page, chiffres du dashboard
  weight-regular: 400
  weight-semibold: 600
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  unit: "8px"       # 4|8|12|16|24|32
components:
  sidebar: "240px, fond blanc, item actif = fond {colors.primary} teint 8% + texte {colors.primary}"
  table: "densité compacte, header {colors.bg-app}, hover ligne, sticky header"
  session-block: "carte pleine couleur statut 12% de fond, bordure gauche 3px couleur statut pleine"
  badge-status: "pill {colors.rounded.sm}, fond couleur statut 12%, texte couleur statut"
  modal-confirm: "centrée, titre + conséquence + champ motif quand requis"
---

# DESIGN — MasterTime Tanger

## Brand & Style

Institutionnel sobre : administration universitaire marocaine, usage quotidien dense. Pas de branding fort — la lisibilité prime. Style « outil de travail » : surfaces blanches, fond gris clair, hiérarchie par la densité et la couleur des statuts plus que par les ombres. Aucun emoji, aucune illustration décorative dans les écrans de données.

## Colors

La palette sert deux rôles : identité (bleu primaire discret) et **code statut** — le véritable langage visuel de l'application. Le code statut est constant partout (calendrier, badges, tableaux, exports) : `PRÉVUE` = `{colors.status-prevue}`, `RÉALISÉE` = `{colors.status-realisee}`, `NON ENCORE RÉALISÉE` = `{colors.status-non-realisee}`, `ANNULÉE` = `{colors.status-annulee}` (désaturée, barré dans le calendrier), `REPORTÉE` = `{colors.status-reportee}`.

## Typography

Une seule famille `{typography.family}` (native Windows, zéro téléchargement — cohérent avec le hors-ligne). Chiffres du tableau de bord en `{typography.size-xl}` semibold ; tableaux en `{typography.size-sm}` ; jamais sous 11px.

## Layout & Spacing

Application pleine fenêtre (min 1280×720, cible 1440+). Sidebar fixe 240px + topbar 56px + zone de contenu scrollable. Grille 8px. Tableaux occupent toute la largeur disponible ; formulaires en colonnes max 720px ou drawer droit 480px.

## Elevation & Depth

Flat par défaut : séparation par `{colors.border}` et fonds, pas d'ombres portées sauf modales/drawers (ombre légère). Le calendrier n'utilise jamais d'ombre sur les séances — la couleur seule porte l'information.

## Shapes

Angles `{rounded.md}` partout ; pills pour les badges de statut ; le calendrier garde des blocs francs `{rounded.sm}` (densité > ornement).

## Components

- **SessionBlock** (calendrier) : fond statut 12%, liseré gauche plein 3px, texte compact : heure, module, salle, professeur ; annulée = fond gris + texte barré ; reportée = badge « → nouvelle date ».
- **Table** : sticky header, recherche intégrée, filtres en ligne, pagination bas de tableau, tri par colonne.
- **KpiCard** (dashboard) : fond blanc, chiffre xl, libellé secondaire, delta/contexte en xs ; alerte conflit = liseré `{colors.error}`.
- **Modal de confirmation destructive** : bouton danger, conséquence explicite, saisie obligatoire du motif quand la règle métier l'exige (annulation, restauration).
- **Banner DÉMO** : bandeau ambre permanent tant que la base contient des `is_demo` — protège contre la confusion démo/réel.

## Do's and Don'ts

- ✅ Un statut = une couleur, partout, y compris exports PDF.
- ✅ États vides explicites (« Aucune séance cette semaine »), jamais de tableau vide muet.
- ✅ Actions destructives derrière modale avec conséquence chiffrée.
- ❌ Pas de toast unique pour les erreurs de conflit — le motif doit rester visible (modal ou panneau).
- ❌ Pas de mode sombre en v1 (usage bureau, exports clairs).
- ❌ Jamais de vert/rouge seul comme seul vecteur d'info (icône ou label joint — cf. EXPERIENCE accessibility).
