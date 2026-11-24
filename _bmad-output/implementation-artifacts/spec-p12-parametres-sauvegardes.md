# Spec P12 — Paramètres & Sauvegardes

Périmètre : pages `/parametres` et `/sauvegardes` (sidebar déjà réservée,
`adminOnly`, BR-24) — gestion `time_slot`, `calendar_exception`,
clé `setting`, sauvegardes horodatées + restauration contrôlée
(FR-51/52/53, BR-23/24). Toutes les mutations : `requireRole: 'ADMIN'`.

## 1. `settings.service.ts` (nouveau, `electron/main/db/`)

**time_slot**
- `listTimeSlots(db)` : tous, triés `weekday, start_min`.
- `createTimeSlot(db, uid, {weekday,start_min,end_min,label?})` /
  `updateTimeSlot(db, uid, id, champs)` / `deleteTimeSlot(db, uid, id)` :
  `weekday ∈ [0,6]` entier ; `start_min`/`end_min` entiers `[0,1440]`,
  `start < end` ; `label` ≤ 60 car. ; `FieldError[]` en français
  (`fields[]` mappables). Écriture via `withAudit`.
- Chevauchements entre créneaux d'un même weekday **autorisés mais
  signalés** : `listTimeSlots` expose `overlaps: boolean` par ligne
  (la génération gère les fenêtres qui se recouvrent — informatif, pas
  bloquant).
- Aucune contrainte FK : édition sans danger pour les séances
  existantes ; affecte uniquement la prochaine génération.

**calendar_exception**
- `listExceptions(db)` : tri `start_date`.
- `createException(db, uid, {start_date,end_date,type,label})` /
  `updateException` / `deleteException` : dates ISO valides,
  `start ≤ end`, `type ∈ FERIE|EXAMEN|FERMETURE|VACANCES`,
  `label` requis ≤ 120. `withAudit`. Chevauchements autorisés.

**setting**
- `getRetention(db)` : `backup_retention`, défaut 10, borné `[1,100]`.
- `setRetention(db, uid, n)` : entier borné, `withAudit` (entity
  `setting`, id = key).

## 2. `backup.service.ts` (nouveau)

`init(backupDir)` reçoit le répertoire `userData/backups` (déjà utilisé
par migrate.ts). Types partagés :
`BackupRow {id, at, path, size_bytes, kind, restored, exists}` —
`exists` = fichier présent sur disque (sauvegarde déplacée/supprimée
manuellement → ligne grisée, restauration impossible).

- `listBackups(db, dir)` : `backup_history` DESC + `exists`.
- `createBackup(db, uid, dir)` : `VACUUM INTO` vers
  `sauvegarde-<ISO-ts>.db` (échappement `'` → `''` comme migrate.ts),
  ligne `backup_history kind='MANUEL'`, audit `CREATE backup`.
  Puis **rotation BR-23** : conserve les `retention` plus récentes
  parmi `kind IN ('MANUEL','AUTO')` ; les excédentaires : fichier
  supprimé + ligne `backup_history` supprimée. `PRE_MIGRATION` hors
  rotation (journalisé dans le commentaire).
- `restoreBackup(db, uid, dir, id, {dbPath, restart})` — FR-52 :
  1. Valide l'id + `exists` + en-tête `SQLite format 3` des 16
     premiers octets.
  2. Crée d'abord une sauvegarde de sécurité de la base courante
     (`kind='AUTO'`, `avant-restauration-<ts>.db`).
  3. Marque `restored=1` sur la ligne restaurée + audit
     `UPDATE backup_history`.
  4. Ferme la connexion DB, copie le fichier sur `dbPath`, supprime
     `-wal`/`-shm` orphelins, puis `restart()` injecté (en prod :
     `app.relaunch(); app.exit(0)` ; en test : noop → réouverture
     possible par l'appelant).
  Signature injectable : le service ne connaît pas `app`.
- `deleteBackup(db, uid, id)` : refuse `PRE_MIGRATION` (référence
  historique — « suppression refusée » FieldError), sinon supprime
  fichier + ligne, audit `DELETE`. FR-53 : confirmation côté UI.
- `openBackupsFolder(dir)` : `shell.openPath` (IPC uniquement).

## 3. IPC (`ipc/settings.ts`, `ipc/backups.ts` — tous `requireRole:'ADMIN'`)

`settings:slots:list|create|update|delete`,
`settings:exceptions:list|create|update|delete`,
`settings:retention:get|set` ;
`backups:list|create|restore|delete|openFolder`.
Guards payload (types, bornes). `backups:restore` reçoit `{id}`
uniquement — `dbPath`/dir/restart résolus côté main.
Enregistrer dans `ipc/index.ts` ; preload `window.api.settings.*` /
`window.api.backups.*` ; types dans `shared/types.ts`.

## 4. UI

**`/parametres`** (`ParamsPage.tsx`, ADMIN — route + sidebar déjà
prévues, activer `enabled`) :
- Onglet **Créneaux horaires** : table (jour, début, fin, libellé,
  badge « chevauchement »), création/édition via Modal+Form
  (`TimePicker` minutes ou `Select` heures), suppression confirmée.
- Onglet **Exceptions calendrier** : table (dates, type taggé,
  libellé), Modal+Form (`RangePicker` + `Select` type).
- Onglet **Sauvegarde** : `InputNumber` rétention 1–100 + save.
- Messages d'erreur serveur remappés aux champs du form (pattern P7b).

**`/sauvegardes`** (`BackupsPage.tsx`) :
- Table : date, type (`Tag` MANUEL/AUTO/PRE_MIGRATION), taille
  formatée, chemin (`dir="auto"`), badge « fichier absent »,
  « restaurée » si `restored=1`.
- Boutons : **Nouvelle sauvegarde**, **Restaurer** (Popconfirm double
  : avertissement « l'application va redémarrer, les données
  actuelles seront remplacées — une sauvegarde de sécurité est créée
  automatiquement »), **Ouvrir le dossier**, **Supprimer**
  (Popconfirm, refusé si PRE_MIGRATION — bouton désactivé + tooltip).

## 5. Tests (`tests/settings.test.ts`, `tests/backups.test.ts`)

- Slots : validation bornes/chevauchement flaggé/CRUD audité.
- Exceptions : dates invalides, inversion, type inconnu, CRUD.
- Retention : défaut 10, bornes, audit.
- Backups : create → fichier + ligne ; rotation conserve N et supprime
  les plus anciennes ; `exists=false` si fichier effacé ; restore
  sur base temp : sécurité AUTO créée, données restaurées réellement
  (réouverture du fichier copié), `restored=1`, header non-SQLite
  refusé ; delete : PRE_MIGRATION refusée, MANUEL supprimée.
- IPC : non-ADMIN → refus (pattern tests existants si présent).

## Non-goals

Import/export de paramètres, gestion `app_user`/profils (existant),
années/semestres CRUD (structurel, hors périmètre), backup chiffré,
restauration sans redémarrage.

---

## Revue (3 couches) — patches exigés

1. **Restauration atomique** (`restoreBackup`) :
   - Refuser `path.resolve(row.path) === path.resolve(deps.dbPath)`
     (FieldError `id`).
   - Copier vers `dbPath + '.restore-tmp'` puis `fs.renameSync` →
     `dbPath` (atomique, jamais de fichier tronqué). Supprimer le tmp
     en cas d'échec.
   - Tout le bloc après `db.close()` dans un `try/finally` :
     `restart()` TOUJOURS appelé une fois la copie lancée (connexion
     morte de toute façon) ; si la copie échoue AVANT le rename, la
     base d'origine est intacte → réouvrir la connexion via
     `openDatabase(deps.dbPath)` et la réinjecter (`connection.current`)
     OU appeler restart quand même — choisir le plus simple et le
     documenter ; dans tous les cas aucune session zombie.
2. **Sécurité AUTO récupérable** : après copie+réouverture de la base
   restaurée, insérer la ligne `backup_history` de la sécurité
   `avant-restauration` (path/size/kind AUTO) dans la base restaurée —
   elle reste listable/restaurable. `restored=1` idem (déjà fait,
   garder ; WHERE id si possible).
3. **Orpheline VACUUM** : try/catch autour de `vacuumInto` →
   DELETE ligne `backup_history` + unlink best-effort du fichier
   partiel avant de propager (createBackup ET sécurité restore).
4. **Rotation** : exclure la plus récente ligne AUTO dont le path
   commence par `avant-restauration-` ; ne compter dans la rétention
   que les lignes dont le fichier existe réellement.
5. **Exception non bornée** : `end_date - start_date ≤ 3660` jours
   (FieldError `end_date`, message FR).
6. **RangePicker partiel** : validator custom sur les deux `range`
   (`range?.[0] && range?.[1]` requis, message FR) dans ParamsPage.
7. Petits :
   - `unlinkIgnore`/`unlink` confinés aux chemins sous `backupDir`
     (startsWith `dir + sep` normalisé) dans rotation et deleteBackup.
   - `setRetention` : pré-check `db.isTransaction` (message clair) ;
     après un `setRetention` réussi, l'IPC `settings:retention:set`
     déclenche `rotateBackups` avec le `backupDir` des deps.
   - `AuditEntry.entity_id` : `number | string | null`.
   - Tooltips sur boutons désactivés : envelopper dans `<span>`.
   - `updateTimeSlot` : `label` omis → conserver l'existant.
   - ParamsPage : `end` affiché 23:59 quand stocké 1440 ; à la
     soumission `23:59` → `end_min = 1440`.
   - `backups:openFolder` : check de rôle DANS le try (ApiResult).
   - `BackupsPage` : afficher `at` en heure locale
     (`new Date(at+'Z').toLocaleString('fr-FR')`) ; en cas d'erreur
     avec `fields`, afficher `fields[0].message` ; `busyId` libéré
     dans un `finally`.
   - `getRetention` : valeur non-`^\d+$` → défaut 10 (pas de parse exotique).
8. Tests : copie échouée → base intacte + restart appelé ;
   `path===dbPath` refusé ; sécurité réinsérée dans base restaurée ;
   orpheline après VACUUM KO (simuler en supprimant le droit écriture
   ou en mockant — sinon tester via path invalide) ; rotation
   exempte avant-restauration + skip lignes mortes ; exception
   > 3660 j refusée ; label omis préservé ; getRetention '0x14' → 10 ;
   entity_id string accepté.
