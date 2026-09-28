import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/agents';
import { AgySession, agyVariant, mapAgyLine, parseAgyModels } from '../../src/main/agents/agy';

// Output recorded from agy 1.2.12 on this Mac.
const MODELS = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;

const STREAM = [
  '{"event":"init","conversation_id":"758f0215","init":{"model":"gemini-3.8-flash-low","cwd":"/w"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/hello.txt"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/hello.txt"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  '{"event":"result","result":{"conversation_id":"758f0215","status":"SUCCESS","response":"OK\\n","usage":{"input_tokens":25137,"output_tokens":261,"thinking_tokens":150,"cache_read_tokens":0}}}',
];

describe('agy driver', () => {
  it('groups effort variants under base models', () => {
    const models = parseAgyModels(MODELS);
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'], ['gemini-3.1-pro', 'Gemini 3.1 Pro'], ['claude-opus-4-6', 'Claude Opus 4.6'], ['gpt-oss-120b', 'GPT-OSS 120B'],
    ]);
    expect(models[0].variants).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']);
  });

  it('picks the variant closest to the requested effort', () => {
    const v = ['gemini-3.1-pro-high', 'gemini-3.1-pro-low'];
    expect(agyVariant('gemini-3.1-pro', v, 'high')).toBe('gemini-3.1-pro-high');
    expect(agyVariant('gemini-3.1-pro', v, 'medium')).toBe('gemini-3.1-pro-high');
    expect(agyVariant('gemini-3.1-pro', v, 'low')).toBe('gemini-3.1-pro-low');
    expect(agyVariant('claude-opus-4-6', ['claude-opus-4-6-thinking'], 'max')).toBe('claude-opus-4-6-thinking');
  });

  it('maps the stream-json events', () => {
    const events: AgentEvent[] = [];
    let conv = '';
    const results = STREAM.map((l) => mapAgyLine(l, '/w', (e) => events.push(e), (id) => (conv = id)));
    expect(conv).toBe('758f0215');
    expect(events).toEqual([
      { t: 'tool', id: 'agy-2', title: 'write to file hello.txt', kind: 'edit', status: 'in_progress', output: undefined },
      { t: 'tool', id: 'agy-2', title: 'write to file hello.txt', kind: 'edit', status: 'completed', output: undefined },
      { t: 'text', text: 'OK' },
      { t: 'usage', input: 25137, output: 411, cacheRead: undefined },
      { t: 'done', stop: 'end_turn' },
    ]);
    expect(results.at(-1)).toBe('done');
  });

  it('builds args: policy only on turn one, plan mode when read-only, resume by conversation', () => {
    const s = new AgySession({ bin: 'agy', root: '/w', env: {}, want: { model: 'gemini-3.1-pro', effort: 'high' }, variants: ['gemini-3.1-pro-high'], readOnly: true, system: 'POLICY' });
    const a1 = s.args('hello');
    expect(a1.slice(0, 2)).toEqual(['-p', 'POLICY\n\n---\n\nhello']);
    expect(a1).toEqual(expect.arrayContaining(['--model', 'gemini-3.1-pro-high', '--mode', 'plan', '--dangerously-skip-permissions']));
    (s as unknown as { first: boolean; conversation: string }).first = false;
    (s as unknown as { conversation: string }).conversation = 'abc';
    const a2 = s.args('again');
    expect(a2[1]).toBe('again');
    expect(a2.slice(-2)).toEqual(['--conversation', 'abc']);
  });
});
