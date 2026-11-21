-- 0005 — Séances multi-groupes (P6c) : une même séance peut réunir
-- plusieurs groupes/filières sans compter comme N occupations de salle
-- (constat analyse Licence). Table remplie par la génération/édition
-- (Phase 7+) — ici : schéma + index seulement.
CREATE TABLE session_group (
  session_id INTEGER NOT NULL REFERENCES session(id),
  student_group_id INTEGER NOT NULL REFERENCES student_group(id),
  PRIMARY KEY (session_id, student_group_id));

CREATE INDEX ix_sg_group ON session_group(student_group_id);

-- Index de performance pour les compteurs corrélés du service Masters
-- (même pattern que 0002) : nb_modules / nb_seances / fiche par master.
CREATE INDEX ix_master_module_master ON master_module(master_id);
