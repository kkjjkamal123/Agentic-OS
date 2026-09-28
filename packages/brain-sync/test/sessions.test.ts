import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaude } from '../src/sessions/claude.ts';
import { parseCodex } from '../src/sessions/codex.ts';
import { cleanPrompt } from '../src/sessions/common.ts';
import { parseOmp } from '../src/sessions/omp.ts';
import { jsonl, put, tmp } from './helpers.ts';

// Shapes mirror real logs from Claude Code 2.1, Codex CLI 0.155 and omp 18.3.

test('claude: prompts, title, model, touched files, cost across resumed runs', () => {
  const dir = tmp();
  const log = put(dir, 'p/abc.jsonl', jsonl([
    { type: 'mode', mode: 'normal', sessionId: 'abc' },
    { type: 'user', cwd: '/w/proj', timestamp: '2026-09-25T10:00:00Z', message: { role: 'user', content: 'build the thing' } },
    { type: 'user', isMeta: true, cwd: '/w/proj', message: { role: 'user', content: 'meta noise' } },
    { type: 'user', cwd: '/w/proj', message: { role: 'user', content: '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>' } },
    { type: 'user', cwd: '/w/proj', message: { role: 'user', content: '<command-name>/review</command-name><command-args>src/a.ts</command-args>' } },
    { type: 'assistant', cwd: '/w/proj', timestamp: '2026-09-25T10:05:00Z', message: { model: 'claude-opus-5-5', content: [
      { type: 'tool_use', name: 'Write', input: { file_path: '/w/proj/a.ts', content: 'x' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'Done.' },
    ] } },
    { type: 'user', cwd: '/w/proj', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/proj/side.ts' } }] } },
    { type: 'file-history-delta', trackingPath: 'b.ts' },
    { type: 'ai-title', aiTitle: 'Build the thing' },
    { type: 'cost-state', startTime: 1, totalCostUSD: 1.5 },
    { type: 'cost-state', startTime: 1, totalCostUSD: 2 },
    { type: 'cost-state', startTime: 2, totalCostUSD: 0.25 },
  ]));
  const s = parseClaude(log)!;
  assert.equal(s.id, 'abc');
  assert.equal(s.title, 'Build the thing');
  assert.equal(s.cwd, '/w/proj');
  assert.deepEqual(s.prompts, ['build the thing', '/review src/a.ts']);
  assert.deepEqual(s.models, ['claude-opus-5-5']);
  assert.deepEqual(s.touched, ['/w/proj/a.ts', '/w/proj/b.ts']);
  assert.equal(s.lastReply, 'Done.');
  assert.equal(s.costUsd, 2.25);
});

test('claude: session with no real prompts is skipped', () => {
  const log = put(tmp(), 'x.jsonl', jsonl([{ type: 'mode', mode: 'normal' }]));
  assert.equal(parseClaude(log), null);
});

test('codex: meta, UserMessage items, FileChange + apply_patch paths, final message', () => {
  const log = put(tmp(), 'rollout-2026-09-22T08-20-19-01a0c705-7755-78c1-8ea4-5ff4ec24fb31.jsonl', jsonl([
    { timestamp: '2026-09-22T02:50:19Z', type: 'session_meta', payload: { id: 'sid-1', cwd: '/Users/me', timestamp: '2026-09-22T02:50:19Z' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-terra' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'make MDView for mac' }] } } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: '*** Begin Patch\n*** Update File: /Users/me/a.swift\n@@\n' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/Users/me/b.swift': { type: 'add' } } } } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Built it.' } },
  ]));
  const s = parseCodex(log)!;
  assert.equal(s.id, 'sid-1');
  assert.equal(s.cwd, '/Users/me');
  assert.deepEqual(s.prompts, ['make MDView for mac']);
  assert.deepEqual(s.models, ['gpt-5.6-terra']);
  assert.deepEqual(s.touched, ['/Users/me/a.swift', '/Users/me/b.swift']);
  assert.equal(s.lastReply, 'Built it.');
  assert.equal(s.title, 'make MDView for mac');
});

test('omp: session cwd, title_change, write + edit-header paths', () => {
  const log = put(tmp(), '2026-09-24T08-54-25-156Z_01a0d29f.jsonl', jsonl([
    { type: 'title', v: 1, title: '' },
    { type: 'session', id: '01a0d29f', timestamp: '2026-09-24T08:54:25Z', cwd: '/tmp' },
    { type: 'model_change', model: 'google-antigravity/gemini-3.1-pro' },
    { type: 'message', timestamp: '2026-09-24T08:55:00Z', message: { role: 'user', content: [{ type: 'text', text: 'build pomodoro' }] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', name: 'write', arguments: { path: '/p/A.swift', content: '' } },
      { type: 'toolCall', name: 'edit', arguments: { input: '[/p/B.swift#D713]\nPUT <3:\n+x\n[/p/C.swift]\n' } },
      { type: 'text', text: 'Timer ready.' },
    ] } },
    { type: 'title_change', title: 'Build macOS Pomodoro timer app' },
  ]));
  const s = parseOmp(log)!;
  assert.equal(s.id, '01a0d29f');
  assert.equal(s.title, 'Build macOS Pomodoro timer app');
  assert.deepEqual(s.touched, ['/p/A.swift', '/p/B.swift', '/p/C.swift']);
  assert.equal(s.lastReply, 'Timer ready.');
});

test('cleanPrompt strips reminders and interrupt markers', () => {
  assert.equal(cleanPrompt('hello<system-reminder>secret</system-reminder>'), 'hello');
  assert.equal(cleanPrompt('[Request interrupted by user for tool use]'), '');
  assert.equal(cleanPrompt('/compact'), '');
});
