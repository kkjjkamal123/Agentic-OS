import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { AgentBatch, ModelRef } from '@shared/agents';
import { Accounts } from '../../src/main/accounts';
import { Catalog } from '../../src/main/agents/catalog';
import { AgentManager } from '../../src/main/agents/manager';
import { loadPolicies } from '../../src/main/agents/policies';
import { openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';
import { Gate } from '../../src/main/tools/gate';
import { TerminalFeed } from '../../src/main/tools/terminal';
import { Workspaces } from '../../src/main/workspace/workspaces';

// Opt-in: spends a few tokens of real subscription quota. AOS_REAL_AGENTS=1 npx vitest run test/integration
describe.runIf(process.env.AOS_REAL_AGENTS)('real subscription agents', () => {
  const db = openDb(':memory:');
  const settings = new SettingsStore(db, defaultSettings(process.env.HOME!));
  const secrets = new SecretStore(db, insecureDevEncryptor);
  const scratchDir = mkdtempSync(join(tmpdir(), 'aos-real-'));
  const catalog = new Catalog({ db, accounts: new Accounts(), secrets, settings, scratchDir });
  const batches: AgentBatch[] = [];
  const gate = new Gate({ mode: () => 'auto-in-workspace', ask: () => {}, resolved: () => {} });
  const workspaces = new Workspaces(db, () => join(scratchDir, 'ws'));
  const m = new AgentManager({ catalog, secrets, settings, gate, workspaces, feed: new TerminalFeed(() => {}), scratchDir, policies: () => loadPolicies(), send: (b) => batches.push(b) });

  const cases: ModelRef[] = [
    { runtime: 'claude-code', model: 'haiku' },
    { runtime: 'codex', model: 'gpt-6-luna' },
    { runtime: 'omp', model: 'google-antigravity/gemini-3.5-flash-lite' },
    { runtime: 'antigravity', model: 'gemini-3.8-flash' },
  ];

  for (const ref of cases) {
    it(`${ref.runtime} / ${ref.model}`, async () => {
      const t0 = Date.now();
      const info = await m.start('summarize', { ref });
      const started = Date.now() - t0;
      await m.prompt(info.id, 'Reply with exactly: OK');
      m.stop(info.id);
      const events = batches.filter((b) => b.sessionId === info.id).flatMap((b) => b.events);
      const text = events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('');
      const usage = events.find((e) => e.t === 'usage');
      const err = events.find((e) => e.t === 'error');
      console.log(`${ref.runtime}: start ${started}ms, total ${Date.now() - t0}ms, reply ${JSON.stringify(text.trim())}, usage ${JSON.stringify(usage ?? null)}${err ? `, error ${JSON.stringify(err)}` : ''}, batches ${batches.filter((b) => b.sessionId === info.id).length}`);
      expect(err).toBeUndefined();
      expect(text).toMatch(/OK/);
    }, 120_000);
  }
});

describe.runIf(process.env.AOS_REAL_AGENTS)('agy in a mission worktree', () => {
  it('writes inside the worktree and nowhere else', async () => {
    const { Workspaces } = await import('../../src/main/workspace/workspaces');
    const { AgySession } = await import('../../src/main/agents/agy');
    const { agentEnv, which } = await import('../../src/main/env');
    const { existsSync, readFileSync } = await import('node:fs');
    const base = mkdtempSync(join(tmpdir(), 'aos-agy-wt-'));
    const ws = new Workspaces(openDb(':memory:'), () => base);
    const w = await ws.create('agy wt');
    const wt = await ws.addWorktree(w.id, 'task/agy');
    const s = new AgySession({ bin: (await which('agy'))!, root: wt, env: await agentEnv(), want: { model: 'gemini-3.8-flash', effort: 'low' }, variants: [], readOnly: false });
    let text = '';
    const outside = join(process.env.HOME!, `aos-agy-escape-${process.pid}.txt`);
    await s.prompt(`Create notes.txt containing the word ready. Also try to create ${outside}. Do not use git. Finish with DONE.`, (e) => {
      if (e.t === 'text') text += e.text;
      if (e.t === 'error') text += `ERROR ${e.message}`;
    });
    console.log('agy worktree reply:', text.slice(0, 200));
    expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toMatch(/ready/);
    expect(existsSync(outside)).toBe(false);
    expect(await ws.mergeWorktree(w.id, 'task/agy', 'agy task')).toEqual([]);
    expect(readFileSync(join(w.path, 'notes.txt'), 'utf8')).toMatch(/ready/);
  }, 180_000);
});
