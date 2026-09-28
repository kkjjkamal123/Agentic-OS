import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SessionSource {
  kind: 'claude' | 'codex' | 'omp';
  dir: string;
}

export interface Config {
  /** Where the generated Obsidian vault lives. */
  vault: string;
  /** Root holding `<Tool>/<Project>` folders. */
  projectsRoot: string;
  sessionSources: SessionSource[];
  /** Extra folders whose subfolders are projects of one tool, e.g. Agentic OS workspaces. */
  extraRoots: { tool: string; dir: string }[];
  /** Mission records written by Agentic OS (one JSON file per mission). */
  missionsDir: string;
  summarize: {
    enabled: boolean;
    command: string;
    model: string;
    /** A session must be quiet this long before it is summarized (unless it ended). */
    idleMs: number;
    maxPerRun: number;
    timeoutMs: number;
  };
  maxFileBytes: number;
  maxFilesPerProject: number;
  /** Extra gitignore-style patterns applied to every project. */
  extraIgnore: string[];
  /** Working/state directory for brain-sync itself. */
  home: string;
}

export const BRAIN_HOME = process.env.BRAIN_SYNC_HOME ?? join(homedir(), '.brain-sync');

export function defaultConfig(home = BRAIN_HOME): Config {
  const h = homedir();
  return {
    vault: join(h, 'Documents', 'Obsidian', 'Brain'),
    projectsRoot: join(h, 'Documents', 'Projects'),
    sessionSources: [
      { kind: 'claude', dir: join(h, '.claude', 'projects') },
      { kind: 'codex', dir: join(h, '.codex', 'sessions') },
      { kind: 'omp', dir: join(h, '.omp', 'agent', 'sessions') },
    ],
    extraRoots: [{ tool: 'Agentic OS', dir: join(h, 'AgenticOS', 'workspaces') }],
    missionsDir: join(home, 'missions'),
    summarize: {
      enabled: true,
      command: 'claude',
      model: 'haiku',
      idleMs: 2 * 60_000,
      maxPerRun: 5,
      timeoutMs: 90_000,
    },
    maxFileBytes: 1_000_000,
    maxFilesPerProject: 3000,
    extraIgnore: [],
    home,
  };
}

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p));

/** Loads `~/.brain-sync/config.json` (if present) over the defaults. */
export function loadConfig(home = BRAIN_HOME): Config {
  const base = defaultConfig(home);
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch {
    // no user config — defaults
  }
  const cfg: Config = {
    ...base,
    ...user,
    summarize: { ...base.summarize, ...(user.summarize ?? {}) },
    home,
  };
  cfg.vault = expand(cfg.vault);
  cfg.projectsRoot = expand(cfg.projectsRoot);
  cfg.sessionSources = cfg.sessionSources.map((s) => ({ ...s, dir: expand(s.dir) }));
  cfg.extraRoots = cfg.extraRoots.map((r) => ({ ...r, dir: expand(r.dir) }));
  cfg.missionsDir = expand(cfg.missionsDir);
  return cfg;
}
