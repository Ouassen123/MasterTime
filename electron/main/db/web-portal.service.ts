/**
 * Portail web (P19) — côté admin : comptes professeurs, file des demandes
 * (annulation / report) avec approbation appliquant la mutation via les
 * services existants (gardes BR-* préservées), génération des avis
 * bilingues FR/AR, réclamations et présence en ligne.
 *
 * Le serveur web (`server/core.mjs`, pur Node) ne fait que lire ces
 * tables et y déposer les demandes/réclamations — toute la décision
 * reste ici, dans l'app desktop.
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { apiErr, apiOk } from '../../../shared/types';
import type {
  ApiResult,
  PortalAccountRow,
  PortalAnnouncementRow,
  PortalComplaintRow,
  PortalRequestRow,
} from '../../../shared/types';
import { changeSessionStatus, moveSession } from './session-edit.service';
import { get } from './connection';

// --- Mots de passe : scrypt « salt:hash » (même format que server/core.mjs) ---

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const hm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const DAYS_AR = [
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
  'الأحد',
];
const DAYS_FR = [
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
];

function dayName(iso: string, days: string[]): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return days[(d.getUTCDay() + 6) % 7];
}

const frDate = (iso: string): string =>
  `${dayName(iso, DAYS_FR)} ${iso.split('-').reverse().join('/')}`;
const arDate = (iso: string): string =>
  `${dayName(iso, DAYS_AR)} ${iso.split('-').reverse().join('/')}`;

// --- Comptes professeurs ------------------------------------------------------

export function listPortalAccounts(
  db: DatabaseSync,
): ApiResult<PortalAccountRow[]> {
  return apiOk(
    db
      .prepare(
        `SELECT a.id, a.professor_id, p.full_name AS professor_name,
                a.login, a.is_active, a.created_at
         FROM web_professor_account a
         JOIN professor p ON p.id = a.professor_id
         ORDER BY p.full_name`,
      )
      .all() as unknown as PortalAccountRow[],
  );
}

export function createPortalAccount(
  db: DatabaseSync,
  professorId: number,
  login: string,
  password: string,
): ApiResult<null> {
  const prof = get<{ id: number }>(
    db,
    `SELECT id FROM professor WHERE id = ?`,
    professorId,
  );
  if (!prof) return apiErr('Professeur introuvable.');
  const cleanLogin = login.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(cleanLogin)) {
    return apiErr('Identifiant invalide (3–40 : lettres, chiffres, ._-).');
  }
  if (password.length < 6) {
    return apiErr('Mot de passe trop court (6 caractères min).');
  }
  try {
    db.prepare(
      `INSERT INTO web_professor_account
         (professor_id, login, password_hash) VALUES (?, ?, ?)`,
    ).run(professorId, cleanLogin, hashPassword(password));
    return apiOk(null);
  } catch {
    return apiErr('Ce professeur a déjà un compte ou cet identifiant est pris.');
  }
}

export function resetPortalPassword(
  db: DatabaseSync,
  accountId: number,
  password: string,
): ApiResult<null> {
  if (password.length < 6) {
    return apiErr('Mot de passe trop court (6 caractères min).');
  }
  const res = db
    .prepare(
      `UPDATE web_professor_account
       SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(hashPassword(password), accountId);
  return res.changes > 0 ? apiOk(null) : apiErr('Compte introuvable.');
}

export function setPortalAccountActive(
  db: DatabaseSync,
  accountId: number,
  active: boolean,
): ApiResult<null> {
  db.prepare(
    `UPDATE web_professor_account
     SET is_active = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(active ? 1 : 0, accountId);
  return apiOk(null);
}

// --- Demandes professeurs ------------------------------------------------------

export function listPortalRequests(
  db: DatabaseSync,
  status: string = 'pending',
): ApiResult<PortalRequestRow[]> {
  const where =
    status === 'all' ? '' : `WHERE sr.status = '${status === 'approved' || status === 'rejected' ? status : 'pending'}'`;
  return apiOk(
    db
      .prepare(
        `SELECT sr.*, p.full_name AS professor_name,
                pr.name AS proposed_room_name,
                s.date AS session_date, s.start_min AS session_start_min,
                s.end_min AS session_end_min, s.room_id AS session_room_id,
                cr.name AS session_room_name,
                (m.name || ' · ' || mo.name || ' · ' ||
                 s.date || ' ' ||
                 printf('%02d:%02d', s.start_min/60, s.start_min%60))
                  AS session_label
         FROM session_request sr
         JOIN professor p ON p.id = sr.professor_id
         JOIN session s ON s.id = sr.session_id
         JOIN master_module mm ON mm.id = s.master_module_id
         JOIN master m ON m.id = mm.master_id
         JOIN module mo ON mo.id = mm.module_id
         LEFT JOIN room pr ON pr.id = sr.proposed_room_id
         LEFT JOIN room cr ON cr.id = s.room_id
         ${where}
         ORDER BY sr.created_at DESC LIMIT 200`,
      )
      .all() as unknown as PortalRequestRow[],
  );
}

interface RequestCtx {
  id: number;
  session_id: number;
  kind: 'cancel' | 'move';
  reason: string;
  proposed_date: string | null;
  proposed_start_min: number | null;
  proposed_end_min: number | null;
  proposed_room_id: number | null;
  proposed_room_name: string | null;
  professor_name: string;
  module_name: string;
  master_name: string;
  date: string;
  start_min: number;
  end_min: number;
  status: string;
}

function loadRequest(db: DatabaseSync, id: number): RequestCtx | null {
  const row = get<RequestCtx>(
    db,
    `SELECT sr.*, p.full_name AS professor_name, mo.name AS module_name,
            m.name AS master_name, s.date, s.start_min, s.end_min,
            pr.name AS proposed_room_name
     FROM session_request sr
     JOIN professor p ON p.id = sr.professor_id
     JOIN session s ON s.id = sr.session_id
     JOIN master_module mm ON mm.id = s.master_module_id
     JOIN master m ON m.id = mm.master_id
     JOIN module mo ON mo.id = mm.module_id
     LEFT JOIN room pr ON pr.id = sr.proposed_room_id
     WHERE sr.id = ?`,
    id,
  );
  return row ?? null;
}

/** Avis bilingue généré à partir de la demande approuvée. */
function buildAnnouncement(r: RequestCtx): {
  title_fr: string;
  title_ar: string;
  body_fr: string;
  body_ar: string;
} {
  const slot = `${hm(r.start_min)}–${hm(r.end_min)}`;
  if (r.kind === 'cancel') {
    return {
      title_fr: `Annulation — ${r.module_name}`,
      title_ar: 'إلغاء حصة',
      body_fr:
        `La séance de « ${r.module_name} » (${r.master_name}) du ` +
        `${frDate(r.date)} ${slot} avec ${r.professor_name} est annulée.` +
        (r.reason ? ` Motif : ${r.reason}.` : ''),
      body_ar:
        `تم إلغاء حصة «${r.module_name}» (${r.master_name}) ` +
        `المبرمجة يوم ${arDate(r.date)} من ${slot} ` +
        `مع الأستاذ(ة) ${r.professor_name}.` +
        (r.reason ? ` السبب: ${r.reason}.` : ''),
    };
  }
  const newSlot =
    r.proposed_start_min != null && r.proposed_end_min != null
      ? `${hm(r.proposed_start_min)}–${hm(r.proposed_end_min)}`
      : '';
  const newDay = r.proposed_date ? frDate(r.proposed_date) : '';
  const newDayAr = r.proposed_date ? arDate(r.proposed_date) : '';
  const room = r.proposed_room_name ? ` en ${r.proposed_room_name}` : '';
  const roomAr = r.proposed_room_name ? ` في ${r.proposed_room_name}` : '';
  return {
    title_fr: `Report — ${r.module_name}`,
    title_ar: 'تأجيل حصة',
    body_fr:
      `La séance de « ${r.module_name} » (${r.master_name}) du ` +
      `${frDate(r.date)} ${slot} avec ${r.professor_name} est reportée ` +
      `au ${newDay} ${newSlot}${room}.` +
      (r.reason ? ` Motif : ${r.reason}.` : ''),
    body_ar:
      `تم تأجيل حصة «${r.module_name}» (${r.master_name}) ` +
      `المبرمجة يوم ${arDate(r.date)} من ${slot} ` +
      `مع الأستاذ(ة) ${r.professor_name} ` +
      `إلى يوم ${newDayAr} ${newSlot}${roomAr}.` +
      (r.reason ? ` السبب: ${r.reason}.` : ''),
  };
}

/**
 * Approuve une demande : applique la mutation via les services séance
 * existants (annulation / déplacement avec gardes BR-*), marque la
 * demande et publie l'avis bilingue — le tout en une transaction.
 */
export function approvePortalRequest(
  db: DatabaseSync,
  userId: number | null,
  id: number,
  adminNote: string = '',
  slot?: { date: string; start_min: number; end_min: number; room_id: number },
): ApiResult<null> {
  const r = loadRequest(db, id);
  if (!r) return apiErr('Demande introuvable.');
  if (r.status !== 'pending') return apiErr('Demande déjà traitée.');

  let applied: ApiResult<{ sessionId: number }> | null = null;
  if (r.kind === 'cancel') {
    applied = changeSessionStatus(db, userId, r.session_id, {
      status: 'ANNULEE',
      reason: r.reason || 'Annulation déclarée par le professeur (portail web)',
    });
  } else {
    // Créneau du report : proposition du prof, sinon choix de l'admin.
    r.proposed_date ??= slot?.date ?? null;
    r.proposed_start_min ??= slot?.start_min ?? null;
    r.proposed_end_min ??= slot?.end_min ?? null;
    r.proposed_room_id ??= slot?.room_id ?? null;
    if (
      !r.proposed_date ||
      r.proposed_start_min == null ||
      r.proposed_end_min == null ||
      r.proposed_room_id == null
    ) {
      return apiErr(
        'Créneau requis : choisissez date, horaire et salle pour approuver ce report.',
      );
    }
    if (!r.proposed_room_name) {
      r.proposed_room_name =
        get<{ name: string }>(
          db,
          'SELECT name FROM room WHERE id = ?',
          r.proposed_room_id,
        )?.name ?? '';
    }
    applied = moveSession(db, userId, r.session_id, {
      date: r.proposed_date,
      start_min: r.proposed_start_min,
      end_min: r.proposed_end_min,
      room_id: r.proposed_room_id,
      reason: r.reason || 'Report demandé par le professeur (portail web)',
    });
  }
  if (!applied.ok) return applied as unknown as ApiResult<null>;

  const a = buildAnnouncement(r);
  db.prepare(
    `UPDATE session_request
     SET status = 'approved', admin_note = ?, decided_at = datetime('now')
     WHERE id = ?`,
  ).run(adminNote, id);
  db.prepare(
    `INSERT INTO announcement
       (title_fr, title_ar, body_fr, body_ar, session_id, session_request_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(a.title_fr, a.title_ar, a.body_fr, a.body_ar, r.session_id, id);
  return apiOk(null);
}

export function rejectPortalRequest(
  db: DatabaseSync,
  id: number,
  adminNote: string = '',
): ApiResult<null> {
  const res = db
    .prepare(
      `UPDATE session_request
       SET status = 'rejected', admin_note = ?, decided_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(adminNote, id);
  return res.changes > 0 ? apiOk(null) : apiErr('Demande introuvable ou déjà traitée.');
}

// --- Réclamations ---------------------------------------------------------------

export function listPortalComplaints(
  db: DatabaseSync,
): ApiResult<PortalComplaintRow[]> {
  return apiOk(
    db
      .prepare(`SELECT * FROM complaint ORDER BY created_at DESC LIMIT 200`)
      .all() as unknown as PortalComplaintRow[],
  );
}

export function setComplaintStatus(
  db: DatabaseSync,
  id: number,
  status: 'read' | 'handled',
): ApiResult<null> {
  db.prepare(`UPDATE complaint SET status = ? WHERE id = ?`).run(status, id);
  return apiOk(null);
}

// --- Avis ------------------------------------------------------------------------

export function listPortalAnnouncements(
  db: DatabaseSync,
): ApiResult<PortalAnnouncementRow[]> {
  return apiOk(
    db
      .prepare(
        `SELECT * FROM announcement ORDER BY published_at DESC LIMIT 100`,
      )
      .all() as unknown as PortalAnnouncementRow[],
  );
}

export function setAnnouncementActive(
  db: DatabaseSync,
  id: number,
  active: boolean,
): ApiResult<null> {
  db.prepare(`UPDATE announcement SET is_active = ? WHERE id = ?`).run(
    active ? 1 : 0,
    id,
  );
  return apiOk(null);
}

// --- Présence ---------------------------------------------------------------------

export function portalOnlineCount(
  db: DatabaseSync,
): ApiResult<{ visitors: number; professors: number }> {
  const visitors = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM web_visitor
     WHERE last_seen_at > datetime('now', '-2 minutes')`,
  );
  const professors = get<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT professor_id) AS n FROM web_session
     WHERE last_seen_at > datetime('now', '-2 minutes')
       AND expires_at > datetime('now')`,
  );
  return apiOk({
    visitors: visitors?.n ?? 0,
    professors: professors?.n ?? 0,
  });
}
