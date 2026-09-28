import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { GateAction } from '@shared/workspace';
import { runSandboxed } from './sandbox';
import type { TerminalFeed } from './terminal';

export interface ToolCtx {
  root: string;
  sessionId: string;
  agent: string;
  env: NodeJS.ProcessEnv;
  check: (a: GateAction) => Promise<boolean>;
  feed: TerminalFeed;
  signal?: AbortSignal;
}

const DENIED = 'Denied by the user or the approval policy. Do not retry; choose another approach or ask the user.';
const MAX_READ = 200_000;
const SKIP = new Set(['.git', 'node_modules', '.worktrees', 'dist', 'build', '.next', '.venv', '__pycache__']);

const clip = (s: string, n = 30_000) => (s.length > n ? `${s.slice(0, n / 2)}\n…[${s.length - n} chars cut]…\n${s.slice(-n / 2)}` : s);

export function fsTools(ctx: ToolCtx) {
  const abs = (p: string) => resolve(ctx.root, p);
  const gated = async <T>(a: GateAction, run: () => Promise<T> | T): Promise<T | string> => ((await ctx.check(a)) ? run() : DENIED);

  return {
    read_file: tool({
      description: 'Read a UTF-8 text file. Paths are relative to the workspace root.',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) =>
        gated({ kind: 'read', paths: [abs(path)], title: `Read ${path}` }, () => {
          const p = abs(path);
          if (statSync(p).size > MAX_READ) return `File is larger than ${MAX_READ} bytes; read a smaller file or search it.`;
          return readFileSync(p, 'utf8');
        }),
    }),
    list_dir: tool({
      description: 'List a directory (recursive up to depth 3, skips .git and node_modules).',
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: ({ path }) =>
        gated({ kind: 'read', paths: [abs(path)], title: `List ${path}` }, () => {
          const out: string[] = [];
          const walk = (d: string, depth: number) => {
            for (const e of readdirSync(d, { withFileTypes: true })) {
              if (SKIP.has(e.name) || out.length > 500) continue;
              const p = resolve(d, e.name);
              out.push(relative(ctx.root, p) + (e.isDirectory() ? '/' : ''));
              if (e.isDirectory() && depth < 3) walk(p, depth + 1);
            }
          };
          walk(abs(path), 1);
          return out.join('\n') || '(empty)';
        }),
    }),
    write_file: tool({
      description: 'Create or overwrite a file with the given content.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) =>
        gated({ kind: 'write', paths: [abs(path)], title: `Write ${path}` }, () => {
          mkdirSync(dirname(abs(path)), { recursive: true });
          writeFileSync(abs(path), content);
          return `Wrote ${path} (${content.length} chars)`;
        }),
    }),
    edit_file: tool({
      description: 'Replace one exact occurrence of old_text with new_text in a file.',
      inputSchema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
      execute: ({ path, old_text, new_text }) =>
        gated({ kind: 'write', paths: [abs(path)], title: `Edit ${path}` }, () => {
          const text = readFileSync(abs(path), 'utf8');
          const n = text.split(old_text).length - 1;
          if (n !== 1) return `old_text found ${n} times; it must match exactly once. Include more surrounding lines.`;
          writeFileSync(abs(path), text.replace(old_text, () => new_text));
          return `Edited ${path}`;
        }),
    }),
    run_command: tool({
      description: 'Run a shell command in the workspace (zsh). Writes outside the workspace are blocked by the OS sandbox.',
      inputSchema: z.object({ command: z.string(), timeout_seconds: z.number().int().min(1).max(1800).default(300) }),
      execute: async ({ command, timeout_seconds }) => {
        if (!(await ctx.check({ kind: 'execute', command, title: command }))) return DENIED;
        const id = ctx.feed.start(ctx.sessionId, ctx.agent, ctx.root, command);
        const r = await runSandboxed(command, ctx.root, ctx.env, {
          timeoutMs: timeout_seconds * 1000,
          signal: ctx.signal,
          onData: (c) => ctx.feed.append(id, c),
        });
        ctx.feed.finish(id, r.exitCode);
        return `exit ${r.exitCode ?? 'killed'}${r.timedOut ? ' (timed out)' : ''}\n${clip(r.output)}`;
      },
    }),
  };
}
