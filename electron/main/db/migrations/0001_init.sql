-- Migration 0001 — schéma initial MasterTime Tanger
-- DDL repris de DATA-MODEL.md (ordre corrigé : référentiels déclarés avant usage FK).
-- Conventions AD-7 : dates TEXT 'YYYY-MM-DD', heures/durées INTEGER minutes.

-- Référentiel temps
CREATE TABLE academic_year (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE,   -- '2026-2027'
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0);

CREATE TABLE semester (
  id INTEGER PRIMARY KEY, academic_year_id INTEGER NOT NULL REFERENCES academic_year(id),
  label TEXT NOT NULL, ordinal INTEGER NOT NULL,        -- S1..S4
  UNIQUE(academic_year_id, ordinal));

CREATE TABLE time_slot (                                -- créneaux autorisés
  id INTEGER PRIMARY KEY, weekday INTEGER NOT NULL,     -- 0=lun..6=dim
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, label TEXT,
  CHECK (start_min < end_min));

CREATE TABLE calendar_exception (                       -- fériés, examens, fermetures
  id INTEGER PRIMARY KEY, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('FERIE','EXAMEN','FERMETURE','VACANCES')),
  label TEXT NOT NULL);

-- Structure pédagogique
CREATE TABLE master (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  filiere TEXT, department TEXT, responsible_name TEXT,
  academic_year_id INTEGER NOT NULL REFERENCES academic_year(id),
  semester_id INTEGER REFERENCES semester(id),
  status TEXT NOT NULL DEFAULT 'ACTIF' CHECK(status IN ('ACTIF','ARCHIVE')),
  is_demo INTEGER NOT NULL DEFAULT 0);

CREATE TABLE student_group (
  id INTEGER PRIMARY KEY, master_id INTEGER NOT NULL REFERENCES master(id),
  name TEXT NOT NULL, size INTEGER,
  UNIQUE(master_id, name));

CREATE TABLE student (                                  -- registre (import)
  id INTEGER PRIMARY KEY, student_group_id INTEGER NOT NULL REFERENCES student_group(id),
  external_id TEXT, full_name TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE(student_group_id, external_id));

CREATE TABLE professor (
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, internal_ref TEXT UNIQUE,
  email TEXT, phone TEXT, is_demo INTEGER NOT NULL DEFAULT 0);

CREATE TABLE module (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0);

CREATE TABLE master_module (                            -- le "quoi enseigner"
  id INTEGER PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES master(id),
  module_id INTEGER NOT NULL REFERENCES module(id),
  semester_id INTEGER NOT NULL REFERENCES semester(id),
  professor_id INTEGER NOT NULL REFERENCES professor(id),
  student_group_id INTEGER REFERENCES student_group(id),  -- NULL = master entier
  volume_min INTEGER NOT NULL,                            -- volume horaire prévu
  session_duration_min INTEGER NOT NULL,
  planned_sessions INTEGER NOT NULL,
  distribution_rule TEXT,                                 -- JSON: prefs/répartition
  sched_start TEXT NOT NULL, sched_end TEXT NOT NULL,
  UNIQUE(master_id, module_id, semester_id, student_group_id));

-- Ressources
CREATE TABLE room (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,    -- 'Amphithéâtre 7'…
  capacity INTEGER, is_active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE professor_availability (
  id INTEGER PRIMARY KEY, professor_id INTEGER NOT NULL REFERENCES professor(id),
  weekday INTEGER NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('DISPO','INDISPO')),
  effective_from TEXT, effective_to TEXT,
  CHECK (start_min < end_min));

CREATE TABLE professor_absence (
  id INTEGER PRIMARY KEY, professor_id INTEGER NOT NULL REFERENCES professor(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT,
  resolution TEXT NOT NULL DEFAULT 'A_TRAITER'
    CHECK(resolution IN ('A_TRAITER','PARTIELLE','RESOLUE')));

-- Utilisateurs (déclarés tôt : référencés par generation/history/audit)
CREATE TABLE app_user (
  id INTEGER PRIMARY KEY, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','GESTIONNAIRE')),
  is_active INTEGER NOT NULL DEFAULT 1);

-- Génération (déclarée avant session : FK session.generation_id)
CREATE TABLE schedule_generation (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES app_user(id),
  academic_year_id INTEGER, semester_id INTEGER,
  params_json TEXT, result_json TEXT,                     -- non placées + motifs
  placed_count INTEGER, status TEXT NOT NULL DEFAULT 'PREVIEW'
    CHECK(status IN ('PREVIEW','APPLIED','ABANDONED')));

-- Cœur : les séances
CREATE TABLE session (
  id INTEGER PRIMARY KEY,
  master_module_id INTEGER NOT NULL REFERENCES master_module(id),
  professor_id INTEGER NOT NULL REFERENCES professor(id),
  room_id INTEGER NOT NULL REFERENCES room(id),
  date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREVUE' CHECK(status IN
    ('PREVUE','REALISEE','ANNULEE','REPORTEE')),
  actual_date TEXT, actual_start_min INTEGER, actual_end_min INTEGER,
  comment TEXT, generation_id INTEGER REFERENCES schedule_generation(id),
  is_demo INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
  CHECK (start_min < end_min));
-- NB: 'NON_ENCORE_REALISEE' non stocké — dérivé (AD-7)

CREATE TABLE session_status_history (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES session(id),
  old_status TEXT, new_status TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by INTEGER REFERENCES app_user(id), reason TEXT,
  old_date TEXT, old_start_min INTEGER, old_end_min INTEGER,
  new_date TEXT, new_start_min INTEGER, new_end_min INTEGER);

-- Présences étudiants (v1)
CREATE TABLE session_attendance (                        -- mode comptage
  session_id INTEGER PRIMARY KEY REFERENCES session(id),
  present_count INTEGER NOT NULL DEFAULT 0,
  absent_count INTEGER NOT NULL DEFAULT 0, note TEXT);

CREATE TABLE student_attendance (                        -- mode nominatif
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES session(id),
  student_id INTEGER NOT NULL REFERENCES student(id),
  status TEXT NOT NULL CHECK(status IN ('PRESENT','ABSENT','JUSTIFIE')),
  UNIQUE(session_id, student_id));

-- Système
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES app_user(id),
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
  old_values TEXT, new_values TEXT);                      -- JSON

CREATE TABLE backup_history (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')),
  path TEXT NOT NULL, size_bytes INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('MANUEL','AUTO','PRE_MIGRATION')),
  restored INTEGER NOT NULL DEFAULT 0);

CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- clés: backup_retention(10), max_daily_load_min, generation_tolerance_min…

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);

-- Index
CREATE INDEX ix_session_room_date    ON session(date, room_id)   WHERE status != 'ANNULEE';
CREATE INDEX ix_session_prof_date    ON session(date, professor_id) WHERE status != 'ANNULEE';
CREATE INDEX ix_session_mm           ON session(master_module_id);
CREATE INDEX ix_session_status       ON session(status);
CREATE INDEX ix_ssh_session          ON session_status_history(session_id);
CREATE INDEX ix_avail_prof_day       ON professor_availability(professor_id, weekday);
CREATE INDEX ix_attend_session       ON student_attendance(session_id);
CREATE INDEX ix_audit_entity         ON audit_log(entity, entity_id);
CREATE INDEX ix_audit_at             ON audit_log(at);
