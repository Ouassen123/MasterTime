/**
 * Tests P12 — Paramètres (`settings.service`) sur base `:memory:`.
 *
 * Couvre (§5) :
 * - créneaux `time_slot` : validation des bornes (weekday 0–6, minutes
 *   [0,1440], start < end, libellé ≤ 60), flag `overlaps` posé/retiré,
 *   CRUD audité (BR-20 via `withAudit`) ;
 * - exceptions `calendar_exception` : dates invalides, inversion
 *   start > end, type inconnu, libellé requis/≤ 120, CRUD ;
 * - rétention `backup_retention` : défaut 10, bornes [1,100], audit
 *   entity `setting` (entity_id = clé, audit manuel — PK textuelle) ;
 * - garde IPC : `guard(..., { requireRole: 'ADMIN' })` refuse un
 *   GESTIONNAIRE, accepte un ADMIN (pattern masters.test).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, openDatabase } from '../electron/main/db/connection';
import {
  loadMigrationsFromDir,
  runMigrations,
} from '../electron/main/db/migrate';
import {
  ensureProfiles,
  listProfiles,
  setCurrentProfile,
} from '../electron/main/db/profile.service';
import {
  createException,
  createTimeSlot,
  deleteException,
  deleteTimeSlot,
  getRetention,
  listExceptions,
  listTimeSlots,
  setRetention,
  updateException,
  updateTimeSlot,
} from '../electron/main/db/settings.service';
import { listAuditLog } from '../electron/main/db/audit.service';
import { currentUserId, guard } from '../electron/main/ipc/helpers';
import type { ApiResult, TimeSlotInput } from '../shared/types';

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

function adminId(db: DatabaseSync): number {
  const admin = listProfiles(db).find((p) => p.role === 'ADMIN');
  expect(admin).toBeDefined();
  return admin!.id;
}

interface AuditRow {
  action: string;
  entity: string;
  entity_id: number | string | null;
  old_values: string | null;
  new_values: string | null;
}

const auditRows = (db: DatabaseSync): AuditRow[] =>
  all<AuditRow>(db, 'SELECT * FROM audit_log ORDER BY id');

const SLOT: TimeSlotInput = {
  weekday: 0,
  start_min: 480, // 08:00
  end_min: 720, // 12:00
  label: 'Matin',
};

beforeEach(() => {
  dbs = [];
});

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // déjà fermée
    }
  }
  dbs = [];
});

// --- Créneaux horaires ----------------------------------------------------------

describe('time_slot — validation', () => {
  it('crée un créneau valide + audit CREATE', () => {
    const db = freshDb();
    const res = createTimeSlot(db, adminId(db), SLOT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      weekday: 0,
      start_min: 480,
      end_min: 720,
      label: 'Matin',
      overlaps: false,
    });
    const audit = auditRows(db).find(
      (r) => r.entity === 'time_slot' && r.action === 'CREATE',
    );
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.new_values!)).toMatchObject({ weekday: 0 });
  });

  it('refuse weekday hors [0,6] ou non entier', () => {
    const db = freshDb();
    const uid = adminId(db);
    for (const weekday of [-1, 7, 1.5, 'lundi' as never]) {
      const res = createTimeSlot(db, uid, { ...SLOT, weekday });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.map((f) => f.field)).toContain('weekday');
      }
    }
  });

  it('refuse minutes hors [0,1440], start >= end et minutes non entières', () => {
    const db = freshDb();
    const uid = adminId(db);
    const cases: [Partial<TimeSlotInput>, string][] = [
      [{ start_min: -1 }, 'start_min'],
      [{ start_min: 1441 }, 'start_min'],
      [{ end_min: -5 }, 'end_min'],
      [{ end_min: 1441 }, 'end_min'],
      [{ start_min: 600, end_min: 600 }, 'end_min'],
      [{ start_min: 700, end_min: 600 }, 'end_min'],
      [{ start_min: 8.5 }, 'start_min'],
    ];
    for (const [patch, field] of cases) {
      const res = createTimeSlot(db, uid, { ...SLOT, ...patch });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.map((f) => f.field)).toContain(field);
      }
    }
  });

  it('refuse un libellé > 60 caractères ou non textuel', () => {
    const db = freshDb();
    const uid = adminId(db);
    const tooLong = createTimeSlot(db, uid, {
      ...SLOT,
      label: 'x'.repeat(61),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.fields?.map((f) => f.field)).toContain('label');
    }
    const badType = createTimeSlot(db, uid, { ...SLOT, label: 42 as never });
    expect(badType.ok).toBe(false);
  });

  it('accepte un libellé de 60 caractères et un libellé absent', () => {
    const db = freshDb();
    const uid = adminId(db);
    expect(
      createTimeSlot(db, uid, { ...SLOT, label: 'x'.repeat(60) }).ok,
    ).toBe(true);
    const res = createTimeSlot(db, uid, {
      weekday: 1,
      start_min: 480,
      end_min: 720,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.label).toBeNull();
  });
});

describe('time_slot — overlaps + CRUD', () => {
  it('overlaps=true sur deux créneaux qui se recouvrent (même weekday)', () => {
    const db = freshDb();
    const uid = adminId(db);
    createTimeSlot(db, uid, SLOT); // 08:00–12:00
    createTimeSlot(db, uid, { weekday: 0, start_min: 600, end_min: 900 });
    createTimeSlot(db, uid, { weekday: 2, start_min: 480, end_min: 720 });
    const rows = listTimeSlots(db);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.start_min === 480 && r.weekday === 0)?.overlaps).toBe(true);
    expect(rows.find((r) => r.start_min === 600)?.overlaps).toBe(true);
    // Le mercredi ne recouvre personne.
    expect(rows.find((r) => r.weekday === 2)?.overlaps).toBe(false);
    // Créneaux qui se touchent (fin == début) : pas de chevauchement.
    createTimeSlot(db, uid, { weekday: 3, start_min: 480, end_min: 720 });
    createTimeSlot(db, uid, { weekday: 3, start_min: 720, end_min: 1080 });
    const thursday = listTimeSlots(db).filter((r) => r.weekday === 3);
    expect(thursday.map((r) => r.overlaps)).toEqual([false, false]);
  });

  it('update modifie les champs + audit UPDATE ; delete + audit DELETE', () => {
    const db = freshDb();
    const uid = adminId(db);
    const created = createTimeSlot(db, uid, SLOT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    const upd = updateTimeSlot(db, uid, id, {
      weekday: 4,
      start_min: 840,
      end_min: 1080,
      label: 'Après-midi',
    });
    expect(upd.ok).toBe(true);
    if (upd.ok) {
      expect(upd.data).toMatchObject({
        weekday: 4,
        start_min: 840,
        end_min: 1080,
        label: 'Après-midi',
      });
    }
    const auditU = auditRows(db).find(
      (r) => r.entity === 'time_slot' && r.action === 'UPDATE',
    );
    expect(auditU).toBeDefined();
    expect(JSON.parse(auditU!.old_values!).weekday).toBe(0);
    expect(JSON.parse(auditU!.new_values!).weekday).toBe(4);

    const del = deleteTimeSlot(db, uid, id);
    expect(del.ok).toBe(true);
    expect(listTimeSlots(db)).toHaveLength(0);
    const auditD = auditRows(db).find(
      (r) => r.entity === 'time_slot' && r.action === 'DELETE',
    );
    expect(auditD).toBeDefined();
  });

  it('update avec label omis conserve le libellé existant ; null explicite l’efface', () => {
    const db = freshDb();
    const uid = adminId(db);
    const created = createTimeSlot(db, uid, SLOT); // label 'Matin'
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    // `label` absent du payload → conservé.
    const kept = updateTimeSlot(db, uid, id, {
      weekday: 0,
      start_min: 540,
      end_min: 780,
    });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.data.label).toBe('Matin');

    // `label: null` explicite → effacé.
    const cleared = updateTimeSlot(db, uid, id, {
      weekday: 0,
      start_min: 540,
      end_min: 780,
      label: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.data.label).toBeNull();
  });

  it('update/delete sur id inconnu → erreur propre ; payload forgé → FieldError', () => {
    const db = freshDb();
    const uid = adminId(db);
    expect(updateTimeSlot(db, uid, 999, SLOT).ok).toBe(false);
    expect(deleteTimeSlot(db, uid, 999).ok).toBe(false);
    // update avec payload forgé sur un id existant → FieldError
    // (pas de TypeError, comme pour les autres référentiels).
    const created = createTimeSlot(db, uid, SLOT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const bad = updateTimeSlot(db, uid, created.data.id, {
      weekday: 'x' as never,
      start_min: 0,
      end_min: 60,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.fields?.map((f) => f.field)).toContain('weekday');
    }
  });
});

// --- Exceptions calendrier ---------------------------------------------------------

describe('calendar_exception — validation + CRUD', () => {
  const EXC = {
    start_date: '2026-11-01',
    end_date: '2026-11-03',
    type: 'VACANCES' as const,
    label: 'Vacances de Toussaint',
  };

  it('crée une exception valide + audit ; tri par start_date', () => {
    const db = freshDb();
    const uid = adminId(db);
    expect(createException(db, uid, EXC).ok).toBe(true);
    createException(db, uid, {
      start_date: '2026-10-07',
      end_date: '2026-10-07',
      type: 'FERMETURE',
      label: 'Inventaire',
    });
    const rows = listExceptions(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].start_date).toBe('2026-10-07'); // tri start_date
    const audit = auditRows(db).find(
      (r) => r.entity === 'calendar_exception' && r.action === 'CREATE',
    );
    expect(audit).toBeDefined();
  });

  it('refuse dates invalides, inversion, type inconnu, libellé vide/long', () => {
    const db = freshDb();
    const uid = adminId(db);
    const cases: [Record<string, unknown>, string][] = [
      [{ start_date: '2026-02-30' }, 'start_date'], // calendairement invalide
      [{ start_date: '07/10/2026' }, 'start_date'],
      [{ end_date: 'n/a' }, 'end_date'],
      [{ start_date: '2026-11-05', end_date: '2026-11-01' }, 'end_date'],
      [{ type: 'CONGE' }, 'type'],
      [{ label: '' }, 'label'],
      [{ label: '   ' }, 'label'],
      [{ label: 'x'.repeat(121) }, 'label'],
    ];
    for (const [patch, field] of cases) {
      const res = createException(db, uid, { ...EXC, ...patch } as never);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.map((f) => f.field)).toContain(field);
      }
    }
    // 120 caractères : accepté.
    expect(
      createException(db, uid, { ...EXC, label: 'x'.repeat(120) }).ok,
    ).toBe(true);
    // Période d'un seul jour (start == end) : acceptée.
    expect(
      createException(db, uid, {
        start_date: '2026-05-01',
        end_date: '2026-05-01',
        type: 'FERIE',
        label: 'Fête du travail',
      }).ok,
    ).toBe(true);
  });

  it('refuse une période de plus de 3660 jours (FieldError end_date)', () => {
    const db = freshDb();
    const uid = adminId(db);
    const res = createException(db, uid, {
      start_date: '2026-01-01',
      end_date: '2040-01-01', // ~14 ans
      type: 'VACANCES',
      label: 'Période irréaliste',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fields?.map((f) => f.field)).toContain('end_date');
    }
    // ~9,9 ans : acceptée.
    expect(
      createException(db, uid, {
        start_date: '2026-01-01',
        end_date: '2035-11-01',
        type: 'VACANCES',
        label: 'Longue période valide',
      }).ok,
    ).toBe(true);
  });

  it('update + delete audités ; id inconnu → erreur propre', () => {
    const db = freshDb();
    const uid = adminId(db);
    const created = createException(db, uid, EXC);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    const upd = updateException(db, uid, id, {
      ...EXC,
      type: 'FERIE',
      label: 'Jour férié',
    });
    expect(upd.ok).toBe(true);
    if (upd.ok) expect(upd.data.type).toBe('FERIE');
    expect(
      auditRows(db).some(
        (r) => r.entity === 'calendar_exception' && r.action === 'UPDATE',
      ),
    ).toBe(true);

    expect(deleteException(db, uid, id).ok).toBe(true);
    expect(listExceptions(db)).toHaveLength(0);
    expect(
      auditRows(db).some(
        (r) => r.entity === 'calendar_exception' && r.action === 'DELETE',
      ),
    ).toBe(true);

    expect(updateException(db, uid, 999, EXC).ok).toBe(false);
    expect(deleteException(db, uid, 999).ok).toBe(false);
  });
});

// --- Rétention ---------------------------------------------------------------------

describe('setting backup_retention', () => {
  it('défaut 10 quand la clé est absente ou illisible ; borné [1,100]', () => {
    const db = freshDb();
    expect(getRetention(db)).toBe(10);
    // Valeur illisible → défaut.
    db.prepare(
      "INSERT INTO setting (key, value) VALUES ('backup_retention', 'abc')",
    ).run();
    expect(getRetention(db)).toBe(10);
    // Hors bornes stocké → rabattu en lecture.
    db.prepare(
      "UPDATE setting SET value = '250' WHERE key = 'backup_retention'",
    ).run();
    expect(getRetention(db)).toBe(100);
    db.prepare(
      "UPDATE setting SET value = '0' WHERE key = 'backup_retention'",
    ).run();
    expect(getRetention(db)).toBe(1);
    // Parse exotique refusé : '0x14' n'est pas `^\d+$` → défaut 10.
    db.prepare(
      "UPDATE setting SET value = '0x14' WHERE key = 'backup_retention'",
    ).run();
    expect(getRetention(db)).toBe(10);
    db.prepare(
      "UPDATE setting SET value = '1e2' WHERE key = 'backup_retention'",
    ).run();
    expect(getRetention(db)).toBe(10);
  });

  it('setRetention écrit + audit entity setting (entity_id = clé)', () => {
    const db = freshDb();
    const uid = adminId(db);
    const res = setRetention(db, uid, 25);
    expect(res.ok).toBe(true);
    expect(getRetention(db)).toBe(25);
    const row = get<{ value: string }>(
      db,
      "SELECT value FROM setting WHERE key = 'backup_retention'",
    );
    expect(row?.value).toBe('25');
    const audit = auditRows(db).find((r) => r.entity === 'setting');
    expect(audit).toBeDefined();
    expect(audit!.action).toBe('CREATE'); // clé absente → CREATE
    expect(audit!.entity_id).toBe('backup_retention');
    // Réécriture → UPDATE audité.
    setRetention(db, uid, 15);
    const audits = auditRows(db).filter((r) => r.entity === 'setting');
    expect(audits.map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);
    expect(JSON.parse(audits[1].old_values!)).toMatchObject({
      value: '25',
    });
    // entity_id textuel accepté et relu tel quel par listAuditLog
    // (AuditEntry.entity_id : number | string | null).
    const entry = listAuditLog(db).find((e) => e.entity === 'setting');
    expect(entry?.entity_id).toBe('backup_retention');
  });

  it('setRetention refuse une transaction déjà ouverte (message clair)', () => {
    const db = freshDb();
    const uid = adminId(db);
    db.exec('BEGIN IMMEDIATE;');
    try {
      expect(() => setRetention(db, uid, 20)).toThrow(/transaction/i);
    } finally {
      db.exec('ROLLBACK;');
    }
    expect(getRetention(db)).toBe(10); // rien n'a été écrit
  });

  it('refuse les valeurs hors bornes ou non entières (FieldError retention)', () => {
    const db = freshDb();
    const uid = adminId(db);
    for (const n of [0, 101, -3, 2.5, 'dix' as never, null as never]) {
      const res = setRetention(db, uid, n);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.fields?.map((f) => f.field)).toContain('retention');
      }
    }
    expect(getRetention(db)).toBe(10); // rien n'a été écrit
  });
});

// --- Garde IPC (BR-24) ------------------------------------------------------------------

describe('garde IPC — requireRole ADMIN', () => {
  it('mutations refusées en GESTIONNAIRE, acceptées en ADMIN', () => {
    const db = freshDb();
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    const admin = listProfiles(db).find((p) => p.role === 'ADMIN')!;

    const mutations: ((d: DatabaseSync) => ApiResult<unknown>)[] = [
      (d) => createTimeSlot(d, currentUserId(d), SLOT),
      (d) =>
        createException(d, currentUserId(d), {
          start_date: '2026-11-01',
          end_date: '2026-11-01',
          type: 'FERIE',
          label: 'Férié',
        }),
      (d) => setRetention(d, currentUserId(d), 20),
      (d) => deleteTimeSlot(d, currentUserId(d), 1),
      (d) => deleteException(d, currentUserId(d), 1),
    ];

    setCurrentProfile(db, gest.id);
    for (const fn of mutations) {
      const denied = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toMatch(/Administrateur/);
    }
    // Aucune écriture ni audit n'a eu lieu.
    expect(listTimeSlots(db)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);

    setCurrentProfile(db, admin.id);
    for (const fn of mutations.slice(0, 3)) {
      // Les 2 suppressions (id 1) échoueraient en "introuvable" si l'id
      // visé n'existe pas — on se limite aux 3 mutations d'écriture.
      const allowed = guard(() => db, fn, { requireRole: 'ADMIN' });
      expect(allowed.ok).toBe(true);
    }
  });
});
