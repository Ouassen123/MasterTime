/**
 * MasterTime — Portail web public (P19).
 *
 * Gestionnaire HTTP pur Node (`node:http` + `node:sqlite`) — aucune
 * dépendance externe. Utilisé :
 *  - en-processus par l'app Electron (`webserver.service.ts`) : le site
 *    est joignable sur le réseau local de la faculté ;
 *  - en autonome via `server/index.mjs` : déploiement sur le serveur de
 *    la faculté (même fichier `mastertime.db`, WAL multi-processus).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC = path.join(__dirname, '..', 'web', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- Utilitaires -------------------------------------------------------------

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const min2hm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function weekBounds(iso) {
  // Lundi de la semaine contenant `iso` → [lundi, dimanche].
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // 0=lundi
  const mon = new Date(d.getTime() - wd * 86400000);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return [fmt(mon), fmt(new Date(mon.getTime() + 6 * 86400000))];
}

function addDays(iso, n) {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000)
    .toISOString()
    .slice(0, 10);
}

// Date locale « YYYY-MM-DD » (et non UTC — évite le décalage minuit→1h).
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- Mots de passe : scrypt « salt:hash » hex (même format côté admin) -------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && crypto.timingSafeEqual(test, ref);
}

// --- Handler -----------------------------------------------------------------

/**
 * @param {{ dbPath: string, publicDir?: string }} opts
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function createHandler({ dbPath, publicDir = DEFAULT_PUBLIC }) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=3000');

  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const q1 = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  function profFromReq(req) {
    const token = parseCookies(req).mt_token;
    if (!token) return null;
    const s = q1(
      `SELECT ws.token, p.id, p.full_name
       FROM web_session ws JOIN professor p ON p.id = ws.professor_id
       WHERE ws.token = ? AND ws.expires_at > datetime('now')`,
      token,
    );
    if (!s) return null;
    run(
      `UPDATE web_session SET last_seen_at = datetime('now') WHERE token = ?`,
      token,
    );
    return s;
  }

  /** Créneaux + salles libres pour reporter `sessionId`
   *  (d'aujourd'hui jusqu'à ~4 semaines, borné par la fin du semestre). */
  function freeSlots(sessionId) {
    const s = q1(
      `SELECT s.id, s.date, s.start_min, s.end_min, s.professor_id,
              mm.master_id, m.name AS master_name, mm.sched_end,
              (SELECT COALESCE(SUM(size),0) FROM student_group g
                WHERE g.master_id = mm.master_id) AS effectif
       FROM session s
       JOIN master_module mm ON mm.id = s.master_module_id
       JOIN master m ON m.id = mm.master_id
       WHERE s.id = ?`,
      sessionId,
    );
    if (!s) return null;
    const dur = s.end_min - s.start_min;
    const today = localToday();
    const horizon = addDays(today, 27);
    const lastDay = s.sched_end && s.sched_end < horizon ? s.sched_end : horizon;
    const out = [];
    for (let date = today; date <= lastDay && out.length < 15; date = addDays(date, 1)) {
      const d = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
      if (d === 6) continue; // dimanche
      // Jour fermé (férié/examen/fermeture) → ignoré.
      const closed = q1(
        `SELECT 1 AS x FROM calendar_exception
         WHERE start_date <= ? AND end_date >= ?
           AND type IN ('FERIE','FERMETURE','EXAMEN') LIMIT 1`,
        date,
        date,
      );
      if (closed) continue;
      // Créneaux autorisés du jour pouvant contenir la durée.
      const slots = q(
        `SELECT start_min, end_min FROM time_slot
         WHERE weekday = ? AND (? <= end_min - start_min)
         ORDER BY start_min`,
        d,
        dur,
      );
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      for (const ts of slots) {
        const start = ts.start_min;
        const end = start + dur;
        if (end > ts.end_min) continue;
        if (date === s.date && start === s.start_min) continue; // créneau actuel
        if (date === today && start <= nowMin) continue; // déjà passé aujourd'hui
        // Prof libre : pas de séance ni indisponibilité ni absence.
        const profBusy = q1(
          `SELECT 1 AS x FROM session
           WHERE professor_id = ? AND date = ? AND status != 'ANNULEE'
             AND start_min < ? AND end_min > ? LIMIT 1`,
          s.professor_id, date, end, start,
        );
        if (profBusy) continue;
        const profIndispo = q1(
          `SELECT 1 AS x FROM professor_availability
           WHERE professor_id = ? AND weekday = ? AND kind = 'INDISPO'
             AND start_min < ? AND end_min > ?
             AND (effective_from IS NULL OR effective_from <= ?)
             AND (effective_to IS NULL OR effective_to >= ?) LIMIT 1`,
          s.professor_id, d, end, start, date, date,
        );
        if (profIndispo) continue;
        const profAbsent = q1(
          `SELECT 1 AS x FROM professor_absence
           WHERE professor_id = ? AND start_date <= ? AND end_date >= ?
           LIMIT 1`,
          s.professor_id, date, date,
        );
        if (profAbsent) continue;
        // Master libre.
        const masterBusy = q1(
          `SELECT 1 AS x FROM session s2
           JOIN master_module mm2 ON mm2.id = s2.master_module_id
           WHERE mm2.master_id = ? AND s2.date = ?
             AND s2.status != 'ANNULEE'
             AND s2.start_min < ? AND s2.end_min > ? LIMIT 1`,
          s.master_id, date, end, start,
        );
        if (masterBusy) continue;
        // Salles libres sur le créneau.
        const rooms = q(
          `SELECT r.id, r.name, r.capacity FROM room r
           WHERE r.is_active = 1
             AND r.capacity >= ?
             AND NOT EXISTS (
               SELECT 1 FROM session sx
               WHERE sx.room_id = r.id AND sx.date = ?
                 AND sx.status != 'ANNULEE'
                 AND sx.start_min < ? AND sx.end_min > ?)
             AND NOT EXISTS (
               SELECT 1 FROM external_occupancy eo
               WHERE eo.room_id = r.id AND eo.weekday = ?
                 AND eo.start_min < ? AND eo.end_min > ?)
           ORDER BY r.capacity, r.name`,
          s.effectif, date, end, start, d, end, start,
        );
        if (rooms.length > 0) {
          out.push({ date, weekday: d, start_min: start, end_min: end, rooms });
        }
        if (out.length >= 15) return out;
      }
    }
    return out;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      // --- API publique ----------------------------------------------------
      if (p === '/api/masters' && req.method === 'GET') {
        return json(res, 200, q(
          `SELECT m.id, m.code, m.name, m.responsible_name,
                  sem.ordinal AS semester_ordinal,
                  CASE WHEN sem.ordinal <= 2 THEN 'M1' ELSE 'M2' END AS level,
                  ay.label AS year_label
           FROM master m
           LEFT JOIN semester sem ON sem.id = m.semester_id
           LEFT JOIN academic_year ay ON ay.id = m.academic_year_id
           WHERE m.status = 'ACTIF'
           ORDER BY m.name`,
        ));
      }

      if (p === '/api/edt' && req.method === 'GET') {
        const masterId = Number(url.searchParams.get('master_id'));
        const week = url.searchParams.get('week') ?? '';
        if (!Number.isInteger(masterId) || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
          return json(res, 400, { error: 'Paramètres invalides' });
        }
        const [wStart, wEnd] = weekBounds(week);
        const master = q1(
          `SELECT m.id, m.name, m.responsible_name, sem.ordinal AS semester_ordinal,
                  ay.label AS year_label
           FROM master m
           LEFT JOIN semester sem ON sem.id = m.semester_id
           LEFT JOIN academic_year ay ON ay.id = m.academic_year_id
           WHERE m.id = ?`,
          masterId,
        );
        if (!master) return json(res, 404, { error: 'Master introuvable' });
        const first = q1(
          `SELECT MIN(s.date) AS d FROM session s
           JOIN master_module mm ON mm.id = s.master_module_id
           WHERE mm.master_id = ? AND s.status != 'ANNULEE'`,
          masterId,
        );
        return json(res, 200, {
          weekStart: wStart,
          firstSessionDate: first?.d ?? null,
          master,
          sessions: q(
            `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
                    mo.name AS module_name, p.full_name AS professor_name,
                    r.name AS room_name
             FROM session s
             JOIN master_module mm ON mm.id = s.master_module_id
             JOIN module mo ON mo.id = mm.module_id
             JOIN professor p ON p.id = s.professor_id
             JOIN room r ON r.id = s.room_id
             WHERE mm.master_id = ? AND s.date BETWEEN ? AND ?
             ORDER BY s.date, s.start_min`,
            masterId, wStart, wEnd,
          ),
        });
      }

      if (p === '/api/announcements' && req.method === 'GET') {
        return json(res, 200, q(
          `SELECT title_fr, title_ar, body_fr, body_ar, published_at
           FROM announcement WHERE is_active = 1
           ORDER BY published_at DESC LIMIT 30`,
        ));
      }

      if (p === '/api/complaints' && req.method === 'POST') {
        const b = await readBody(req);
        const message = String(b.message ?? '').trim();
        if (message.length < 5 || message.length > 2000) {
          return json(res, 400, { error: 'Message invalide (5–2000 car.)' });
        }
        run(
          `INSERT INTO complaint (author_name, author_role, message)
           VALUES (?, ?, ?)`,
          String(b.name ?? '').slice(0, 100),
          ['etudiant', 'professeur', 'autre'].includes(b.role)
            ? b.role
            : 'etudiant',
          message,
        );
        return json(res, 201, { ok: true });
      }

      if (p === '/api/heartbeat' && req.method === 'POST') {
        const b = await readBody(req);
        const v = String(b.visitor ?? '').slice(0, 64);
        if (v) {
          run(
            `INSERT INTO web_visitor (token, last_seen_at)
             VALUES (?, datetime('now'))
             ON CONFLICT(token) DO UPDATE SET last_seen_at = datetime('now')`,
            v,
          );
        }
        const online = q1(
          `SELECT COUNT(*) AS n FROM web_visitor
           WHERE last_seen_at > datetime('now', '-2 minutes')`,
        ).n;
        return json(res, 200, { online });
      }

      // --- API professeur --------------------------------------------------
      if (p === '/api/prof/login' && req.method === 'POST') {
        const b = await readBody(req);
        const acc = q1(
          `SELECT a.id, a.professor_id, a.password_hash
           FROM web_professor_account a
           WHERE a.login = ? AND a.is_active = 1`,
          String(b.login ?? ''),
        );
        if (!acc || !verifyPassword(String(b.password ?? ''), acc.password_hash)) {
          return json(res, 401, { error: 'Identifiants incorrects' });
        }
        const token = crypto.randomUUID();
        run(
          `INSERT INTO web_session (token, professor_id, expires_at)
           VALUES (?, ?, datetime('now', '+12 hours'))`,
          token,
          acc.professor_id,
        );
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `mt_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
        });
        return res.end('{"ok":true}');
      }

      if (p === '/api/prof/logout' && req.method === 'POST') {
        const token = parseCookies(req).mt_token;
        if (token) run(`DELETE FROM web_session WHERE token = ?`, token);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'mt_token=; Path=/; HttpOnly; Max-Age=0',
        });
        return res.end('{"ok":true}');
      }

      if (p.startsWith('/api/prof/')) {
        const prof = profFromReq(req);
        if (!prof) return json(res, 401, { error: 'Non connecté' });

        if (p === '/api/prof/me' && req.method === 'GET') {
          const masters = q(
            `SELECT DISTINCT m.id, m.name FROM master m
             JOIN master_module mm ON mm.master_id = m.id
             LEFT JOIN session s ON s.master_module_id = mm.id
             WHERE mm.professor_id = ? OR s.professor_id = ?
             ORDER BY m.name`,
            prof.id, prof.id,
          );
          return json(res, 200, {
            id: prof.id,
            full_name: prof.full_name,
            masters,
          });
        }

        if (p === '/api/prof/sessions' && req.method === 'GET') {
          const week = url.searchParams.get('week') ?? '';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
            return json(res, 400, { error: 'Semaine invalide' });
          }
          const [wStart, wEnd] = weekBounds(week);
          return json(res, 200, {
            weekStart: wStart,
            sessions: q(
              `SELECT s.id, s.date, s.start_min, s.end_min, s.status,
                      mo.name AS module_name, r.name AS room_name,
                      m.name AS master_name,
                      (SELECT COUNT(*) FROM session_request sr
                        WHERE sr.session_id = s.id AND sr.status = 'pending')
                        AS pending_requests
               FROM session s
               JOIN master_module mm ON mm.id = s.master_module_id
               JOIN module mo ON mo.id = mm.module_id
               JOIN master m ON m.id = mm.master_id
               JOIN room r ON r.id = s.room_id
               WHERE (s.professor_id = ? OR mm.professor_id = ?)
                 AND s.date BETWEEN ? AND ?
               ORDER BY s.date, s.start_min`,
              prof.id, prof.id, wStart, wEnd,
            ),
          });
        }

        if (p === '/api/prof/free-slots' && req.method === 'GET') {
          const sid = Number(url.searchParams.get('session_id'));
          const slots = freeSlots(sid);
          if (!slots) return json(res, 404, { error: 'Séance introuvable' });
          return json(res, 200, slots);
        }

        if (p === '/api/prof/requests' && req.method === 'GET') {
          return json(res, 200, q(
            `SELECT sr.*, s.date AS session_date, s.start_min, s.end_min,
                    mo.name AS module_name, m.name AS master_name,
                    pr.name AS proposed_room_name
             FROM session_request sr
             JOIN session s ON s.id = sr.session_id
             JOIN master_module mm ON mm.id = s.master_module_id
             JOIN module mo ON mo.id = mm.module_id
             JOIN master m ON m.id = mm.master_id
             LEFT JOIN room pr ON pr.id = sr.proposed_room_id
             WHERE sr.professor_id = ?
             ORDER BY sr.created_at DESC LIMIT 50`,
            prof.id,
          ));
        }

        if (p === '/api/prof/requests' && req.method === 'POST') {
          const b = await readBody(req);
          const sid = Number(b.session_id);
          const kind = b.kind === 'move' ? 'move' : 'cancel';
          const sess = q1(
            `SELECT s.id, s.status, s.date
             FROM session s JOIN master_module mm ON mm.id = s.master_module_id
             WHERE s.id = ? AND (s.professor_id = ? OR mm.professor_id = ?)`,
            sid, prof.id, prof.id,
          );
          const today = localToday();
          if (!sess || !['PREVUE', 'REPORTEE'].includes(sess.status) || sess.date < today) {
            return json(res, 400, { error: 'Séance invalide' });
          }
          const dup = q1(
            `SELECT 1 AS x FROM session_request
             WHERE session_id = ? AND status = 'pending' LIMIT 1`,
            sid,
          );
          if (dup) {
            return json(res, 400, { error: 'Demande déjà en attente' });
          }
          let pd = null, ps = null, pe = null, pr = null;
          if (kind === 'move' && b.proposed && b.proposed.date) {
            const prop = b.proposed;
            pd = String(prop.date ?? '');
            ps = Number(prop.start_min);
            pe = Number(prop.end_min);
            pr = Number(prop.room_id);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || !(ps < pe) || !Number.isInteger(pr) || pd < today) {
              return json(res, 400, { error: 'Créneau proposé invalide' });
            }
          }
          run(
            `INSERT INTO session_request
               (session_id, professor_id, kind, reason,
                proposed_date, proposed_start_min, proposed_end_min,
                proposed_room_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            sid, prof.id, kind, String(b.reason ?? '').slice(0, 500),
            pd, ps, pe, pr,
          );
          return json(res, 201, { ok: true });
        }
      }

      // --- Fichiers statiques ----------------------------------------------
      if (req.method === 'GET') {
        let rel = p === '/' ? '/index.html' : p;
        const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
        if (!file.startsWith(path.normalize(publicDir))) {
          return json(res, 403, { error: 'Interdit' });
        }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }

      return json(res, 404, { error: 'Introuvable' });
    } catch (err) {
      console.error('[web]', err);
      return json(res, 500, { error: 'Erreur serveur' });
    }
  };
}
