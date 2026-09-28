import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Append-only: never edit a shipped migration.
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'settings-and-secrets',
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE secrets (
        id         TEXT PRIMARY KEY,
        cipher     BLOB NOT NULL,
        hint       TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'model-catalog-cache',
    sql: `
      CREATE TABLE catalog (
        runtime    TEXT PRIMARY KEY,
        models     TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: 'workspaces',
    sql: `
      CREATE TABLE workspaces (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: 'blocked-models',
    sql: `
      CREATE TABLE blocked_models (
        runtime TEXT NOT NULL,
        model   TEXT NOT NULL,
        reason  TEXT NOT NULL,
        until   INTEGER NOT NULL,
        PRIMARY KEY (runtime, model)
      );
    `,
  },
  {
    id: 5,
    name: 'missions',
    sql: `
      CREATE TABLE missions (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE mission_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL
      );
      CREATE INDEX mission_events_by_mission ON mission_events (mission_id, id);
    `,
  },
];

export function migrate(db: Db): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
  return applied;
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}
