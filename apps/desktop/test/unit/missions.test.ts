import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { Mission, MissionEvent } from '@shared/missions';
import { Accounts } from '../../src/main/accounts';
import { Catalog } from '../../src/main/agents/catalog';
import { AgentManager } from '../../src/main/agents/manager';
import { Launcher } from '../../src/main/missions/launcher';
import { extractJson, Missions } from '../../src/main/missions/orchestrator';
import type { Net } from '../../src/main/net';
import { openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';
import { Gate } from '../../src/main/tools/gate';
import { TerminalFeed } from '../../src/main/tools/terminal';
import { git, Workspaces } from '../../src/main/workspace/workspaces';

const FAKE = join(import.meta.dirname, '../fixtures/fake-acp-agent.mjs');

function setup(opts: { net?: Net } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'aos-mission-'));
  const db = openDb(':memory:');
  const settings = new SettingsStore(db, defaultSettings('/h'));
  settings.update({ workspaceRoot: join(base, 'ws') });
  const secrets = new SecretStore(db, insecureDevEncryptor, {});
  const catalog = new Catalog({ db, accounts: new Accounts(), secrets, settings, scratchDir: base, fakeAgent: FAKE });
  const gate = new Gate({ mode: () => 'auto-in-workspace', ask: () => {}, resolved: () => {} });
  const workspaces = new Workspaces(db, () => settings.get().workspaceRoot);
  const feed = new TerminalFeed(() => {});
  const agents = new AgentManager({ catalog, secrets, settings, workspaces, gate, feed, scratchDir: base, policies: () => ({ caveman: '', ponytail: '' }), send: () => {} });
  const updates: Mission[] = [];
  const events: MissionEvent[] = [];
  const launcher = new Launcher({ feed, show: () => ({ close: () => {} }), openApp: async () => {}, send: () => {} });
  const missions = new Missions({ db, agents, workspaces, gate, feed, settings, launcher, net: opts.net, send: (m) => updates.push(m), event: (e) => events.push(e), workspacesChanged: () => {} });
  const finished = (id: string) =>
    new Promise<Mission>((resolve) => {
      const t = setInterval(() => {
        const m = missions.get(id);
        if (['done', 'failed', 'cancelled'].includes(m.status)) {
          clearInterval(t);
          resolve(m);
        }
      }, 50);
    });
  return { missions, workspaces, updates, events, feed, finished, settings };
}

describe('extractJson', () => {
  it('finds fenced or bare JSON in chatty replies', () => {
    expect(extractJson('Sure.\n```json\n{"a":1}\n```\nDone')).toEqual({ a: 1 });
    expect(extractJson('result: {"approve": true, "issues": []} ok')).toEqual({ approve: true, issues: [] });
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('Missions (full pipeline against the fake ACP agent)', () => {
  it('plans, builds tasks in worktrees respecting deps, reviews, merges, verifies and ships', async () => {
    const { missions, workspaces, events, feed, finished } = setup();
    const m0 = await missions.start({ goal: 'Make two text files' });
    const m = await finished(m0.id);
    expect(m.status).toBe('done');
    expect(m.tasks.map((t) => [t.id, t.status])).toEqual([['t1', 'done'], ['t2', 'done']]);
    expect(m.tasks[0].reviewer).toBeDefined();
    expect(m.checks.map((c) => [c.name, c.exitCode])).toEqual([['build', 0], ['test', 0], ['launch', 0]]);
    expect(m).toMatchObject({ product: 'A tiny page that shows two files.', stack: 'HTML', run: { kind: 'web', open: 'index.html' } });
    expect(m.stats).toMatchObject({ files: expect.any(Number), lines: expect.any(Number) });
    expect(m.finishedAt).toBeTruthy();
    expect(m.report).toContain('Shipped');
    expect(m.usage.input).toBeGreaterThan(0);

    const ws = workspaces.get(m.workspaceId);
    expect(readFileSync(join(ws.path, 't2.txt'), 'utf8')).toBe('t2 by fake\n');
    expect(existsSync(join(ws.path, '.worktrees', 't1'))).toBe(false);
    const log = await git(ws.path, ['log', '--oneline']);
    expect(log).toMatch(/t1: Write t1/);
    expect(log).toMatch(/t2: Write t2/);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['plan', 'task', 'review', 'merge', 'check', 'ship']));
    expect(feed.history().map((r) => r.command)).toEqual(['test -f t1.txt', 'test -f t1.txt && test -f t2.txt']);
  }, 60_000);

  it('failing checks trigger bounded fix rounds, then an honest failure with a report', async () => {
    const { missions, finished } = setup();
    const m = await finished((await missions.start({ goal: 'Do the impossible' })).id);
    expect(m.status).toBe('failed');
    expect(m.fixRounds).toBe(3);
    expect(m.error).toMatch(/Checks still fail/);
    expect(m.report).toBeTruthy();
  }, 60_000);

  it('cancel stops the mission and marks unfinished tasks', async () => {
    const { missions, updates, finished } = setup();
    const m0 = await missions.start({ goal: 'Make two text files' });
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (updates.some((u) => u.id === m0.id && u.status === 'building')) {
          clearInterval(t);
          r();
        }
      }, 10);
    });
    missions.cancel(m0.id);
    const m = await finished(m0.id);
    expect(m.status).toBe('cancelled');
    expect(m.tasks.some((t) => t.status === 'cancelled')).toBe(true);
  }, 60_000);

  it('marks missions interrupted by an app quit', async () => {
    const { missions } = setup();
    const m0 = await missions.start({ goal: 'Make two text files' });
    missions.recoverInterrupted();
    expect(missions.get(m0.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) });
    missions.cancel(m0.id);
  });
});

describe('mission guards', () => {
  it('names workspaces cleanly from messy goals', async () => {
    const { nameFromGoal } = await import('../../src/main/missions/orchestrator');
    expect(nameFromGoal('A tiny Python CLI greet.py: `python3 greet.py Ada` prints')).toBe('A tiny Python CLI greet.py');
    expect(nameFromGoal('???')).toBe('Mission');
  });

  it('stops a mission that exceeds the token budget', async () => {
    const { missions, settings, finished } = setup();
    settings.update({ missionTokenBudget: 1 });
    const m = await finished((await missions.start({ goal: 'Make two text files' })).id);
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/token budget/);
  }, 60_000);
});

describe('dispatcher and team communication', () => {
  it('a cheap dispatcher assigns models, and agents get team briefs and hand-offs when assigned', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'aos-log-')), 'prompts.jsonl');
    process.env.FAKE_PROMPT_LOG = log;
    const { missions, events, finished } = setup();
    // Two options per role so the dispatcher has a real choice to make.
    const agents = (missions as unknown as { d: { agents: AgentManager } }).d.agents;
    const two = async (role: string) => [
      { runtime: 'omp' as const, model: 'fake-fast', effort: 'medium' as const },
      { runtime: 'omp' as const, model: 'fake-smart', effort: 'medium' as const },
    ].filter(() => role !== 'nope');
    const original = agents.candidates.bind(agents);
    agents.candidates = (async (role: never, opts: { exclude?: Set<string> } = {}) =>
      role === 'summarize' ? original(role, opts) : (await two(role)).filter((r) => !opts.exclude?.has(`${r.runtime}|${r.model}`))) as never;

    const m = await finished((await missions.start({ goal: 'Make two text files' })).id);
    delete process.env.FAKE_PROMPT_LOG;
    expect(m.status).toBe('done');
    expect(m.dispatcher).toBeDefined();
    for (const t of m.tasks) {
      expect(t.plannedCoder).toEqual({ runtime: 'omp', model: 'fake-smart' });
      expect(t.coder).toEqual({ runtime: 'omp', model: 'fake-smart' });
      expect(t.handoff).toMatch(/^DONE: wrote t\d\.txt · files: (index\.html, )?t\d\.txt$/);
    }
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['dispatch', 'handoff']));

    const prompts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text as string);
    const t2 = prompts.find((p) => p.includes('Your task (t2)'))!;
    expect(t2).toMatch(/Team \(parallel[\s\S]*t1 Write t1 \[done\] omp\/fake-smart/);
    expect(t2).toMatch(/Hand-offs from tasks you build on:\n- t1 \(omp\/fake-smart\): DONE: wrote t1\.txt · files: index\.html, t1\.txt/);
    const review = prompts.find((p) => p.includes('Review the change for task "Write t2"'))!;
    expect(review).toMatch(/Coder's note: DONE: wrote t2\.txt/);
    expect(prompts.find((p) => p.includes('Write the ship report'))).toMatch(/Write t1: done · DONE: wrote t1\.txt/);
  }, 60_000);
});

const until = async (fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Missions: pause, resume, follow-ups and undo', () => {
  it('pauses when the internet drops, then resumes the same task on the same model', async () => {
    let up = false;
    let reconnect = () => {};
    const net: Net = { online: async () => up, waitOnline: (signal) => new Promise((r) => { reconnect = r; signal.addEventListener('abort', () => r()); }) };
    const { missions, updates, events, finished } = setup({ net });
    const m0 = await missions.start({ goal: 'Make two files DROPNET' });
    await until(() => updates.some((m) => m.id === m0.id && m.status === 'paused' && m.pause?.reason === 'offline'));
    up = true;
    reconnect();
    const m = await finished(m0.id);
    expect(m.status).toBe('done');
    expect(m.pause).toBeUndefined();
    expect(events.some((e) => e.text.startsWith('Connection lost'))).toBe(true);
    expect(events.some((e) => e.kind === 'switch')).toBe(false);
  }, 60_000);

  it('Pause waits for the current step, Resume continues', async () => {
    const { missions, updates, finished } = setup();
    const m0 = await missions.start({ goal: 'Make two files SLOWTASK' });
    await until(() => missions.get(m0.id).tasks.some((t) => t.status === 'coding'));
    missions.pause(m0.id);
    expect(missions.get(m0.id).pause?.reason).toBe('user');
    await until(() => missions.get(m0.id).status === 'paused');
    const frozen = JSON.stringify(missions.get(m0.id).tasks.map((t) => t.status));
    await new Promise((r) => setTimeout(r, 600));
    expect(JSON.stringify(missions.get(m0.id).tasks.map((t) => t.status))).toBe(frozen);
    await missions.resume(m0.id);
    const m = await finished(m0.id);
    expect(m.status).toBe('done');
    expect(updates.some((x) => x.status === 'paused')).toBe(true);
  }, 60_000);

  it('Resume continues a cancelled mission from its finished tasks', async () => {
    const { missions, events, finished } = setup();
    const m0 = await missions.start({ goal: 'Make two files SLOWTASK' });
    await until(() => missions.get(m0.id).tasks[0]?.status === 'done');
    missions.cancel(m0.id);
    expect((await finished(m0.id)).status).toBe('cancelled');
    await missions.resume(m0.id);
    const m = await finished(m0.id);
    expect(m.status).toBe('done');
    expect(m.resumes).toBe(1);
    expect(events.some((e) => e.text === 'Resumed: 1/2 tasks already done.')).toBe(true);
  }, 60_000);

  it('a change request builds on the product, and Undo restores the previous version', async () => {
    const { missions, workspaces, finished } = setup();
    const parent = await finished((await missions.start({ goal: 'Make two text files' })).id);
    const ws = workspaces.get(parent.workspaceId);
    const child = await finished((await missions.start({ goal: 'Also add t3', workspaceId: parent.workspaceId, parentId: parent.id })).id);
    expect(child.status).toBe('done');
    expect(child.run).toEqual(parent.run);
    expect(child.tasks[0].files).toEqual(['t3.txt']);
    expect(existsSync(join(ws.path, 't3.txt'))).toBe(true);

    await expect(missions.undo(parent.id)).rejects.toThrow(/Newer changes/);
    await missions.undo(child.id);
    expect(existsSync(join(ws.path, 't3.txt'))).toBe(false);
    expect(existsSync(join(ws.path, 't1.txt'))).toBe(true);
    expect(missions.get(child.id).undone).toBe(true);
    expect(await git(ws.path, ['log', '-1', '--format=%s'])).toMatch(/^Undo: Also add t3/);
  }, 60_000);
});
