import { basename, isAbsolute, join } from 'node:path';
import type { SessionData } from '../types.ts';
import { cleanPrompt, firstLine, jsonl, textOf } from './common.ts';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Parses a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`). */
export function parseClaude(logPath: string): SessionData | null {
  const s: SessionData = {
    kind: 'claude', id: basename(logPath, '.jsonl'), logPath, title: '', cwd: '', models: [],
    started: '', ended: '', prompts: [], touched: [], lastReply: '',
  };
  const touched = new Set<string>();
  const models = new Set<string>();
  const relTracked: string[] = [];
  // One cost-state per process run (resumes start a new one); total = sum of each run's latest.
  const costByRun = new Map<string, number>();

  for (const r of jsonl(logPath)) {
    if (r.timestamp) {
      if (!s.started) s.started = r.timestamp;
      s.ended = r.timestamp;
    }
    if (r.sessionId && !s.id) s.id = r.sessionId;
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    switch (r.type) {
      case 'ai-title':
        if (r.aiTitle) s.title = r.aiTitle;
        break;
      case 'summary':
        if (!s.title && r.summary) s.title = r.summary;
        break;
      case 'cost-state':
        if (typeof r.totalCostUSD === 'number') costByRun.set(String(r.startTime ?? ''), r.totalCostUSD);
        break;
      case 'file-history-delta':
        if (r.trackingPath) relTracked.push(r.trackingPath);
        break;
      case 'user': {
        if (r.isMeta || r.isSidechain || r.toolUseResult) break;
        const c = r.message?.content;
        if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) break;
        const p = cleanPrompt(textOf(c));
        if (p) s.prompts.push(p);
        break;
      }
      case 'assistant': {
        if (r.isSidechain) break;
        const m = r.message;
        if (m?.model && m.model !== '<synthetic>') models.add(m.model);
        if (!Array.isArray(m?.content)) break;
        for (const b of m.content) {
          if (b?.type === 'tool_use' && WRITE_TOOLS.has(b.name)) {
            const fp = b.input?.file_path ?? b.input?.notebook_path;
            if (typeof fp === 'string') touched.add(fp);
          } else if (b?.type === 'text' && b.text?.trim()) {
            s.lastReply = b.text.trim();
          }
        }
        break;
      }
    }
  }
  for (const rel of relTracked) touched.add(isAbsolute(rel) ? rel : join(s.cwd, rel));
  if (!s.prompts.length) return null;
  s.models = [...models];
  s.touched = [...touched].sort();
  if (costByRun.size) s.costUsd = [...costByRun.values()].reduce((a, b) => a + b, 0);
  if (!s.title) s.title = firstLine(s.prompts[0]);
  return s;
}
