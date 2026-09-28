import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type RequestPermissionRequest, type RequestPermissionResponse, type SessionConfigOption, type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, ModelInfo, Routed } from '@shared/agents';
import type { ActionKind, GateAction } from '@shared/workspace';

export interface AcpCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type Emit = (e: AgentEvent) => void;

const EFFORT_ORDER = ['off', 'minimal', 'low', 'default', 'auto', 'medium', 'high', 'xhigh', 'max'];

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

function flatValues(o: SessionConfigOption): { value: string; name: string }[] {
  if (o.type !== 'select') return [];
  return (o as SelectOption).options.flatMap((x) => ('options' in x ? x.options : [x])).map((x) => ({ value: String(x.value), name: x.name }));
}

export function modelsFrom(options: SessionConfigOption[] | null | undefined): ModelInfo[] {
  const o = options?.find((c) => c.category === 'model');
  return o ? flatValues(o).map((v) => ({ id: v.value, name: v.name })) : [];
}

function closestEffort(values: string[], want: Routed['effort']): string | undefined {
  if (values.includes(want)) return want;
  const target = EFFORT_ORDER.indexOf(want);
  return [...values].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - target) - Math.abs(EFFORT_ORDER.indexOf(b) - target))[0];
}

const KIND: Record<string, ActionKind | 'free'> = {
  read: 'read', search: 'read', edit: 'write', move: 'write', delete: 'delete', execute: 'execute', fetch: 'fetch', think: 'free', switch_mode: 'free',
};

export function toGateAction(req: RequestPermissionRequest): GateAction | null {
  const tc = req.toolCall;
  const kind = KIND[tc.kind ?? ''] ?? 'other';
  if (kind === 'free') return null;
  const raw = tc.rawInput as { command?: string | string[]; cmd?: string | string[] } | undefined;
  const c = raw?.command ?? raw?.cmd;
  return {
    kind,
    title: tc.title ?? undefined,
    paths: tc.locations?.map((l) => l.path),
    command: Array.isArray(c) ? c.join(' ') : c,
  };
}

export type Decide = (a: GateAction) => Promise<boolean>;

export async function answerPermission(req: RequestPermissionRequest, decide: Decide): Promise<RequestPermissionResponse> {
  const action = toGateAction(req);
  const ok = action ? await decide(action) : true;
  const pick = req.options.find((o) => o.kind === (ok ? 'allow_once' : 'reject_once')) ?? req.options.find((o) => o.kind === (ok ? 'allow_always' : 'reject_always'));
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

// JSON-RPC "Internal error" hides the useful part in `data` (often a nested provider error).
export function errorText(e: unknown): string {
  const err = e as { message?: string; data?: { details?: string; message?: string } };
  let msg = err.data?.details ?? err.data?.message ?? err.message ?? String(e);
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(msg);
      msg = j?.error?.message ?? j?.message ?? msg;
      if (typeof msg !== 'string') break;
    } catch {
      break;
    }
  }
  return String(msg).replace(/^unexpected status \d+ [\w ]+: /, '');
}

export class AcpSession {
  private child: ChildProcess;
  private conn: ClientSideConnection;
  private emit: Emit = () => {};
  private stderr = '';
  private sessionId = '';
  models: ModelInfo[] = [];
  exited = false;

  private decide: Decide;

  private constructor(cmd: AcpCommand, cwd: string, decide: Decide) {
    this.decide = decide;
    this.child = spawn(cmd.file, cmd.args, { cwd, env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    this.child.on('exit', (code) => {
      this.exited = true;
      if (code) this.emit({ t: 'error', message: `agent exited (${code}) ${this.stderr.trim().split('\n').pop() ?? ''}`.trim() });
    });
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>);
    this.conn = new ClientSideConnection(
      () => ({
        requestPermission: (req) => answerPermission(req, this.decide),
        sessionUpdate: async (n) => this.onUpdate(n),
      }),
      stream,
    );
  }

  static async start(
    cmd: AcpCommand,
    cwd: string,
    want?: Pick<Routed, 'model' | 'effort'>,
    opts: { system?: string; decide?: Decide; timeoutMs?: number } = {},
  ): Promise<AcpSession> {
    const s = new AcpSession(cmd, cwd, opts.decide ?? (async (a) => a.kind === 'read'));
    const timeoutMs = opts.timeoutMs ?? 45_000;
    const failed = new Promise<never>((_, reject) => {
      s.child.once('error', reject);
      s.child.once('exit', (code) => reject(new Error(`agent exited during startup (${code}): ${s.stderr.trim().slice(-300)}`)));
      setTimeout(() => reject(new Error('agent did not start in time')), timeoutMs).unref();
    });
    try {
      await Promise.race([s.init(cwd, want, opts.system), failed]);
    } catch (e) {
      s.dispose();
      throw e;
    }
    return s;
  }

  private async init(cwd: string, want?: Pick<Routed, 'model' | 'effort'>, system?: string) {
    await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agentic-os', version: '0.1.0' },
    });
    // Claude Code's bridge reads `_meta.systemPrompt`; others ignore unknown meta.
    const res = await this.conn.newSession({ cwd, mcpServers: [], _meta: system ? { systemPrompt: { append: system } } : undefined });
    this.sessionId = res.sessionId;
    this.models = modelsFrom(res.configOptions);
    if (!want) return;
    // Model first: switching model can add or remove other options (Haiku has no effort level).
    let options = res.configOptions ?? [];
    for (const category of ['model', 'thought_level'] as const) {
      const o = options.find((c) => c.category === category);
      if (!o) continue;
      const values = flatValues(o).map((v) => v.value);
      const value = category === 'model' ? (values.includes(want.model) ? want.model : undefined) : closestEffort(values, want.effort);
      if (value && value !== String((o as SelectOption).currentValue)) {
        options = (await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: o.id, value })).configOptions ?? options;
      }
    }
  }

  private onUpdate({ update: u }: SessionNotification) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') this.emit({ t: 'text', text: u.content.text });
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') this.emit({ t: 'thought', text: u.content.text });
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const output = u.content
          ?.map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : ''))
          .join('')
          .trim();
        this.emit({ t: 'tool', id: u.toolCallId, title: u.title ?? undefined, kind: u.kind ?? undefined, status: u.status ?? undefined, output: output || undefined });
        break;
      }
    }
  }

  async prompt(text: string, emit: Emit): Promise<void> {
    this.emit = emit;
    try {
      const res = await this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
      if (res.usage) {
        emit({ t: 'usage', input: res.usage.inputTokens, output: res.usage.outputTokens, cacheRead: res.usage.cachedReadTokens ?? undefined });
      }
      emit({ t: 'done', stop: res.stopReason });
    } catch (e) {
      emit({ t: 'error', message: this.exited ? `agent stopped: ${this.stderr.trim().split('\n').pop() ?? ''}` : errorText(e) });
    } finally {
      this.emit = () => {};
    }
  }

  async cancel() {
    if (this.sessionId && !this.exited) await this.conn.cancel({ sessionId: this.sessionId });
  }

  dispose() {
    if (!this.exited) this.child.kill();
  }
}
