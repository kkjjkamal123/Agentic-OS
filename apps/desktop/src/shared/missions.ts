import { z } from 'zod';
import type { ModelRef, Usage } from './agents';

export type TaskStatus = 'queued' | 'coding' | 'reviewing' | 'fixing' | 'merging' | 'done' | 'failed' | 'cancelled';
export type MissionStatus = 'planning' | 'building' | 'verifying' | 'shipping' | 'paused' | 'done' | 'failed' | 'cancelled';
export type Stage = 'plan' | 'build' | 'review' | 'test' | 'ship';

export interface MissionTask {
  id: string;
  title: string;
  spec: string;
  deps: string[];
  acceptance: string[];
  complexity: 'light' | 'normal' | 'hard';
  /** Files this task owns; parallel tasks never share one, which keeps merges clean. */
  files?: string[];
  status: TaskStatus;
  coder?: ModelRef;
  reviewer?: ModelRef;
  /** What the dispatcher model chose (tried first; routing takes over if it fails or is limited). */
  plannedCoder?: ModelRef;
  plannedReviewer?: ModelRef;
  dispatchNote?: string;
  /** The coder's note to the rest of the team: what it built and which files it touched. */
  handoff?: string;
  sessionId?: string;
  rounds: number;
  note?: string;
}

export type RunKind = 'web' | 'macos-app' | 'cli';

/** How to launch the finished product with one click. Paths are relative to the workspace. */
export interface RunSpec {
  kind: RunKind;
  /** Long-running start command (web dev server, CLI entry). */
  start?: string;
  /** Where a started web app listens. */
  url?: string;
  /** File or bundle to open directly (index.html, build/Hangman.app). */
  open?: string;
}

export interface TestState {
  missionId: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  message?: string;
  url?: string;
}

export interface VerifyStep {
  name: 'setup' | 'build' | 'test' | 'launch';
  command: string;
  exitCode: number | null;
}

export interface Mission {
  id: string;
  goal: string;
  workspaceId: string;
  workspaceName: string;
  quality: 'saver' | 'balanced' | 'max';
  status: MissionStatus;
  stage: Stage;
  /** Set while paused, or while a requested pause waits for the current step to finish. */
  pause?: { reason: 'offline' | 'user'; since: string };
  /** The mission this one changes (a follow-up request on the same product). */
  parentId?: string;
  /** main before and after this mission: the version it can be undone to. */
  baseCommit?: string;
  headCommit?: string;
  undone?: boolean;
  resumes?: number;
  summary?: string;
  /** What the user gets, in one sentence. */
  product?: string;
  stack?: string;
  run?: RunSpec;
  stats?: { files: number; lines: number; testFiles: number };
  finishedAt?: string;
  planner?: ModelRef;
  dispatcher?: ModelRef;
  tasks: MissionTask[];
  verify: { setup?: string; build?: string; test?: string };
  checks: VerifyStep[];
  fixRounds: number;
  report?: string;
  error?: string;
  usage: Usage;
  activeSessions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MissionEvent {
  missionId: string;
  ts: number;
  kind: 'plan' | 'dispatch' | 'task' | 'handoff' | 'review' | 'merge' | 'check' | 'fix' | 'ship' | 'switch' | 'error' | 'info';
  text: string;
}

const cmd = z.string().max(2000).optional().transform((s) => (s?.trim() ? s.trim() : undefined));

export const PlanSchema = z.object({
  summary: z.string().min(1).max(4000),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(1).max(200),
        spec: z.string().min(1).max(8000),
        deps: z.array(z.string()).default([]),
        acceptance: z.array(z.string()).default([]),
        complexity: z.enum(['light', 'normal', 'hard']).catch('normal'),
        files: z.array(z.string().max(300)).max(60).optional(),
      }),
    )
    .min(1)
    .max(12),
  verify: z.object({ setup: cmd, build: cmd, test: cmd }).default({ setup: undefined, build: undefined, test: undefined }),
  product: z.string().max(400).optional(),
  stack: z.string().max(200).optional(),
  run: z
    .object({
      kind: z.enum(['web', 'macos-app', 'cli']).catch('web'),
      start: cmd,
      url: z.string().max(200).optional().transform((u) => (u?.startsWith('http://localhost') || u?.startsWith('http://127.0.0.1') ? u : undefined)),
      open: z.string().max(300).optional().transform((p) => (p && !p.startsWith('/') && !p.split('/').includes('..') ? p : undefined)),
    })
    .optional(),
});

export type Plan = z.infer<typeof PlanSchema>;

export const ReviewSchema = z.object({ approve: z.boolean(), issues: z.array(z.string()).default([]) });

export const MissionStartSchema = z
  .object({
    goal: z.string().trim().min(3).max(8000),
    workspaceId: z.string().uuid().optional(),
    quality: z.enum(['saver', 'balanced', 'max']).optional(),
    parentId: z.string().uuid().optional(),
  })
  .strict();

export type MissionStart = z.infer<typeof MissionStartSchema>;

export const DispatchSchema = z.object({
  assign: z.array(z.object({ task: z.string(), coder: z.string(), reviewer: z.string().optional(), why: z.string().max(300).optional() })),
});
