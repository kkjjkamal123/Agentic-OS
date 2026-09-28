import { describe, expect, it } from 'vitest';
import type { ModelInfo, RuntimeCatalog } from '@shared/agents';
import { classifyError, isLimitError, paramsB, poolOf, rank, route } from '../../src/main/agents/router';

const cat = (runtime: RuntimeCatalog['runtime'], models: (string | ModelInfo)[], available = true): RuntimeCatalog => ({
  runtime, available, models: models.map((m) => (typeof m === 'string' ? { id: m, name: m } : m)),
});
const ag = (m: string) => `google-antigravity/${m}`;

// Exactly what the real CLIs report on this Mac (Claude Code's aliases carry the version only in the name).
const CLAUDE_CODE = cat('claude-code', [
  { id: 'default', name: 'Default (recommended)' }, { id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' }, { id: 'haiku', name: 'Haiku 4.5' }, { id: 'claude-opus-5', name: 'Opus 5' },
  { id: 'claude-fable-5', name: 'Fable 5' }, { id: 'claude-opus-4-8', name: 'Opus 4.8' }, { id: 'claude-opus-4-7', name: 'Opus 4.7' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
]);
const CODEX = cat('codex', ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
const OMP = cat('omp', [
  'claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite', 'gemini-3.1-pro',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gpt-oss-120b', 'tab_flash_lite_preview',
].map(ag));
const machine = [CLAUDE_CODE, CODEX, OMP, cat('antigravity', [], false)];
const noClaudeCode = [CODEX, OMP];

describe('model choice per role and usage level', () => {
  it('balanced: Opus 5.5 (the alias, not Opus 5) plans and reviews, Sonnet 5 codes', () => {
    expect(route('plan', machine)).toEqual({ runtime: 'claude-code', model: 'opus', effort: 'high' });
    expect(route('code', machine)).toEqual({ runtime: 'claude-code', model: 'sonnet', effort: 'medium' });
    expect(route('test', machine)).toEqual({ runtime: 'claude-code', model: 'haiku', effort: 'low' });
    expect(route('summarize', machine)).toEqual({ runtime: 'omp', model: ag('gemini-3.5-flash-lite'), effort: 'low' });
  });

  it('max quality: Fable 5.1 plans at max effort, Opus codes normal tasks, Fable takes hard ones', () => {
    expect(route('plan', machine, { quality: 'max' })).toEqual({ runtime: 'claude-code', model: 'claude-fable-5-1', effort: 'max' });
    expect(route('code', machine, { quality: 'max' })).toEqual({ runtime: 'claude-code', model: 'opus', effort: 'high' });
    expect(route('code', machine, { quality: 'max', complexity: 'hard' })).toMatchObject({ model: 'claude-fable-5-1', effort: 'max' });
  });

  it('saver: no Opus or Fable, low effort, fast models for light tasks', () => {
    expect(route('plan', machine, { quality: 'saver' })).toEqual({ runtime: 'claude-code', model: 'sonnet', effort: 'medium' });
    expect(route('code', machine, { quality: 'saver', complexity: 'light' })).toEqual({ runtime: 'claude-code', model: 'haiku', effort: 'low' });
    expect(rank('plan', machine, { quality: 'saver' }).some((r) => /opus|fable/.test(r.model))).toBe(false);
  });

  it('balanced routes by task difficulty', () => {
    expect(route('code', machine, { complexity: 'light' })).toMatchObject({ model: 'haiku' });
    expect(route('code', machine, { complexity: 'hard' })).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('never picks Fable outside max, the "default" alias, or 1M variants', () => {
    for (const role of ['plan', 'review', 'code', 'chat'] as const) {
      expect(rank(role, machine).some((r) => /fable|^default$|\[1m\]/.test(r.model))).toBe(false);
    }
  });

  it('newest versions win without hard-coded numbers', () => {
    expect(route('plan', noClaudeCode)).toMatchObject({ runtime: 'omp', model: ag('claude-opus-4-6') });
    expect(route('code', noClaudeCode)).toMatchObject({ runtime: 'omp', model: ag('claude-sonnet-4-6') });
    expect(route('test', noClaudeCode)).toMatchObject({ runtime: 'omp', model: ag('gemini-3.8-flash') });
    expect(route('review', noClaudeCode, { avoidVendor: 'anthropic' })).toMatchObject({ runtime: 'codex', model: 'gpt-5.6-terra' });
  });
});

describe('spreading and failures', () => {
  it('review goes to a different vendor than the coder', () => {
    expect(route('review', machine, { avoidVendor: 'anthropic' })).toMatchObject({ runtime: 'codex', model: 'gpt-5.6-terra' });
    expect(route('review', machine, { avoidVendor: 'openai' })).toMatchObject({ runtime: 'claude-code', model: 'opus' });
    expect(route('review', [CODEX, OMP], { avoidVendor: 'openai' })).toMatchObject({ runtime: 'omp', model: ag('claude-opus-4-6') });
  });

  it('spreads parallel work across subscription pools', () => {
    const pick = (load: Record<string, number>) => route('code', machine, { load });
    expect(pick({})).toMatchObject({ runtime: 'claude-code' });
    expect(pick({ 'claude-subscription': 1 })).toMatchObject({ runtime: 'omp', model: ag('claude-sonnet-4-6') });
    expect(pick({ 'claude-subscription': 1, antigravity: 1 })).toMatchObject({ runtime: 'codex', model: 'gpt-5.6-terra' });
  });

  it('skips a pool that hit its usage limit, and excluded models', () => {
    expect(route('plan', machine, { cooling: new Set(['claude-subscription']) })).toMatchObject({ runtime: 'omp', model: ag('claude-opus-4-6') });
    expect(rank('plan', machine, { cooling: new Set(['claude-subscription', 'antigravity']) })[0]).toMatchObject({ runtime: 'codex' });
    expect(route('plan', machine, { exclude: new Set(['claude-code|opus']) })).toMatchObject({ runtime: 'claude-code', model: 'claude-opus-5' });
  });

  it('widens to other tiers when the requested one has nothing', () => {
    expect(route('summarize', [CLAUDE_CODE])).toMatchObject({ runtime: 'claude-code', model: 'haiku' });
    expect(route('test', [cat('codex', ['gpt-5.6-terra'])])).toMatchObject({ runtime: 'codex', model: 'gpt-5.6-terra', effort: 'low' });
    expect(route('chat', [cat('omp', ['acme/new-model-x'])])).toMatchObject({ runtime: 'omp', model: 'acme/new-model-x' });
    expect(route('chat', [cat('codex', ['gpt-5.6-terra'], false)])).toBeNull();
  });

  it('classifies real provider errors', () => {
    expect(classifyError('This request requires more credits, or fewer max_tokens.')).toBe('credits');
    expect(classifyError('This model requires you to complete the following before use: 18+ age confirmation.')).toBe('model');
    expect(classifyError("Function 'b0fcd392': Not found for account 'hU16'")).toBe('model');
    expect(classifyError("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.")).toBe('model');
    expect(isLimitError("You've hit your usage limit")).toBe(true);
    expect(classifyError('ENOENT: no such file')).toBe('other');
    expect(poolOf({ runtime: 'omp', model: ag('claude-opus-4-6') })).toBe('antigravity');
    expect(poolOf({ runtime: 'antigravity', model: 'gemini-3.1-pro' })).toBe('antigravity');
  });
});

describe('APIs and open catalogs', () => {
  it('Anthropic API: Opus 5.5 for balanced planning, Fable 5.1 for max', () => {
    const api = [cat('anthropic', ['claude-opus-4-1', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'])];
    expect(route('plan', api)).toMatchObject({ model: 'claude-opus-5-5' });
    expect(route('plan', api, { quality: 'max' })).toMatchObject({ model: 'claude-fable-5-1' });
    expect(route('code', api)).toMatchObject({ model: 'claude-sonnet-5' });
  });

  it('OpenRouter never auto-picks aliases or unknown newest models', () => {
    const or = [cat('openrouter', ['~openai/gpt-astra-latest', 'meta/muse-spark-1.3-contributor', 'anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5', 'google/gemini-3.5-flash'])];
    expect(route('plan', or)).toMatchObject({ model: 'anthropic/claude-opus-4.6' });
    expect(route('code', or)).toMatchObject({ model: 'anthropic/claude-sonnet-4.6' });
    expect(route('summarize', or)?.model).toMatch(/haiku|flash/);
  });

  const NIM = [
    'mistralai/mistral-nemotron', 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3.5-lightning-30b-a3b',
    'nvidia/nemotron-nano-3-30b-a3b', 'deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'meta/llama-3.1-8b-instruct',
    'qwen/qwen3-coder-480b-a35b-instruct',
  ];

  it('NVIDIA NIM is classified by size and tier words', () => {
    const nim = [cat('nvidia', NIM)];
    expect(route('plan', nim)).toMatchObject({ runtime: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' });
    expect(route('code', nim)).toMatchObject({ model: 'qwen/qwen3-coder-480b-a35b-instruct' });
    expect(route('test', nim)?.model).toMatch(/lightning|nano|flash/);
    expect(route('plan', [cat('nvidia', [...NIM, 'nvidia/nemotron-4-ultra-1000b-a90b'])])).toMatchObject({ model: 'nvidia/nemotron-4-ultra-1000b-a90b' });
  });

  it('paramsB reads total, not active, parameters', () => {
    expect(paramsB('nvidia/nemotron-3-ultra-550b-a55b')).toBe(550);
    expect(paramsB('meta/llama-3.1-405b-instruct')).toBe(405);
    expect(paramsB('qwen2.5-coder:7b')).toBe(7);
    expect(paramsB('moonshotai/kimi-k3')).toBeNull();
  });
});

describe('Antigravity CLI (agy)', () => {
  // Grouped exactly as parseAgyModels groups the real `agy models` output.
  const AGY = cat('antigravity', [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
  ]);

  it('is preferred over omp for Gemini, and shares the Antigravity quota pool with it', () => {
    expect(route('test', [AGY, OMP])).toMatchObject({ runtime: 'antigravity', model: 'gemini-3.8-flash' });
    expect(route('review', [AGY, OMP, CODEX], { avoidVendor: 'anthropic', cooling: new Set(['chatgpt-subscription']) })).toMatchObject({ runtime: 'antigravity', model: 'gemini-3.1-pro' });
    // Cooling the shared pool takes both omp and agy out.
    expect(rank('test', [AGY, OMP], { cooling: new Set(['antigravity']) })).toEqual([]);
  });

  it('its Claude models count as Anthropic for cross-vendor review', () => {
    const r = rank('review', [AGY], { avoidVendor: 'anthropic' });
    expect(r.some((x) => /claude/.test(x.model))).toBe(false);
    expect(r[0]).toMatchObject({ model: 'gemini-3.1-pro' });
  });
});
