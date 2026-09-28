import { basename } from 'node:path';
import type { SessionData } from '../types.ts';
import { cleanPrompt, firstLine, jsonl, textOf } from './common.ts';

const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/g;

/** Parses a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). */
export function parseCodex(logPath: string): SessionData | null {
  const s: SessionData = {
    kind: 'codex', id: basename(logPath, '.jsonl').replace(/^rollout-[\dT-]+?-(?=[0-9a-f]{8}-)/, ''), logPath,
    title: '', cwd: '', models: [], started: '', ended: '', prompts: [], touched: [], lastReply: '',
  };
  const touched = new Set<string>();
  const models = new Set<string>();

  for (const r of jsonl(logPath)) {
    if (r.timestamp) {
      if (!s.started) s.started = r.timestamp;
      s.ended = r.timestamp;
    }
    const p = r.payload ?? {};
    if (r.type === 'session_meta') {
      if (p.id) s.id = p.id;
      if (p.cwd) s.cwd = p.cwd;
      if (p.timestamp) s.started = p.timestamp;
      continue;
    }
    if (r.type === 'turn_context' && p.model) models.add(p.model);
    if (r.type === 'world_state') {
      const m = p.state?.collaboration_mode?.model;
      if (m) models.add(m);
    }
    if (r.type === 'response_item' && p.type === 'custom_tool_call' && typeof p.input === 'string') {
      for (const m of p.input.matchAll(PATCH_FILE)) touched.add(m[1].trim());
    }
    if (r.type !== 'event_msg') continue;
    switch (p.type) {
      case 'thread_settings_applied':
        if (p.thread_settings?.model) models.add(p.thread_settings.model);
        break;
      case 'user_message': {
        const t = cleanPrompt(typeof p.message === 'string' ? p.message : '');
        if (t) s.prompts.push(t);
        break;
      }
      case 'thread_name_updated':
        if (p.thread_name) s.title = p.thread_name;
        break;
      case 'task_complete':
        if (p.last_agent_message) s.lastReply = p.last_agent_message;
        break;
      case 'item_completed': {
        const it = p.item ?? {};
        if (it.type === 'UserMessage') {
          const t = cleanPrompt(textOf(it.content, ['text', 'Text', 'input_text']));
          if (t && s.prompts[s.prompts.length - 1] !== t) s.prompts.push(t);
        } else if (it.type === 'FileChange' && it.changes) {
          for (const f of Object.keys(it.changes)) touched.add(f);
        } else if (it.type === 'AgentMessage') {
          const t = textOf(it.content, ['Text', 'text', 'output_text']);
          if (t.trim()) s.lastReply = t.trim();
        }
        break;
      }
    }
  }
  if (!s.prompts.length) return null;
  s.models = [...models];
  s.touched = [...touched].sort();
  if (!s.title) s.title = firstLine(s.prompts[0]);
  return s;
}
