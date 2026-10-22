/**
 * Tests P6a — services des référentiels (salles, modules), profils et audit
 * transactionnel (AD-6) sur base temporaire `:memory:` — aucun Electron.
 *
 * Couvre : CRUD salle+module, doublons refusés, suppression liée refusée
 * (BR-22) + désactivation, audit CREATE/UPDATE/DELETE avec old/new JSON,
 * profils seedés + `setCurrentProfile`.
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
import { seedDemo } from '../electron/main/db/seed-demo';
import {
  ensureProfiles,
  getCurrentProfile,
  listProfiles,
  setCurrentProfile,
} from '../electron/main/db/profile.service';
import {
  createRoom,
  deleteRoom,
  listRooms,
  setRoomActive,
  updateRoom,
} from '../electron/main/db/room.service';
import {
  createModule,
  deleteModule,
  listModules,
  updateModule,
} from '../electron/main/db/module.service';
import { withAudit } from '../electron/main/db/audit.service';
import type { AppUser } from '../shared/types';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../electron/main/db/migrations',
);

let dbs: DatabaseSync[];

function freshDb(opts: { seed?: boolean } = {}): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
  ensureProfiles(db);
  if (opts.seed) seedDemo(db);
  return db;
}

function admin(db: DatabaseSync): AppUser {
  const user = listProfiles(db).find((p) => p.role === 'ADMIN');
  expect(user).toBeDefined();
  return user!;
}

interface AuditRow {
  id: number;
  user_id: number | null;
  action: string;
  entity: string;
  entity_id: number | null;
  old_values: string | null;
  new_values: string | null;
}

function auditRows(db: DatabaseSync, entity?: string): AuditRow[] {
  const rows = all<AuditRow>(
    db,
    'SELECT * FROM audit_log' + (entity ? ' WHERE entity = ?' : '') +
      ' ORDER BY id',
    ...(entity ? [entity] : []),
  );
  return rows;
}

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

describe('profils (app_user)', () => {
  it('seede Administrateur (ADMIN) + Gestionnaire (GESTIONNAIRE) si vide', () => {
    const db = freshDb();
    const profiles = listProfiles(db);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.role)).toEqual(['ADMIN', 'GESTIONNAIRE']);
    expect(profiles[0].display_name).toBe('Administrateur');
    expect(profiles[1].display_name).toBe('Gestionnaire');
    // Profil courant persisté = administrateur par défaut
    expect(getCurrentProfile(db)?.role).toBe('ADMIN');
  });

  it('idempotent : second appel ne duplique pas les profils', () => {
    const db = freshDb();
    ensureProfiles(db);
    ensureProfiles(db);
    expect(listProfiles(db)).toHaveLength(2);
  });

  it('ne ré-seede pas si app_user contient déjà des profils', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    runMigrations(db, { migrations: loadMigrationsFromDir(MIGRATIONS_DIR) });
    db.prepare(
      "INSERT INTO app_user (display_name, role) VALUES ('Fatima', 'GESTIONNAIRE')",
    ).run();
    ensureProfiles(db);
    const profiles = listProfiles(db);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].display_name).toBe('Fatima');
    // …et le profil courant pointe sur l'existant
    expect(getCurrentProfile(db)?.display_name).toBe('Fatima');
  });

  it('setCurrentProfile bascule et persiste ; id invalide refusé', () => {
    const db = freshDb();
    const gestionnaire = listProfiles(db).find(
      (p) => p.role === 'GESTIONNAIRE',
    )!;
    const res = setCurrentProfile(db, gestionnaire.id);
    expect(res.ok).toBe(true);
    expect(getCurrentProfile(db)?.id).toBe(gestionnaire.id);

    const bad = setCurrentProfile(db, 9999);
    expect(bad.ok).toBe(false);
    expect(getCurrentProfile(db)?.id).toBe(gestionnaire.id);
  });
});

describe('salles (room)', () => {
  it('créer une salle : INSERT + audit CREATE avec new_values JSON', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const res = createRoom(db, uid, { name: 'Salle 2', capacity: 30 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe('Salle 2');
    expect(res.data.capacity).toBe(30);
    expect(res.data.is_active).toBe(1);
    expect(listRooms(db).some((r) => r.name === 'Salle 2')).toBe(true);

    const log = auditRows(db, 'room');
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('CREATE');
    expect(log[0].user_id).toBe(uid);
    expect(log[0].entity_id).toBe(res.data.id);
    expect(log[0].old_values).toBeNull();
    expect(JSON.parse(log[0].new_values!)).toMatchObject({
      name: 'Salle 2',
      capacity: 30,
    });
  });

  it('doublon de nom : refus avec erreur champ name, aucune écriture', () => {
    const db = freshDb();
    const uid = admin(db).id;
    createRoom(db, uid, { name: 'Amphi 7', capacity: 240 });
    const dup = createRoom(db, uid, { name: 'Amphi 7', capacity: 10 });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.fields).toEqual([
      { field: 'name', message: expect.any(String) },
    ]);
    expect(
      listRooms(db).filter((r) => r.name === 'Amphi 7'),
    ).toHaveLength(1);
    expect(auditRows(db, 'room')).toHaveLength(1); // uniquement le 1er INSERT
  });

  it('nom vide : erreur champ name sans INSERT', () => {
    const db = freshDb();
    const res = createRoom(db, null, { name: '   ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fields?.[0].field).toBe('name');
    expect(listRooms(db)).toHaveLength(0);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('capacité invalide (0, négative, non entière) : erreur champ capacity', () => {
    const db = freshDb();
    for (const capacity of [0, -5, 2.5]) {
      const res = createRoom(db, null, { name: `S-${capacity}`, capacity });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.fields?.[0].field).toBe('capacity');
    }
    expect(listRooms(db)).toHaveLength(0);
  });

  it('modifier la capacité : UPDATE + audit old/new', () => {
    const db = freshDb({ seed: true });
    const uid = admin(db).id;
    const amphi7 = listRooms(db).find((r) => r.name === 'Amphi 7')!;
    expect(amphi7.capacity).toBe(240);
    const res = updateRoom(db, uid, amphi7.id, {
      name: 'Amphi 7',
      capacity: 200,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.capacity).toBe(200);

    const log = auditRows(db, 'room').filter((r) => r.action === 'UPDATE');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].old_values!).capacity).toBe(240);
    expect(JSON.parse(log[0].new_values!).capacity).toBe(200);
  });

  it('suppression refusée si séances liées (BR-22) : message chiffré', () => {
    const db = freshDb({ seed: true });
    const uid = admin(db).id;
    const amphi = listRooms(db).find((r) => r.sessionCount > 0)!;
    expect(amphi).toBeDefined();
    const res = deleteRoom(db, uid, amphi.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(String(amphi.sessionCount));
    expect(res.error).toMatch(/séance/);
    // Rien n'a été supprimé ni audité
    expect(get(db, 'SELECT id FROM room WHERE id = ?', amphi.id)).toBeDefined();
    expect(auditRows(db, 'room')).toHaveLength(0);
  });

  it('désactivation : is_active=0, séances intactes, audit écrit', () => {
    const db = freshDb({ seed: true });
    const uid = admin(db).id;
    const amphi = listRooms(db).find((r) => r.sessionCount > 0)!;
    const res = setRoomActive(db, uid, amphi.id, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.is_active).toBe(0);
    expect(res.data.sessionCount).toBe(amphi.sessionCount); // intact
    const sessions = get<{ c: number }>(
      db,
      'SELECT count(*) AS c FROM session WHERE room_id = ?',
      amphi.id,
    )!.c;
    expect(sessions).toBe(amphi.sessionCount);
    expect(
      auditRows(db, 'room').some(
        (r) => r.action === 'UPDATE' && r.entity_id === amphi.id,
      ),
    ).toBe(true);
  });

  it('suppression d’une salle libre : DELETE + audit avec old_values', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const created = createRoom(db, uid, { name: 'Salle vide' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = deleteRoom(db, uid, created.data.id);
    expect(res.ok).toBe(true);
    expect(
      listRooms(db).some((r) => r.name === 'Salle vide'),
    ).toBe(false);
    const del = auditRows(db, 'room').find((r) => r.action === 'DELETE');
    expect(del).toBeDefined();
    expect(JSON.parse(del!.old_values!).name).toBe('Salle vide');
    expect(del!.new_values).toBeNull();
  });
});

describe('modules (module)', () => {
  it('créer un module : INSERT + audit CREATE', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const res = createModule(db, uid, { code: 'MOD-NEW', name: 'Nouveau module' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.is_demo).toBe(0);
    expect(listModules(db).some((m) => m.code === 'MOD-NEW')).toBe(true);
    const log = auditRows(db, 'module');
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('CREATE');
    expect(log[0].user_id).toBe(uid);
    expect(JSON.parse(log[0].new_values!)).toMatchObject({
      code: 'MOD-NEW',
      name: 'Nouveau module',
    });
  });

  it('doublons code et nom refusés avec erreurs de champs', () => {
    const db = freshDb();
    const uid = admin(db).id;
    createModule(db, uid, { code: 'GL101', name: 'Génie logiciel' });

    const dupCode = createModule(db, uid, { code: 'GL101', name: 'Autre nom' });
    expect(dupCode.ok).toBe(false);
    if (!dupCode.ok) expect(dupCode.fields?.[0].field).toBe('code');

    const dupName = createModule(db, uid, { code: 'XX999', name: 'Génie logiciel' });
    expect(dupName.ok).toBe(false);
    if (!dupName.ok) expect(dupName.fields?.[0].field).toBe('name');

    const empty = createModule(db, uid, { code: '', name: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.fields?.map((f) => f.field)).toEqual(['code', 'name']);
    }
    expect(listModules(db)).toHaveLength(1);
  });

  it('modifier : UPDATE + audit old/new', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const created = createModule(db, uid, { code: 'BD201', name: 'Bases' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = updateModule(db, uid, created.data.id, {
      code: 'BD201',
      name: 'Bases de données avancées',
    });
    expect(res.ok).toBe(true);
    const log = auditRows(db, 'module').filter((r) => r.action === 'UPDATE');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].old_values!).name).toBe('Bases');
    expect(JSON.parse(log[0].new_values!).name).toBe(
      'Bases de données avancées',
    );
  });

  it('suppression refusée si master_module lié (BR-22)', () => {
    const db = freshDb({ seed: true });
    const uid = admin(db).id;
    const linked = listModules(db).find((m) => m.masterModuleCount > 0)!;
    expect(linked).toBeDefined();
    const res = deleteModule(db, uid, linked.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(String(linked.masterModuleCount));
    expect(get(db, 'SELECT id FROM module WHERE id = ?', linked.id)).toBeDefined();
  });

  it('suppression d’un module non lié : DELETE + audit', () => {
    const db = freshDb();
    const uid = admin(db).id;
    const created = createModule(db, uid, { code: 'ORPH', name: 'Orphelin' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = deleteModule(db, uid, created.data.id);
    expect(res.ok).toBe(true);
    const del = auditRows(db, 'module').find((r) => r.action === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.new_values).toBeNull();
  });
});

describe('audit transactionnel (AD-6)', () => {
  it('échec de la mutation : ROLLBACK intégral, aucune trace orpheline', () => {
    const db = freshDb();
    const uid = admin(db).id;
    // Mutation réelle (INSERT salle) puis exception dans la même TX auditée :
    // ni la salle ni la ligne audit_log ne doivent survivre.
    expect(() =>
      withAudit(db, uid, 'CREATE', 'room', null, () => {
        const id = Number(
          db.prepare('INSERT INTO room (name) VALUES (?)').run('Salle fantôme')
            .lastInsertRowid,
        );
        throw new Error(`échec simulé après INSERT #${id}`);
      }),
    ).toThrow(/échec simulé/);
    expect(listRooms(db).some((r) => r.name === 'Salle fantôme')).toBe(false);
    expect(auditRows(db, 'room')).toHaveLength(0);
  });

  it('le profil courant est utilisé comme user_id', () => {
    const db = freshDb();
    const gest = listProfiles(db).find((p) => p.role === 'GESTIONNAIRE')!;
    const res = createRoom(db, gest.id, { name: 'Salle G' });
    expect(res.ok).toBe(true);
    const log = auditRows(db, 'room');
    expect(log[0].user_id).toBe(gest.id);
  });
});
