/**
 * Détection de conflits (P7a — BR-11) — lecture seule, tout en SQL :
 * self-joins sur date + chevauchement strict (`a.start < b.end AND
 * b.start < a.end`), paires miroir éliminées par `b.id > a.id`.
 * Les séances ANNULEE ne produisent jamais de conflit.
 *
 * Kinds : ROOM (même salle), PROFESSOR (même professeur), MASTER (même
 * master via master_module), GROUP (même groupe via session_group),
 * EXTERNAL (séance ↔ external_occupancy même salle, weekday récurrent
 * ↔ weekday de la date — AD-7 : 0=lundi, SQLite %w 0=dimanche donc
 * `(%w + 6) % 7`).
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ConflictFilter,
  ConflictItem,
  ConflictKind,
  ConflictSummary,
  PlacementConflict,
  PlacementQuery,
} from '../../../shared/types';
import { apiErr, apiOk, type ApiResult } from '../../../shared/types';
import { all, get } from './connection';
import { isValidIsoDate } from './date';

const KIND_ORDER: ConflictKind[] = [
  'EXTERNAL',
  'GROUP',
  'MASTER',
  'PROFESSOR',
  'ROOM',
];

/** Jointures référentiel des deux séances d'une paire (alias a/b). */
const PAIR_JOINS = `
  JOIN master_module am ON am.id = a.master_module_id
  JOIN master maa ON maa.id = am.master_id
  JOIN module moa ON moa.id = am.module_id
  JOIN master_module bm ON bm.id = b.master_module_id
  JOIN master mab ON mab.id = bm.master_id
  JOIN module mob ON mob.id = bm.module_id`;

const PAIR_COLS = `
       a.id AS a_id, b.id AS b_id, a.date,
       max(a.start_min, b.start_min) AS ov_start,
       min(a.end_min, b.end_min) AS ov_end,
       maa.name AS a_master, moa.name AS a_module,
       mab.name AS b_master, mob.name AS b_module`;

interface PairRow {
  a_id: number;
  b_id: number;
  date: string;
  ov_start: number;
  ov_end: number;
  a_master: string;
  a_module: string;
  b_master: string;
  b_module: string;
  entity: string;
}

/** Plage de dates optionnelle : `a.date`/`s.date` selon l'alias utilisé. */
function dateRange(
  alias: 'a' | 's',
  filter: ConflictFilter | undefined,
): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const from =
    typeof filter?.dateFrom === 'string' ? filter.dateFrom.trim() : '';
  const to = typeof filter?.dateTo === 'string' ? filter.dateTo.trim() : '';
  if (isValidIsoDate(from)) {
    clauses.push(` AND ${alias}.date >= ?`);
    params.push(from);
  }
  if (isValidIsoDate(to)) {
    clauses.push(` AND ${alias}.date <= ?`);
    params.push(to);
  }
  return { clause: clauses.join(''), params };
}

function pairItem(kind: ConflictKind, r: PairRow): ConflictItem {
  return {
    kind,
    date: r.date,
    startMin: r.ov_start,
    endMin: r.ov_end,
    entityLabel: r.entity,
    sessions: [
      {
        id: r.a_id,
        label: `${r.a_module} — ${r.a_master}`,
        masterName: r.a_master,
        moduleName: r.a_module,
      },
      {
        id: r.b_id,
        label: `${r.b_module} — ${r.b_master}`,
        masterName: r.b_master,
        moduleName: r.b_module,
      },
    ],
    detail: `${r.a_module} (${r.a_master}) ↔ ${r.b_module} (${r.b_master})`,
  };
}

/** Validation du filtre : dates fournies mais invalides → erreur. */
function validateFilter(filter: ConflictFilter | undefined): string | null {
  if (
    filter?.dateFrom != null &&
    (typeof filter.dateFrom !== 'string' || !isValidIsoDate(filter.dateFrom))
  ) {
    return 'Date de début invalide (AAAA-MM-JJ attendu).';
  }
  if (
    filter?.dateTo != null &&
    (typeof filter.dateTo !== 'string' || !isValidIsoDate(filter.dateTo))
  ) {
    return 'Date de fin invalide (AAAA-MM-JJ attendu).';
  }
  return null;
}

/**
 * Conflits réels de la base (BR-11), triés (date, kind). Une entrée par
 * paire de séances en chevauchement — les doublons de paires GROUP
 * (même séance partageant plusieurs groupes) sont fusionnés en
 * concaténant les libellés de groupes.
 */
export function detectConflicts(
  db: DatabaseSync,
  filter: ConflictFilter = {},
): ApiResult<ConflictItem[]> {
  const err = validateFilter(filter);
  if (err) return apiErr(err);
  const range = dateRange('a', filter);
  const items: ConflictItem[] = [];

  // ROOM — même salle, même date, chevauchement strict.
  for (const r of all<PairRow>(
    db,
    `SELECT${PAIR_COLS}, r.name AS entity
       FROM session a
       JOIN session b ON b.date = a.date AND b.room_id = a.room_id
                     AND b.id > a.id
       JOIN room r ON r.id = a.room_id${PAIR_JOINS}
      WHERE a.status != 'ANNULEE' AND b.status != 'ANNULEE'
        AND a.start_min < b.end_min AND b.start_min < a.end_min${range.clause}`,
    ...range.params,
  )) {
    items.push(pairItem('ROOM', r));
  }

  // PROFESSOR — même professeur.
  for (const r of all<PairRow>(
    db,
    `SELECT${PAIR_COLS}, p.full_name AS entity
       FROM session a
       JOIN session b ON b.date = a.date AND b.professor_id = a.professor_id
                     AND b.id > a.id
       JOIN professor p ON p.id = a.professor_id${PAIR_JOINS}
      WHERE a.status != 'ANNULEE' AND b.status != 'ANNULEE'
        AND a.start_min < b.end_min AND b.start_min < a.end_min${range.clause}`,
    ...range.params,
  )) {
    items.push(pairItem('PROFESSOR', r));
  }

  // MASTER — même master (via master_module des deux côtés).
  for (const r of all<PairRow>(
    db,
    `SELECT${PAIR_COLS}, maa.name AS entity
       FROM session a
       JOIN session b ON b.date = a.date AND b.id > a.id${PAIR_JOINS}
      WHERE bm.master_id = am.master_id
        AND a.status != 'ANNULEE' AND b.status != 'ANNULEE'
        AND a.start_min < b.end_min AND b.start_min < a.end_min${range.clause}`,
    ...range.params,
  )) {
    items.push(pairItem('MASTER', r));
  }

  // GROUP — groupes d'une séance = mm.student_group_id UNION session_group
  // (même définition que group_name de SESSION_SELECT), des DEUX côtés :
  // deux séances dont le même groupe vient de chemins différents
  // (mm d'un côté, session_group de l'autre) produisent bien un conflit.
  // Fusion par paire : plusieurs groupes communs → une seule entrée,
  // entityLabel et detail listent tous les groupes.
  const SESSION_GROUPS = `SELECT s.id AS sid, g.id AS gid,
            g.name || ' (' || gm.name || ')' AS glabel
       FROM session s
       JOIN master_module mmx ON mmx.id = s.master_module_id
      JOIN student_group g ON g.id = mmx.student_group_id
       JOIN master gm ON gm.id = g.master_id
      UNION
      SELECT sg.session_id, g2.id, g2.name || ' (' || gm2.name || ')'
       FROM session_group sg
       JOIN student_group g2 ON g2.id = sg.student_group_id
       JOIN master gm2 ON gm2.id = g2.master_id`;
  const groupByPair = new Map<string, { item: ConflictItem; base: string }>();
  for (const r of all<PairRow>(
    db,
    `SELECT${PAIR_COLS}, ga.glabel AS entity
       FROM session a
       JOIN session b ON b.date = a.date AND b.id > a.id
       JOIN (${SESSION_GROUPS}) ga ON ga.sid = a.id
       JOIN (${SESSION_GROUPS}) gb ON gb.sid = b.id AND gb.gid = ga.gid${PAIR_JOINS}
      WHERE a.status != 'ANNULEE' AND b.status != 'ANNULEE'
        AND a.start_min < b.end_min AND b.start_min < a.end_min${range.clause}`,
    ...range.params,
  )) {
    const key = `${r.a_id}:${r.b_id}`;
    const prev = groupByPair.get(key);
    if (prev) {
      prev.item.entityLabel = `${prev.item.entityLabel}, ${r.entity}`;
      prev.item.detail = `${prev.base} — ${prev.item.entityLabel}`;
    } else {
      const item = pairItem('GROUP', r);
      const base = item.detail;
      item.detail = `${base} — ${r.entity}`;
      groupByPair.set(key, { item, base });
    }
  }
  for (const { item } of groupByPair.values()) items.push(item);

  // EXTERNAL — séance ↔ blocage Licence même salle, weekday récurrent.
  const extRange = dateRange('s', filter);
  interface ExtRow {
    s_id: number;
    date: string;
    ov_start: number;
    ov_end: number;
    program: string;
    groupe: string | null;
    occ_module: string | null;
    room_name: string;
    s_master: string;
    s_module: string;
  }
  for (const r of all<ExtRow>(
    db,
    `SELECT s.id AS s_id, s.date,
            max(s.start_min, eo.start_min) AS ov_start,
            min(s.end_min, eo.end_min) AS ov_end,
            eo.program, eo.groupe, eo.module AS occ_module,
            r.name AS room_name,
            ma.name AS s_master, mo.name AS s_module
       FROM session s
       JOIN external_occupancy eo
         ON eo.room_id = s.room_id
        AND eo.weekday = ((CAST(strftime('%w', s.date) AS integer) + 6) % 7)
        AND s.start_min < eo.end_min AND eo.start_min < s.end_min
       JOIN room r ON r.id = s.room_id
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master ma ON ma.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
      WHERE s.status != 'ANNULEE'
        AND (eo.academic_year_id IS NULL
             OR eo.academic_year_id = ma.academic_year_id)${extRange.clause}`,
    ...extRange.params,
  )) {
    const entity = `Licence — ${r.program}${r.groupe ? ` · ${r.groupe}` : ''}`;
    items.push({
      kind: 'EXTERNAL',
      date: r.date,
      startMin: r.ov_start,
      endMin: r.ov_end,
      entityLabel: entity,
      sessions: [
        {
          id: r.s_id,
          label: `${r.s_module} — ${r.s_master}`,
          masterName: r.s_master,
          moduleName: r.s_module,
        },
      ],
      detail: `${entity} occupe ${r.room_name}`,
    });
  }

  items.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
      x.entityLabel.localeCompare(y.entityLabel) ||
      x.startMin - y.startMin,
  );
  return apiOk(items);
}

// --- Garde d'écriture (P7b — BR-10) ------------------------------------------

/**
 * Colonnes de la séance adverse `b` confrontée au candidat : fenêtre de
 * chevauchement + libellés master/module (mêmes jointures que PAIR_JOINS,
 * côté `b` uniquement — le candidat n'existe pas en base).
 */
const ADVERSE_JOINS = `
  JOIN master_module bm ON bm.id = b.master_module_id
  JOIN master mab ON mab.id = bm.master_id
  JOIN module mob ON mob.id = bm.module_id`;

const ADVERSE_COLS = `
       b.id AS b_id,
       max(?, b.start_min) AS ov_start, min(?, b.end_min) AS ov_end,
       mab.name AS b_master, mob.name AS b_module`;

interface AdverseRow {
  b_id: number;
  ov_start: number;
  ov_end: number;
  b_master: string;
  b_module: string;
  entity: string;
}

function placementItem(
  kind: ConflictKind,
  q: PlacementQuery,
  r: AdverseRow,
): PlacementConflict {
  return {
    kind,
    date: q.date,
    startMin: r.ov_start,
    endMin: r.ov_end,
    entityLabel: r.entity,
    sessions: [
      {
        id: r.b_id,
        label: `${r.b_module} — ${r.b_master}`,
        masterName: r.b_master,
        moduleName: r.b_module,
      },
    ],
    detail: `${r.entity} ↔ ${r.b_module} (${r.b_master})`,
  };
}

/**
 * Garde d'écriture BR-7→BR-10 : vérifie qu'un CANDIDAT de séance peut
 * occuper [date, startMin, endMin) — mêmes règles que `detectConflicts`
 * mais ciblées sur un seul créneau (une requête par kind, pas de
 * full-scan). `excludeSessionId` retire la séance déplacée de la
 * comparaison ; `groupIds` est l'ensemble COMPLET des groupes du
 * candidat (mm.student_group_id + session_group). Retour vide =
 * placement autorisé ; l'appelant refuse l'écriture sinon.
 */
export function checkSessionPlacement(
  db: DatabaseSync,
  q: PlacementQuery,
): ApiResult<PlacementConflict[]> {
  const date = typeof q?.date === 'string' ? q.date.trim() : '';
  if (!isValidIsoDate(date)) {
    return apiErr('Date invalide (AAAA-MM-JJ attendu).');
  }
  if (
    !Number.isInteger(q.startMin) ||
    !Number.isInteger(q.endMin) ||
    q.startMin < 0 ||
    q.startMin >= q.endMin ||
    q.endMin > 1440
  ) {
    return apiErr('Horaire invalide (0 ≤ début < fin ≤ 24h00).');
  }
  const isRef = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0;
  if (!isRef(q.roomId) || !isRef(q.professorId) || !isRef(q.masterId)) {
    return apiErr('Référence invalide (salle, professeur ou master).');
  }
  const master = get<{ academic_year_id: number }>(
    db,
    'SELECT academic_year_id FROM master WHERE id = ?',
    q.masterId,
  );
  if (!master) {
    return apiErr('Master inexistant.');
  }
  const exclude = isRef(q.excludeSessionId) ? q.excludeSessionId : -1;
  const groupIds = Array.isArray(q.groupIds)
    ? [...new Set(q.groupIds.filter(isRef))]
    : [];
  const items: PlacementConflict[] = [];

  // ROOM — même salle, même date, chevauchement strict.
  for (const r of all<AdverseRow>(
    db,
    `SELECT${ADVERSE_COLS}, r.name AS entity
       FROM session b
       JOIN room r ON r.id = b.room_id${ADVERSE_JOINS}
      WHERE b.date = ? AND b.room_id = ?
        AND b.status != 'ANNULEE' AND b.id != ?
        AND ? < b.end_min AND b.start_min < ?`,
    q.startMin, q.endMin, date, q.roomId, exclude, q.startMin, q.endMin,
  )) {
    items.push(placementItem('ROOM', { ...q, date }, r));
  }

  // PROFESSOR — même professeur.
  for (const r of all<AdverseRow>(
    db,
    `SELECT${ADVERSE_COLS}, p.full_name AS entity
       FROM session b
       JOIN professor p ON p.id = b.professor_id${ADVERSE_JOINS}
      WHERE b.date = ? AND b.professor_id = ?
        AND b.status != 'ANNULEE' AND b.id != ?
        AND ? < b.end_min AND b.start_min < ?`,
    q.startMin, q.endMin, date, q.professorId, exclude, q.startMin, q.endMin,
  )) {
    items.push(placementItem('PROFESSOR', { ...q, date }, r));
  }

  // MASTER — même master (via master_module de l'adverse).
  for (const r of all<AdverseRow>(
    db,
    `SELECT${ADVERSE_COLS}, mab.name AS entity
       FROM session b${ADVERSE_JOINS}
      WHERE b.date = ? AND bm.master_id = ?
        AND b.status != 'ANNULEE' AND b.id != ?
        AND ? < b.end_min AND b.start_min < ?`,
    q.startMin, q.endMin, date, q.masterId, exclude, q.startMin, q.endMin,
  )) {
    items.push(placementItem('MASTER', { ...q, date }, r));
  }

  // GROUP — le groupe du candidat est un groupe de l'adverse
  // (mm.student_group_id UNION session_group, même définition que
  // detectConflicts). Plusieurs groupes communs avec la même séance
  // adverse → une seule entrée, libellés concaténés.
  if (groupIds.length > 0) {
    const bySession = new Map<number, PlacementConflict>();
    for (const r of all<AdverseRow>(
      db,
      `SELECT${ADVERSE_COLS}, gb.name || ' (' || gm.name || ')' AS entity
         FROM session b${ADVERSE_JOINS}
         JOIN student_group gb
           ON (gb.id = bm.student_group_id
               OR EXISTS (SELECT 1 FROM session_group sg
                           WHERE sg.session_id = b.id
                             AND sg.student_group_id = gb.id))
         JOIN master gm ON gm.id = gb.master_id
        WHERE b.date = ?
          AND b.status != 'ANNULEE' AND b.id != ?
          AND ? < b.end_min AND b.start_min < ?
          AND gb.id IN (${groupIds.map(() => '?').join(', ')})
        ORDER BY b.id, entity`,
      q.startMin, q.endMin, date, exclude, q.startMin, q.endMin, ...groupIds,
    )) {
      const prev = bySession.get(r.b_id);
      if (prev) {
        prev.entityLabel = `${prev.entityLabel}, ${r.entity}`;
        prev.detail = `${prev.detail}, ${r.entity}`;
      } else {
        const item = placementItem('GROUP', { ...q, date }, r);
        item.detail = `${r.entity} ↔ ${r.b_module} (${r.b_master})`;
        bySession.set(r.b_id, item);
      }
    }
    for (const item of bySession.values()) items.push(item);
  }

  // EXTERNAL — blocage Licence même salle, weekday(date), année du master.
  interface ExtPlacementRow {
    ov_start: number;
    ov_end: number;
    program: string;
    groupe: string | null;
    room_name: string;
  }
  for (const r of all<ExtPlacementRow>(
    db,
    `SELECT max(?, eo.start_min) AS ov_start, min(?, eo.end_min) AS ov_end,
            eo.program, eo.groupe, r.name AS room_name
       FROM external_occupancy eo
       JOIN room r ON r.id = eo.room_id
      WHERE eo.room_id = ?
        AND eo.weekday = ((CAST(strftime('%w', ?) AS integer) + 6) % 7)
        AND ? < eo.end_min AND eo.start_min < ?
        AND (eo.academic_year_id IS NULL OR eo.academic_year_id = ?)`,
    q.startMin, q.endMin, q.roomId, date, q.startMin, q.endMin,
    master.academic_year_id,
  )) {
    const entity = `Licence — ${r.program}${r.groupe ? ` · ${r.groupe}` : ''}`;
    items.push({
      kind: 'EXTERNAL',
      date,
      startMin: r.ov_start,
      endMin: r.ov_end,
      entityLabel: entity,
      sessions: [], // blocage externe : pas de séance adverse
      detail: `${entity} occupe ${r.room_name}`,
    });
  }

  items.sort(
    (x, y) =>
      KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
      x.entityLabel.localeCompare(y.entityLabel) ||
      x.startMin - y.startMin,
  );
  return apiOk(items);
}

/** Compteur global par kind (carte dashboard « Conflits à résoudre »). */
export function conflictSummary(db: DatabaseSync): ConflictSummary {
  const res = detectConflicts(db);
  const byKind: Record<ConflictKind, number> = {
    EXTERNAL: 0,
    GROUP: 0,
    MASTER: 0,
    PROFESSOR: 0,
    ROOM: 0,
  };
  const items = res.ok ? res.data : [];
  for (const c of items) byKind[c.kind] += 1;
  return { total: items.length, byKind };
}
