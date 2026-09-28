import { SecretIdSchema, SecretValueSchema } from '@shared/schemas';
import { SECRETS, type SecretId, type SecretStatus } from '@shared/secrets';
import type { Db } from './db';

/** Encrypts at rest. Production uses Electron safeStorage (macOS Keychain-held key). */
export interface Encryptor {
  kind: 'keychain' | 'insecure-dev';
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** Dev/test only — lets e2e runs avoid Keychain prompts for the unsigned Electron binary. */
export const insecureDevEncryptor: Encryptor = {
  kind: 'insecure-dev',
  encrypt: (p) => Buffer.from('dev:' + Buffer.from(p, 'utf8').toString('base64')),
  decrypt: (c) => Buffer.from(c.toString().replace(/^dev:/, ''), 'base64').toString('utf8'),
};

interface Row {
  id: string;
  cipher: Uint8Array;
  hint: string | null;
  updated_at: string;
}

/**
 * API keys. The renderer only ever sees `SecretStatus`; plaintext is available to main-process
 * code through `resolve()` (stored value first, then the launch environment).
 */
export class SecretStore {
  private db: Db;
  private enc: Encryptor;
  private env: NodeJS.ProcessEnv;

  constructor(db: Db, enc: Encryptor, env: NodeJS.ProcessEnv = process.env) {
    this.db = db;
    this.enc = enc;
    this.env = env;
  }

  private row(id: SecretId): Row | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as Row | undefined;
  }

  status(id: SecretId): SecretStatus {
    const r = this.row(id);
    const def = SECRETS.find((s) => s.id === id)!;
    return {
      id,
      stored: !!r,
      fromEnv: !r && !!this.env[def.env],
      hint: r?.hint ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }

  list(): SecretStatus[] {
    return SECRETS.map((s) => this.status(s.id));
  }

  set(id: unknown, value: unknown): SecretStatus {
    const sid = SecretIdSchema.parse(id);
    const v = SecretValueSchema.parse(value);
    const cipher = this.enc.encrypt(v);
    this.db
      .prepare('INSERT INTO secrets (id, cipher, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cipher = excluded.cipher, hint = excluded.hint, updated_at = excluded.updated_at')
      .run(sid, cipher, v.slice(-4), new Date().toISOString());
    return this.status(sid);
  }

  remove(id: unknown): SecretStatus {
    const sid = SecretIdSchema.parse(id);
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(sid);
    return this.status(sid);
  }

  /** Main-process only. Never send the result over IPC. */
  resolve(id: SecretId): string | undefined {
    const r = this.row(id);
    if (r) return this.enc.decrypt(Buffer.from(r.cipher));
    const def = SECRETS.find((s) => s.id === id)!;
    return this.env[def.env] || undefined;
  }
}
