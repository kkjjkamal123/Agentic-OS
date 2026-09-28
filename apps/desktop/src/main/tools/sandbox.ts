import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

// Package managers need their caches; everything else outside the workspace stays read-only.
const WRITABLE_CACHES = ['.npm', '.cache', 'Library/Caches', '.pnpm-store', '.yarn', '.bun', '.cargo', '.rustup', '.gradle', 'go/pkg', '.local/share/pnpm', '.deno', '.m2', 'Library/Developer/Xcode/DerivedData'];
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', 'Library/Keychains', '.config/gh', '.kube', '.docker'];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const q = (p: string) => JSON.stringify(real(p));

export function profile(root: string, extraWritable: string[] = [], opts: { keychain?: boolean } = {}): string {
  const secrets = SECRET_DIRS.filter((d) => !(opts.keychain && d === 'Library/Keychains'));
  const writable = [root, ...extraWritable, tmpdir(), '/private/tmp', '/private/var/folders', ...WRITABLE_CACHES.map((c) => join(HOME, c))];
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-not (require-any ${writable.map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (subpath "/dev/fd"))))`,
    `(deny file-read* ${secrets.map((d) => `(subpath ${q(join(HOME, d))})`).join(' ')})`,
  ].join('\n');
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 200_000;

/** Runs a shell command confined by macOS Seatbelt: writes only inside `root` (plus caches/tmp), no secret reads. */
export function runSandboxed(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; signal?: AbortSignal; onData?: (chunk: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile(root), '/bin/zsh', '-c', command], {
      cwd: root,
      env: { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const take = (d: Buffer) => {
      const s = d.toString();
      if (output.length < MAX_OUTPUT) output += s.slice(0, MAX_OUTPUT - output.length);
      opts.onData?.(s);
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 10 * 60_000);
    const abort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      resolve({ exitCode: code, output, timedOut });
    });
    child.on('error', (e) => resolve({ exitCode: null, output: e.message, timedOut }));
  });
}
