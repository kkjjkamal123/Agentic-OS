import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/main/store/db';
import { runSandboxed } from '../../src/main/tools/sandbox';
import { TerminalFeed } from '../../src/main/tools/terminal';
import { fsTools } from '../../src/main/tools/fs-tools';
import { git, Workspaces } from '../../src/main/workspace/workspaces';

const tmp = () => mkdtempSync(join(tmpdir(), 'aos-ws-'));

describe('Workspaces', () => {
  it('creates a git repo, lists, reads, diffs, and refuses path escapes', async () => {
    const ws = new Workspaces(openDb(':memory:'), () => tmp());
    const w = await ws.create('My Todo App!');
    expect(w.path).toMatch(/my-todo-app$/);
    expect((await git(w.path, ['log', '--oneline'])).trim()).toMatch(/Start workspace/);
    writeFileSync(join(w.path, 'index.html'), '<h1>hi</h1>\n');
    expect(ws.tree(w.id).map((e) => e.name)).toEqual(['.gitignore', 'index.html']);
    expect(ws.read(w.id, 'index.html').text).toBe('<h1>hi</h1>\n');
    expect(await ws.diff(w.id)).toContain('+<h1>hi</h1>');
    expect(() => ws.read(w.id, '../../etc/passwd')).toThrow(/escapes/);
    expect(ws.list().map((x) => x.id)).toEqual([w.id]);
  });

  it('runs tasks in worktrees and merges them back, reporting conflicts', async () => {
    const ws = new Workspaces(openDb(':memory:'), () => tmp());
    const w = await ws.create('parallel');
    const a = await ws.addWorktree(w.id, 'task/a');
    const b = await ws.addWorktree(w.id, 'task/b');
    writeFileSync(join(a, 'a.txt'), 'A\n');
    writeFileSync(join(b, 'shared.txt'), 'from b\n');
    expect(await ws.mergeWorktree(w.id, 'task/a', 'Task A')).toEqual([]);
    expect(await ws.mergeWorktree(w.id, 'task/b', 'Task B')).toEqual([]);
    expect(readFileSync(join(w.path, 'a.txt'), 'utf8')).toBe('A\n');
    expect(existsSync(a)).toBe(false);

    const c = await ws.addWorktree(w.id, 'task/c');
    const d = await ws.addWorktree(w.id, 'task/d');
    writeFileSync(join(c, 'shared.txt'), 'from c\n');
    writeFileSync(join(d, 'shared.txt'), 'from d\n');
    expect(await ws.mergeWorktree(w.id, 'task/c', 'C')).toEqual([]);
    expect(await ws.mergeWorktree(w.id, 'task/d', 'D')).toEqual(['shared.txt']);
    expect(readFileSync(join(w.path, 'shared.txt'), 'utf8')).toBe('from c\n');
  });
});

describe('sandbox + tools', () => {
  it('lets commands write inside the workspace only, and hides secrets', async () => {
    const root = tmp();
    const outside = join(homedir(), `aos-sandbox-probe-${process.pid}.txt`);
    const r = await runSandboxed(`echo ok > inside.txt && cat inside.txt; echo x > ${JSON.stringify(outside)} || echo BLOCKED; ls ~/.ssh >/dev/null 2>&1 || echo NOSSH`, root, process.env);
    expect(r.output).toContain('ok');
    expect(r.output).toContain('BLOCKED');
    expect(existsSync(outside)).toBe(false);
    if (existsSync(join(homedir(), '.ssh'))) expect(r.output).toContain('NOSSH');
  });

  it('tools go through the gate and stream commands to the terminal feed', async () => {
    const root = tmp();
    const feed = new TerminalFeed(() => {});
    const asked: string[] = [];
    const tools = fsTools({ root, sessionId: 's', agent: 'Test', env: process.env, feed, check: async (a) => (asked.push(a.kind), a.kind !== 'delete') });
    const call = (t: { execute?: (...a: never[]) => unknown }, input: object) => (t.execute as (i: object, o: object) => Promise<string>)(input, { toolCallId: 'x', messages: [] });
    expect(await call(tools.write_file, { path: 'src/a.txt', content: 'hello world' })).toMatch(/Wrote/);
    expect(await call(tools.edit_file, { path: 'src/a.txt', old_text: 'world', new_text: 'OS' })).toMatch(/Edited/);
    expect(await call(tools.read_file, { path: 'src/a.txt' })).toBe('hello OS');
    expect(await call(tools.run_command, { command: 'cat src/a.txt', timeout_seconds: 30 })).toContain('exit 0\nhello OS');
    expect(feed.history()[0]).toMatchObject({ command: 'cat src/a.txt', exitCode: 0, output: 'hello OS' });
    expect(asked).toEqual(['write', 'write', 'read', 'execute']);
  });
});
