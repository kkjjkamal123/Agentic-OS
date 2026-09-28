import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DirEntry, Workspace } from '@shared/workspace';
import type { Db } from '../store/db';

const HIDDEN = new Set(['.git', 'node_modules', '.worktrees', '.DS_Store', 'dist', 'build', '.next', '.venv', '__pycache__', 'DerivedData', '.build']);
const MAX_READ = 1_000_000;

const GITIGNORE = 'node_modules/\ndist/\nbuild/\n.worktrees/\n.DS_Store\n.env\n*.log\n';

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) =>
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) =>
      err ? rej(new Error(errOut.trim() || err.message)) : res(out),
    ),
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';

export class Workspaces {
  private db: Db;
  private root: () => string;

  constructor(db: Db, root: () => string) {
    this.db = db;
    this.root = root;
  }

  list(): Workspace[] {
    return (this.db.prepare('SELECT id, name, path, created_at AS createdAt FROM workspaces ORDER BY created_at DESC').all() as unknown as Workspace[])
      .filter((w) => existsSync(w.path));
  }

  get(id: string): Workspace {
    const w = this.db.prepare('SELECT id, name, path, created_at AS createdAt FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
    if (!w || !existsSync(w.path)) throw new Error('Workspace not found');
    return w;
  }

  async create(name: string): Promise<Workspace> {
    const base = slug(name);
    let path = join(this.root(), base);
    for (let i = 2; existsSync(path); i++) path = join(this.root(), `${base}-${i}`);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.gitignore'), GITIGNORE);
    await git(path, ['init', '-q', '-b', 'main']);
    await git(path, ['add', '-A']);
    await git(path, ['-c', 'user.name=Agentic OS', '-c', 'user.email=agents@agentic-os.local', 'commit', '-q', '-m', 'Start workspace']);
    const w: Workspace = { id: randomUUID(), name: name.trim(), path, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(w.id, w.name, w.path, w.createdAt);
    return w;
  }

  private resolveIn(w: Workspace, rel: string): string {
    const abs = resolve(w.path, rel);
    if (abs !== w.path && !abs.startsWith(w.path + sep)) throw new Error('Path escapes the workspace');
    return abs;
  }

  tree(id: string, rel = ''): DirEntry[] {
    const w = this.get(id);
    const dir = this.resolveIn(w, rel);
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !HIDDEN.has(e.name))
      .map((e) => {
        const abs = join(dir, e.name);
        return { name: e.name, rel: relative(w.path, abs), dir: e.isDirectory(), size: e.isFile() ? statSync(abs).size : 0 };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  read(id: string, rel: string): { text: string | null; size: number } {
    const abs = this.resolveIn(this.get(id), rel);
    const size = statSync(abs).size;
    if (size > MAX_READ) return { text: null, size };
    const buf = readFileSync(abs);
    return { text: buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8'), size };
  }

  async diff(id: string): Promise<string> {
    const w = this.get(id);
    await git(w.path, ['add', '-A', '--intent-to-add']);
    return git(w.path, ['diff', '--no-color', '--stat', '--patch', 'HEAD']);
  }

  async addWorktree(id: string, branch: string): Promise<string> {
    const w = this.get(id);
    const path = join(w.path, '.worktrees', slug(branch));
    await git(w.path, ['worktree', 'add', '-q', '-b', branch, path, 'main']);
    return path;
  }

  async removeWorktree(id: string, branch: string) {
    const w = this.get(id);
    await git(w.path, ['worktree', 'remove', '--force', join(w.path, '.worktrees', slug(branch))]).catch(() => {});
    await git(w.path, ['branch', '-q', '-D', branch]).catch(() => {});
  }

  async files(path: string, max = 150): Promise<string[]> {
    const out = await git(path, ['ls-files', '--cached', '--others', '--exclude-standard']);
    return out.split('\n').filter(Boolean).slice(0, max);
  }

  /** Everything changed in `path` since `base`, including new untracked files. */
  async diffSince(path: string, base: string): Promise<string> {
    await git(path, ['add', '-A', '--intent-to-add']);
    return git(path, ['diff', '--no-color', base]);
  }

  async changedFiles(path: string, base: string): Promise<string[]> {
    await git(path, ['add', '-A', '--intent-to-add']);
    return (await git(path, ['diff', '--name-only', base])).split('\n').filter(Boolean);
  }

  async stats(path: string): Promise<{ files: number; lines: number; testFiles: number }> {
    const files = (await git(path, ['ls-files'])).split('\n').filter(Boolean);
    let lines = 0;
    for (const f of files.slice(0, 5000)) {
      try {
        const abs = join(path, f);
        if (statSync(abs).size > MAX_READ) continue;
        const buf = readFileSync(abs);
        if (!buf.subarray(0, 8000).includes(0)) lines += buf.toString('utf8').split('\n').length;
      } catch {}
    }
    return { files: files.length, lines, testFiles: files.filter((f) => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|^test_/i.test(f)).length };
  }

  async head(path: string): Promise<string> {
    return (await git(path, ['rev-parse', 'main'])).trim();
  }

  /** Makes main look exactly like `commit` again, recorded as a new commit so nothing is lost. */
  async restore(path: string, commit: string, message: string) {
    await git(path, ['read-tree', '-u', '--reset', commit]);
    await this.commitAll(path, message);
  }

  /** Worktrees a killed or cancelled mission left behind (their branches carry the mission's short id). */
  async pruneMissionWorktrees(id: string, short: string) {
    const w = this.get(id);
    await git(w.path, ['worktree', 'prune']).catch(() => {});
    const out = await git(w.path, ['worktree', 'list', '--porcelain']).catch(() => '');
    for (const m of out.matchAll(/^branch refs\/heads\/(task\/\S+)$/gm)) if (m[1].includes(`-${short}-`)) await this.removeWorktree(id, m[1]);
  }

  async commitAll(path: string, message: string): Promise<boolean> {
    await git(path, ['add', '-A']);
    if (!(await git(path, ['status', '--porcelain'])).trim()) return false;
    await git(path, ['-c', 'user.name=Agentic OS', '-c', 'user.email=agents@agentic-os.local', 'commit', '-q', '-m', message]);
    return true;
  }

  /** Commits the worktree, merges it into main and removes it. Returns conflicting files, if any. */
  async mergeWorktree(id: string, branch: string, message: string): Promise<string[]> {
    const w = this.get(id);
    const path = join(w.path, '.worktrees', slug(branch));
    const who = ['-c', 'user.name=Agentic OS', '-c', 'user.email=agents@agentic-os.local'];
    await git(path, ['add', '-A']);
    if ((await git(path, ['status', '--porcelain'])).trim()) await git(path, [...who, 'commit', '-q', '-m', message]);
    try {
      await git(w.path, [...who, 'merge', '--no-ff', '-q', '-m', `Merge ${branch}`, branch]);
    } catch {
      const conflicts = (await git(w.path, ['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean);
      await git(w.path, ['merge', '--abort']);
      return conflicts;
    }
    await git(w.path, ['worktree', 'remove', '--force', path]);
    await git(w.path, ['branch', '-q', '-d', branch]);
    return [];
  }
}
