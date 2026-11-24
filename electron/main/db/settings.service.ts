/**
 * Service Paramètres (P12 — FR-51, BR-23/24) : gestion des créneaux
 * horaires `time_slot`, des exceptions calendrier `calendar_exception`
 * et de la clé `setting.backup_retention`.
 *
 * - Créneaux : weekday 0=lun..6=dim, minutes entières dans [0,1440],
 *   `start < end`, libellé ≤ 60 car. Les chevauchements entre créneaux
 *   d'un même jour sont AUTORISÉS mais signalés (`overlaps`) : la
 *   génération gère les fenêtres qui se recouvrent. Aucune FK ne
 *   référence `time_slot` — édition sans danger pour les séances
 *   existantes, effet uniquement sur la prochaine génération.
 * - Exceptions : dates ISO valides, `start ≤ end`, type CHECK en base,
 *   libellé requis ≤ 120 car. Chevauchements autorisés.
 * - Rétention : `backup_retention` (défaut 10), entier borné [1,100].
 *
 * Toutes les écritures passent par `withAudit` (BR-20) — sauf
 * `setRetention` : `setting` a une PK texte (`key`) alors que
 * `withAudit` relit par colonne `id` numérique ; l'audit y est écrit
 * manuellement au même format (entity `setting`, entity_id = clé).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  CalendarExceptionInput,
  CalendarExceptionRow,
  FieldError,
  TimeSlotInput,
  TimeSlotRow,
} from '../../../shared/types';
import { apiErr, apiOk, CALENDAR_EXCEPTION_TYPES } from '../../../shared/types';
import { all, get, run } from './connection';
import { withAudit } from './audit.service';
import { isValidIsoDate } from './date';

const MAX_SLOT_LABEL = 60;
const MAX_EXCEPTION_LABEL = 120;
/** Borne anti-erreur de saisie : une exception ≤ ~10 ans (3660 jours). */
const MAX_EXCEPTION_SPAN_DAYS = 3660;
const DAY_MS = 86_400_000;

const RETENTION_KEY = 'backup_retention';
const RETENTION_DEFAULT = 10;
const RETENTION_MIN = 1;
const RETENTION_MAX = 100;

const VALIDATION_ERR = 'Validation impossible : corrigez les champs signalés.';

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// --- Créneaux horaires -------------------------------------------------------

interface TimeSlotDbRow {
  id: number;
  weekday: number;
  start_min: number;
  end_min: number;
  label: string | null;
  overlaps: number;
}

function toTimeSlotRow(r: TimeSlotDbRow): TimeSlotRow {
  return {
    id: r.id,
    weekday: r.weekday,
    start_min: r.start_min,
    end_min: r.end_min,
    label: r.label,
    overlaps: r.overlaps === 1,
  };
}

const SLOT_SELECT = `
  SELECT t.id, t.weekday, t.start_min, t.end_min, t.label,
         EXISTS (
           SELECT 1 FROM time_slot o
            WHERE o.weekday = t.weekday AND o.id != t.id
              AND o.start_min < t.end_min AND o.end_min > t.start_min
         ) AS overlaps
    FROM time_slot t`;

function getTimeSlot(db: DatabaseSync, id: number): TimeSlotRow | undefined {
  const r = get<TimeSlotDbRow>(db, `${SLOT_SELECT} WHERE t.id = ?`, id);
  return r ? toTimeSlotRow(r) : undefined;
}

/** Tous les créneaux, triés `weekday, start_min`, avec flag `overlaps`. */
export function listTimeSlots(db: DatabaseSync): TimeSlotRow[] {
  return all<TimeSlotDbRow>(
    db,
    `${SLOT_SELECT} ORDER BY t.weekday, t.start_min, t.id`,
  ).map(toTimeSlotRow);
}

function validateTimeSlotInput(input: TimeSlotInput): FieldError[] {
  const errors: FieldError[] = [];
  const { weekday, start_min, end_min, label } = input ?? {};
  if (!isInt(weekday) || weekday < 0 || weekday > 6) {
    errors.push({
      field: 'weekday',
      message: 'Le jour doit être un entier entre 0 (lundi) et 6 (dimanche).',
    });
  }
  const startOk = isInt(start_min) && start_min >= 0 && start_min <= 1440;
  const endOk = isInt(end_min) && end_min >= 0 && end_min <= 1440;
  if (!startOk) {
    errors.push({
      field: 'start_min',
      message: "L'heure de début doit être un entier de minutes entre 0 et 1440.",
    });
  }
  if (!endOk) {
    errors.push({
      field: 'end_min',
      message: "L'heure de fin doit être un entier de minutes entre 0 et 1440.",
    });
  }
  if (startOk && endOk && start_min >= end_min) {
    errors.push({
      field: 'end_min',
      message: "L'heure de fin doit être strictement postérieure au début.",
    });
  }
  const lbl = label ?? null;
  if (lbl != null && (typeof lbl !== 'string' || lbl.length > MAX_SLOT_LABEL)) {
    errors.push({
      field: 'label',
      message: `Le libellé ne doit pas dépasser ${MAX_SLOT_LABEL} caractères.`,
    });
  }
  return errors;
}

export function createTimeSlot(
  db: DatabaseSync,
  userId: number | null,
  input: TimeSlotInput,
): ApiResult<TimeSlotRow> {
  const errors = validateTimeSlotInput(input);
  if (errors.length > 0) return apiErr(VALIDATION_ERR, errors);
  const label = input.label?.trim() || null;
  const id = withAudit(db, userId, 'CREATE', 'time_slot', null, () =>
    Number(
      run(
        db,
        'INSERT INTO time_slot (weekday, start_min, end_min, label) VALUES (?, ?, ?, ?)',
        input.weekday,
        input.start_min,
        input.end_min,
        label,
      ).lastInsertRowid,
    ),
  );
  return apiOk(getTimeSlot(db, id!)!);
}

export function updateTimeSlot(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: TimeSlotInput,
): ApiResult<TimeSlotRow> {
  const existing = getTimeSlot(db, id);
  if (!existing) {
    return apiErr('Créneau introuvable.');
  }
  const errors = validateTimeSlotInput(input);
  if (errors.length > 0) return apiErr(VALIDATION_ERR, errors);
  // `label` OMIS (undefined) → valeur existante conservée ;
  // null/'' explicite → effacé (comportement de correction volontaire).
  const label =
    input.label === undefined ? existing.label : input.label?.trim() || null;
  withAudit(db, userId, 'UPDATE', 'time_slot', id, () => {
    run(
      db,
      'UPDATE time_slot SET weekday = ?, start_min = ?, end_min = ?, label = ? WHERE id = ?',
      input.weekday,
      input.start_min,
      input.end_min,
      label,
      id,
    );
  });
  return apiOk(getTimeSlot(db, id)!);
}

export function deleteTimeSlot(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  if (!getTimeSlot(db, id)) {
    return apiErr('Créneau introuvable.');
  }
  withAudit(db, userId, 'DELETE', 'time_slot', id, () => {
    run(db, 'DELETE FROM time_slot WHERE id = ?', id);
  });
  return apiOk(null);
}

// --- Exceptions calendrier ---------------------------------------------------

function getException(
  db: DatabaseSync,
  id: number,
): CalendarExceptionRow | undefined {
  return get<CalendarExceptionRow>(
    db,
    'SELECT id, start_date, end_date, type, label FROM calendar_exception WHERE id = ?',
    id,
  );
}

/** Toutes les exceptions, triées par date de début. */
export function listExceptions(db: DatabaseSync): CalendarExceptionRow[] {
  return all<CalendarExceptionRow>(
    db,
    'SELECT id, start_date, end_date, type, label FROM calendar_exception ORDER BY start_date, id',
  );
}

function validateExceptionInput(
  input: CalendarExceptionInput,
): FieldError[] {
  const errors: FieldError[] = [];
  const { start_date, end_date, type, label } = input ?? {};
  const startOk =
    typeof start_date === 'string' && isValidIsoDate(start_date.trim());
  const endOk =
    typeof end_date === 'string' && isValidIsoDate(end_date.trim());
  if (!startOk) {
    errors.push({
      field: 'start_date',
      message: 'La date de début est invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (!endOk) {
    errors.push({
      field: 'end_date',
      message: 'La date de fin est invalide (AAAA-MM-JJ attendu).',
    });
  }
  if (startOk && endOk && start_date.trim() > end_date.trim()) {
    errors.push({
      field: 'end_date',
      message: 'La date de fin doit être postérieure ou égale au début.',
    });
  } else if (
    startOk &&
    endOk &&
    (Date.parse(end_date.trim()) - Date.parse(start_date.trim())) / DAY_MS >
      MAX_EXCEPTION_SPAN_DAYS
  ) {
    errors.push({
      field: 'end_date',
      message: `La période ne doit pas dépasser ${MAX_EXCEPTION_SPAN_DAYS} jours.`,
    });
  }
  if (
    typeof type !== 'string' ||
    !(CALENDAR_EXCEPTION_TYPES as readonly string[]).includes(type)
  ) {
    errors.push({ field: 'type', message: "Type d'exception inconnu." });
  }
  const lbl = typeof label === 'string' ? label.trim() : '';
  if (!lbl) {
    errors.push({ field: 'label', message: 'Le libellé est obligatoire.' });
  } else if (lbl.length > MAX_EXCEPTION_LABEL) {
    errors.push({
      field: 'label',
      message: `Le libellé ne doit pas dépasser ${MAX_EXCEPTION_LABEL} caractères.`,
    });
  }
  return errors;
}

export function createException(
  db: DatabaseSync,
  userId: number | null,
  input: CalendarExceptionInput,
): ApiResult<CalendarExceptionRow> {
  const errors = validateExceptionInput(input);
  if (errors.length > 0) return apiErr(VALIDATION_ERR, errors);
  const id = withAudit(db, userId, 'CREATE', 'calendar_exception', null, () =>
    Number(
      run(
        db,
        `INSERT INTO calendar_exception (start_date, end_date, type, label)
         VALUES (?, ?, ?, ?)`,
        input.start_date.trim(),
        input.end_date.trim(),
        input.type,
        input.label.trim(),
      ).lastInsertRowid,
    ),
  );
  return apiOk(getException(db, id!)!);
}

export function updateException(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  input: CalendarExceptionInput,
): ApiResult<CalendarExceptionRow> {
  if (!getException(db, id)) {
    return apiErr('Exception introuvable.');
  }
  const errors = validateExceptionInput(input);
  if (errors.length > 0) return apiErr(VALIDATION_ERR, errors);
  withAudit(db, userId, 'UPDATE', 'calendar_exception', id, () => {
    run(
      db,
      `UPDATE calendar_exception
          SET start_date = ?, end_date = ?, type = ?, label = ?
        WHERE id = ?`,
      input.start_date.trim(),
      input.end_date.trim(),
      input.type,
      input.label.trim(),
      id,
    );
  });
  return apiOk(getException(db, id)!);
}

export function deleteException(
  db: DatabaseSync,
  userId: number | null,
  id: number,
): ApiResult<null> {
  if (!getException(db, id)) {
    return apiErr('Exception introuvable.');
  }
  withAudit(db, userId, 'DELETE', 'calendar_exception', id, () => {
    run(db, 'DELETE FROM calendar_exception WHERE id = ?', id);
  });
  return apiOk(null);
}

// --- Rétention des sauvegardes -----------------------------------------------

/**
 * `backup_retention` : valeur stockée, défaut 10 si absente ou illisible,
 * bornée [1,100] (une valeur stockée hors bornes est rabattue, pas
 * d'erreur en lecture). Seul un entier décimal canonique (`^\d+$`)
 * est accepté — `'0x14'`, `'1e2'`, `' 15 '`… → défaut, pas de parse
 * exotique.
 */
export function getRetention(db: DatabaseSync): number {
  const row = get<{ value: string }>(
    db,
    'SELECT value FROM setting WHERE key = ?',
    RETENTION_KEY,
  );
  if (row === undefined || !/^\d+$/.test(row.value)) {
    return RETENTION_DEFAULT;
  }
  const n = Number(row.value); // chiffres uniquement → conversion sûre
  return Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, n));
}

/**
 * Met à jour `backup_retention` — entier dans [1,100].
 * Audit manuel au format `withAudit` : entity `setting`,
 * `entity_id` = clé (`'backup_retention'`) — la PK de `setting` est
 * textuelle, `withAudit` ne relit que par colonne `id`.
 */
export function setRetention(
  db: DatabaseSync,
  userId: number | null,
  n: unknown,
): ApiResult<number> {
  if (!isInt(n) || n < RETENTION_MIN || n > RETENTION_MAX) {
    return apiErr(VALIDATION_ERR, [
      {
        field: 'retention',
        message: `La rétention doit être un entier entre ${RETENTION_MIN} et ${RETENTION_MAX}.`,
      },
    ]);
  }
  if (db.isTransaction) {
    // Comme `withAudit` : BEGIN IMMEDIATE imbriqué échouerait et un
    // rollback externe laisserait la trace sans la mutation.
    throw new Error(
      'setRetention refusé : transaction déjà ouverte — ' +
        "l'audit doit piloter sa propre transaction.",
    );
  }
  db.exec('BEGIN IMMEDIATE;');
  try {
    const before = get<Record<string, unknown>>(
      db,
      'SELECT * FROM setting WHERE key = ?',
      RETENTION_KEY,
    );
    run(
      db,
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      RETENTION_KEY,
      String(n),
    );
    const after = get<Record<string, unknown>>(
      db,
      'SELECT * FROM setting WHERE key = ?',
      RETENTION_KEY,
    );
    const oldJson = before === undefined ? null : JSON.stringify(before);
    const newJson = after === undefined ? null : JSON.stringify(after);
    if (oldJson !== newJson) {
      run(
        db,
        `INSERT INTO audit_log (user_id, action, entity, entity_id, old_values, new_values)
         VALUES (?, ?, ?, ?, ?, ?)`,
        userId,
        before === undefined ? 'CREATE' : 'UPDATE',
        'setting',
        RETENTION_KEY,
        oldJson,
        newJson,
      );
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // connexion possiblement hors transaction — l'erreur d'origine prime
    }
    throw err;
  }
  return apiOk(n);
}
