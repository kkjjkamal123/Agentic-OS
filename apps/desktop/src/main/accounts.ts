import { ACCOUNTS, type AccountId, type AccountStatus } from '@shared/accounts';
import { forgetWhich, run as defaultRun, which as defaultWhich, type ExecResult } from './env';

export type Run = (file: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;
export type Which = (bin: string) => Promise<string | null>;
type Parsed = Pick<AccountStatus, 'signedIn' | 'plan'>;

const PLAN_NAMES: Record<string, string> = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

export function parseClaudeStatus(out: string): Parsed {
  try {
    const s = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (!s.loggedIn) return { signedIn: false, plan: null };
    const plan = s.subscriptionType ? (PLAN_NAMES[s.subscriptionType] ?? `Claude ${s.subscriptionType}`) : s.authMethod === 'claude.ai' ? 'Claude subscription' : 'API key';
    return { signedIn: true, plan };
  } catch {
    return { signedIn: null, plan: null };
  }
}

export function parseCodexStatus(out: string): Parsed {
  if (/not logged in/i.test(out)) return { signedIn: false, plan: null };
  const m = out.match(/logged in using (.+)/i);
  if (!m) return { signedIn: null, plan: null };
  const how = m[1].trim().replace(/\.$/, '');
  return { signedIn: true, plan: /chatgpt/i.test(how) ? 'ChatGPT subscription' : how };
}

// `omp models --json` only lists models from providers omp can authenticate with.
export function parseOmpModels(out: string): Parsed {
  try {
    const d = JSON.parse(out.slice(out.search(/[[{]/)));
    const items: { provider?: string }[] = Array.isArray(d) ? d : (d.models ?? []);
    const counts = new Map<string, number>();
    for (const m of items) if (m.provider) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    if (!counts.size) return { signedIn: false, plan: null };
    return { signedIn: true, plan: [...counts].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} · ${n} models`).join(', ') };
  } catch {
    return { signedIn: null, plan: null };
  }
}

// `agy models` lists models only when signed in.
export function parseAgyStatus(out: string): Parsed {
  const n = out.split('\n').filter((l) => /^\S+\t.+/.test(l)).length;
  if (n) return { signedIn: true, plan: `Google Antigravity · ${n} models` };
  return /sign in|log ?in|auth|unauthori[sz]ed|credential/i.test(out) ? { signedIn: false, plan: null } : { signedIn: null, plan: null };
}

const STATUS: Record<AccountId, { args: string[]; parse: (out: string) => Parsed } | null> = {
  'claude-code': { args: ['auth', 'status'], parse: parseClaudeStatus },
  codex: { args: ['login', 'status'], parse: parseCodexStatus },
  omp: { args: ['models', '--json'], parse: parseOmpModels },
  antigravity: { args: ['models'], parse: parseAgyStatus },
};

export class Accounts {
  private cache: Promise<AccountStatus[]> | null = null;
  private run: Run;
  private which: Which;

  constructor(run: Run = defaultRun, which: Which = defaultWhich) {
    this.run = run;
    this.which = which;
  }

  private loginStarted = 0;

  list(refresh = false): Promise<AccountStatus[]> {
    if (refresh) forgetWhich();
    if (refresh || !this.cache) this.cache = Promise.all(ACCOUNTS.map((a) => this.detect(a.id)));
    return this.cache;
  }

  /** Called when a sign-in/install Terminal is opened; the next app focus re-checks accounts. */
  noteLoginStarted() {
    this.loginStarted = Date.now();
  }

  /** True once per sign-in attempt within 15 minutes, so focusing the app refreshes status. */
  shouldRefreshOnFocus(): boolean {
    if (!this.loginStarted || Date.now() - this.loginStarted > 15 * 60_000) return false;
    this.loginStarted = 0;
    return true;
  }

  private async detect(id: AccountId): Promise<AccountStatus> {
    const def = ACCOUNTS.find((a) => a.id === id)!;
    const bin = await this.which(def.bin);
    if (!bin) return { id, installed: false, signedIn: false, plan: null, version: null };
    const st = STATUS[id];
    const [ver, status] = await Promise.all([this.run(bin, ['--version'], 10_000), st ? this.run(bin, st.args, 20_000) : null]);
    const version = ver.ok ? (ver.out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null) : null;
    if (!st || !status) return { id, installed: true, signedIn: null, plan: null, version };
    return { id, installed: true, version, ...st.parse(status.out) };
  }
}
