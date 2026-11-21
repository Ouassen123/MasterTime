-- 0003 — Occupation externe des salles (BR-25 : séances fixes Licences,
-- contrainte dure pour le moteur, exclue des statistiques Masters).
CREATE TABLE external_occupancy (
  id INTEGER PRIMARY KEY,
  program TEXT NOT NULL,                    -- 'Licence S1 droit privé'
  groupe TEXT,                              -- 'A' | 'B' | 'unique'
  module TEXT, professor TEXT,
  room_id INTEGER NOT NULL REFERENCES room(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 5), -- 0=lun (AD-7)
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  academic_year_id INTEGER REFERENCES academic_year(id),
  source_file TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  CHECK (start_min < end_min));
CREATE INDEX ix_ext_occ_room ON external_occupancy (room_id, weekday, start_min);
