# MasterTime Tanger

Gestion des emplois du temps des Masters — FSJP Tanger
(Université Abdelmalek Essaâdi).

Application de bureau **Electron + React + SQLite** (`node:sqlite`) :
génération automatique des emplois du temps, suivi des séances,
absences des professeurs, présences étudiantes, rapports, import/export
CSV, paramètres et sauvegardes. Guide utilisateur :
[`docs/GUIDE-UTILISATEUR.md`](docs/GUIDE-UTILISATEUR.md).

## Prérequis (développement)

- **Node.js ≥ 22.13.0** — requis pour `node:sqlite` (`DatabaseSync`
  actif sans flag, utilisé par le main et les tests Vitest).
- Windows 10/11 pour produire/tester l'installateur NSIS.

## Commandes

| Commande | Effet |
|---|---|
| `npm install` | Installe les dépendances (Electron ~150 Mo, attendu) |
| `npm run dev` | Lance l'app Electron en mode dev (electron-vite, HMR renderer) |
| `npm test` | Tests Vitest (migrations, services, règles métier — bases temporaires) |
| `npm run typecheck` | Vérification TypeScript stricte (renderer + main/tests) |
| `npm run build` | Build production electron-vite → `out/` |
| `npm run pack` | Build + packaging non compressé → `release/win-unpacked/` |
| `npm run dist` | Build + installateur NSIS → `release/MasterTime Tanger Setup *.exe` |

## Packaging Windows (electron-builder)

Configuration dans [`electron-builder.yml`](electron-builder.yml) :
installateur **NSIS par utilisateur** (`perMachine: false`) — aucune
installation administrateur requise (postes de la faculté), choix du
dossier d'installation possible, raccourcis Bureau + menu Démarrer,
interface de l'installateur en français.

- `npm run pack` → `release/win-unpacked/MasterTime Tanger.exe` : rapide,
  permet de vérifier le contenu embarqué sans produire d'installateur.
- `npm run dist` → `release/MasterTime Tanger Setup <version>.exe` :
  nécessite un téléchargement réseau au premier build (outils NSIS /
  winCodeSign, mis en cache ensuite dans `%LOCALAPPDATA%\electron-builder\Cache`).
- Icône : `build/icon.png` (256×256) est générée par
  `node scripts/make-icon.js` (Node pur : zlib + CRC32, aucune
  dépendance image) ; electron-builder la convertit en `.ico` tout seul.

### Données de l'application installée

La base SQLite vit dans `app.getPath('userData')` →
`%APPDATA%\MasterTime Tanger\mastertime.db` (le `productName` diffère du
nom dev — dossier différent). **Premier lancement installé = base
neuve** : les migrations s'appliquent puis le **jeu de données réel
FSJP** est chargé automatiquement (17 salles, 14 Masters S3, 133
professeurs, 93 modules, ~97 séances hebdomadaires × 12 semaines,
168 occupations Licence). Pour récupérer les données d'une installation
de dev : *Sauvegardes* → sauvegarde manuelle → copier le fichier `.db` →
*Restaurer* dans l'autre environnement.

## Arborescence

```
electron/main/          processus principal (propriétaire de la DB)
  db/                   connexion unique DatabaseSync (WAL + FK), services
  db/migrations/        fichiers NNNN_*.sql appliqués au démarrage
  ipc/                  handlers IPC
  preload.ts            contextBridge → window.api
src/                    renderer React/TS (client mince, aucun accès DB)
shared/                 types/contrats IPC partagés main ↔ renderer
tests/                  Vitest (bases :memory: / fichiers temporaires)
scripts/make-icon.js    génère build/icon.png (icône de l'app)
electron-builder.yml    packaging NSIS
docs/                   documentation utilisateur
```

## État du projet

Fonctionnalités livrées :

- Référentiels : Masters (groupes, master-modules), Professeurs
  (disponibilités, absences), Modules, Salles ;
- Emplois du temps en lecture : vues Semaine / Mois / Année, par
  Master / Professeur / Salle, occupations externes (Licence), panneau
  de conflits persistant ;
- Édition manuelle des séances (création, déplacement, statuts,
  groupes) avec blocage des conflits et motif tracé ;
- Génération automatique **COMPLETE** / **REGENERATE** : preview avant
  application, diff des remplacements, échecs partiels expliqués
  (raisons + suggestions), modules « fixés » gelés ;
- Registre central des séances : filtres combinés, pagination serveur,
  colonne retard « J+n », « reste à effectuer » par master-module ;
- Absences des professeurs → séances impactées → décisions
  (remplacement / report / annulation) ;
- Présences : compteurs ou nominatif par groupe, sur les séances
  réalisées ;
- 10 rapports (emploi du temps hebdo, bilan d'heures, absences,
  avancement, occupation des salles, conflits…) + exports CSV et PDF ;
- Import CSV avec aperçu ligne à ligne (OK / doublon / erreur) et
  stratégie de conflit par lot ; export CSV des entités ;
- Paramètres : créneaux horaires, exceptions calendrier (ferié, examen,
  fermeture, vacances), rétention des sauvegardes ;
- Sauvegardes (manuelles, automatiques, pré-migration) avec rotation
  bornée + restauration contrôlée (sauvegarde de sécurité +
  redémarrage) ;
- Profils **ADMIN** / **GESTIONNAIRE** (droits vérifiés côté main),
  journal d'audit des actions.
