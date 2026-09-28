import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { Effort, ModelInfo, Routed } from '@shared/agents';
import { profile } from '../tools/sandbox';
import type { Emit } from './acp';

// Google's Antigravity CLI in headless mode. Print mode can't stop to ask for permission, so it
// runs with permissions skipped inside a Seatbelt sandbox: writes are confined to the workspace
// (or nowhere, for read-only roles) plus agy's own state under ~/.gemini.

const AGY_STATE = [join(homedir(), '.gemini')];
const EFFORT_SUFFIX = /-(high|medium|low|thinking)$/;
const TURN_TIMEOUT_MS = 30 * 60_000;

export interface AgyModel extends ModelInfo {
  variants: string[];
}

/** `agy models` prints "id<TAB>Name"; effort is baked into ids, so group variants under a base id. */
export function parseAgyModels(out: string): AgyModel[] {
  const byBase = new Map<string, AgyModel>();
  for (const line of out.split('\n')) {
    const [id, name] = line.split('\t').map((s) => s?.trim());
    if (!id || !name || /\s/.test(id)) continue;
    const base = id.replace(EFFORT_SUFFIX, '');
    const m = byBase.get(base) ?? { id: base, name: name.replace(/\s*\((High|Medium|Low|Thinking)\)$/, ''), variants: [] };
    m.variants.push(id);
    byBase.set(base, m);
  }
  return [...byBase.values()];
}

const ORDER: Record<Effort, string[]> = {
  max: ['high', 'thinking', 'medium', 'low'],
  high: ['high', 'thinking', 'medium', 'low'],
  medium: ['medium', 'high', 'thinking', 'low'],
  low: ['low', 'medium', 'high', 'thinking'],
};

export function agyVariant(base: string, variants: string[], effort: Effort): string {
  for (const s of ORDER[effort]) if (variants.includes(`${base}-${s}`)) return `${base}-${s}`;
  return variants.includes(base) || !variants.length ? base : variants[0];
}

type Step = {
  step_type?: string;
  state?: string;
  step_index?: number;
  text_delta?: string;
  tool_name?: string;
  tool_info?: { parameters?: Record<string, unknown> };
  error?: string;
};
type Line = {
  event?: string;
  conversation_id?: string;
  step_update?: Step;
  result?: { status?: string; response?: string; error?: string; usage?: Record<string, number> };
};

function toolKind(name: string): string {
  if (/command|terminal|shell/.test(name)) return 'execute';
  if (/write|replace|edit|create|delete|move/.test(name)) return 'edit';
  if (/browser|web|fetch|search_web|url/.test(name)) return 'fetch';
  return 'read';
}

export function mapAgyLine(line: string, root: string, emit: Emit, onConversation: (id: string) => void): 'done' | void {
  let ev: Line;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.event === 'init' && ev.conversation_id) onConversation(ev.conversation_id);
  const s = ev.step_update;
  if (ev.event === 'step_update' && s) {
    if (s.step_type === 'agent_response' && s.text_delta) emit({ t: 'text', text: s.text_delta });
    else if (s.step_type === 'tool' && s.tool_name) {
      const p = s.tool_info?.parameters ?? {};
      const cmd = (p.CommandLine ?? p.Command ?? p.command) as string | undefined;
      const path = Object.values(p).find((v) => typeof v === 'string' && v.startsWith('/')) as string | undefined;
      const title = cmd ?? (path ? `${s.tool_name.replace(/_/g, ' ')} ${relative(root, path) || path}` : s.tool_name.replace(/_/g, ' '));
      const status = s.state === 'DONE' ? (s.error ? 'failed' : 'completed') : 'in_progress';
      emit({ t: 'tool', id: `agy-${s.step_index}`, title, kind: toolKind(s.tool_name), status, output: s.error });
    }
  }
  if (ev.event === 'result' && ev.result) {
    const r = ev.result;
    const u = r.usage ?? {};
    emit({ t: 'usage', input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), cacheRead: u.cache_read_tokens || undefined });
    emit(r.status === 'SUCCESS' ? { t: 'done', stop: 'end_turn' } : { t: 'error', message: r.error ?? r.response ?? `Antigravity ${r.status ?? 'failed'}` });
    return 'done';
  }
}

export class AgySession {
  private conversation: string | null = null;
  private child: ChildProcess | null = null;
  private first = true;
  private opts: { bin: string; root: string; env: NodeJS.ProcessEnv; model: string; effort?: string; readOnly: boolean; system?: string };

  constructor(opts: { bin: string; root: string; env: NodeJS.ProcessEnv; want: Pick<Routed, 'model' | 'effort'>; variants: string[]; readOnly: boolean; system?: string }) {
    const known = opts.variants.some((v) => v !== opts.want.model);
    // Known variants: use the exact id. Unknown: agy accepts the base id plus --effort.
    this.opts = known
      ? { ...opts, model: agyVariant(opts.want.model, opts.variants, opts.want.effort) }
      : { ...opts, model: opts.want.model, effort: opts.want.effort === 'max' ? 'high' : opts.want.effort };
  }

  args(text: string): string[] {
    // No system-prompt flag in print mode: policies ride on the first turn only (stable prefix).
    const prompt = this.first && this.opts.system ? `${this.opts.system}\n\n---\n\n${text}` : text;
    return [
      '-p', prompt, '--output-format', 'stream-json', '--model', this.opts.model, ...(this.opts.effort ? ['--effort', this.opts.effort] : []),
      '--disable-slash-commands', '--dangerously-skip-permissions',
      ...(this.opts.readOnly ? ['--mode', 'plan'] : []),
      ...(this.conversation ? ['--conversation', this.conversation] : []),
    ];
  }

  prompt(text: string, emit: Emit): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let stderr = '';
      const writable = this.opts.readOnly ? AGY_STATE : [this.opts.root, ...AGY_STATE];
      // agy keeps its Google sign-in in the Keychain; other secret folders stay unreadable.
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile(writable[0], writable.slice(1), { keychain: true }), this.opts.bin, ...this.args(text)], {
        cwd: this.opts.root,
        env: this.opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.first = false;
      this.child = child;
      const timer = setTimeout(() => child.kill('SIGTERM'), TURN_TIMEOUT_MS);
      child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      createInterface({ input: child.stdout! }).on('line', (line) => {
        if (mapAgyLine(line, this.opts.root, emit, (id) => (this.conversation = id)) === 'done') finished = true;
      });
      child.on('error', (e) => {
        emit({ t: 'error', message: e.message });
        finished = true;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        if (!finished) emit(signal ? { t: 'done', stop: 'cancelled' } : { t: 'error', message: stderr.trim().split('\n').pop() || `agy exited (${code})` });
        resolve();
      });
    });
  }

  cancel() {
    this.child?.kill('SIGINT');
  }

  dispose() {
    this.cancel();
  }
}
