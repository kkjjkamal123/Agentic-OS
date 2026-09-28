import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { AgentBatch, AgentEvent } from '@shared/agents';
import { Accounts } from '../../src/main/accounts';
import { AcpSession, answerPermission, toGateAction, type AcpCommand } from '../../src/main/agents/acp';
import { Catalog } from '../../src/main/agents/catalog';
import { AgentManager, coalesce } from '../../src/main/agents/manager';
import { NativeSession } from '../../src/main/agents/native';
import { openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';
import { Gate } from '../../src/main/tools/gate';
import { TerminalFeed } from '../../src/main/tools/terminal';
import { Workspaces } from '../../src/main/workspace/workspaces';

const FAKE = join(import.meta.dirname, '../fixtures/fake-acp-agent.mjs');
const fakeCmd: AcpCommand = { file: process.execPath, args: [FAKE], env: process.env };
const tmp = () => mkdtempSync(join(tmpdir(), 'aos-agents-'));

const collect = () => {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
};

describe('AcpSession (real ACP over stdio against a fake agent)', () => {
  it('applies the routed model + effort and maps the event stream', async () => {
    const s = await AcpSession.start(fakeCmd, tmp(), { model: 'fake-smart', effort: 'high' });
    expect(s.models.map((m) => m.id)).toEqual(['fake-fast', 'fake-smart']);
    const { events, emit } = collect();
    await s.prompt('hello there', emit);
    s.dispose();
    expect(events[0]).toEqual({ t: 'thought', text: 'thinking' });
    expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toBe('[fake-smart/high] Echo: hello there ');
    expect(events.at(-2)).toEqual({ t: 'usage', input: 10, output: 4, cacheRead: 4 });
    expect(events.at(-1)).toEqual({ t: 'done', stop: 'end_turn' });
  });

  it('asks the gate before an edit and reports the outcome', async () => {
    const asked: string[] = [];
    const s = await AcpSession.start(fakeCmd, tmp(), undefined, { decide: async (a) => (asked.push(a.kind), false) });
    const { events, emit } = collect();
    await s.prompt('please edit a file', emit);
    s.dispose();
    expect(asked).toEqual(['write']);
    expect(events.filter((e) => e.t === 'tool').at(-1)).toMatchObject({ id: 't1', status: 'failed' });
  });

  it('reports a clear error when the agent binary is missing', async () => {
    await expect(AcpSession.start({ file: '/nope/agent', args: [], env: process.env }, tmp())).rejects.toThrow();
  });

  it('maps ACP permission requests onto gate actions', async () => {
    const opts = [{ optionId: 'a', name: 'Allow', kind: 'allow_once' as const }, { optionId: 'r', name: 'Reject', kind: 'reject_once' as const }];
    const req = (toolCall: object) => ({ sessionId: 's', toolCall: { toolCallId: 't', ...toolCall } as never, options: opts });
    expect(toGateAction(req({ kind: 'execute', title: 'npm test', rawInput: { command: ['npm', 'test'] } }))).toMatchObject({ kind: 'execute', command: 'npm test' });
    expect(toGateAction(req({ kind: 'edit', locations: [{ path: '/w/a.ts' }] }))).toMatchObject({ kind: 'write', paths: ['/w/a.ts'] });
    expect(toGateAction(req({ kind: 'think' }))).toBeNull();
    expect(await answerPermission(req({ kind: 'edit' }), async () => true)).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } });
    expect(await answerPermission(req({ kind: 'edit' }), async () => false)).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } });
  });
});

describe('NativeSession', () => {
  it('streams text, keeps history, and sends the cached system prompt first', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'Hi ' },
            { type: 'text-delta', id: '1', delta: 'there' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 12, noCache: 2, cacheRead: 10, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } },
          ],
        }),
      }),
    });
    const s = new NativeSession(model, 'openai', 'SYSTEM', 'low');
    const { events, emit } = collect();
    await s.prompt('hello', emit);
    await s.prompt('again', collect().emit);
    expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hi there');
    expect(events.find((e) => e.t === 'usage')).toMatchObject({ input: 12, output: 2, cacheRead: 10 });
    const second = model.doStreamCalls[1].prompt;
    expect(second[0]).toMatchObject({ role: 'system', content: 'SYSTEM', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } });
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

function managerDeps(scratchDir: string, send: (b: AgentBatch) => void, policies = { caveman: 'CAVE', ponytail: 'PONY' }) {
  const db = openDb(':memory:');
  const settings = new SettingsStore(db, defaultSettings('/h'));
  const secrets = new SecretStore(db, insecureDevEncryptor, {});
  const catalog = new Catalog({ db, accounts: new Accounts(), secrets, settings, scratchDir, fakeAgent: FAKE });
  const gate = new Gate({ mode: () => 'auto-in-workspace', ask: () => {}, resolved: () => {} });
  const workspaces = new Workspaces(db, () => join(scratchDir, 'ws'));
  return { catalog, secrets, settings, gate, workspaces, feed: new TerminalFeed(() => {}), scratchDir, policies: () => policies, send };
}

describe('AgentManager', () => {
  it('routes, streams in few batches, and runs in the chosen workspace', async () => {
    const batches: AgentBatch[] = [];
    const scratchDir = tmp();
    const deps = managerDeps(scratchDir, (b) => batches.push(b));
    const m = new AgentManager(deps);
    const cats = await deps.catalog.list();
    expect(cats.filter((c) => c.available).map((c) => c.runtime)).toEqual(['omp']);

    const ws = await deps.workspaces.create('Demo App');
    const info = await m.start('code', { workspaceId: ws.id });
    expect(info).toMatchObject({ ref: { runtime: 'omp' }, workspaceId: ws.id });
    await m.prompt(info.id, 'one two three four five six seven');
    m.stopAll();
    const events = batches.flatMap((b) => b.events);
    expect(events.filter((e) => e.t === 'text').length).toBeLessThanOrEqual(2);
    expect(events.at(-1)).toEqual({ t: 'done', stop: 'end_turn' });
  });

  it('max quality raises effort', async () => {
    const deps = managerDeps(tmp(), () => {});
    const m = new AgentManager(deps);
    expect((await m.start('plan', { quality: 'max' })).effort).toBe('max');
    expect((await m.start('plan', { quality: 'balanced' })).effort).toBe('high');
    m.stopAll();
  });

  it('cancel stops a long reply', async () => {
    const send = vi.fn();
    const m = new AgentManager(managerDeps(tmp(), send, { caveman: '', ponytail: '' }));
    const info = await m.start('chat');
    const run = m.prompt(info.id, 'slow reply please with many words to stream');
    setTimeout(() => void m.cancel(info.id), 300);
    await run;
    m.stopAll();
    const events: AgentEvent[] = send.mock.calls.flatMap(([b]) => b.events);
    expect(events.at(-1)).toEqual({ t: 'done', stop: 'cancelled' });
  });

  it('coalesce merges only same-kind neighbours', () => {
    const q: AgentEvent[] = [];
    for (const e of [{ t: 'text', text: 'a' }, { t: 'text', text: 'b' }, { t: 'thought', text: 'x' }, { t: 'text', text: 'c' }] as AgentEvent[]) coalesce(q, e);
    expect(q).toEqual([{ t: 'text', text: 'ab' }, { t: 'thought', text: 'x' }, { t: 'text', text: 'c' }]);
  });
});

describe('Anthropic thinking parameters', () => {
  it('uses adaptive thinking + effort on current models and budgets only on Haiku 4.5', async () => {
    const { anthropicThinking } = await import('../../src/main/agents/native');
    expect(anthropicThinking('claude-opus-5-5', 'high')).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } });
    expect(anthropicThinking('claude-fable-5-1', 'max')).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } });
    expect(anthropicThinking('claude-sonnet-5', 'low')).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } });
    expect(anthropicThinking('claude-haiku-4-5', 'medium')).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } });
    expect(anthropicThinking('claude-haiku-4-5', 'low')).toBeUndefined();
  });
});

describe('automatic model switching', () => {
  it('an Auto chat hands over to the next best model on a usage limit, with a recap', async () => {
    const log = join(tmp(), 'prompts.jsonl');
    process.env.FAKE_PROMPT_LOG = log;
    const batches: AgentBatch[] = [];
    const m = new AgentManager(managerDeps(tmp(), (b) => batches.push(b)));
    const info = await m.start('chat');
    expect(info.ref.model).toBe('fake-fast');
    await m.prompt(info.id, 'first question');
    await m.prompt(info.id, 'LIMITME second question');
    m.stopAll();
    delete process.env.FAKE_PROMPT_LOG;
    const events = batches.flatMap((b) => b.events);
    const sw = events.find((e) => e.t === 'switch');
    expect(sw).toMatchObject({ ref: { runtime: 'omp', model: 'fake-smart' }, reason: expect.stringMatching(/usage limit/) });
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(events.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text).join('')).toContain('[fake-smart/');
    const prompts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const handover = prompts.find((p) => p.model === 'fake-smart');
    expect(handover.text).toMatch(/taking over this conversation[\s\S]*first question[\s\S]*LIMITME second question/);
  });

  it('a chat pinned to a model reports the limit instead of switching', async () => {
    const batches: AgentBatch[] = [];
    const m = new AgentManager(managerDeps(tmp(), (b) => batches.push(b)));
    const info = await m.start('chat', { ref: { runtime: 'omp', model: 'fake-fast' } });
    await m.prompt(info.id, 'LIMITME please');
    m.stopAll();
    const events = batches.flatMap((b) => b.events);
    expect(events.some((e) => e.t === 'switch')).toBe(false);
    expect(events.find((e) => e.t === 'error')).toMatchObject({ message: expect.stringMatching(/usage limit/) });
  });
});
