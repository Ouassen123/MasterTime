-- 0007 — Occupation Licence permanente + modules fixables.
-- Les blocages Licence sont des fixtures récurrentes valables pour
-- toutes les années universitaires (NULL = toutes années, règle déjà
-- appliquée par conflict.service et generation.service).
UPDATE external_occupancy SET academic_year_id = NULL;

-- Un module fixé (is_fixed=1) gèle ses séances : le générateur en mode
-- REGENERATE l'ignore ; COMPLETE peut toujours compléter le manquant.
ALTER TABLE master_module
  ADD COLUMN is_fixed INTEGER NOT NULL DEFAULT 0;
