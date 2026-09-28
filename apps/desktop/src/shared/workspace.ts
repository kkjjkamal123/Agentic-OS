import { z } from 'zod';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface DirEntry {
  name: string;
  rel: string;
  dir: boolean;
  size: number;
}

export type ActionKind = 'read' | 'write' | 'delete' | 'execute' | 'fetch' | 'other';

export interface GateAction {
  kind: ActionKind;
  title?: string;
  paths?: string[];
  command?: string;
}

export type Verdict = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string };

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  agent: string;
  action: GateAction;
  reason: string;
}

export type ApprovalAnswer = 'once' | 'session' | 'deny';

export interface CommandRun {
  id: string;
  sessionId: string;
  agent: string;
  cwd: string;
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: number;
}

export const WorkspaceNameSchema = z.string().trim().min(1).max(80);
export const RelPathSchema = z.string().max(4096).refine((p) => !p.split('/').includes('..') && !p.startsWith('/'), 'path must stay inside the workspace');
export const ApprovalAnswerSchema = z.enum(['once', 'session', 'deny']);
