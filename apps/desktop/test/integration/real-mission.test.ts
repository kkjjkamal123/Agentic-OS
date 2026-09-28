import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { Mission } from '@shared/missions';
import { Accounts } from '../../src/main/accounts';
import { Catalog } from '../../src/main/agents/catalog';
import { AgentManager } from '../../src/main/agents/manager';
import { loadPolicies } from '../../src/main/agents/policies';
import { Launcher } from '../../src/main/missions/launcher';
import { Missions } from '../../src/main/missions/orchestrator';
import { openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';
import { Gate } from '../../src/main/tools/gate';
import { TerminalFeed } from '../../src/main/tools/terminal';
import { Workspaces } from '../../src/main/workspace/workspaces';

// Opt-in: runs a real multi-model mission on your subscriptions. AOS_REAL_AGENTS=1 npx vitest run test/integration/real-mission.test.ts
async function setup() {
    const base = mkdtempSync(join(tmpdir(), 'aos-real-mission-'));
    const db = openDb(join(base, 'db.sqlite'));
    const settings = new SettingsStore(db, defaultSettings(process.env.HOME!));
    settings.update({ workspaceRoot: join(base, 'ws'), maxParallelAgents: 2 });
    const secrets = new SecretStore(db, insecureDevEncryptor);
    const catalog = new Catalog({ db, accounts: new Accounts(), secrets, settings, scratchDir: base });
    const gate: Gate = new Gate({ mode: () => 'auto-in-workspace', ask: (r) => (console.log('[ASK-DENIED]', r.agent, r.action.kind, r.action.command ?? r.action.paths?.join(','), '|', r.reason), setTimeout(() => gate.answer(r.id, 'deny'), 0)), resolved: () => {} });
    const workspaces = new Workspaces(db, () => settings.get().workspaceRoot);
    const feed = new TerminalFeed(() => {});
    const agents = new AgentManager({ catalog, secrets, settings, workspaces, gate, feed, scratchDir: base, policies: () => loadPolicies(), send: () => {} });
    const shown: string[] = [];
    const launcher = new Launcher({ feed, show: (url) => (shown.push(url), { close: () => {} }), openApp: async () => {}, send: (s) => console.log('[test]', s.state, s.url ?? s.message ?? '') });
    const missions = new Missions({ db, agents, workspaces, gate, feed, settings, launcher, send: () => {}, event: (e) => console.log(`[${e.kind}] ${e.text}`), workspacesChanged: () => {} });
    return { missions, workspaces, launcher, shown };
}

async function run(goal: string) {
    const { missions, workspaces, launcher, shown } = await setup();
    const m0 = await missions.start({ goal });
    const m = await new Promise<Mission>((resolve) => {
      const t = setInterval(() => {
        const x = missions.get(m0.id);
        if (['done', 'failed', 'cancelled'].includes(x.status)) {
          clearInterval(t);
          resolve(x);
        }
      }, 1000);
    });
    const ws = workspaces.get(m.workspaceId);
    console.log(JSON.stringify({
      status: m.status, error: m.error, planner: m.planner,
      tasks: m.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, coder: t.coder, reviewer: t.reviewer, rounds: t.rounds, note: t.note })),
      product: m.product, stack: m.stack, run: m.run, stats: m.stats,
      checks: m.checks.map((c) => [c.name, c.command, c.exitCode]), fixRounds: m.fixRounds, usage: m.usage, files: readdirSync(ws.path),
    }, null, 1));
    console.log('REPORT:\n' + m.report);
    return { m, ws, launcher, shown };
}

describe.runIf(process.env.AOS_REAL_AGENTS)('real mission', () => {
  it('ships a tiny Python CLI with tests using several models', async () => {
    const { m } = await run('A tiny Python CLI greet.py: `python3 greet.py Ada` prints "Hello, Ada!". Include a unittest file. Standard library only. At most 2 tasks.');
    expect(m.status).toBe('done');
  }, 30 * 60_000);

  it('turns a game idea into a graphical app the Test button opens', async () => {
    const { m, ws, launcher, shown } = await run('Hangman game');
    expect(m.status).toBe('done');
    expect(m.run?.kind).toBe('web');
    expect(m.checks.find((c) => c.name === 'launch')?.exitCode).toBe(0);
    await launcher.test(m, ws.path);
    expect(shown).toHaveLength(1);
    launcher.stopAll();
  }, 30 * 60_000);
});
