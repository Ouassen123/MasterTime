-- Migration 0002 — index de performance pour les compteurs corrélés des
-- services référentiels (P6a) : sessionCount par salle et masterModuleCount
-- par module.
-- ix_session_room_date (0001) est partiel (WHERE status != 'ANNULEE') et
-- couvre la colonne date d'abord — il ne sert pas le comptage par room_id.

CREATE INDEX IF NOT EXISTS ix_session_room
  ON session(room_id);

CREATE INDEX IF NOT EXISTS ix_master_module_module
  ON master_module(module_id);