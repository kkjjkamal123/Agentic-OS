import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelInfo, Routed } from '@shared/agents';
import type { Emit } from './acp';

// Codex's ACP bridge lags the CLI (plan models fail with "requires a newer version of Codex"),
// so drive the user's own up-to-date CLI through its official headless mode instead.

export const CODEX_MODELS_CACHE = join(homedir(), '.codex/models_cache.json');

export function codexModels(path = CODEX_MODELS_CACHE): ModelInfo[] {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { models: { slug: string; display_name?: string; visibility?: string; priority?: number }[] };
    return d.models
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  } catch {
    return [];
  }
}

const EFFORT: Record<Routed['effort'], string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

export type CodexSandbox = 'read-only' | 'workspace-write';

// Codex can't ask for approval mid-`exec`, so the policy maps onto its own OS sandbox instead.
export function codexArgs(want: Pick<Routed, 'model' | 'effort'>, thread: string | null, sandbox: CodexSandbox = 'read-only', system?: string): string[] {
  const common = ['--json', '--skip-git-repo-check', '-s', sandbox, '-m', want.model, '-c', `model_reasoning_effort="${EFFORT[want.effort]}"`];
  if (system) common.push('-c', `developer_instructions=${JSON.stringify(system)}`);
  return thread ? ['exec', ...common, 'resume', thread, '-'] : ['exec', ...common, '-'];
}

type CodexItem = { id: string; type: string; text?: string; command?: string; status?: string; aggregated_output?: string; exit_code?: number; changes?: { path: string }[] };

export function mapCodexLine(line: string, emit: Emit, onThread: (id: string) => void): 'done' | void {
  let ev: { type: string; thread_id?: string; item?: CodexItem; usage?: Record<string, number>; error?: { message?: string }; message?: string };
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  const it = ev.item;
  switch (ev.type) {
    case 'thread.started':
      if (ev.thread_id) onThread(ev.thread_id);
      break;
    case 'item.started':
    case 'item.completed':
      if (!it) break;
      if (it.type === 'agent_message' && ev.type === 'item.completed') emit({ t: 'text', text: it.text ?? '' });
      else if (it.type === 'reasoning' && ev.type === 'item.completed') emit({ t: 'thought', text: it.text ?? '' });
      else if (it.type === 'command_execution') {
        const done = ev.type === 'item.completed';
        emit({ t: 'tool', id: it.id, title: it.command, kind: 'execute', status: done ? (it.exit_code ? 'failed' : (it.status ?? 'completed')) : 'in_progress', output: done ? it.aggregated_output : undefined });
      }
      else if (it.type === 'file_change') emit({ t: 'tool', id: it.id, title: it.changes?.map((c) => c.path).join(', ') ?? 'file change', kind: 'edit', status: it.status });
      else if (it.type === 'web_search') emit({ t: 'tool', id: it.id, title: 'web search', kind: 'fetch', status: ev.type === 'item.completed' ? 'completed' : 'in_progress' });
      break;
    case 'turn.completed': {
      const u = ev.usage ?? {};
      emit({ t: 'usage', input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cacheRead: u.cached_input_tokens });
      emit({ t: 'done', stop: 'end_turn' });
      return 'done';
    }
    case 'turn.failed':
    case 'error':
      emit({ t: 'error', message: ev.error?.message ?? ev.message ?? 'Codex failed' });
      return 'done';
  }
}

export class CodexSession {
  private thread: string | null = null;
  private child: ChildProcess | null = null;
  private bin: string;
  private cwd: string;
  private env: NodeJS.ProcessEnv;
  private want: Pick<Routed, 'model' | 'effort'>;
  private sandbox: CodexSandbox;
  private system?: string;

  constructor(bin: string, cwd: string, env: NodeJS.ProcessEnv, want: Pick<Routed, 'model' | 'effort'>, sandbox: CodexSandbox, system?: string) {
    this.bin = bin;
    this.cwd = cwd;
    this.env = env;
    this.want = want;
    this.sandbox = sandbox;
    this.system = system;
  }

  // One short-lived process per turn: nothing idles in the background between messages.
  prompt(text: string, emit: Emit): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let stderr = '';
      const child = spawn(this.bin, codexArgs(this.want, this.thread, this.sandbox, this.system), { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      createInterface({ input: child.stdout! }).on('line', (line) => {
        if (mapCodexLine(line, emit, (id) => (this.thread = id)) === 'done') finished = true;
      });
      child.on('error', (e) => {
        emit({ t: 'error', message: e.message });
        finished = true;
      });
      child.on('close', (code, signal) => {
        this.child = null;
        if (!finished) {
          emit(signal ? { t: 'done', stop: 'cancelled' } : { t: 'error', message: stderr.trim().split('\n').pop() || `codex exited (${code})` });
        }
        resolve();
      });
      child.stdin!.end(text);
    });
  }

  cancel() {
    this.child?.kill('SIGINT');
  }

  dispose() {
    this.cancel();
  }
}
