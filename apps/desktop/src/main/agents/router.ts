import { vendorOf, type Effort, type ModelInfo, type ModelRef, type Role, type Routed, type RuntimeCatalog, type RuntimeId, type Vendor } from '@shared/agents';
import type { Quality } from '@shared/settings';

type Tier = 'top' | 'strong' | 'fast' | 'lite';
type Open = 'heavy' | 'code' | 'light';
type Pref = [RuntimeId, RegExp | Open];
export type Complexity = 'light' | 'normal' | 'hard';

// Version-free patterns; `best` picks the newest match (by display name too, since Claude
// Code's aliases like "opus" carry the version only in their name).
const FABLE = /fable/;
const OPUS = /opus/;
const SONNET = /sonnet/;
const HAIKU = /haiku/;
const GEMINI_PRO = /gemini-[\d.]+-pro$/;
const AGY_OPUS = /claude-opus/;
const AGY_SONNET = /claude-sonnet/;
const GEMINI_FLASH = /gemini-[\d.]+-flash$/;
const GEMINI_LITE = /gemini-[\d.]+-flash-lite$/;
const HEAVY_GPT = /terra|^gpt-\d+(\.\d+)?$/;
const LIGHT_GPT = /luna|mini|nano/;
// OpenRouter lists hundreds of models, newest (often gated or preview) first; stick to known families.
const OR_TOP = /^(anthropic\/claude-(fable|opus)|openai\/gpt-\d+(\.\d+)?$|google\/gemini-[\d.]+-pro)/;
const OR_STRONG = /^(anthropic\/claude-sonnet|qwen\/qwen[\d.]*-coder|openai\/gpt-\d+(\.\d+)?$|deepseek\/deepseek-(v|r)\d|mistralai\/devstral|google\/gemini-[\d.]+-pro)/;
const OR_FAST = /^(anthropic\/claude-haiku|openai\/gpt-[\d.]+-(mini|nano)|google\/gemini-[\d.]+-flash(-lite)?$|mistralai\/.*small)/;

// Order = preference inside a tier: subscriptions (already paid for) before metered APIs before
// local. omp's Claude models bill Google Antigravity, not Claude Pro: a second Claude pool.
const TIERS: Record<Tier, Pref[]> = {
  top: [
    ['claude-code', FABLE], ['claude-code', OPUS], ['omp', OPUS], ['antigravity', AGY_OPUS], ['codex', HEAVY_GPT], ['antigravity', GEMINI_PRO], ['omp', GEMINI_PRO],
    ['anthropic', FABLE], ['anthropic', OPUS], ['openai', /^gpt-\d+(\.\d+)?$/], ['google', /gemini-.*pro/], ['openrouter', OR_TOP],
    ['nvidia', 'heavy'], ['ollama', 'heavy'],
  ],
  strong: [
    ['claude-code', SONNET], ['omp', SONNET], ['antigravity', AGY_SONNET], ['codex', HEAVY_GPT], ['antigravity', GEMINI_PRO], ['omp', GEMINI_PRO],
    ['anthropic', SONNET], ['openai', /codex|^gpt-\d+(\.\d+)?$/], ['google', /gemini-.*pro/], ['openrouter', OR_STRONG],
    ['nvidia', 'code'], ['ollama', 'code'],
  ],
  fast: [
    ['claude-code', HAIKU], ['antigravity', GEMINI_FLASH], ['omp', GEMINI_FLASH], ['codex', LIGHT_GPT],
    ['anthropic', HAIKU], ['openai', /mini/], ['google', /flash/], ['openrouter', OR_FAST], ['nvidia', 'light'], ['ollama', 'light'],
  ],
  lite: [
    ['omp', GEMINI_LITE], ['antigravity', GEMINI_FLASH], ['omp', GEMINI_FLASH], ['claude-code', HAIKU], ['codex', LIGHT_GPT], ['ollama', 'light'],
    ['google', /flash-lite|flash/], ['anthropic', HAIKU], ['openai', /mini|nano/], ['nvidia', 'light'], ['openrouter', OR_FAST],
  ],
};

interface Plan {
  tier: Tier;
  effort: Effort;
  /** Fable is the priciest model; only Max quality reaches for it. */
  fable?: boolean;
}

// What each job gets at each usage level. Code depends on how hard the planner rated the task.
const PLANS: Record<Quality, Record<Exclude<Role, 'code'>, Plan> & { code: Record<Complexity, Plan> }> = {
  saver: {
    plan: { tier: 'strong', effort: 'medium' },
    review: { tier: 'strong', effort: 'low' },
    test: { tier: 'fast', effort: 'low' },
    summarize: { tier: 'lite', effort: 'low' },
    chat: { tier: 'fast', effort: 'low' },
    code: { light: { tier: 'fast', effort: 'low' }, normal: { tier: 'strong', effort: 'low' }, hard: { tier: 'strong', effort: 'medium' } },
  },
  balanced: {
    plan: { tier: 'top', effort: 'high' },
    review: { tier: 'top', effort: 'high' },
    test: { tier: 'fast', effort: 'low' },
    summarize: { tier: 'lite', effort: 'low' },
    chat: { tier: 'strong', effort: 'medium' },
    code: { light: { tier: 'fast', effort: 'medium' }, normal: { tier: 'strong', effort: 'medium' }, hard: { tier: 'top', effort: 'high' } },
  },
  max: {
    plan: { tier: 'top', effort: 'max', fable: true },
    review: { tier: 'top', effort: 'high', fable: true },
    test: { tier: 'strong', effort: 'medium' },
    summarize: { tier: 'fast', effort: 'low' },
    chat: { tier: 'top', effort: 'high' },
    code: { light: { tier: 'strong', effort: 'medium' }, normal: { tier: 'top', effort: 'high' }, hard: { tier: 'top', effort: 'max', fable: true } },
  },
};

const planFor = (role: Role, quality: Quality, complexity: Complexity): Plan =>
  role === 'code' ? PLANS[quality].code[complexity] : PLANS[quality][role];

export const effortFor = (role: Role, quality: Quality = 'balanced', complexity: Complexity = 'normal'): Effort => planFor(role, quality, complexity).effort;

/** Which quota a model spends: models behind one subscription share its limits. */
export function poolOf(ref: ModelRef): string {
  if (ref.runtime === 'claude-code') return 'claude-subscription';
  if (ref.runtime === 'codex') return 'chatgpt-subscription';
  // omp's google-antigravity models and Google's own agy share one Antigravity quota.
  if (ref.runtime === 'antigravity' || (ref.runtime === 'omp' && ref.model.startsWith('google-antigravity/'))) return 'antigravity';
  if (ref.runtime === 'omp') return `omp:${ref.model.split('/')[0]}`;
  return ref.runtime;
}

const versionKey = (m: ModelInfo) => (m.id.match(/\d+/g)?.length ? m.id : m.name).match(/\d+/g)?.map(Number) ?? [];

function best(models: ModelInfo[]): ModelInfo | undefined {
  return [...models].sort((a, b) => {
    const va = versionKey(a);
    const vb = versionKey(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? -1) - (va[i] ?? -1);
      if (d) return d;
    }
    // Same version: non-preview first, then the alias the CLI recommends ("opus") over a pinned id.
    return Number(/preview|exp/.test(a.id)) - Number(/preview|exp/.test(b.id)) || a.id.length - b.id.length;
  })[0];
}

// Open-model catalogs (NVIDIA NIM, Ollama) change weekly and follow no naming scheme, so
// classify by what the name says: total parameters ("550b", not the "a55b" active count) and tier words.
const LIGHT_WORDS = /nano|mini|lite|lightning|flash|small|tiny|haiku/i;
const HEAVY_WORDS = /ultra|large|super|max|pro\b|opus|kimi-k\d|deepseek-(r\d|v\d)/i;
const CODER = /coder|devstral|codestral|starcoder|codegemma|code-?llama/i;

export function paramsB(id: string): number | null {
  const m = id.match(/(?:^|[^a-z\d.])(\d+(?:\.\d+)?)b(?![a-z])/i);
  return m ? Number(m[1]) : null;
}

const size = (id: string) => paramsB(id) ?? (HEAVY_WORDS.test(id) ? 400 : LIGHT_WORDS.test(id) ? 20 : 70);

function byOpen(models: ModelInfo[], kind: Open): ModelInfo | undefined {
  const newest = (a: ModelInfo, b: ModelInfo) => (best([a, b]) === a ? -1 : 1);
  if (kind === 'light') {
    const small = models.filter((m) => (LIGHT_WORDS.test(m.id) || size(m.id) <= 40) && size(m.id) >= 3);
    return [...small].sort((a, b) => Number(LIGHT_WORDS.test(b.id)) - Number(LIGHT_WORDS.test(a.id)) || newest(a, b))[0];
  }
  const coders = models.filter((m) => CODER.test(m.id) && size(m.id) >= 30);
  const pool = kind === 'code' && coders.length ? coders : models;
  return [...pool].filter((m) => !LIGHT_WORDS.test(m.id) || kind === 'code').sort((a, b) => size(b.id) - size(a.id) || newest(a, b))[0];
}

export interface RouteOpts {
  avoidVendor?: Vendor;
  /** Tasks currently running per pool; busy pools are pushed down so parallel work spreads out. */
  load?: Record<string, number>;
  /** Pools that just hit a usage limit. */
  cooling?: Set<string>;
  quality?: Quality;
  complexity?: Complexity;
  /** `runtime|model` pairs to skip, e.g. ones that just failed in this mission. */
  exclude?: Set<string>;
}

// A busy pool drops 3 places per running task: with three parallel coders that yields
// Claude Code, then omp's Claude (Antigravity quota), then Codex.
const LOAD_PENALTY = 3;
const NEVER = /^default$|\[1m\]/;

export function rank(role: Role, catalogs: RuntimeCatalog[], opts: RouteOpts = {}): Routed[] {
  const plan = planFor(role, opts.quality ?? 'balanced', opts.complexity ?? 'normal');
  const allowed = (p: Pref) => plan.fable || p[1] !== FABLE;
  const byRuntime = new Map(catalogs.filter((c) => c.available).map((c) => [c.runtime, c]));
  const ok = (runtime: RuntimeId, id: string) =>
    !NEVER.test(id) && vendorOf({ runtime, model: id }) !== opts.avoidVendor && !opts.cooling?.has(poolOf({ runtime, model: id })) && !opts.exclude?.has(`${runtime}|${id}`);
  const pick = ([runtime, match]: Pref) => {
    const models = byRuntime.get(runtime)?.models.filter((m) => ok(runtime, m.id)) ?? [];
    if (typeof match === 'string') return byOpen(models, match);
    return best(models.filter((m) => match.test(m.id) && !m.id.startsWith('~') && !m.id.endsWith(':free')));
  };
  const seen = new Set<string>();
  const out: { r: Routed; score: number }[] = [];
  const add = (runtime: RuntimeId, model: ModelInfo | undefined, index: number) => {
    if (!model || seen.has(`${runtime}|${model.id}`)) return;
    seen.add(`${runtime}|${model.id}`);
    // Rank among models that actually exist, so unavailable slots never shift the load balance.
    const position = out.length + (index >= 1000 ? 1000 : 0);
    out.push({ r: { runtime, model: model.id, effort: plan.effort }, score: position + LOAD_PENALTY * (opts.load?.[poolOf({ runtime, model: model.id })] ?? 0) });
  };
  const prefs = TIERS[plan.tier].filter(allowed);
  prefs.forEach((p, i) => add(p[0], pick(p), i));
  // Nothing in the tier is available (e.g. only Claude Code while Saver wants Gemini Flash-Lite):
  // widen to every tier before giving up, keeping the requested effort.
  if (!out.length) {
    [...TIERS.strong, ...TIERS.top, ...TIERS.fast, ...TIERS.lite].filter(allowed).forEach((p, i) => add(p[0], pick(p), prefs.length + i));
  }
  if (!out.length) {
    for (const [runtime] of TIERS.top) add(runtime, byRuntime.get(runtime)?.models.find((m) => ok(runtime, m.id)), 1000);
  }
  return out.sort((a, b) => a.score - b.score).map((x) => x.r);
}

export const route = (role: Role, catalogs: RuntimeCatalog[], opts: RouteOpts = {}): Routed | null => rank(role, catalogs, opts)[0] ?? null;

const NETWORK_RE = /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT|socket hang up|getaddrinfo|network (error|is unreachable|connection)|internet connection|could not resolve host|connection (reset|closed|error|lost|timed out)|you are offline|stream disconnected/i;
const LIMIT_RE = /rate.?limit|usage limit|quota|limit reached|too many requests|\b429\b|overloaded|resource.?exhausted|exceeded/i;
const CREDIT_RE = /more credits|insufficient (credits|funds|balance)|billing|payment required|\b402\b/i;
const MODEL_RE = /not found|does not exist|no access|not supported|requires a newer version|age confirmation|attestation|not available|unknown model|invalid model|\b40[34]\b/i;

export type Failure = 'network' | 'limit' | 'credits' | 'model' | 'other';

/** What a provider error means for routing: wait for the connection, rest the pool, or drop just this model. */
export function classifyError(message: string): Failure {
  if (NETWORK_RE.test(message)) return 'network';
  if (CREDIT_RE.test(message)) return 'credits';
  if (LIMIT_RE.test(message)) return 'limit';
  if (MODEL_RE.test(message)) return 'model';
  return 'other';
}

export const isLimitError = (message: string) => classifyError(message) === 'limit';
/** Another model can help; a lost connection or a bug in the task can't be fixed by switching. */
export const shouldSwitch = (message: string) => ['limit', 'credits', 'model'].includes(classifyError(message));
