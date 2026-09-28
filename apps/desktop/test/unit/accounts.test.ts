import { describe, expect, it } from 'vitest';
import { Accounts, parseClaudeStatus, parseCodexStatus, parseOmpModels, type Run } from '../../src/main/accounts';

describe('status parsers (real CLI output shapes)', () => {
  it('claude auth status', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}')).toEqual({ signedIn: true, plan: 'Claude Pro' });
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}').plan).toBe('Claude Max');
    expect(parseClaudeStatus('{"loggedIn":false}')).toEqual({ signedIn: false, plan: null });
    expect(parseClaudeStatus('garbage')).toEqual({ signedIn: null, plan: null });
  });
  it('codex login status', () => {
    expect(parseCodexStatus('Logged in using ChatGPT')).toEqual({ signedIn: true, plan: 'ChatGPT subscription' });
    expect(parseCodexStatus('Logged in using an API key')).toEqual({ signedIn: true, plan: 'an API key' });
    expect(parseCodexStatus('Not logged in')).toEqual({ signedIn: false, plan: null });
  });
  it('omp models --json', () => {
    const out = JSON.stringify([{ provider: 'google-antigravity' }, { provider: 'google-antigravity' }, { provider: 'anthropic' }]);
    expect(parseOmpModels(out)).toEqual({ signedIn: true, plan: 'google-antigravity · 2 models, anthropic · 1 models' });
    expect(parseOmpModels('[]')).toEqual({ signedIn: false, plan: null });
  });
});

describe('Accounts', () => {
  it('reports missing CLIs as not installed without running them', async () => {
    const calls: string[] = [];
    const which = async (bin: string) => (bin === 'codex' ? '/opt/homebrew/bin/codex' : null);
    const run: Run = async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (args[0] === '--version') return { ok: true, out: 'codex-cli 0.155.1' };
      if (args.join(' ') === 'login status') return { ok: true, out: 'Logged in using ChatGPT' };
      return { ok: false, out: '' };
    };
    const list = await new Accounts(run, which).list();
    expect(list.find((a) => a.id === 'codex')).toMatchObject({ installed: true, signedIn: true, version: '0.155.1' });
    expect(list.find((a) => a.id === 'antigravity')).toMatchObject({ installed: false, signedIn: false });
    expect(calls.every((c) => c.startsWith('/opt/homebrew/bin/codex'))).toBe(true);
  });
});
