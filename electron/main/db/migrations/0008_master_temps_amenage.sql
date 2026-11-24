-- 0008 — Masters « temps aménagé » (formation payante — traitement du
-- service économique / paiement différé).
-- Le flag prépare le filtrage : un rapport dédié (rémunération des
-- heures assurées sur les masters à temps aménagé) viendra en phase
-- ultérieure ; aucun traitement de paiement en v1.
ALTER TABLE master ADD COLUMN temps_amenage INTEGER NOT NULL DEFAULT 0;
