/**
 * Tests seed RÉEL FSJP — migration 0003 + jeu de données officiel 2026/2027.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { bundledMigrations, runMigrations } from '../electron/main/db/migrate';
import { seedReal } from '../electron/main/db/seed-real';
import { countRows } from '../electron/main/db/connection';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, { migrations: bundledMigrations() });
  return db;
}

describe('seed réel FSJP', () => {
  it('insère le référentiel réel, is_demo=0 partout', () => {
    const db = freshDb();
    const r = seedReal(db);
    expect(r.inserted).toBe(true);
    expect(countRows(db, 'master')).toBe(14);
    expect(countRows(db, 'room')).toBe(17);
    expect(countRows(db, 'professor')).toBe(133);
    expect(countRows(db, 'module')).toBe(93);
    expect(countRows(db, 'master_module')).toBe(97);
    expect(countRows(db, 'session')).toBe(97 * 12);
    expect(countRows(db, 'external_occupancy')).toBe(168);
    expect(countRows(db, 'session_status_history')).toBe(97 * 12);
    for (const t of ['master', 'module', 'session', 'external_occupancy']) {
      const c = db
        .prepare(`SELECT count(*) AS c FROM ${t} WHERE is_demo != 0`)
        .get() as { c: number };
      expect(c.c).toBe(0);
    }
    db.close();
  });

  it('idempotent : second appel sans effet', () => {
    const db = freshDb();
    seedReal(db);
    expect(seedReal(db).inserted).toBe(false);
    expect(countRows(db, 'master')).toBe(14);
    db.close();
  });

  it('les capacités réelles des salles sont celles du document officiel', () => {
    const db = freshDb();
    seedReal(db);
    const rows = db
      .prepare("SELECT name, capacity FROM room WHERE name IN ('Amphi 6','Amphi 7','Salle 1','Salle 4','Salle 9')")
      .all() as { name: string; capacity: number | null }[];
    const m = Object.fromEntries(rows.map((r) => [r.name, r.capacity]));
    expect(m['Amphi 6']).toBe(140);
    expect(m['Amphi 7']).toBe(60);
    expect(m['Salle 1']).toBe(60);
    expect(m['Salle 4']).toBe(78);
    expect(m['Salle 9']).toBeNull();
    db.close();
  });
});
