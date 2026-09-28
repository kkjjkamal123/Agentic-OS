import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/agents';
import { codexArgs, codexModels, mapCodexLine } from '../../src/main/agents/codex';
import { errorText } from '../../src/main/agents/acp';

// Lines recorded from `codex exec --json` (codex-cli 0.155.1).
const LINES = [
  '{"type":"thread.started","thread_id":"01a0e29d-8425-73a2-b3f6-ee08bcb52276"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13898,"cached_input_tokens":5888,"output_tokens":5,"reasoning_output_tokens":2}}',
];

describe('codex exec driver', () => {
  it('maps the JSONL stream', () => {
    const events: AgentEvent[] = [];
    let thread = '';
    const results = LINES.map((l) => mapCodexLine(l, (e) => events.push(e), (t) => (thread = t)));
    expect(thread).toBe('01a0e29d-8425-73a2-b3f6-ee08bcb52276');
    expect(events).toEqual([
      { t: 'tool', id: 'item_1', title: 'ls', kind: 'execute', status: 'in_progress' },
      { t: 'tool', id: 'item_1', title: 'ls', kind: 'execute', status: 'completed' },
      { t: 'text', text: 'OK' },
      { t: 'usage', input: 13898, output: 7, cacheRead: 5888 },
      { t: 'done', stop: 'end_turn' },
    ]);
    expect(results.at(-1)).toBe('done');
  });

  it('maps policy to the Codex sandbox, injects instructions, and resumes threads', () => {
    expect(codexArgs({ model: 'gpt-6-luna', effort: 'low' }, null)).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '-']);
    const a = codexArgs({ model: 'm', effort: 'max' }, 'T', 'workspace-write', 'Be "terse"\nnow');
    expect(a).toContain('workspace-write');
    expect(a).toContain('model_reasoning_effort="xhigh"');
    expect(a).toContain('developer_instructions="Be \\"terse\\"\\nnow"');
    expect(a.slice(-3)).toEqual(['resume', 'T', '-']);
  });

  it('lists only plan-visible models in priority order', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cx-')), 'models_cache.json');
    writeFileSync(p, JSON.stringify({ models: [
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 7 },
      { slug: 'gpt-reserve', visibility: 'hide', priority: 3 },
      { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 3 },
    ] }));
    expect(codexModels(p).map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra']);
    expect(codexModels('/nope')).toEqual([]);
  });

  it('errorText digs the provider message out of JSON-RPC errors', () => {
    const e = { message: 'Internal error', data: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported."}}' } };
    expect(errorText(e)).toBe("The 'x' model is not supported.");
    expect(errorText({ message: 'Internal error', data: { details: 'Unknown config option: effort' } })).toBe('Unknown config option: effort');
  });
});
