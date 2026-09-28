#!/usr/bin/env node
// Deterministic ACP agent for tests: echoes prompts, exercises thoughts, tools, permissions and usage.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

const config = {
  model: { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-fast', options: [{ value: 'fake-fast', name: 'Fake Fast' }, { value: 'fake-smart', name: 'Fake Smart' }] },
  effort: { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high'].map((v) => ({ value: v, name: v })) },
};
const cancelled = new Set();

new AgentSideConnection(
  (conn) => ({
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'fake', version: '1.0.0' }, authMethods: [] }),
    newSession: async () => ({ sessionId: 's1', configOptions: Object.values(config) }),
    setSessionConfigOption: async ({ configId, value }) => {
      config[configId].currentValue = value;
      return { configOptions: Object.values(config) };
    },
    authenticate: async () => ({}),
    cancel: async ({ sessionId }) => void cancelled.add(sessionId),
    prompt: async ({ sessionId, prompt }) => {
      const text = prompt.map((b) => b.text ?? '').join('');
      if (process.env.FAKE_PROMPT_LOG) appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify({ model: config.model.currentValue, text }) + '\n');
      const send = (update) => conn.sessionUpdate({ sessionId, update });
      if (text.includes('LIMITME') && config.model.currentValue === 'fake-fast') {
        throw RequestError.internalError({ message: "You've hit your usage limit. Try again later." });
      }
      const say = async (reply) => {
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
        return { stopReason: 'end_turn', usage: { inputTokens: 400, outputTokens: 20, totalTokens: 420, cachedReadTokens: 50 } };
      };
      if (text.includes('Assign one coder and one reviewer')) {
        // Deterministic dispatcher: always take the last listed option, so tests can tell it was honoured.
        const assign = [...text.matchAll(/^(t\d+) \[.*\n\s+coders: (.*)\n\s+reviewers: (.*)$/gm)].map(([, task, c, r]) => ({
          task, coder: c.split('; ').at(-1).split('=')[0], reviewer: r.split('; ').at(-1).split('=')[0], why: 'fake pick',
        }));
        return say('```json\n' + JSON.stringify({ assign }) + '\n```');
      }
      if (text.includes('Make a build plan') && text.includes('This is a change request')) {
        return say('```json\n' + JSON.stringify({
          summary: 'Add t3.',
          tasks: [{ id: 't3', title: 'Write t3', spec: 'Create t3.txt', files: ['t3.txt'], deps: [], acceptance: ['t3.txt exists'], complexity: 'light' }],
          verify: { test: 'test -f t3.txt' },
        }) + '\n```');
      }
      if (text.includes('Make a build plan')) {
        const impossible = text.includes('impossible');
        return say('```json\n' + JSON.stringify({
          product: 'A tiny page that shows two files.',
          stack: 'HTML',
          run: { kind: 'web', open: 'index.html' },
          summary: 'Two text files.',
          tasks: [
            { id: 't1', title: 'Write t1', spec: 'Create t1.txt', deps: [], acceptance: ['t1.txt exists'] },
            { id: 't2', title: 'Write t2', spec: 'Create t2.txt', deps: ['t1'], acceptance: ['t2.txt exists'] },
          ],
          verify: { build: 'test -f t1.txt', test: impossible ? 'exit 3' : 'test -f t1.txt && test -f t2.txt' },
        }) + '\n```');
      }
      const task = text.match(/Your task \((t\d+)\)/);
      // First attempt at t1 loses the connection; the retry (same worktree) succeeds.
      const dropMark = join(tmpdir(), `aos-dropnet-${process.cwd().replace(/\W/g, '_')}`);
      if (task?.[1] === 't1' && text.includes('DROPNET') && !existsSync(dropMark)) {
        writeFileSync(dropMark, '');
        throw RequestError.internalError({ message: 'fetch failed: getaddrinfo ENOTFOUND api.example.com' });
      }
      if (task && text.includes('SLOWTASK')) await new Promise((r) => setTimeout(r, 1500));
      if (task) {
        writeFileSync(join(process.cwd(), `${task[1]}.txt`), `${task[1]} by fake\n`);
        if (task[1] === 't1') writeFileSync(join(process.cwd(), 'index.html'), '<!doctype html><title>Fake app</title><h1>Fake app is live</h1>\n');
        return say(`DONE: wrote ${task[1]}.txt`);
      }
      if (text.includes('Review the change for task')) return say('```json\n{"approve": true, "issues": []}\n```');
      if (text.includes('check failed')) return say('DONE: tried');
      if (text.includes('Write the ship report')) return say('## Shipped\nTwo files. Run `cat t1.txt`.');
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      if (text.includes('edit')) {
        await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit file', kind: 'edit', status: 'pending' });
        const res = await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: 't1', title: 'Edit file', kind: 'edit' },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: res.outcome.optionId === 'yes' ? 'completed' : 'failed' });
      }
      const shell = async (id, command, output) => {
        await send({ sessionUpdate: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: 'pending', rawInput: { command } });
        const res = await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: id, title: command, kind: 'execute', rawInput: { command } },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        });
        const ok = res.outcome.optionId === 'yes';
        await send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: ok ? [{ type: 'content', content: { type: 'text', text: output } }] : [] });
      };
      if (text.includes('build')) await shell(`b${Date.now()}`, 'npm run build', 'vite v7 building…\n✓ built in 212ms');
      if (text.includes('push')) await shell(`p${Date.now()}`, 'git push origin main', 'To github.com:me/app.git\n   abc..def  main -> main');
      const words = `[${config.model.currentValue}/${config.effort.currentValue}] Echo: ${text}`.split(' ');
      for (const w of words) {
        if (cancelled.has(sessionId)) return { stopReason: 'cancelled' };
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w + ' ' } });
        if (text.includes('slow')) await new Promise((r) => setTimeout(r, 200));
      }
      return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: words.length, totalTokens: 10 + words.length, cachedReadTokens: 4 } };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
