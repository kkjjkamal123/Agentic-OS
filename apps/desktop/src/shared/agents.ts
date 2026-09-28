import type { AccountId } from './accounts';
import type { SecretId } from './secrets';

export type Vendor = 'anthropic' | 'openai' | 'google' | 'nvidia' | 'local' | 'other';
export type Source = 'subscription' | 'api' | 'local';

interface RuntimeBase {
  label: string;
  source: Source;
}

export const RUNTIMES = {
  'claude-code': { label: 'Claude Code', kind: 'acp', source: 'subscription', vendor: 'anthropic', account: 'claude-code' },
  codex: { label: 'Codex', kind: 'cli', source: 'subscription', vendor: 'openai', account: 'codex' },
  omp: { label: 'omp', kind: 'acp', source: 'subscription', vendor: 'other', account: 'omp' },
  antigravity: { label: 'Antigravity', kind: 'cli', source: 'subscription', vendor: 'other', account: 'antigravity' },
  anthropic: { label: 'Anthropic API', kind: 'api', source: 'api', vendor: 'anthropic', secret: 'anthropic' },
  openai: { label: 'OpenAI API', kind: 'api', source: 'api', vendor: 'openai', secret: 'openai' },
  google: { label: 'Gemini API', kind: 'api', source: 'api', vendor: 'google', secret: 'google' },
  openrouter: { label: 'OpenRouter', kind: 'api', source: 'api', vendor: 'other', secret: 'openrouter' },
  nvidia: { label: 'NVIDIA NIM', kind: 'api', source: 'api', vendor: 'nvidia', secret: 'nvidia' },
  ollama: { label: 'Ollama', kind: 'api', source: 'local', vendor: 'local' },
} as const satisfies Record<string, RuntimeBase & { kind: 'acp' | 'cli' | 'api'; vendor: Vendor; account?: AccountId; secret?: SecretId }>;

export type RuntimeId = keyof typeof RUNTIMES;
export const RUNTIME_IDS = Object.keys(RUNTIMES) as RuntimeId[];

export const ROLES = ['chat', 'plan', 'code', 'review', 'test', 'summarize'] as const;
export type Role = (typeof ROLES)[number];

export interface ModelInfo {
  id: string;
  name: string;
}

export interface RuntimeCatalog {
  runtime: RuntimeId;
  available: boolean;
  reason?: string;
  models: ModelInfo[];
}

export interface ModelRef {
  runtime: RuntimeId;
  model: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface Routed extends ModelRef {
  effort: Effort;
}

export type AgentEvent =
  | { t: 'text'; text: string }
  | { t: 'thought'; text: string }
  | { t: 'tool'; id: string; title?: string; kind?: string; status?: string; output?: string }
  | { t: 'usage'; input: number; output: number; cacheRead?: number; costUsd?: number }
  | { t: 'done'; stop: string }
  | { t: 'error'; message: string }
  | { t: 'switch'; ref: ModelRef; reason: string };

export interface AgentBatch {
  sessionId: string;
  events: AgentEvent[];
}

export interface SessionInfo {
  id: string;
  role: Role;
  ref: ModelRef;
  effort: Effort;
  workspaceId: string | null;
}

export interface StartOpts {
  ref?: ModelRef;
  workspaceId?: string;
  quality?: 'saver' | 'balanced' | 'max';
}

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

// omp and OpenRouter host many vendors; cross-vendor review needs the real one.
export function vendorOf(ref: ModelRef): Vendor {
  const v = RUNTIMES[ref.runtime].vendor;
  if (v !== 'other') return v;
  const m = ref.model.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return 'anthropic';
  if (/gemini|google/.test(m)) return 'google';
  if (/gpt|openai|\bo\d/.test(m)) return 'openai';
  if (/nvidia|nemotron/.test(m)) return 'nvidia';
  return 'other';
}
