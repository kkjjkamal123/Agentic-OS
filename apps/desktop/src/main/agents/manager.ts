import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIMES, type AgentBatch, type AgentEvent, type Role, type Routed, type SessionInfo, type StartOpts, type Usage, type Vendor } from '@shared/agents';
import type { Quality } from '@shared/settings';
import type { GateAction } from '@shared/workspace';
import { agentEnv, which } from '../env';
import type { SecretStore } from '../store/secrets';
import type { SettingsStore } from '../store/settings';
import type { Gate } from '../tools/gate';
import { fsTools } from '../tools/fs-tools';
import type { TerminalFeed } from '../tools/terminal';
import type { Workspaces } from '../workspace/workspaces';
import { AcpSession } from './acp';
import type { Catalog } from './catalog';
import { AgySession } from './agy';
import { CodexSession } from './codex';
import { languageModel, NativeSession, type ApiRuntime } from './native';
import { systemPrompt, type Policies } from './policies';
import { classifyError, effortFor, poolOf, rank, route, shouldSwitch, type Complexity, type RouteOpts } from './router';

const FLUSH_MS = 80;
const IDLE_MS = 10 * 60_000;
const COOLDOWN_MS = 15 * 60_000;
const CREDITS_COOLDOWN_MS = 60 * 60_000;

export interface InternalStart extends StartOpts {
  /** Run in this folder (a task worktree) instead of the workspace root. */
  root?: string;
  /** Planners and reviewers look but never touch. */
  readOnly?: boolean;
  complexity?: Complexity;
}

export interface Reply {
  text: string;
  error?: string;
  usage: Usage;
}

const READ_KINDS = new Set(['read', 'fetch']);
const MAX_SWITCHES = 3;

/** Carries a conversation over to a new model after a switch. */
export function recap(transcript: { role: 'user' | 'agent'; text: string }[], next: string): string {
  if (!transcript.length) return next;
  const lines = transcript.slice(-8).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text}`);
  return `You are taking over this conversation from another model. So far:\n${lines.join('\n')}\n\nUser: ${next}`;
}

interface Live {
  info: SessionInfo;
  root: string;
  label: string;
  session: AcpSession | CodexSession | AgySession | NativeSession;
  busy: boolean;
  queue: AgentEvent[];
  commands: Set<string>;
  tap?: (e: AgentEvent) => void;
  /** Started on Auto: allowed to hand the conversation to the next best model on limits. */
  auto: boolean;
  opts: InternalStart;
  transcript: { role: 'user' | 'agent'; text: string }[];
  flushTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

export interface ManagerDeps {
  catalog: Catalog;
  secrets: SecretStore;
  settings: SettingsStore;
  workspaces: Workspaces;
  gate: Gate;
  feed: TerminalFeed;
  policies: () => Policies;
  scratchDir: string;
  send: (batch: AgentBatch) => void;
}

// Consecutive text/thought deltas collapse into one event: fewer IPC messages, fewer renders.
export function coalesce(queue: AgentEvent[], e: AgentEvent) {
  const last = queue[queue.length - 1];
  if (last && (e.t === 'text' || e.t === 'thought') && last.t === e.t) last.text += e.text;
  else queue.push({ ...e });
}

export class AgentManager {
  private live = new Map<string, Live>();
  private cooling = new Map<string, number>();
  private d: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.d = deps;
  }

  routeOpts(avoidVendor?: Vendor, quality?: Quality): RouteOpts {
    const load: Record<string, number> = {};
    for (const l of this.live.values()) if (l.busy) load[poolOf(l.info.ref)] = (load[poolOf(l.info.ref)] ?? 0) + 1;
    const now = Date.now();
    const cooling = new Set([...this.cooling].filter(([, until]) => until > now).map(([pool]) => pool));
    return { avoidVendor, load, cooling, quality: quality ?? this.d.settings.get().quality };
  }

  async route(role: Role, opts: { avoidVendor?: Vendor; quality?: Quality; complexity?: Complexity } = {}): Promise<Routed | null> {
    return route(role, await this.d.catalog.list(), { ...this.routeOpts(opts.avoidVendor, opts.quality), complexity: opts.complexity });
  }

  async candidates(role: Role, opts: { avoidVendor?: Vendor; quality?: Quality; complexity?: Complexity; exclude?: Set<string> } = {}): Promise<Routed[]> {
    return rank(role, await this.d.catalog.list(), { ...this.routeOpts(opts.avoidVendor, opts.quality), complexity: opts.complexity, exclude: opts.exclude });
  }

  async start(role: Role, opts: InternalStart = {}): Promise<SessionInfo> {
    const quality = opts.quality ?? this.d.settings.get().quality;
    const routed = opts.ref ? { ...opts.ref, effort: effortFor(role, quality, opts.complexity) } : await this.route(role, { quality, complexity: opts.complexity });
    if (!routed) throw new Error('No model available. Sign in to a subscription or add an API key in Settings.');
    const root = opts.root ?? (opts.workspaceId ? this.d.workspaces.get(opts.workspaceId).path : join(this.d.scratchDir, 'scratch'));
    mkdirSync(root, { recursive: true });
    const id = randomUUID();
    const { session, label } = await this.spawn(id, role, routed, root, opts);
    const info: SessionInfo = { id, role, ref: { runtime: routed.runtime, model: routed.model }, effort: routed.effort, workspaceId: opts.workspaceId ?? null };
    this.live.set(id, { info, root, label, session, busy: false, queue: [], commands: new Set(), auto: !opts.ref, opts: { ...opts, quality }, transcript: [] });
    this.touch(id);
    return info;
  }

  private async spawn(id: string, role: Role, routed: Routed, root: string, opts: InternalStart): Promise<{ session: Live['session']; label: string }> {
    const def = RUNTIMES[routed.runtime];
    const label = def.label;
    const system = systemPrompt(role, this.d.policies());
    const decide = (a: GateAction) => (opts.readOnly && !READ_KINDS.has(a.kind) ? Promise.resolve(false) : this.d.gate.check(id, label, root, a));
    const env = await agentEnv();
    const readOnly = !!opts.readOnly || this.d.settings.get().approvalMode === 'ask';
    if (routed.runtime === 'antigravity') {
      const bin = await which('agy');
      if (!bin) throw new Error('Antigravity CLI is not installed');
      return { label, session: new AgySession({ bin, root, env, want: routed, variants: this.d.catalog.agyVariants(routed.model), readOnly, system }) };
    }
    if (def.kind === 'cli') {
      const bin = await which('codex');
      if (!bin) throw new Error('Codex is not installed');
      return { label, session: new CodexSession(bin, root, env, routed, readOnly ? 'read-only' : 'workspace-write', system) };
    }
    if (def.kind === 'acp') {
      const cmd = await this.d.catalog.command(routed.runtime);
      if (!cmd) throw new Error(`${label} is not available`);
      if (cmd.args[0] === 'acp') cmd.args = ['--append-system-prompt', system, ...cmd.args];
      const s = await AcpSession.start(cmd, root, routed, { system, decide });
      this.d.catalog.remember(routed.runtime, s.models);
      return { label, session: s };
    }
    const key = 'secret' in def ? this.d.secrets.resolve(def.secret) : undefined;
    const model = languageModel(routed.runtime as ApiRuntime, routed.model, key, this.d.settings.get().ollamaBaseUrl);
    const tools = (signal: AbortSignal) => {
      const all = fsTools({ root, sessionId: id, agent: label, env, check: decide, feed: this.d.feed, signal });
      return opts.readOnly ? { read_file: all.read_file, list_dir: all.list_dir } : all;
    };
    return { label, session: new NativeSession(model, routed.runtime as ApiRuntime, system, routed.effort, tools, routed.model) };
  }

  private emit(id: string, e: AgentEvent) {
    const l = this.live.get(id);
    if (!l) return;
    if (e.t === 'error') e = { ...e, message: this.onFailure(l, e.message) };
    if (e.t === 'tool') this.trackCommand(l, e);
    l.tap?.(e);
    coalesce(l.queue, e);
    if (e.t === 'done' || e.t === 'error') this.flush(id);
    else l.flushTimer ??= setTimeout(() => this.flush(id), FLUSH_MS);
  }

  /** Routes around the failure next time and says so in the message. */
  onFailure(l: { info: SessionInfo }, message: string): string {
    const kind = classifyError(message);
    const { runtime, model } = l.info.ref;
    if (kind === 'limit' || kind === 'credits') {
      this.cooling.set(poolOf(l.info.ref), Date.now() + (kind === 'credits' ? CREDITS_COOLDOWN_MS : COOLDOWN_MS));
      return `${message} (Auto will skip ${RUNTIMES[runtime].label} for the next ${kind === 'credits' ? 'hour' : '15 minutes'}.)`;
    }
    if (kind === 'model') {
      this.d.catalog.block(runtime, model, message);
      return `${message} (${model} is unavailable on your account; Auto won't pick it again this week.)`;
    }
    return message;
  }

  // CLI agents run shell commands themselves; mirror them into the Terminal feed.
  private trackCommand(l: Live, e: Extract<AgentEvent, { t: 'tool' }>) {
    const runId = `${l.info.id}:${e.id}`;
    if (e.kind === 'execute' && !l.commands.has(runId)) {
      l.commands.add(runId);
      this.d.feed.start(l.info.id, l.label, l.root, e.title ?? 'command', runId);
    }
    if (l.commands.has(runId) && (e.status === 'completed' || e.status === 'failed')) {
      this.d.feed.finish(runId, e.status === 'failed' ? 1 : 0, e.output);
    }
  }

  private flush(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    clearTimeout(l.flushTimer);
    l.flushTimer = undefined;
    if (!l.queue.length) return;
    const events = l.queue;
    l.queue = [];
    this.d.send({ sessionId: id, events });
  }

  private touch(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    clearTimeout(l.idleTimer);
    l.idleTimer = setTimeout(() => !l.busy && this.stop(id), IDLE_MS);
    l.idleTimer.unref();
  }

  async prompt(id: string, text: string): Promise<void> {
    const l = this.live.get(id);
    if (!l) throw new Error('Session ended. Start a new one.');
    if (l.busy) throw new Error('Agent is still working');
    l.busy = true;
    const tried = new Set<string>();
    try {
      let input = text;
      for (let attempt = 0; ; attempt++) {
        let held: string | undefined;
        let reply = '';
        await l.session.prompt(input, (e) => {
          if (e.t === 'text') reply += e.text;
          if (e.t === 'error' && l.auto && attempt < MAX_SWITCHES && shouldSwitch(e.message)) {
            held = e.message;
            this.onFailure(l, e.message);
            return;
          }
          this.emit(id, e);
        });
        if (!held) {
          l.transcript.push({ role: 'user', text }, { role: 'agent', text: reply });
          break;
        }
        tried.add(`${l.info.ref.runtime}|${l.info.ref.model}`);
        const [next] = await this.candidates(l.info.role, { quality: l.opts.quality, complexity: l.opts.complexity, exclude: tried });
        if (!next) {
          this.emit(id, { t: 'error', message: `${held} (no other model is available right now)` });
          break;
        }
        l.session.dispose();
        const spawned = await this.spawn(id, l.info.role, next, l.root, l.opts);
        l.session = spawned.session;
        l.label = spawned.label;
        l.info = { ...l.info, ref: { runtime: next.runtime, model: next.model }, effort: next.effort };
        this.emit(id, { t: 'switch', ref: l.info.ref, reason: held.slice(0, 200) });
        input = recap(l.transcript, text);
      }
    } finally {
      l.busy = false;
      this.flush(id);
      this.touch(id);
    }
  }

  /** Sends one prompt and returns the whole reply (used by missions). */
  async ask(id: string, text: string): Promise<Reply> {
    const l = this.live.get(id);
    if (!l) throw new Error('Session ended');
    const r: Reply = { text: '', usage: { input: 0, output: 0, cached: 0 } };
    l.tap = (e) => {
      if (e.t === 'text') r.text += e.text;
      else if (e.t === 'error') r.error = e.message;
      else if (e.t === 'usage') {
        r.usage.input += e.input;
        r.usage.output += e.output;
        r.usage.cached += e.cacheRead ?? 0;
      }
    };
    try {
      await this.prompt(id, text);
    } finally {
      l.tap = undefined;
    }
    return r;
  }

  async cancel(id: string) {
    await this.live.get(id)?.session.cancel();
  }

  stop(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    clearTimeout(l.idleTimer);
    clearTimeout(l.flushTimer);
    l.session.dispose();
    this.d.gate.dropSession(id);
    this.live.delete(id);
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  sessions(): SessionInfo[] {
    return [...this.live.values()].map((l) => l.info);
  }
}
