import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { Routed, RuntimeId } from '@shared/agents';
import type { Emit } from './acp';

export const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

export type ApiRuntime = Exclude<RuntimeId, 'claude-code' | 'codex' | 'omp' | 'antigravity'>;

export function languageModel(runtime: ApiRuntime, model: string, key: string | undefined, ollamaBase: string): LanguageModel {
  switch (runtime) {
    case 'anthropic': return createAnthropic({ apiKey: key })(model);
    case 'openai': return createOpenAI({ apiKey: key })(model);
    case 'google': return createGoogleGenerativeAI({ apiKey: key })(model);
    case 'openrouter': return createOpenRouter({ apiKey: key })(model);
    case 'nvidia': return createOpenAICompatible({ name: 'nvidia', baseURL: NVIDIA_BASE, apiKey: key })(model);
    case 'ollama': return createOllama({ baseURL: `${ollamaBase.replace(/\/$/, '')}/api` })(model);
  }
}

const THINKING_BUDGET: Record<Routed['effort'], number> = { low: 0, medium: 2048, high: 8192, max: 16384 };

// Claude 4.6+ (Sonnet 5, Opus 5.x, Fable) reject `budgetTokens` with a 400: they take adaptive
// thinking plus an effort level. Only Haiku 4.5 and older still use a token budget.
export function anthropicThinking(model: string, effort: Routed['effort']) {
  if (/haiku-4|claude-3|sonnet-4-5|opus-4-[015]\b/.test(model)) {
    return THINKING_BUDGET[effort] ? { anthropic: { thinking: { type: 'enabled' as const, budgetTokens: THINKING_BUDGET[effort] } } } : undefined;
  }
  return { anthropic: { thinking: { type: 'adaptive' as const }, effort } };
}
const MAX_STEPS = 40;

function toolTitle(name: string, input: unknown): string {
  const i = (input ?? {}) as { path?: string; command?: string };
  return i.command ?? (i.path ? `${name.replace('_', ' ')} ${i.path}` : name);
}

export class NativeSession {
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private model: LanguageModel;
  private runtime: ApiRuntime;
  private system: string;
  private effort: Routed['effort'];
  private tools?: (signal: AbortSignal) => ToolSet;
  private modelId: string;

  constructor(model: LanguageModel, runtime: ApiRuntime, system: string, effort: Routed['effort'], tools?: (signal: AbortSignal) => ToolSet, modelId = '') {
    this.model = model;
    this.modelId = modelId;
    this.runtime = runtime;
    this.system = system;
    this.effort = effort;
    this.tools = tools;
  }

  async prompt(text: string, emit: Emit): Promise<void> {
    this.history.push({ role: 'user', content: text });
    this.abort = new AbortController();
    try {
      const result = streamText({
        model: this.model,
        abortSignal: this.abort.signal,
        // Byte-identical every turn so provider prompt caches hit.
        instructions: { role: 'system', content: this.system, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        messages: this.history,
        tools: this.tools?.(this.abort.signal),
        // Providers reserve credit for the full output cap; 64k defaults fail on small balances.
        maxOutputTokens: this.effort === 'max' ? 32_000 : 12_000,
        onError: () => {},
        stopWhen: isStepCount(MAX_STEPS),
        providerOptions: this.runtime === 'anthropic' ? anthropicThinking(this.modelId, this.effort) : undefined,
      });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          emit({ t: 'text', text: part.text });
        } else if (part.type === 'tool-call') {
          emit({ t: 'tool', id: part.toolCallId, title: toolTitle(part.toolName, part.input), kind: part.toolName, status: 'in_progress' });
        } else if (part.type === 'tool-result') {
          emit({ t: 'tool', id: part.toolCallId, status: 'completed' });
        } else if (part.type === 'tool-error') {
          emit({ t: 'tool', id: part.toolCallId, status: 'failed', output: String(part.error) });
        } else if (part.type === 'reasoning-delta') {
          emit({ t: 'thought', text: part.text });
        } else if (part.type === 'error') {
          throw part.error;
        } else if (part.type === 'finish') {
          const u = part.totalUsage;
          emit({ t: 'usage', input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.inputTokenDetails?.cacheReadTokens });
          emit({ t: 'done', stop: part.finishReason });
        }
      }
      this.history.push(...(await result.response).messages);
    } catch (e) {
      this.history.pop();
      emit(this.abort?.signal.aborted ? { t: 'done', stop: 'cancelled' } : { t: 'error', message: (e as Error).message });
    } finally {
      this.abort = null;
    }
  }

  cancel() {
    this.abort?.abort();
  }

  dispose() {
    this.cancel();
  }
}
