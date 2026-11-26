/**
 * Tests P19 — portail web : migration 0009, comptes profs (scrypt),
 * cycle complet des demandes (annulation / report approuvés → avis
 * bilingue publié), rejet, réclamations et présence en ligne.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, openDatabase, run } from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import { ensureProfiles } from '../electron/main/db/profile.service';
import {
  approvePortalRequest,
  createPortalAccount,
  createPortalAnnouncement,
  deletePortalAnnouncement,
  listPortalAccounts,
  listPortalAnnouncements,
  listPortalComplaints,
  listPortalRequests,
  portalOnlineCount,
  rejectPortalRequest,
  resetPortalPassword,
  setComplaintStatus,
  updatePortalAnnouncement,
} from '../electron/main/db/web-portal.service';
import { hashPassword, verifyPassword } from '../server/core.mjs';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

let dbs: DatabaseSync[];

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  return db;
}

interface Fx {
  profId: number;
  roomId: number;
  room2Id: number;
  sessionId: number;
}

function seedFixture(db: DatabaseSync): Fx {
  const yearId = Number(
    run(
      db,
      "INSERT INTO academic_year (label, start_date, end_date, is_current) VALUES ('2026-2027','2026-09-01','2027-08-31',1)",
    ).lastInsertRowid,
  );
  const semId = Number(
    run(
      db,
      "INSERT INTO semester (academic_year_id, label, ordinal) VALUES (?,'S3',3)",
      yearId,
    ).lastInsertRowid,
  );
  const masterId = Number(
    run(
      db,
      "INSERT INTO master (code, name, academic_year_id, semester_id) VALUES ('M-P','Master Portail',?,?)",
      yearId,
      semId,
    ).lastInsertRowid,
  );
  const groupId = Number(
    run(
      db,
      "INSERT INTO student_group (master_id, name, size) VALUES (?,'G1',30)",
      masterId,
    ).lastInsertRowid,
  );
  const profId = Number(
    run(db, "INSERT INTO professor (full_name) VALUES ('Prof Web')")
      .lastInsertRowid,
  );
  const roomId = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle W1', 60)")
      .lastInsertRowid,
  );
  const room2Id = Number(
    run(db, "INSERT INTO room (name, capacity) VALUES ('Salle W2', 90)")
      .lastInsertRowid,
  );
  const modId = Number(
    run(db, "INSERT INTO module (code, name) VALUES ('MOD-W','Module Web')")
      .lastInsertRowid,
  );
  const mmId = Number(
    run(
      db,
      `INSERT INTO master_module
         (master_id, module_id, semester_id, professor_id, student_group_id,
          volume_min, session_duration_min, planned_sessions,
          sched_start, sched_end)
       VALUES (?,?,?,?,?,1200,120,10,'2026-09-01','2027-07-31')`,
      masterId,
      modId,
      semId,
      profId,
      groupId,
    ).lastInsertRowid,
  );
  // Créneaux autorisés : lun–sam, 8h–18h.
  for (let wd = 0; wd < 6; wd++) {
    run(
      db,
      'INSERT INTO time_slot (weekday, start_min, end_min) VALUES (?,480,1080)',
      wd,
    );
  }
  // Séance future : lundi 2027-06-07, 08:00–10:00.
  const sessionId = Number(
    run(
      db,
      `INSERT INTO session
         (master_module_id, professor_id, room_id, date, start_min, end_min)
       VALUES (?,?,?,'2027-06-07',480,600)`,
      mmId,
      profId,
      roomId,
    ).lastInsertRowid,
  );
  return { profId, roomId, room2Id, sessionId };
}

function addRequest(
  db: DatabaseSync,
  fx: Fx,
  kind: 'cancel' | 'move',
): number {
  return Number(
    run(
      db,
      `INSERT INTO session_request
         (session_id, professor_id, kind, reason,
          proposed_date, proposed_start_min, proposed_end_min,
          proposed_room_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      fx.sessionId,
      fx.profId,
      kind,
      'Motif test',
      kind === 'move' ? '2027-06-09' : null,
      kind === 'move' ? 600 : null,
      kind === 'move' ? 720 : null,
      kind === 'move' ? fx.room2Id : null,
    ).lastInsertRowid,
  );
}

beforeEach(() => {
  dbs = [];
});
afterEach(() => {
  for (const db of dbs) db.close();
});

describe('P19 — migration 0009', () => {
  it('crée les tables du portail', () => {
    const db = freshDb();
    for (const t of [
      'web_professor_account',
      'web_session',
      'web_visitor',
      'session_request',
      'announcement',
      'complaint',
    ]) {
      expect(
        get<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM sqlite_master
           WHERE type = 'table' AND name = ?`,
          t,
        )?.n,
      ).toBe(1);
    }
  });
});

describe('P19 — mots de passe scrypt', () => {
  it('hash + verify (format salt:hash partagé avec le serveur)', () => {
    const h = hashPassword('s3cret');
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword('s3cret', h)).toBe(true);
    expect(verifyPassword('autre', h)).toBe(false);
  });
});

describe('P19 — comptes professeurs', () => {
  it('crée un compte, refuse doublon prof et mdp court', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    expect(
      createPortalAccount(db, fx.profId, 'prof.web', 'secret1').ok,
    ).toBe(true);
    // Doublon professeur → refusé
    expect(
      createPortalAccount(db, fx.profId, 'autre.login', 'secret1').ok,
    ).toBe(false);
    // Mot de passe court → refusé
    const p2 = Number(
      run(db, "INSERT INTO professor (full_name) VALUES ('P2')")
        .lastInsertRowid,
    );
    expect(createPortalAccount(db, p2, 'p2', '123').ok).toBe(false);
    const rows = listPortalAccounts(db);
    expect(rows.ok && rows.data).toHaveLength(1);
    expect(rows.ok && rows.data[0]?.login).toBe('prof.web');
  });

  it('réinitialise le mot de passe', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    createPortalAccount(db, fx.profId, 'prof.web', 'secret1');
    const acc = listPortalAccounts(db);
    const id = acc.ok ? acc.data[0]!.id : 0;
    expect(resetPortalPassword(db, id, 'nouveau42').ok).toBe(true);
    const stored = get<{ password_hash: string }>(
      db,
      'SELECT password_hash FROM web_professor_account WHERE id = ?',
      id,
    );
    expect(verifyPassword('nouveau42', stored!.password_hash)).toBe(true);
  });
});

describe('P19 — demandes professeurs', () => {
  it('approuver une annulation → séance ANNULEE + avis bilingue', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    const reqId = addRequest(db, fx, 'cancel');
    const res = approvePortalRequest(db, null, reqId);
    expect(res.ok).toBe(true);
    const s = get<{ status: string }>(
      db,
      'SELECT status FROM session WHERE id = ?',
      fx.sessionId,
    );
    expect(s?.status).toBe('ANNULEE');
    const req = get<{ status: string }>(
      db,
      'SELECT status FROM session_request WHERE id = ?',
      reqId,
    );
    expect(req?.status).toBe('approved');
    const anns = listPortalAnnouncements(db);
    expect(anns.ok && anns.data).toHaveLength(1);
    const a = anns.ok ? anns.data[0]! : ({} as never);
    expect(a.title_fr).toContain('Annulation');
    expect(a.body_ar).toContain('إلغاء');
    expect(a.is_active).toBe(1);
  });

  it('approuver un report → séance déplacée + avis publié', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    const reqId = addRequest(db, fx, 'move');
    const res = approvePortalRequest(db, null, reqId);
    expect(res.ok).toBe(true);
    const s = get<{
      date: string;
      start_min: number;
      end_min: number;
      room_id: number;
    }>(
      db,
      'SELECT date, start_min, end_min, room_id FROM session WHERE id = ?',
      fx.sessionId,
    );
    expect(s?.date).toBe('2027-06-09');
    expect(s?.start_min).toBe(600);
    expect(s?.end_min).toBe(720);
    expect(s?.room_id).toBe(fx.room2Id);
    const anns = listPortalAnnouncements(db);
    expect(anns.ok && anns.data[0]?.title_fr).toContain('Report');
    expect(anns.ok && anns.data[0]?.body_ar).toContain('تأجيل');
  });

  it('report sans créneau proposé → l\'admin choisit le créneau à l\'approbation', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    const reqId = Number(
      run(
        db,
        `INSERT INTO session_request
           (session_id, professor_id, kind, reason)
         VALUES (?,?,'move','Report sans proposition')`,
        fx.sessionId,
        fx.profId,
      ).lastInsertRowid,
    );
    // Sans créneau → refus (l'approbation exige un créneau complet)
    expect(approvePortalRequest(db, null, reqId).ok).toBe(false);
    // Créneau choisi par l'admin → séance déplacée + avis publié
    const res = approvePortalRequest(db, null, reqId, '', {
      date: '2027-06-10',
      start_min: 840,
      end_min: 960,
      room_id: fx.room2Id,
    });
    expect(res.ok).toBe(true);
    const s = get<{
      date: string;
      start_min: number;
      end_min: number;
      room_id: number;
    }>(
      db,
      'SELECT date, start_min, end_min, room_id FROM session WHERE id = ?',
      fx.sessionId,
    );
    expect(s?.date).toBe('2027-06-10');
    expect(s?.start_min).toBe(840);
    expect(s?.room_id).toBe(fx.room2Id);
    const anns = listPortalAnnouncements(db);
    expect(anns.ok && anns.data[0]?.body_fr).toContain('Salle W2');
    expect(anns.ok && anns.data[0]?.body_ar).toContain('تأجيل');
  });

  it('rejeter → demande rejetée, séance inchangée', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    const reqId = addRequest(db, fx, 'cancel');
    expect(rejectPortalRequest(db, reqId, 'Refusé').ok).toBe(true);
    const s = get<{ status: string }>(
      db,
      'SELECT status FROM session WHERE id = ?',
      fx.sessionId,
    );
    expect(s?.status).toBe('PREVUE');
    // Double décision refusée
    expect(approvePortalRequest(db, null, reqId).ok).toBe(false);
  });

  it('listage des demandes par statut', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    addRequest(db, fx, 'cancel');
    const pending = listPortalRequests(db, 'pending');
    expect(pending.ok && pending.data).toHaveLength(1);
    expect(
      pending.ok && pending.data[0]?.professor_name,
    ).toBe('Prof Web');
    const approved = listPortalRequests(db, 'approved');
    expect(approved.ok && approved.data).toHaveLength(0);
  });
});

describe('P19 — réclamations + présence', () => {
  it('cycle réclamation new → handled', () => {
    const db = freshDb();
    run(
      db,
      "INSERT INTO complaint (author_name, author_role, message) VALUES ('Étudiant X','etudiant','Test message')",
    );
    const rows = listPortalComplaints(db);
    expect(rows.ok && rows.data).toHaveLength(1);
    const id = rows.ok ? rows.data[0]!.id : 0;
    expect(setComplaintStatus(db, id, 'handled').ok).toBe(true);
    expect(get<{ status: string }>(db, 'SELECT status FROM complaint')?.status).toBe(
      'handled',
    );
  });

  it('compteur en ligne : visiteurs + profs récents', () => {
    const db = freshDb();
    const fx = seedFixture(db);
    run(
      db,
      "INSERT INTO web_visitor (token) VALUES ('v1'), ('v2')",
    );
    run(
      db,
      `INSERT INTO web_session (token, professor_id, expires_at)
       VALUES ('tok1', ?, datetime('now','+2 hours'))`,
      fx.profId,
    );
    const res = portalOnlineCount(db);
    expect(res.ok && res.data.visitors).toBe(2);
    expect(res.ok && res.data.professors).toBe(1);
  });
});

describe('P19 — avis admin (CRUD)', () => {
  it('créer, modifier, dépublier, supprimer un avis', () => {
    const db = freshDb();
    // Création : titre/corps FR requis
    expect(
      createPortalAnnouncement(db, { title_fr: '', body_fr: '' }).ok,
    ).toBe(false);
    expect(
      createPortalAnnouncement(db, {
        title_fr: 'Examens S1',
        title_ar: 'الامتحانات',
        body_fr: 'Les examens commencent le 15 décembre.',
        body_ar: 'تبدأ الامتحانات يوم 15 دجنبر.',
      }).ok,
    ).toBe(true);
    let rows = listPortalAnnouncements(db);
    expect(rows.ok && rows.data).toHaveLength(1);
    const id = rows.ok ? rows.data[0]!.id : 0;
    // Modification
    expect(
      updatePortalAnnouncement(db, id, {
        title_fr: 'Examens S1 (reportés)',
        body_fr: 'Report au 20 décembre.',
      }).ok,
    ).toBe(true);
    rows = listPortalAnnouncements(db);
    expect(rows.ok && rows.data[0]?.title_fr).toContain('reportés');
    // Suppression
    expect(deletePortalAnnouncement(db, id).ok).toBe(true);
    expect(deletePortalAnnouncement(db, id).ok).toBe(false);
    rows = listPortalAnnouncements(db);
    expect(rows.ok && rows.data).toHaveLength(0);
  });
});
