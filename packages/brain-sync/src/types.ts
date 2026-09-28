export interface OutlineItem {
  kind: string;
  name: string;
}

/** Cached per-file analysis (keyed by path + mtime + size). */
export interface FileAnalysis {
  binary: boolean;
  lines: number;
  outline: OutlineItem[];
  /** Import/link targets as alternative absolute paths; resolved each run. */
  linkCandidates: string[][];
}

export interface ProjectFile {
  abs: string;
  /** Path relative to the project root, posix separators. */
  rel: string;
  size: number;
  mtimeMs: number;
  lang: string;
  tooBig: boolean;
  analysis: FileAnalysis;
  /** Resolved absolute paths of project files this file links to. */
  links: string[];
}

export interface Project {
  tool: string;
  name: string;
  root: string;
  files: ProjectFile[];
  /** Relative dir paths ('' = root). */
  dirs: string[];
  stack: string[];
  readme: string;
  truncated: number;
  lastModified: number;
  /** The folder no longer exists; kept so its sessions stay linked. */
  missing?: boolean;
}

export interface SessionData {
  kind: 'claude' | 'codex' | 'omp';
  id: string;
  logPath: string;
  title: string;
  cwd: string;
  models: string[];
  started: string;
  ended: string;
  prompts: string[];
  /** Absolute paths the agent wrote/edited. */
  touched: string[];
  lastReply: string;
  costUsd?: number;
}

interface ModelRef {
  runtime: string;
  model: string;
}

/** Written by Agentic OS to `<missionsDir>/<id>.json` when a mission ends. */
export interface MissionRecord {
  id: string;
  goal: string;
  status: string;
  workspacePath: string;
  workspaceName: string;
  quality: string;
  planner?: ModelRef;
  tasks: { id: string; title: string; status: string; coder?: ModelRef; reviewer?: ModelRef; note?: string }[];
  checks: { name: string; command: string; exitCode: number | null }[];
  report?: string;
  error?: string;
  usage: { input: number; output: number; cached: number };
  createdAt: string;
  updatedAt: string;
}
