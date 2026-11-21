-- 0004 — Désactivation des professeurs (BR-22 : suppression refusée si
-- master_module/séance/absence liés — l'alternative est is_active = 0,
-- les données pédagogiques restent intactes).
ALTER TABLE professor ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
