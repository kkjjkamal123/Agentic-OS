import { basename } from 'node:path';
import type { SessionData } from '../types.ts';
import { cleanPrompt, firstLine, jsonl, textOf } from './common.ts';

const EDIT_HEADER = /^\[([^\]#\n]+?)(?:#[^\]\n]*)?\]/gm;

/** Parses an oh-my-pi session (`~/.omp/agent/sessions/<slug>/<ts>_<id>.jsonl`). */
export function parseOmp(logPath: string): SessionData | null {
  const s: SessionData = {
    kind: 'omp', id: basename(logPath, '.jsonl').replace(/^.*_/, ''), logPath, title: '', cwd: '', models: [],
    started: '', ended: '', prompts: [], touched: [], lastReply: '',
  };
  const touched = new Set<string>();
  const models = new Set<string>();

  for (const r of jsonl(logPath)) {
    if (r.timestamp) {
      if (!s.started) s.started = r.timestamp;
      s.ended = r.timestamp;
    }
    switch (r.type) {
      case 'session':
        if (r.id) s.id = r.id;
        if (r.cwd) s.cwd = r.cwd;
        break;
      case 'title':
      case 'title_change':
        if (r.title) s.title = r.title;
        break;
      case 'model_change':
        if (r.model) models.add(r.model);
        break;
      case 'message': {
        const m = r.message ?? {};
        if (m.role === 'user') {
          const t = cleanPrompt(textOf(m.content));
          if (t) s.prompts.push(t);
        } else if (m.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === 'toolCall') {
              const a = b.arguments ?? {};
              if ((b.name === 'write' || b.name === 'edit') && typeof a.path === 'string') touched.add(a.path);
              if (b.name === 'edit' && typeof a.input === 'string') {
                for (const h of a.input.matchAll(EDIT_HEADER)) if (h[1].startsWith('/')) touched.add(h[1]);
              }
            } else if (b?.type === 'text' && b.text?.trim()) {
              s.lastReply = b.text.trim();
            }
          }
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
