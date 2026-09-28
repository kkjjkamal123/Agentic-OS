import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { sessionKey } from './render/notes.ts';
import type { Summary } from './state.ts';
import type { SessionData } from './types.ts';

export type SummaryMode = 'auto' | 'all' | 'none';

/** Changes whenever the session gains prompts/edits/a new final reply. */
export const fingerprint = (s: SessionData) => `${s.prompts.length}:${s.touched.length}:${s.lastReply.length}`;

const isTrivial = (s: SessionData) => s.touched.length === 0 && s.prompts.join(' ').length < 40;

export function pickForSummary(
  sessions: SessionData[],
  summaries: Record<string, Summary>,
  cfg: Config,
  mode: SummaryMode,
  finalLogs: Set<string>,
  now = Date.now(),
): SessionData[] {
  if (mode === 'none' || !cfg.summarize.enabled) return [];
  const due = sessions.filter((s) => {
    if (summaries[sessionKey(s)]?.key === fingerprint(s)) return false;
    if (mode === 'all' || finalLogs.has(s.logPath)) return true;
    return now - new Date(s.ended).getTime() >= cfg.summarize.idleMs;
  });
  // Newest first so the sessions you care about get summaries before the backlog.
  due.sort((a, b) => (a.ended < b.ended ? 1 : -1));
  return mode === 'all' ? due : due.slice(0, cfg.summarize.maxPerRun);
}

export function buildPrompt(s: SessionData): string {
  let budget = 9000;
  const take = (t: string, n: number) => {
    const x = t.length > n ? t.slice(0, n) + ' …' : t;
    budget -= x.length;
    return x;
  };
  const prompts: string[] = [];
  for (const [i, p] of s.prompts.entries()) {
    if (budget < 1500) {
      prompts.push(`(${s.prompts.length - i} more prompts omitted)`);
      break;
    }
    prompts.push(`${i + 1}. ${take(p, 900)}`);
  }
  return [
    `Summarize this ${s.kind} coding-agent session for the user's personal knowledge base.`,
    'Write 2-4 plain sentences: what the user wanted and what actually got done (or where it stopped).',
    'Then, if useful, up to 4 short bullet points of concrete outcomes (files, decisions, open issues).',
    'No headings, no preamble, no sign-off. Markdown bullets only. Refer to the user as "you".',
    '',
    `Title: ${s.title}`,
    `Working directory: ${s.cwd}`,
    `Models: ${s.models.join(', ') || 'unknown'}`,
    '',
    'User prompts:',
    ...prompts,
    '',
    `Files written/edited (${s.touched.length}): ${s.touched.slice(0, 40).join(', ') || 'none'}`,
    '',
    'Final assistant reply:',
    take(s.lastReply || '(none)', 2500),
  ].join('\n');
}

function runClaude(cfg: Config, prompt: string): Promise<string> {
  const cwd = join(cfg.home, 'tmp');
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      cfg.summarize.command,
      [
        '-p', '--model', cfg.summarize.model, '--no-session-persistence', '--setting-sources', 'project',
        '--tools', '', '--disable-slash-commands', '--strict-mcp-config',
      ],
      // BRAIN_SYNC_CHILD stops our own hooks from re-triggering inside this child run.
      { cwd, env: { ...process.env, BRAIN_SYNC_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), cfg.summarize.timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Summarizes sessions (3 at a time), recording results in `summaries`. Returns count written. */
export async function summarize(
  due: SessionData[],
  summaries: Record<string, Summary>,
  cfg: Config,
  log: (m: string) => void,
): Promise<number> {
  let done = 0;
  const queue = [...due];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const key = fingerprint(s);
      if (isTrivial(s)) {
        summaries[sessionKey(s)] = { key, text: 'Short exchange with no file changes.', at: new Date().toISOString() };
        done++;
        continue;
      }
      try {
        const text = await runClaude(cfg, buildPrompt(s));
        summaries[sessionKey(s)] = { key, text, at: new Date().toISOString() };
        done++;
        log(`summarized ${s.kind} "${s.title}"`);
      } catch (e) {
        log(`summary failed for ${s.logPath}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return done;
}
