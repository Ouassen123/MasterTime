---
title: "Analyse des données réelles — FSJP Tanger (EDT Masters S3 2026/2027)"
created: 2026-11-21
sources:
  - "Liste capacités salles/amphis — document officiel FSJP Boukhalef"
  - "14 PDF 'استعمالات الزمن' Masters Semestre 3, site de la faculté"
  - "Captures site web faculté (listes des programmes)"
---

# Analyse des données réelles — FSJP Tanger

## 1. Établissement réel

**Faculté des Sciences Juridiques et Politiques (FSJP) — Université Abdelmalek Essaâdi, campus Boukhalef, Tanger.** Masters de droit (arabe majoritairement, filières francophones aussi d'après le site). Interface arabe pour les données sources ; l'application reste en français mais devra **accepter les chaînes arabes** (noms de Masters/modules/professeurs) — stockage UTF-8 OK, RTL à l'affichage à prévoir (minimalement `dir="auto"`).

## 2. Inventaire réel des salles (document officiel)

| Salle | Capacité | Salle | Capacité |
|---|---|---|---|
| المدرج 1 (Amphi 1) | 100 | القاعة 1 (Salle 1) | 60 |
| المدرج 2 | 80 | القاعة 2 | 40 |
| المدرج 3 | 80 | القاعة 4 | 78 |
| المدرج 4 | 80 | القاعة 5 | 36 |
| المدرج 5 | 100 | القاعة 6 | 36 |
| المدرج 6 | 140 | القاعة 7 | 36 |
| المدرج 7 | 60 | القاعة 8 | 36 |
| المدرج 8 | 60 | | |

**Total : 1022 places, 15 salles.** ⚠️ Corrections vs notre seed : Amphi 7 = 60 (pas 240), Amphi 8 = 60 (pas 200), Salle 1 = 60 (pas 40). **Anomalies constatées** : pas de Salle 3 ni de Salle 9 dans la liste officielle, **pourtant القاعة 9 est utilisée par 4 Masters** dans les EDT et un Master cite la salle « 3 ». → Inventaire à reconfirmer avec la faculté (salles hors liste ? nouvelles ?).

## 3. Structure réelle des Masters (14 fichiers S3)

Chaque Master S3 = **6 ou 7 modules**, chacun **1 séance hebdomadaire de 2h** (volume semestriel ~30h/module si ~15 semaines). 14 Masters S3 × ~7 séances = **~98 séances hebdomadaires** pour S3 seul. Le S1 (M1) aura un volume comparable — mais ses créneaux doivent composer avec les Licences (voir §6).

| # | Master (arabe) | Coordinateur |
|---|---|---|
| 1 | القانون والعلوم الإدارية والمالية للتنمية | د.محمد يحيا |
| 2 | قانون الاستثمار وآليات تدبير المنازعات | دة. جميلة العماري |
| 3 | السياسة الجنائية ورصد وتحليل الظاهرة الإجرامية | د. هشام بوحوص |
| 4 | القانون الجنائي للأعمال والعدالة الرقمية | د.أويس السيمو |
| 5 | الدراسات العقارية والتوثيق الرقمي | د. ايت الحاج |
| 6 | المنازعات العقدية والتكنولجيا الحديثة | دة. مريم الطاشي |
| 7 | القانون المدني والأعمال والمعاملات الإئتمانية | د.أحمد الجباري |
| 8 | المساطر القانونية والوسائل البديلة لتسوية المنازعات | دة. سعاد حميدي |
| 9 | القانون المقارن للأعمال | د.محمد حامي الدين |
| 10 | المنازعات المدنية والتجارية | دة. لبنى الغومرتي |
| 11 | المهن القانونية والقضائية والرقمية والتحولات الاقتصادية | دة. وداد العيدوني |
| 12 | حقوق الإنسان والتقاضي الدولي | د.عبد القادر مساعد |
| 13 | قانون المنازعات | د. الحسن الجماعي |
| 14 | قوانين التجارة والاعمال والتحول الرقمي | د.بنتركي خالد |

## 4. Contraintes réelles vs hypothèses du PRD (Q3 résolue)

| Hypothèse assumée | Réalité observée | Action |
|---|---|---|
| Lun–Sam, 08h–19h | **Lun–Sam, 08h00–18h00** | Ajuster créneaux par défaut |
| Durées 1h30/2h/3h | **2h dominant** ; exceptions : 08:30–10:00 (1h30), 09:00–12:00 (3h), 15:00–17:00 (2h, début impair) | Les créneaux doivent être **par séance**, pas une grille rigide — `time_slot` = plages autorisées (08–18) + durées libres, ou granularité 30 min |
| Modules en arabe uniquement | Non — plusieurs modules en **français** (droit fiscal, Contentieux administratif…) | Pas de contrainte de langue sur les données |
| 1 professeur par séance | **3 séances co-enseignées** (2 profs : عقود التكنولولجيا، منازعات الشغل، العدالة الانتقالية) | Modèle : `session_professor` N-N, ou 2 profs dans master_module — **décision à trancher** |
| Salles = Amphi 7, Amphi 8, Salle 1 | **15 salles** ; les 3 du brief sont utilisées (القاعة1 beaucoup, المدرج7 beaucoup) | Mettre à jour le seed avec l'inventaire réel |
| ~60 profs | **~60 noms distincts**, dont ~15 enseignant dans 2+ Masters | Confirme le besoin de détection de conflits professeurs |

Jours utilisés : **tous les jours Lun–Sam**. Plages : 08:00, 08:30, 09:00, 10:00, 12:00, 14:00, 15:00, 16:00 (fins à 18:00).

## 5. ⚠️ Conflits détectés dans les données officielles

| Conflit | Détail |
|---|---|
| **C1 — Salle** | Samedi 12:00–14:00, **القاعة 6** : « القانون المدني المعمق » (M. المدني) **et** « العدالة الجنائية التنبؤية » (M. السياسة الجنائية) — même créneau, même salle |
| **C2 — Salle** | Jeudi 16:00–18:00, **القاعة 8** : « جرائم البورصة » (M. العدالة الرقمية) **et** « التحكيم في المنازعات المالية والبنكية » (M. المساطر) |
| **C3 — Master** | M. المنازعات العقدية : 2 séances Jeudi 16:00–18:00 **القاعة 1** (التحكيم في العقود التجارية + عقود التكنولولجيا co-enseignée) — même Master à 2 endroits, ou double saisie d'une même séance |
| **Ambiguïté** | M. حقوق الإنسان : salles notées « 5, 1, 8, 3 » sans préfixe القاعة/المدرج ; « 3 » n'existe ni en قاعة ni listée |

Ces cas réels seront de **parfaits jeux de test** pour le détecteur de conflits (Phase 7) et l'import (Phase 10 doit les signaler, pas les importer en l'état).

## 6. Nouvelle contrainte métier — occupation des Licences

**Exigence utilisateur (21/11/2026)** : les séances fixes des Licences occupent les mêmes salles ; les générer pour les Masters (surtout M1/S1) sans les connaître crée des conflits de salle.

→ **Nouvelle règle métier proposée BR-25** : table `external_occupancy` (programme externe : « Licence S5 droit privé », salle, jour, créneau, semestre) — **contrainte dure** pour le moteur et les déplacements manuels, **exclue** des statistiques Masters. Importable comme les autres référentiels. Schéma à ajouter en migration 0003.

## 7. Implications pour le modèle (décisions à valider)

| # | Question | Proposition |
|---|---|---|
| D1 | Co-enseignement (2 profs/séance) | `session.professor_id` = titulaire principal + table `session_professor` N-N pour co-intervenants ; conflit prof vérifié sur les deux |
| D2 | Occupation Licences | `external_occupancy` (cf. BR-25) |
| D3 | Créneaux irréguliers (08:30, 09–12, 15–17) | `time_slot` = bornes par défaut + sessions à heures libres avec contrôle « dans les bornes » ; granularité 30 min |
| D4 | Salles « 3 » et « 9 » hors liste officielle | Confirmer l'inventaire avec la faculté ; le modèle accepte toute salle — prévoir champ `source_notes` |
| D5 | Noms arabes (masters/profs/modules) | Stockage UTF-8 ; affichage `dir="auto"` ; codes Masters courts ajoutés (ex. `M-CIVIL`) pour le tri |
| D6 | Import | Gabarit d'import aligné sur le format officiel (Module|Prof|Jour|Horaire|Salle) + parsing PDF/HTML du site |

## 8. Fichiers produits

- `pdf-extract/*.txt` — texte extrait des 14 PDF (source analysée)
- `sessions-s3-2026.csv` — 98 séances normalisées (master, module, prof, jour, début, fin, salle) — prête pour tester l'import
