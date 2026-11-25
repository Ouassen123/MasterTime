/**
 * Résolution assistée des conflits de salle (P16) — propose et applique
 * la réaffectation des séances impliquées dans un conflit ROOM ou
 * EXTERNAL vers une salle active libre au MÊME créneau (aucune séance ne
 * change de date/heure/professeur/master). Les conflits PROFESSOR,
 * MASTER et GROUP sont volontairement exclus : changer l'horaire ou le
 * titulaire impacte les étudiants — décision humaine.
 *
 * - `previewReassignment` : calcul en mémoire, rien n'est écrit.
 *   Occupation salle indexée `date|room` + occupation Licence indexée
 *   `room|weekday` (même règle d'année que detectConflicts EXTERNAL :
 *   blocage NULL ou de l'année du master). Les propositions sont
 *   calculées EN SÉQUENCE : une salle attribuée devient occupée pour les
 *   propositions suivantes, une salle libérée redevient disponible —
 *   aucune proposition ne crée de nouveau conflit, et le second membre
 *   d'une paire ROOM reste en place quand le premier part (une seule
 *   séance bouge par collision).
 * - `applyReassignment` : rejoue le preview dans une `BEGIN IMMEDIATE`
 *   (le monde ne peut plus changer dans la TX), puis pour chaque
 *   proposition re-vérifie la salle cible avec `checkSessionPlacement`
 *   restreint aux kinds ROOM+EXTERNAL — échec → `skipped`, pas
 *   d'écriture. Sinon UPDATE `session.room_id` + audit explicite
 *   (`audit_log` UPDATE session, old/new JSON) + historique de statut
 *   avec motif « Réaffectation salle — résolution de conflit ».
 *   Retourne `{moved, skipped}`.
 *
 * Collision récurrente : les propositions sont calculées séance par
 * séance (chaque ligne `session` est datée) — chaque semaine d'un
 * créneau récurrent est donc traitée indépendamment.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiResult,
  RoomReassignPreview,
  RoomReassignProposal,
  RoomReassignResult,
  RoomReassignSkip,
} from '../../../shared/types';
import { apiErr, apiOk } from '../../../shared/types';
import { all, get, run } from './connection';
import { checkSessionPlacement } from './conflict.service';
import { weekdayOf } from './availability';

/** Motif consigné dans session_status_history (AD-7). */
const REASSIGN_REASON = 'Réaffectation salle — résolution de conflit';

interface Interval {
  s: number;
  e: number;
}

/** Intervalle occupé par une séance (`sid` pour libérer la salle au move). */
interface RoomInterval extends Interval {
  sid: number;
}

/** Blocage Licence (`yearId` NULL = toutes années — règle EXTERNAL). */
interface ExtInterval extends Interval {
  yearId: number | null;
}

interface RoomInfo {
  id: number;
  name: string;
  capacity: number | null;
}

/** Séance non annulée chargée pour la simulation. */
interface SessionInfo {
  id: number;
  date: string;
  start_min: number;
  end_min: number;
  room_id: number;
  room_name: string;
  professor_id: number;
  master_id: number;
  /** Année universitaire du master (règle EXTERNAL). */
  year_id: number;
  mm_group_id: number | null;
  /** « module — master » (affichage). */
  label: string;
  /** Kinds ROOM/EXTERNAL détectés lors de la passe initiale. */
  kinds: Set<'ROOM' | 'EXTERNAL'>;
}

/** Monde simulé : séances + index d'occupation + référentiel salles. */
interface SimWorld {
  sessions: SessionInfo[];
  /** `date|room_id` → intervalles des séances non annulées. */
  occRoom: Map<string, RoomInterval[]>;
  /** `room_id|weekday` → blocages Licence récurrents (0=lun, AD-7). */
  extOcc: Map<string, ExtInterval[]>;
  rooms: RoomInfo[];
  /** `session_id` → groupes de la séance (mm.student_group ∪ session_group). */
  groupIdsOf: Map<number, number[]>;
  groupSize: Map<number, number | null>;
}

function overlaps(s: number, e: number, iv: Interval): boolean {
  return s < iv.e && iv.s < e;
}

/** Ligne SQL d'une séance avant enrichissement (`kinds` ajouté en mémoire). */
type SessionRowSql = Omit<SessionInfo, 'kinds'>;

/** Charge le monde simulé (séances non ANNULEE, salles actives, blocages). */
function loadWorld(db: DatabaseSync): SimWorld {
  const sessions = all<SessionRowSql>(
    db,
    `SELECT s.id, s.date, s.start_min, s.end_min, s.room_id,
            r.name AS room_name, s.professor_id,
            mm.master_id, ma.academic_year_id AS year_id,
            mm.student_group_id AS mm_group_id,
            mo.name || ' — ' || ma.name AS label
       FROM session s
       JOIN room r ON r.id = s.room_id
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master ma ON ma.id = mm.master_id
       JOIN module mo ON mo.id = mm.module_id
      WHERE s.status != 'ANNULEE'
      ORDER BY s.date, s.start_min, s.id`,
  ).map((r): SessionInfo => ({ ...r, kinds: new Set() }));

  const occRoom = new Map<string, RoomInterval[]>();
  for (const s of sessions) {
    const key = `${s.date}|${s.room_id}`;
    const list = occRoom.get(key) ?? [];
    list.push({ s: s.start_min, e: s.end_min, sid: s.id });
    occRoom.set(key, list);
  }

  const extOcc = new Map<string, ExtInterval[]>();
  for (const o of all<{
    room_id: number;
    weekday: number;
    start_min: number;
    end_min: number;
    academic_year_id: number | null;
  }>(
    db,
    `SELECT room_id, weekday, start_min, end_min, academic_year_id
       FROM external_occupancy`,
  )) {
    const key = `${o.room_id}|${o.weekday}`;
    const list = extOcc.get(key) ?? [];
    list.push({
      s: o.start_min,
      e: o.end_min,
      yearId: o.academic_year_id,
    });
    extOcc.set(key, list);
  }

  const rooms = all<RoomInfo>(
    db,
    'SELECT id, name, capacity FROM room WHERE is_active = 1 ORDER BY id',
  );

  const groupIdsOf = new Map<number, number[]>();
  for (const s of sessions) {
    if (s.mm_group_id != null) groupIdsOf.set(s.id, [s.mm_group_id]);
  }
  for (const r of all<{ session_id: number; student_group_id: number }>(
    db,
    'SELECT session_id, student_group_id FROM session_group',
  )) {
    const list = groupIdsOf.get(r.session_id) ?? [];
    if (!list.includes(r.student_group_id)) list.push(r.student_group_id);
    groupIdsOf.set(r.session_id, list);
  }

  const groupSize = new Map<number, number | null>(
    all<{ id: number; size: number | null }>(
      db,
      'SELECT id, size FROM student_group',
    ).map((g) => [g.id, g.size]),
  );

  return { sessions, occRoom, extOcc, rooms, groupIdsOf, groupSize };
}

/** Conflit ROOM résiduel dans le monde simulé (une autre séance chevauche). */
function roomConflict(w: SimWorld, s: SessionInfo): boolean {
  return (w.occRoom.get(`${s.date}|${s.room_id}`) ?? []).some(
    (iv) => iv.sid !== s.id && overlaps(s.start_min, s.end_min, iv),
  );
}

/** Conflit EXTERNAL résiduel : blocage Licence même salle, weekday(date). */
function extConflict(w: SimWorld, s: SessionInfo): boolean {
  const key = `${s.room_id}|${weekdayOf(s.date)}`;
  return (w.extOcc.get(key) ?? []).some(
    (iv) =>
      (iv.yearId == null || iv.yearId === s.year_id) &&
      overlaps(s.start_min, s.end_min, iv),
  );
}

/**
 * Effectif de la séance (BR-9) : Σ tailles des groupes mm ∪ session_group.
 * Inconnu (aucun groupe, ou taille NULL) → `null` = pas de contrainte
 * capacité.
 */
function effectifOf(w: SimWorld, sessionId: number): number | null {
  const gids = w.groupIdsOf.get(sessionId) ?? [];
  if (gids.length === 0) return null;
  let sum = 0;
  for (const gid of gids) {
    const size = w.groupSize.get(gid);
    if (size == null) return null;
    sum += size;
  }
  return sum;
}

/**
 * Salle cible d'une séance : active, ≠ actuelle, libre au créneau dans le
 * monde simulé (aucune séance qui chevauche à cette date, aucun blocage
 * Licence du weekday qui chevauche — même règle d'année), et de
 * capacité ≥ effectif quand celui-ci est connu. Choix déterministe :
 * capacité suffisante la plus proche de l'effectif (sinon la plus petite
 * salle, capacité inconnue en dernier), tie-break id.
 */
function pickRoom(w: SimWorld, s: SessionInfo): RoomInfo | null {
  const wd = weekdayOf(s.date);
  const effectif = effectifOf(w, s.id);
  const candidates = w.rooms.filter((r) => {
    if (r.id === s.room_id) return false;
    if (effectif != null && r.capacity != null && r.capacity < effectif) {
      return false;
    }
    if (
      (w.occRoom.get(`${s.date}|${r.id}`) ?? []).some((iv) =>
        overlaps(s.start_min, s.end_min, iv),
      )
    ) {
      return false;
    }
    if (
      (w.extOcc.get(`${r.id}|${wd}`) ?? []).some(
        (iv) =>
          (iv.yearId == null || iv.yearId === s.year_id) &&
          overlaps(s.start_min, s.end_min, iv),
      )
    ) {
      return false;
    }
    return true;
  });
  const score = (r: RoomInfo): number =>
    r.capacity == null
      ? Number.MAX_SAFE_INTEGER
      : effectif != null
        ? r.capacity - effectif // ≥ 0 (filtré) : le plus proche gagne
        : r.capacity; // effectif inconnu : la plus petite salle gagne
  candidates.sort((a, b) => score(a) - score(b) || a.id - b.id);
  return candidates[0] ?? null;
}

/**
 * Calcul des propositions — partagé par le preview (lecture seule) et
 * l'apply (rejoué dans la transaction). Détection initiale des kinds par
 * séance, puis passe séquentielle : chaque séance encore en conflit
 * reçoit la meilleure salle libre et son déplacement est SIMULÉ dans
 * l'index (libère l'ancienne salle, occupe la nouvelle).
 */
function computePreview(db: DatabaseSync): RoomReassignPreview {
  const w = loadWorld(db);
  for (const s of w.sessions) {
    if (roomConflict(w, s)) s.kinds.add('ROOM');
    if (extConflict(w, s)) s.kinds.add('EXTERNAL');
  }
  const proposals: RoomReassignProposal[] = [];
  const skipped: RoomReassignSkip[] = [];
  for (const s of w.sessions) {
    if (s.kinds.size === 0) continue;
    // Re-check monde simulé : un déplacement antérieur a pu résorber le
    // conflit (l'autre membre d'une paire ROOM reste alors en place).
    if (!roomConflict(w, s) && !extConflict(w, s)) continue;
    const target = pickRoom(w, s);
    if (target == null) {
      const effectif = effectifOf(w, s.id);
      skipped.push({
        session_id: s.id,
        label: s.label,
        date: s.date,
        start_min: s.start_min,
        end_min: s.end_min,
        reason:
          effectif != null
            ? `Aucune salle libre d'une capacité suffisante ` +
              `(≥ ${effectif}) à ce créneau.`
            : 'Aucune salle active libre à ce créneau.',
      });
      continue;
    }
    proposals.push({
      session_id: s.id,
      label: s.label,
      date: s.date,
      start_min: s.start_min,
      end_min: s.end_min,
      old_room: s.room_name,
      new_room_id: target.id,
      new_room: target.name,
      kinds: [...s.kinds].sort(),
    });
    // Déplacement simulé : libère l'ancienne salle, occupe la nouvelle.
    const oldKey = `${s.date}|${s.room_id}`;
    w.occRoom.set(
      oldKey,
      (w.occRoom.get(oldKey) ?? []).filter((iv) => iv.sid !== s.id),
    );
    const newKey = `${s.date}|${target.id}`;
    const movedList = w.occRoom.get(newKey) ?? [];
    movedList.push({ s: s.start_min, e: s.end_min, sid: s.id });
    w.occRoom.set(newKey, movedList);
    s.room_id = target.id;
  }
  return { proposals, skipped };
}

/**
 * Aperçu de la réaffectation (lecture seule) : propositions + séances
 * sans salle compatible (`skipped`). Déterministe : mêmes entrées →
 * mêmes propositions.
 */
export function previewReassignment(
  db: DatabaseSync,
): ApiResult<RoomReassignPreview> {
  return apiOk(computePreview(db));
}

interface SessionApplyRow {
  id: number;
  status: string;
  date: string;
  start_min: number;
  end_min: number;
  room_id: number;
  professor_id: number;
  master_id: number;
}

/**
 * Application : rejoue `computePreview` dans une `BEGIN IMMEDIATE` (les
 * propositions reflètent donc le monde réel à l'instant de l'apply — un
 * monde qui aurait changé depuis l'aperçu affiché est recalculé, jamais
 * rejoué à l'aveugle). Chaque proposition est re-vérifiée par
 * `checkSessionPlacement` (kinds ROOM+EXTERNAL) AVANT son UPDATE : les
 * déplacements déjà écrits dans la TX sont vus par les vérifications
 * suivantes — aucun nouveau conflit ne peut être créé. Écriture par
 * séance : UPDATE room_id + audit_log explicite (UPDATE session, old/new
 * JSON) + session_status_history avec motif. Tout échec de garde →
 * `skipped`, pas d'écriture pour cette séance.
 */
export function applyReassignment(
  db: DatabaseSync,
  userId: number | null,
): ApiResult<RoomReassignResult> {
  if (db.isTransaction) {
    return apiErr('Une transaction est déjà ouverte.');
  }
  db.exec('BEGIN IMMEDIATE;');
  try {
    const { proposals, skipped } = computePreview(db);
    const resultSkipped: RoomReassignSkip[] = [...skipped];
    let moved = 0;
    for (const p of proposals) {
      const cur = get<SessionApplyRow>(
        db,
        `SELECT s.id, s.status, s.date, s.start_min, s.end_min,
                s.room_id, s.professor_id, mm.master_id
           FROM session s
           JOIN master_module mm ON mm.id = s.master_module_id
          WHERE s.id = ?`,
        p.session_id,
      );
      // Garde défensive (même TX : impossible en pratique).
      if (cur == null || cur.status === 'ANNULEE') {
        resultSkipped.push({
          session_id: p.session_id,
          label: p.label,
          date: p.date,
          start_min: p.start_min,
          end_min: p.end_min,
          reason: 'Séance annulée ou supprimée.',
        });
        continue;
      }
      const check = checkSessionPlacement(db, {
        date: cur.date,
        startMin: cur.start_min,
        endMin: cur.end_min,
        roomId: p.new_room_id,
        professorId: cur.professor_id,
        masterId: cur.master_id,
        excludeSessionId: cur.id,
        kinds: ['ROOM', 'EXTERNAL'],
      });
      if (!check.ok) {
        // Données lues en base : une erreur ici est une incohérence
        // interne — rollback intégral plutôt qu'une application partielle.
        throw new Error(check.error);
      }
      if (check.data.length > 0) {
        resultSkipped.push({
          session_id: p.session_id,
          label: p.label,
          date: p.date,
          start_min: p.start_min,
          end_min: p.end_min,
          reason: "La salle proposée n'est plus libre à ce créneau.",
        });
        continue;
      }
      const before = get<Record<string, unknown>>(
        db,
        'SELECT * FROM session WHERE id = ?',
        p.session_id,
      );
      run(
        db,
        `UPDATE session SET room_id = ?, updated_at = datetime('now')
          WHERE id = ?`,
        p.new_room_id,
        p.session_id,
      );
      const after = get<Record<string, unknown>>(
        db,
        'SELECT * FROM session WHERE id = ?',
        p.session_id,
      );
      run(
        db,
        `INSERT INTO audit_log
           (user_id, action, entity, entity_id, old_values, new_values)
         VALUES (?, 'UPDATE', 'session', ?, ?, ?)`,
        userId,
        p.session_id,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      );
      run(
        db,
        `INSERT INTO session_status_history
           (session_id, old_status, new_status, changed_by, reason,
            old_date, old_start_min, old_end_min,
            new_date, new_start_min, new_end_min)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.session_id,
        cur.status,
        cur.status,
        userId,
        REASSIGN_REASON,
        cur.date,
        cur.start_min,
        cur.end_min,
        cur.date,
        cur.start_min,
        cur.end_min,
      );
      moved++;
    }
    db.exec('COMMIT;');
    return apiOk({ moved, skipped: resultSkipped });
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // connexion possiblement hors transaction — l'erreur d'origine prime
    }
    throw err;
  }
}
