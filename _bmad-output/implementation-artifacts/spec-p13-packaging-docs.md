# Spec P13 — Packaging Windows + documentation

Périmètre : installateur Windows via `electron-builder` (NSIS,
installation par utilisateur sans droits admin), icône, scripts npm,
documentation utilisateur + dev. Aucune nouvelle dépendance runtime.

## 1. Dépendance & config

- `npm i -D electron-builder` — version publiée ≥ 7 jours (pin exact).
- `electron-builder.yml` :
  - `appId: ma.fst.mastertime` ; `productName: MasterTime Tanger`
  - `directories.output: release`
  - `files: ['out/**', 'package.json']` (migrations déjà embarquées
    dans le bundle via `import.meta.glob` — rien d'autre à shipper)
  - `asar: true` ; `win.target: ['nsis']` ; `icon: build/icon.png`
  - `nsis` : `oneClick: false`, `perMachine: false` (install
    utilisateur, aucun droit admin requis — PC faculté),
    `allowToChangeInstallationDirectory: true`,
    `createDesktopShortcut: true`, `createStartMenuShortcut: true`,
    `shortcutName: 'MasterTime Tanger'`, `language: fr`
  - `electronLanguages: ['fr', 'en-US']`
- `package.json` scripts : `"pack": "npm run build && electron-builder --dir"`,
  `"dist": "npm run build && electron-builder --win nsis"`.

## 2. Icône `build/icon.png` (256×256)

Aucune dépendance image : script `scripts/make-icon.js` (Node pur,
zlib+CRC) générant un PNG 256×256 — fond bleu nuit `#1f3864`,
grille calendrier blanche, initiales « MT ». Le lancer une fois,
committer le PNG. electron-builder convertit PNG→ICO tout seul.

## 3. userData en installé

`app.getPath('userData')` → `%APPDATA%\MasterTime Tanger\` (productName
≠ name → dossier différent du dev : **premier lancement installé =
base neuve + seed réel automatique**, documenter : pour récupérer les
données dev → sauvegarde + restauration).

## 4. Docs

- `README.md` : description, prérequis dev (Node ≥22.13), commandes
  (`dev`, `test`, `typecheck`, `build`, `pack`, `dist`), arborescence,
  sortie `release/` (setup NSIS + unpacked), état du projet (features).
- `docs/GUIDE-UTILISATEUR.md` (français) : installation, premier
  lancement (données réelles FSJP chargées automatiquement), profils
  Admin/Gestionnaire, workflows : génération (COMPLETE/REGENERATE,
  modules fixés), modification manuelle + blocage conflits, registre
  séances, absences→décisions, présences, rapports PDF/CSV,
  import/export CSV, paramètres (créneaux + exceptions + rétention),
  sauvegardes & restauration (y compris récupération données dev),
  dépannage (base corrompue → restaurer ; fichier absent ; logs).
- `AGENTS.md` : ajouter `pack`/`dist` dans le tableau des commandes.

## 5. Vérification

- `npm run pack` → `release/win-unpacked/` + lancer
  `MasterTime Tanger.exe` rapidement si possible (ou au moins vérifier
  que l'exécutable existe et que `out/` contient tout).
- `npm run dist` → `release/MasterTime Tanger Setup *.exe` si le
  réseau autorise le téléchargement NSIS (cache electron-builder).
  Si offline → documenter le blocage, config quand même validée
  par `--dir`.
- `npx vitest run` + `typecheck` restent verts (aucun code métier
  touché).
