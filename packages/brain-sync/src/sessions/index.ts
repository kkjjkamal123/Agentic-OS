import { statSync } from 'node:fs';
import type { Config, SessionSource } from '../config.ts';
import type { State } from '../state.ts';
import type { SessionData } from '../types.ts';
import { parseClaude } from './claude.ts';
import { parseCodex } from './codex.ts';
import { findJsonl } from './common.ts';
import { parseOmp } from './omp.ts';

const ADAPTERS: Record<SessionSource['kind'], { depth: number; parse: (p: string) => SessionData | null }> = {
  // Claude: <slug>/<session>.jsonl only — deeper files are subagent transcripts.
  claude: { depth: 2, parse: parseClaude },
  codex: { depth: 5, parse: parseCodex },
  omp: { depth: 2, parse: parseOmp },
};

/** Parses every session log, reusing cached results for unchanged files. */
export function loadSessions(cfg: Config, state: State): SessionData[] {
  const out: SessionData[] = [];
  const live = new Set<string>();
  for (const src of cfg.sessionSources) {
    const a = ADAPTERS[src.kind];
    if (!a) continue;
    for (const log of findJsonl(src.dir, a.depth)) {
      let st;
      try {
        st = statSync(log);
      } catch {
        continue;
      }
      live.add(log);
      const c = state.sessions[log];
      const data = c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.data : a.parse(log);
      state.sessions[log] = { mtimeMs: st.mtimeMs, size: st.size, data };
      // Skip brain-sync's own summarizer runs and throwaway temp-dir sessions with nothing written.
      if (data && !data.cwd.startsWith(cfg.home)) out.push(data);
    }
  }
  for (const k of Object.keys(state.sessions)) if (!live.has(k)) delete state.sessions[k];
  return out.sort((x, y) => (x.started < y.started ? -1 : 1));
}
