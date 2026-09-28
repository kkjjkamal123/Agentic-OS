import { mkdirSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { SyncLock } from './lock.ts';
import { renderAll } from './render/notes.ts';
import { discoverProjects, scanProject } from './scan/projects.ts';
import { loadMissions } from './missions.ts';
import { loadSessions } from './sessions/index.ts';
import { CACHE_VERSION, loadState, saveState, type State } from './state.ts';
import { pickForSummary, summarize, type SummaryMode } from './summarize.ts';
import type { Project, SessionData } from './types.ts';
import { ensureVaultConfig } from './vault/obsidian.ts';
import { writeVault } from './vault/write.ts';

export interface SyncOptions {
  /** Ignore analysis/session caches (summaries are kept). */
  full?: boolean;
  summaries?: SummaryMode;
  /** Session logs that just ended — summarize now instead of waiting for idle. */
  finalLogs?: string[];
  log?: (msg: string) => void;
  config?: Config;
}

export interface SyncResult {
  ran: boolean;
  projects: number;
  files: number;
  sessions: number;
  notes: number;
  written: number;
  renamed: number;
  archived: number;
  deleted: number;
  summarized: number;
  ms: number;
}

/**
 * Sessions whose working dir points into `<projectsRoot>/<Tool>/<Project>` that no longer exists
 * get a placeholder project, so deleting a folder doesn't orphan its history in the graph.
 */
function missingProjects(sessions: SessionData[], projects: Project[], root: string): Project[] {
  const known = new Set(projects.map((p) => p.root));
  const out = new Map<string, Project>();
  for (const s of sessions) {
    for (const path of [s.cwd, ...s.touched]) {
      if (!path?.startsWith(root + sep)) continue;
      const [tool, name] = relative(root, path).split(sep);
      if (!tool || !name) continue;
      const pr = `${root}${sep}${tool}${sep}${name}`;
      if (known.has(pr) || out.has(pr)) continue;
      // Only a real project if a session actually *worked in* it (cwd), not a stray file path.
      if (s.cwd !== pr && !s.cwd.startsWith(pr + sep)) continue;
      out.set(pr, { tool, name, root: pr, files: [], dirs: [''], stack: [], readme: '', truncated: 0, lastModified: 0, missing: true });
    }
  }
  return [...out.values()];
}

function scanAll(cfg: Config, state: State, sessions: SessionData[]): Project[] {
  const seen = new Set<string>();
  const projects = discoverProjects(cfg.projectsRoot, cfg.extraRoots).map((p) => scanProject(p, cfg, state, seen));
  for (const k of Object.keys(state.files)) if (!seen.has(k)) delete state.files[k];
  return [...projects, ...missingProjects(sessions, projects, cfg.projectsRoot)];
}

async function syncOnce(cfg: Config, opts: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const state = loadState(cfg.home);
  if (opts.full || state.cacheVersion !== CACHE_VERSION) {
    state.files = {};
    state.sessions = {};
    state.cacheVersion = CACHE_VERSION;
  }
  mkdirSync(cfg.vault, { recursive: true });
  if (ensureVaultConfig(cfg.vault)) log(`created vault config in ${cfg.vault}/.obsidian`);

  const sessions = loadSessions(cfg, state);
  const projects = scanAll(cfg, state, sessions);
  const render = () =>
    renderAll({ projects, sessions, missions: loadMissions(cfg.missionsDir), summaries: state.summaries, summarizeEnabled: cfg.summarize.enabled && opts.summaries !== 'none' });

  let notes = render();
  const w = writeVault(cfg.vault, notes, state.notes);
  state.notes = w.index;
  saveState(cfg.home, state);

  // Slow part last: notes are already current; summaries fill in afterwards.
  const due = pickForSummary(sessions, state.summaries, cfg, opts.summaries ?? 'auto', new Set(opts.finalLogs ?? []));
  let summarized = 0;
  if (due.length) {
    log(`summarizing ${due.length} session(s)…`);
    summarized = await summarize(due, state.summaries, cfg, log);
    if (summarized) {
      notes = render();
      const w2 = writeVault(cfg.vault, notes, state.notes);
      state.notes = w2.index;
      w.written += w2.written;
    }
  }

  const ms = Date.now() - t0;
  state.lastRun = { at: new Date().toISOString(), ms, written: w.written, notes: notes.length };
  saveState(cfg.home, state);
  return {
    ran: true,
    projects: projects.length,
    files: projects.reduce((n, p) => n + p.files.length, 0),
    sessions: sessions.length,
    notes: notes.length,
    written: w.written,
    renamed: w.renamed,
    archived: w.archived,
    deleted: w.deleted,
    summarized,
    ms,
  };
}

/** Runs a sync under the single-flight lock; returns `ran: false` if another sync was busy. */
export async function sync(opts: SyncOptions = {}): Promise<SyncResult> {
  const cfg = opts.config ?? loadConfig();
  const lock = new SyncLock(cfg.home);
  if (!lock.acquire()) {
    return { ran: false, projects: 0, files: 0, sessions: 0, notes: 0, written: 0, renamed: 0, archived: 0, deleted: 0, summarized: 0, ms: 0 };
  }
  try {
    let res = await syncOnce(cfg, opts);
    // Triggers that arrived mid-run: one more pass picks them all up.
    for (let i = 0; i < 3 && lock.takePending(); i++) {
      const again = await syncOnce(cfg, { ...opts, full: false, finalLogs: [] });
      res = { ...again, written: res.written + again.written, summarized: res.summarized + again.summarized, ms: res.ms + again.ms };
    }
    return res;
  } finally {
    lock.release();
  }
}
