-- 0009 — Portail web public : comptes profs, sessions de connexion,
-- présence visiteurs, demandes profs (annulation/report), avis bilingues
-- publiés et réclamations.
CREATE TABLE web_professor_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  professor_id INTEGER NOT NULL UNIQUE REFERENCES professor(id) ON DELETE CASCADE,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE web_session (
  token TEXT PRIMARY KEY,
  professor_id INTEGER NOT NULL REFERENCES professor(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_web_session_prof ON web_session(professor_id);
CREATE INDEX idx_web_session_seen ON web_session(last_seen_at);

-- Visiteurs anonymes (heartbeat navigateur) — compteur « en ligne ».
CREATE TABLE web_visitor (
  token TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  professor_id INTEGER NOT NULL REFERENCES professor(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cancel','move')),
  reason TEXT NOT NULL DEFAULT '',
  proposed_date TEXT,
  proposed_start_min INTEGER,
  proposed_end_min INTEGER,
  proposed_room_id INTEGER REFERENCES room(id),
  status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX idx_session_request_status ON session_request(status);
CREATE INDEX idx_session_request_prof ON session_request(professor_id);

CREATE TABLE announcement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_fr TEXT NOT NULL,
  title_ar TEXT NOT NULL DEFAULT '',
  body_fr TEXT NOT NULL,
  body_ar TEXT NOT NULL DEFAULT '',
  session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
  session_request_id INTEGER REFERENCES session_request(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_announcement_active ON announcement(is_active, published_at);

CREATE TABLE complaint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT 'etudiant',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','handled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_complaint_status ON complaint(status);
