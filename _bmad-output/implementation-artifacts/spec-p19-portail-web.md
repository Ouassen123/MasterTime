# Spec P19 — Portail web public (EDT + avis + demandes profs)

## Objectif

Publier les emplois du temps en ligne pour étudiants et professeurs, piloté depuis l'app desktop. Le site fonctionne d'abord en local (serveur embarqué dans l'app Electron, joignable via l'IP du poste sur le réseau faculté) et est conçu pour être déployé ensuite sur le serveur de la faculté (`node server/index.js` autonome, même base SQLite).

## Décisions

- **Accès** : les deux — local maintenant (serveur embarqué), hébergement faculté plus tard sans changement de code.
- **Auth prof** : login + mot de passe (comptes gérés par l'admin dans l'app desktop). Étudiants : aucun compte, consultation libre.
- **Avis** : bilingue Français + Arabe, auto-généré à chaque décision admin (annulation / report validé), publié sur l'accueil style panneau d'affichage fsjest.ma.
- **Stack** : serveur HTTP natif Node (`node:http`) + `node:sqlite` sur la même `mastertime.db` (WAL) ; frontend statique HTML/CSS/JS sans build — rapide, déployable tel quel. Zéro dépendance externe.
- **Hachage mots de passe** : `node:crypto` scrypt + sel.

## Schéma (migration 0009)

- `web_professor_account(id, professor_id UNIQUE, login UNIQUE, password_hash, is_active, …)` — comptes profs créés par l'admin.
- `web_session(token, professor_id, created_at, last_seen_at, expires_at)` — sessions de connexion + présence en ligne.
- `web_visitor(token, last_seen_at)` — compteur « en ligne » anonyme (heartbeat toutes les 30 s côté navigateur).
- `session_request(id, session_id, professor_id, kind 'cancel'|'move', reason, proposed_date, proposed_start_min, proposed_end_min, proposed_room_id, status 'pending'|'approved'|'rejected', admin_note, created_at, decided_at)` — demandes prof (annulation / report).
- `announcement(id, title_fr, title_ar, body_fr, body_ar, session_id, published_at, is_active)` — avis bilingues publiés.
- `complaint(id, author_name, author_role, message, created_at, status 'new'|'read'|'handled')` — réclamations.

## Serveur (`server/`)

`server/core.js` : gestionnaire de requêtes pur Node recevant un `DatabaseSync` — réutilisé par le service Electron (`webserver.service.ts`, démarre `node:http` en-processus sur le même fichier DB) et par `server/index.js` autonome (`DB_PATH` env → déploiement faculté).

API :
- `GET /api/masters` — liste des masters (id, nom, niveau M1/M2) pour le sélecteur public.
- `GET /api/edt?master_id=&week=YYYY-MM-DD` — séances non annulées du master sur la semaine (+ nom salle, prof, module, statut).
- `GET /api/announcements` — avis actifs publiés (FR + AR).
- `POST /api/complaints` {name, role, message} — réclamation.
- `POST /api/heartbeat` {visitor} — présence en ligne.
- `POST /api/prof/login` {login, password} → cookie `mt_token` ; `POST /api/prof/logout`.
- `GET /api/prof/me` — profil + master concernés.
- `GET /api/prof/sessions?week=` — ses séances (titulaire ou intervenant).
- `GET /api/prof/free-slots?session_id=` — créneaux + salles libres compatibles (même semaine, master & prof libres) via la logique de disponibilité existante.
- `GET /api/prof/requests` / `POST /api/prof/requests` — ses demandes (kind=cancel|move, motif, créneau proposé).

## Site public (`web/public/`)

- `index.html` — en-tête FSJP (logo), fil d'avis bilingue (AR en RTL), liens vers les EDT par master, formulaire « Réclamation ».
- `edt.html` — sélecteur master + semaine, grille jour × séances (lecture seule, statut affiché).
- `prof.html` — connexion → ses séances de la semaine ; par séance : « Déclarer annulée » (motif) ou « Proposer un report » (liste des créneaux/salles libres proposés par le système) → envoi de demande.
- `styles.css` + `app.js` — léger, responsive, sans framework.

## Admin (app desktop)

Nouvelle page « Portail web » :
- Interrupteur serveur ON/OFF + port (défaut 8080) + affichage URL (`http://localhost:PORT` et `http://<IP-LAN>:PORT`).
- Compteur « en ligne » temps réel (visitors + profs connectés, fenêtre 2 min).
- Onglet « Demandes » : file des `session_request` pending → **Approuver** applique via les services existants (annulation → status annulée + motif ; report → déplacement validé par les gardes-fous BR-*) puis génère l'avis bilingue ; **Rejeter** (note admin).
- Onglet « Réclamations » : inbox, marquer lue/traitée.
- Onglet « Comptes profs » : créer/réinitialiser login+mot de passe par professeur, activer/désactiver.
- Onglet « Avis » : historique des avis publiés, dépublier.

## Vérifications

- Tests Vitest : migration 0009 + services web (comptes, demandes cycle complet, avis, présence).
- Manuel : `npm run dev` → activer le portail → ouvrir `http://localhost:8080` → parcours étudiant (EDT) + parcours prof (login → demande) + approbation admin → avis visible.
