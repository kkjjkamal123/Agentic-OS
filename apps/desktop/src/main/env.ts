import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

let pathOnce: Promise<string> | null = null;

// Dock-launched apps get a bare PATH; ask a login shell once instead of per command.
export function loginPath(): Promise<string> {
  pathOnce ??= new Promise((resolve) => {
    const fallback = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':');
    execFile('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { timeout: 8_000 }, (err, out) => resolve(!err && out ? out : fallback));
  });
  return pathOnce;
}

// BRAIN_SYNC_CHILD makes the user's brain-sync Claude hooks exit at once inside agent sessions:
// missions edit many files, and the background watcher already picks the workspace up.
export async function agentEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await loginPath(), BRAIN_SYNC_CHILD: '1', ...extra };
}

const found = new Map<string, Promise<string | null>>();

async function lookup(bin: string): Promise<string | null> {
  for (const dir of (await loginPath()).split(':')) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Cached PATH lookup; `forget` after installs so a newly installed CLI is found. */
export function which(bin: string): Promise<string | null> {
  if (!found.has(bin)) found.set(bin, lookup(bin));
  return found.get(bin)!;
}

export const forgetWhich = () => found.clear();

export interface ExecResult {
  ok: boolean;
  out: string;
}

export async function run(file: string, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  const env = await agentEnv();
  return new Promise((resolve) =>
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() }),
    ),
  );
}
