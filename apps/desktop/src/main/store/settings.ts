import { SettingsPatchSchema, SettingsSchema } from '@shared/schemas';
import type { Settings } from '@shared/settings';
import type { Db } from './db';

type Listener = (s: Settings) => void;

/** Key/value settings with defaults; rows that no longer validate fall back to the default. */
export class SettingsStore {
  private listeners = new Set<Listener>();
  private db: Db;
  private defaults: Settings;

  constructor(db: Db, defaults: Settings) {
    this.db = db;
    this.defaults = defaults;
  }

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = { ...this.defaults };
    const shape = SettingsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>;
    for (const { key, value } of rows) {
      if (!(key in shape)) continue;
      try {
        const r = shape[key].safeParse(JSON.parse(value));
        if (r.success) out[key] = r.data;
      } catch {
        // corrupt row — keep default
      }
    }
    return out as unknown as Settings;
  }

  /** Validates the patch (unknown keys rejected), persists it and notifies listeners. */
  update(patch: unknown): Settings {
    const p = SettingsPatchSchema.parse(patch);
    const next = SettingsSchema.parse({ ...this.get(), ...p });
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.exec('BEGIN');
    try {
      for (const k of Object.keys(p) as (keyof Settings & string)[]) upsert.run(k, JSON.stringify(next[k]));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
