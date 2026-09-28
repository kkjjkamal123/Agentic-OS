import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/settings';
import { migrate, MIGRATIONS, openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';

const fresh = () => openDb(':memory:');

describe('migrations', () => {
  it('apply once and are idempotent', () => {
    const db = fresh();
    expect(migrate(db)).toEqual([]); // openDb already ran them
    const ids = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual(MIGRATIONS.map((m) => m.id));
  });
});

describe('SettingsStore', () => {
  it('returns defaults, persists patches and notifies', () => {
    const db = fresh();
    const s = new SettingsStore(db, defaultSettings('/home/me'));
    expect(s.get().workspaceRoot).toBe('/home/me/AgenticOS/workspaces');
    const seen = vi.fn();
    s.onChange(seen);
    s.update({ theme: 'dark', maxParallelAgents: 5 });
    expect(new SettingsStore(db, defaultSettings('/home/me')).get()).toMatchObject({ theme: 'dark', maxParallelAgents: 5 });
    expect(seen).toHaveBeenCalledOnce();
  });

  it('rejects invalid values and unknown keys without writing', () => {
    const s = new SettingsStore(fresh(), defaultSettings('/h'));
    expect(() => s.update({ maxParallelAgents: 0 })).toThrow();
    expect(() => s.update({ theme: 'neon' })).toThrow();
    expect(() => s.update({ evil: true })).toThrow();
    expect(s.get().maxParallelAgents).toBe(3);
  });

  it('falls back to the default when a stored row is corrupt', () => {
    const db = fresh();
    db.prepare("INSERT INTO settings (key, value) VALUES ('missionTokenBudget', '\"lots\"')").run();
    expect(new SettingsStore(db, defaultSettings('/h')).get().missionTokenBudget).toBe(2000);
  });
});

describe('SecretStore', () => {
  it('stores encrypted, exposes only status + last-4 hint, resolves in main', () => {
    const db = fresh();
    const s = new SecretStore(db, insecureDevEncryptor, {});
    const st = s.set('anthropic', '  sk-ant-abcdefgh1234  ');
    expect(st).toMatchObject({ id: 'anthropic', stored: true, hint: '1234' });
    expect(JSON.stringify(st)).not.toContain('abcdefgh');
    const raw = db.prepare('SELECT cipher FROM secrets').get() as { cipher: Uint8Array };
    expect(Buffer.from(raw.cipher).toString()).not.toContain('sk-ant-abcdefgh1234');
    expect(s.resolve('anthropic')).toBe('sk-ant-abcdefgh1234');
  });

  it('falls back to the launch environment and reports it', () => {
    const s = new SecretStore(fresh(), insecureDevEncryptor, { OPENAI_API_KEY: 'sk-env-key-0000' });
    expect(s.status('openai')).toMatchObject({ stored: false, fromEnv: true });
    expect(s.resolve('openai')).toBe('sk-env-key-0000');
    s.set('openai', 'sk-stored-key-1111');
    expect(s.resolve('openai')).toBe('sk-stored-key-1111');
    s.remove('openai');
    expect(s.resolve('openai')).toBe('sk-env-key-0000');
  });

  it('validates ids and values from the renderer', () => {
    const s = new SecretStore(fresh(), insecureDevEncryptor, {});
    expect(() => s.set('nope', 'sk-123456789')).toThrow();
    expect(() => s.set('openai', 'short')).toThrow();
    expect(s.list().map((x) => x.id)).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'nvidia']);
  });
});
