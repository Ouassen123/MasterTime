-- 0006 — Décisions d'absence (P9a, BR-17/18, FR-36→38) : pour chaque
-- séance impactée par une absence de professeur, une décision explicite
-- (remplacement / report / annulation) tracée avec auteur et horodatage.
-- Une décision par (absence, séance) — UNIQUE. REMPLACEMENT exige un
-- remplaçant (substitute_professor_id NOT NULL garanti applicativement ;
-- le CHECK le rend obligatoire dès que la décision est REMPLACEMENT).
-- professor_absence.resolution (A_TRAITER/PARTIELLE/RESOLUE) est STOCKÉE
-- et recalculée à chaque décision par absence.service.
CREATE TABLE absence_decision (
  id INTEGER PRIMARY KEY,
  absence_id INTEGER NOT NULL REFERENCES professor_absence(id),
  session_id INTEGER NOT NULL REFERENCES session(id),
  decision TEXT NOT NULL
    CHECK(decision IN ('REMPLACEMENT','REPORT','ANNULATION')),
  substitute_professor_id INTEGER REFERENCES professor(id),
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES app_user(id),
  note TEXT,
  CHECK(decision != 'REMPLACEMENT' OR substitute_professor_id IS NOT NULL),
  UNIQUE(absence_id, session_id));

CREATE INDEX ix_decision_absence ON absence_decision(absence_id);
