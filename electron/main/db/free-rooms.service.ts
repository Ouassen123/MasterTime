/**
 * P18 — Grille des salles disponibles (lecture seule).
 *
 * `freeRoomsGrid(db, params)` : pour la semaine `week_start` (lundi ISO)
 * et une durée `duration_min` ∈ {60,90,120,180} (défaut 120), découpe
 * chaque fenêtre `time_slot` du weekday en créneaux candidats de la
 * durée demandée — un créneau doit tenir ENTIER dans une fenêtre (même
 * règle que la génération : hors grille = non planifiable).
 *
 * Par (jour, créneau) : salles `is_active=1` sans séance non-ANNULEE
 * chevauchant [start,end] ET sans `external_occupancy` du weekday
 * chevauchant (année NULL ou année contenant le jour — même règle que
 * la garde BR-7/P7). Un jour couvert par `calendar_exception` est
 * marqué `closed` (type de l'exception) et n'a aucune case.
 *
 * Réponse : `{days, slots, cells}` — `cells["<date>|<start_min>"]`
 * liste les salles libres triées par capacité croissante puis nom ;
 * les cases sans salle libre sont omises (« — » côté UI).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  CalendarExceptionType,
  FieldError,
  FreeRoomRef,
  FreeRoomsDay,
  FreeRoomsGrid,
  FreeRoomsParams,
  FreeRoomsSlot,
} from '../../../shared/types';
import { apiErr, apiOk, FREE_ROOMS_DURATIONS } from '../../../shared/types';
import { all } from './connection';
import { isValidIsoDate } from './date';
import { weekdayOf } from './availability';

interface Interval {
  s: number;
  e: number;
}

interface ExtOcc {
  s: number;
  e: number;
  yearId: number | null;
}

/** `date` + `days` jours en ISO (calcul UTC — pas de fuseau). */
function addDays(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Fenêtres `time_slot` par weekday (0=lun..6=dim), triées. */
function loadSlotsByWeekday(db: DatabaseSync): Map<number, Interval[]> {
  const map = new Map<number, Interval[]>();
  for (const ts of all<{
    weekday: number;
    start_min: number;
    end_min: number;
  }>(
    db,
    'SELECT weekday, start_min, end_min FROM time_slot ORDER BY weekday, start_min',
  )) {
    const list = map.get(ts.weekday) ?? [];
    list.push({ s: ts.start_min, e: ts.end_min });
    map.set(ts.weekday, list);
  }
  return map;
}

export function freeRoomsGrid(
  db: DatabaseSync,
  params: FreeRoomsParams,
): ApiResult<FreeRoomsGrid> {
  // --- Validation stricte --------------------------------------------------
  const errors: FieldError[] = [];
  const weekStart =
    typeof params?.week_start === 'string' ? params.week_start.trim() : '';
  if (!isValidIsoDate(weekStart) || weekdayOf(weekStart) !== 0) {
    errors.push({
      field: 'week_start',
      message: 'Le début de semaine doit être un lundi (AAAA-MM-JJ).',
    });
  }
  const durationMin = params?.duration_min ?? 120;
  if (
    !Number.isInteger(durationMin) ||
    !(FREE_ROOMS_DURATIONS as readonly number[]).includes(durationMin)
  ) {
    errors.push({
      field: 'duration_min',
      message: 'Durée invalide (60, 90, 120 ou 180 minutes).',
    });
  }
  if (errors.length > 0) {
    return apiErr('Paramètres de la grille invalides.', errors);
  }
  const weekEnd = addDays(weekStart, 6);

  // --- Référentiels ---------------------------------------------------------
  const slotsByWeekday = loadSlotsByWeekday(db);

  // Jours fermés par exception calendrier (bornes clampées à la semaine —
  // une plage très longue ne doit pas faire boucler l'expansion).
  const closedByDate = new Map<string, CalendarExceptionType>();
  for (const ex of all<{
    start_date: string;
    end_date: string;
    type: CalendarExceptionType;
  }>(
    db,
    `SELECT start_date, end_date, type FROM calendar_exception
      WHERE start_date <= ? AND end_date >= ?`,
    weekEnd,
    weekStart,
  )) {
    if (
      !isValidIsoDate(ex.start_date) ||
      !isValidIsoDate(ex.end_date) ||
      ex.start_date > ex.end_date
    ) {
      continue;
    }
    for (let d = ex.start_date; d <= ex.end_date && d <= weekEnd; d = addDays(d, 1)) {
      if (d >= weekStart) closedByDate.set(d, ex.type);
    }
  }

  // Séances non-ANNULEE de la semaine : `date|roomId` → intervalles.
  const busyByRoomDay = new Map<string, Interval[]>();
  for (const s of all<{
    room_id: number;
    date: string;
    start_min: number;
    end_min: number;
  }>(
    db,
    `SELECT room_id, date, start_min, end_min FROM session
      WHERE date >= ? AND date <= ? AND status != 'ANNULEE'`,
    weekStart,
    weekEnd,
  )) {
    const key = `${s.date}|${s.room_id}`;
    const list = busyByRoomDay.get(key) ?? [];
    list.push({ s: s.start_min, e: s.end_min });
    busyByRoomDay.set(key, list);
  }

  // Occupations externes pré-indexées `roomId|weekday` → intervalles
  // (même indexation que la génération — pas de requête par candidat).
  const extByRoomDay = new Map<string, ExtOcc[]>();
  for (const o of all<{
    roomId: number;
    weekday: number;
    s: number;
    e: number;
    yearId: number | null;
  }>(
    db,
    `SELECT room_id AS roomId, weekday, start_min AS s, end_min AS e,
            academic_year_id AS yearId
       FROM external_occupancy`,
  )) {
    const key = `${o.roomId}|${o.weekday}`;
    const list = extByRoomDay.get(key) ?? [];
    list.push({ s: o.s, e: o.e, yearId: o.yearId });
    extByRoomDay.set(key, list);
  }

  // Années universitaires → année contenant chaque jour (règle BR-7 :
  // occupation NULL ou de l'année du jour seulement).
  const years = all<{ id: number; start_date: string; end_date: string }>(
    db,
    'SELECT id, start_date, end_date FROM academic_year',
  );
  const yearOf = (date: string): number | null =>
    years.find((y) => y.start_date <= date && date <= y.end_date)?.id ?? null;

  // Salles actives : tri capacité croissante puis nom (capacité inconnue
  // en dernier — l'utilisateur choisit la plus adaptée).
  const rooms = all<FreeRoomRef>(
    db,
    'SELECT id AS room_id, name, capacity FROM room WHERE is_active = 1',
  ).sort(
    (a, b) =>
      (a.capacity ?? Number.MAX_SAFE_INTEGER) -
        (b.capacity ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  );

  // --- Jours + union des créneaux candidats ----------------------------------
  const days: FreeRoomsDay[] = [];
  const slotsByDate = new Map<string, FreeRoomsSlot[]>();
  const slotSet = new Map<string, FreeRoomsSlot>(); // `${s}-${e}` → slot
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    days.push({ date, closed: closedByDate.get(date) ?? null });
    const seen = new Set<string>();
    const daySlots: FreeRoomsSlot[] = [];
    for (const w of slotsByWeekday.get(weekdayOf(date)) ?? []) {
      for (let s = w.s; s + durationMin <= w.e; s += durationMin) {
        const key = `${s}-${s + durationMin}`;
        let slot = slotSet.get(key);
        if (!slot) {
          slot = { start_min: s, end_min: s + durationMin };
          slotSet.set(key, slot);
        }
        if (!seen.has(key)) {
          seen.add(key);
          daySlots.push(slot);
        }
      }
    }
    daySlots.sort((a, b) => a.start_min - b.start_min);
    slotsByDate.set(date, daySlots);
  }
  const slots = [...slotSet.values()].sort(
    (a, b) => a.start_min - b.start_min,
  );

  // --- Cases : salles libres par (jour, créneau) ------------------------------
  const cells: Record<string, FreeRoomRef[]> = {};
  for (const day of days) {
    if (day.closed != null) continue; // jour fermé : aucune case
    const weekday = weekdayOf(day.date);
    const yearId = yearOf(day.date);
    for (const slot of slotsByDate.get(day.date) ?? []) {
      const free = rooms.filter((r) => {
        const sess = busyByRoomDay.get(`${day.date}|${r.room_id}`) ?? [];
        if (sess.some((iv) => slot.start_min < iv.e && iv.s < slot.end_min)) {
          return false;
        }
        const ext = extByRoomDay.get(`${r.room_id}|${weekday}`) ?? [];
        return !ext.some(
          (iv) =>
            (iv.yearId == null || iv.yearId === yearId) &&
            slot.start_min < iv.e &&
            iv.s < slot.end_min,
        );
      });
      if (free.length > 0) {
        cells[`${day.date}|${slot.start_min}`] = free;
      }
    }
  }

  return apiOk({ days, slots, cells });
}
