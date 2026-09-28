import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileAnalysis, SessionData } from './types.ts';

const STATE_VERSION = 1;
/** Bump when parsers/analysis change: drops cached parses (not summaries or the note index). */
export const CACHE_VERSION = 2;

export interface Summary {
  /** Fingerprint of the session content that was summarized. */
  key: string;
  text: string;
  at: string;
}

export interface State {
  version: number;
  files: Record<string, { mtimeMs: number; size: number; analysis: FileAnalysis }>;
  sessions: Record<string, { mtimeMs: number; size: number; data: SessionData | null }>;
  summaries: Record<string, Summary>;
  /** Note key → vault-relative path for every note brain-sync generated last run. */
  notes: Record<string, string>;
  cacheVersion?: number;
  lastRun?: { at: string; ms: number; written: number; notes: number };
}

export const emptyState = (): State => ({ version: STATE_VERSION, files: {}, sessions: {}, summaries: {}, notes: {} });

export function loadState(home: string): State {
  try {
    const s = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as State;
    if (s.version === STATE_VERSION) return s;
  } catch {
    // missing or corrupt — start fresh
  }
  return emptyState();
}

export function saveState(home: string, state: State): void {
  const p = join(home, 'state.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(state));
  renameSync(p + '.tmp', p);
}
