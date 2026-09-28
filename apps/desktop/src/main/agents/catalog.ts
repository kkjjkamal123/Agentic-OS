import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { RUNTIMES, RUNTIME_IDS, type ModelInfo, type RuntimeCatalog, type RuntimeId } from '@shared/agents';
import type { Accounts } from '../accounts';
import { agentEnv, run, which } from '../env';
import type { Db } from '../store/db';
import type { SecretStore } from '../store/secrets';
import type { SettingsStore } from '../store/settings';
import { AcpSession, type AcpCommand } from './acp';
import { parseAgyModels, type AgyModel } from './agy';
import { codexModels } from './codex';
import { NVIDIA_BASE } from './native';

const TTL_MS = 24 * 60 * 60 * 1000;
const req = createRequire(import.meta.url);

const ADAPTERS: Partial<Record<RuntimeId, string>> = {
  'claude-code': '@agentclientprotocol/claude-agent-acp/dist/index.js',
};

async function nodeCommand(script: string, env: NodeJS.ProcessEnv): Promise<AcpCommand> {
  // Child processes can't read inside app.asar; packaged adapters live in app.asar.unpacked.
  script = script.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  const node = await which('node');
  if (node) return { file: node, args: [script], env };
  return { file: process.execPath, args: [script], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

type Lister = (key: string | undefined, ollamaBase: string) => Promise<ModelInfo[]>;

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 8_000): Promise<any> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

const NON_CHAT = /embed|rerank|reward|whisper|tts|audio|realtime|image|dall-e|transcribe|moderation|search|clip|vision-only|guard|safety|parse|retriever|nv-embed|bge|vila|deplot|kosmos|paligemma|neva|fuyu/i;
const ids = (xs: { id: string; name?: string; display_name?: string }[]) =>
  xs.filter((m) => !NON_CHAT.test(m.id)).map((m) => ({ id: m.id, name: m.display_name ?? m.name ?? m.id }));

const LISTERS: Partial<Record<RuntimeId, Lister>> = {
  anthropic: async (key) => ids((await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key!, 'anthropic-version': '2023-06-01' })).data),
  openai: async (key) => ids((await getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` })).data).filter((m) => /^(gpt|o\d|codex)/.test(m.id)),
  google: async (key) =>
    ((await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key!)}`)).models as any[])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName ?? m.name })),
  openrouter: async () => ids((await getJson('https://openrouter.ai/api/v1/models')).data),
  nvidia: async (key) => ids((await getJson(`${NVIDIA_BASE}/models`, { authorization: `Bearer ${key}` })).data),
  ollama: async (_key, base) => ((await getJson(`${base.replace(/\/$/, '')}/api/tags`, {}, 1_500)).models as any[]).map((m) => ({ id: m.name, name: m.name })),
};

export interface CatalogDeps {
  db: Db;
  accounts: Accounts;
  secrets: SecretStore;
  settings: SettingsStore;
  scratchDir: string;
  /** Dev/e2e only: an ACP agent script that stands in for omp. */
  fakeAgent?: string;
}

export class Catalog {
  private d: CatalogDeps;
  private inflight: Promise<RuntimeCatalog[]> | null = null;
  private revalidating = new Set<RuntimeId>();
  private listeners = new Set<(list: RuntimeCatalog[]) => void>();

  constructor(deps: CatalogDeps) {
    this.d = deps;
  }

  async command(runtime: RuntimeId): Promise<AcpCommand | null> {
    const env = await agentEnv();
    if (this.d.fakeAgent) return runtime === 'omp' ? nodeCommand(this.d.fakeAgent, env) : null;
    if (runtime === 'omp') {
      const omp = await which('omp');
      return omp ? { file: omp, args: ['acp'], env } : null;
    }
    const adapter = ADAPTERS[runtime];
    if (!adapter) return null;
    // Drive the user's own signed-in, up-to-date Claude Code instead of the SDK's bundled copy.
    const claude = runtime === 'claude-code' ? await which('claude') : null;
    return nodeCommand(req.resolve(adapter), claude ? { ...env, CLAUDE_CODE_EXECUTABLE: claude } : env);
  }

  private cached(runtime: RuntimeId): { models: ModelInfo[]; fresh: boolean } | null {
    const row = this.d.db.prepare('SELECT models, updated_at FROM catalog WHERE runtime = ?').get(runtime) as { models: string; updated_at: number } | undefined;
    return row ? { models: JSON.parse(row.models), fresh: Date.now() - row.updated_at < TTL_MS } : null;
  }

  /** Effort variants of an Antigravity model (agy bakes effort into its ids). */
  agyVariants(base: string): string[] {
    const c = this.cached('antigravity');
    return (c?.models as AgyModel[] | undefined)?.find((m) => m.id === base)?.variants ?? [base];
  }

  remember(runtime: RuntimeId, models: ModelInfo[]) {
    if (!models.length) return;
    this.d.db
      .prepare('INSERT INTO catalog (runtime, models, updated_at) VALUES (?, ?, ?) ON CONFLICT(runtime) DO UPDATE SET models = excluded.models, updated_at = excluded.updated_at')
      .run(runtime, JSON.stringify(models), Date.now());
  }

  onChange(l: (list: RuntimeCatalog[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async changed() {
    const list = await this.list();
    for (const l of this.listeners) l(list);
  }

  /** Forget cached models (a key was added/removed, a server moved) and push the new catalog out. */
  invalidate(runtimes: RuntimeId[]) {
    for (const r of runtimes) this.d.db.prepare('DELETE FROM catalog WHERE runtime = ?').run(r);
    void this.changed();
  }

  // Stale lists are served instantly and refreshed in the background; listeners hear about new models.
  private revalidate(runtime: RuntimeId, before: ModelInfo[]) {
    if (this.revalidating.has(runtime)) return;
    this.revalidating.add(runtime);
    void this.one(runtime, true)
      .then((c) => {
        if (JSON.stringify(c.models.map((m) => m.id)) !== JSON.stringify(before.map((m) => m.id))) void this.changed();
      })
      .finally(() => this.revalidating.delete(runtime));
  }

  /** A model the provider refused for this account (gone, gated, unsupported) stays out of routing for a week. */
  block(runtime: RuntimeId, model: string, reason: string, days = 7) {
    this.d.db
      .prepare('INSERT INTO blocked_models (runtime, model, reason, until) VALUES (?, ?, ?, ?) ON CONFLICT(runtime, model) DO UPDATE SET reason = excluded.reason, until = excluded.until')
      .run(runtime, model, reason.slice(0, 300), Date.now() + days * 86_400_000);
    void this.changed();
  }

  private blocked(): Set<string> {
    const rows = this.d.db.prepare('SELECT runtime, model FROM blocked_models WHERE until > ?').all(Date.now()) as { runtime: string; model: string }[];
    return new Set(rows.map((r) => `${r.runtime}|${r.model}`));
  }

  list(refresh = false): Promise<RuntimeCatalog[]> {
    // A refresh must not be answered by an older, non-refreshing request that is still in flight.
    if (!refresh && this.inflight) return this.inflight;
    const p: Promise<RuntimeCatalog[]> = Promise.all(RUNTIME_IDS.map((r) => this.one(r, refresh)))
      .then((list) => {
        const blocked = this.blocked();
        return list.map((c) => ({ ...c, models: c.models.filter((m) => !blocked.has(`${c.runtime}|${m.id}`)) }));
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  private async one(runtime: RuntimeId, refresh: boolean): Promise<RuntimeCatalog> {
    const def = RUNTIMES[runtime];
    const cache = this.cached(runtime);
    const out = (available: boolean, models: ModelInfo[], reason?: string): RuntimeCatalog => ({ runtime, available, models, reason });

    if (def.kind === 'acp' || def.kind === 'cli') {
      if (this.d.fakeAgent) {
        const cmd = await this.command(runtime);
        return cmd ? this.probe(runtime, cmd, cache, refresh) : out(false, [], 'Disabled in test mode');
      }
      const acct = (await this.d.accounts.list()).find((a) => a.id === def.account);
      if (!acct?.installed) return out(false, [], `${def.label} is not installed`);
      if (acct.signedIn === false) return out(false, [], `Not signed in to ${def.label}`);
      if (runtime === 'codex') {
        const models = codexModels();
        return out(models.length > 0, models, models.length ? undefined : 'Run Codex once to load its model list');
      }
      if (runtime === 'antigravity') {
        if (cache && !refresh) {
          if (!cache.fresh) this.revalidate(runtime, cache.models);
          return out(true, cache.models);
        }
        const bin = await which('agy');
        const r = bin ? await run(bin, ['models'], 30_000) : { ok: false, out: '' };
        const models = parseAgyModels(r.out);
        this.remember(runtime, models);
        return out(models.length > 0, models, models.length ? undefined : 'Antigravity listed no models; sign in with agy');
      }
      const cmd = await this.command(runtime);
      if (!cmd) return out(false, [], `${def.label} is not available`);
      return this.probe(runtime, cmd, cache, refresh);
    }

    if (this.d.fakeAgent) return out(false, [], 'Disabled in test mode');
    const key = 'secret' in def ? this.d.secrets.resolve(def.secret) : undefined;
    if ('secret' in def && !key) return out(false, [], `Add a ${def.label} key in Settings`);
    if (cache && !refresh) {
      if (!cache.fresh) this.revalidate(runtime, cache.models);
      return out(true, cache.models);
    }
    try {
      const models = await LISTERS[runtime]!(key, this.d.settings.get().ollamaBaseUrl);
      this.remember(runtime, models);
      return out(true, models);
    } catch (e) {
      if (runtime === 'ollama') return out(false, [], 'Ollama is not running');
      return out(!!cache, cache?.models ?? [], `Could not list models: ${(e as Error).message}`);
    }
  }

  // Spawning an agent just to read its model list costs battery: at most once a day, in the background.
  private async probe(runtime: RuntimeId, cmd: AcpCommand, cache: { models: ModelInfo[]; fresh: boolean } | null, refresh: boolean): Promise<RuntimeCatalog> {
    if (cache && !refresh) {
      if (!cache.fresh) this.revalidate(runtime, cache.models);
      return { runtime, available: true, models: cache.models };
    }
    const cwd = join(this.d.scratchDir, 'probe');
    mkdirSync(cwd, { recursive: true });
    try {
      const s = await AcpSession.start(cmd, cwd);
      s.dispose();
      this.remember(runtime, s.models);
      return { runtime, available: true, models: s.models };
    } catch (e) {
      return { runtime, available: !!cache, models: cache?.models ?? [], reason: (e as Error).message };
    }
  }
}
