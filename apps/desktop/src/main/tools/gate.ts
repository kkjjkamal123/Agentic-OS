import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ApprovalMode } from '@shared/settings';
import type { ApprovalAnswer, ApprovalRequest, GateAction, Verdict } from '@shared/workspace';

const HOME = homedir();

const BLOCKED: [RegExp, string][] = [
  [/(^|[;&|]\s*)sudo\b/, 'sudo is never allowed'],
  [/\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|~|\$HOME)(\/?\s|\/?$)/i, 'deletes the whole disk or home folder'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes a download straight into a shell'],
  [/\bmkfs\b|\bdiskutil\s+(erase|partition|zero)/, 'formats a disk'],
  [/\bdd\b[^;&|]*\bof=\/dev\//, 'writes raw to a device'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\b(shutdown|reboot|halt)\b/, 'powers off the Mac'],
  [/\bsecurity\s+(find|dump|delete|export)-/, 'reads the Keychain'],
  [/\b(csrutil|spctl\s+--master-disable|launchctl)\b/, 'changes system security or services'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, 'opens up the whole disk'],
];

const RISKY: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'publishes a package'],
  [/\b(vercel|netlify|fly|flyctl|heroku|firebase|wrangler)\b.*\bdeploy\b|\bgh\s+release\b/, 'deploys or releases'],
  [/\bdocker\s+(push|system\s+prune)\b/, 'pushes or prunes Docker'],
  [/\bosascript\b/, 'controls other apps'],
];

const SENSITIVE = ['.ssh', '.aws', '.gnupg', 'Library/Keychains', '.netrc', '.config/gh', '.codex/auth.json', '.claude/.credentials.json', '.docker/config.json', '.kube']
  .map((p) => resolve(HOME, p));

// Agents report real paths (/private/var/...) while roots may be symlinked (/var/...); compare canonical forms.
export function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(p);
      tail.push(basename(head));
      head = up;
    }
  }
}

const TMP = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/dev/null', '/dev/stdout', '/dev/stderr'];
// Toolchains and system files that commands commonly reference by absolute path to read or run.
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/opt/homebrew', '/opt/local', '/Library', '/System', '/Applications', '/etc', '/private/etc', '/dev', '/nix'];
const MUTATING = /(^|[\s;&|(])(rm|rmdir|mv|cp|ln|chmod|chown|chflags|dd|truncate|tee|install|rsync|unlink|mkdir|touch|shred|git\s+(clean|reset|checkout|restore)|sed\s+-i)\b|>{1,2}\s*[^&\s]/;

/**
 * Agent CLIs run shell commands in their own process, so the gate has to read paths out of the
 * command text: `rm -rf ~/Documents/x` names no `paths`, but it clearly reaches outside.
 */
export function commandPaths(command: string, root: string): string[] {
  const out = new Set<string>();
  for (const raw of command.split(/[\s;&|()<>=`'"]+/)) {
    let tok = raw.replace(/^\$\{?HOME\}?/, HOME).replace(/^~(?=\/|$)/, HOME);
    if (!tok || tok.startsWith('-') || /^[a-z]+:\/\//i.test(tok)) continue;
    if (tok.startsWith('/') || tok.startsWith('..')) out.add(canonical(isAbsolute(tok) ? tok : resolve(root, tok)));
    else if (tok.includes('/../')) out.add(canonical(resolve(root, tok)));
  }
  return [...out];
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);
const isSensitive = (p: string) => SENSITIVE.some((s) => inside(p, s));

export function decide(action: GateAction, root: string, mode: ApprovalMode): Verdict {
  const cmd = action.command?.trim();
  if (cmd) {
    for (const [re, why] of BLOCKED) if (re.test(cmd)) return { decision: 'deny', reason: `Blocked: ${why}` };
  }
  root = canonical(root);
  const paths = (action.paths ?? []).map((p) => canonical(isAbsolute(p) ? p : resolve(root, p)));
  if (cmd) {
    const mutating = MUTATING.test(cmd);
    for (const p of commandPaths(cmd, root)) {
      if (inside(p, root) || TMP.some((t) => inside(p, t))) continue;
      if (!mutating && SYSTEM_READ.some((t) => inside(p, t))) continue;
      paths.push(p);
    }
  }
  const secret = paths.find(isSensitive) ?? (cmd && SENSITIVE.find((s) => cmd.includes(s) || cmd.includes(s.replace(HOME, '~'))));
  if (secret) return { decision: 'ask', reason: `Touches private credentials (${secret.replace(HOME, '~')})` };
  if (mode === 'yolo') return { decision: 'allow' };

  const outside = paths.find((p) => !inside(p, root));
  const risky = cmd && RISKY.find(([re]) => re.test(cmd));
  if (risky) return { decision: 'ask', reason: `Command ${risky[1]}` };

  if (mode === 'ask') {
    if (action.kind === 'read' && !outside) return { decision: 'allow' };
    return { decision: 'ask', reason: outside ? `Works outside the workspace (${outside.replace(HOME, '~')})` : 'Approval policy: ask every time' };
  }
  if (outside) return { decision: 'ask', reason: `${action.kind === 'read' ? 'Reads' : 'Changes'} files outside the workspace (${outside.replace(HOME, '~')})` };
  return { decision: 'allow' };
}

// "Allow for this session" covers the same kind of action with the same program or folder.
export function grantKey(a: GateAction): string {
  if (a.command) return `${a.kind}:${a.command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  return `${a.kind}:${a.paths?.[0] ? dirname(a.paths[0]) : a.title ?? ''}`;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (ok: boolean) => void;
}

export interface GateDeps {
  mode: () => ApprovalMode;
  ask: (req: ApprovalRequest) => void;
  resolved: (id: string, pendingCount: number) => void;
}

export class Gate {
  private pending = new Map<string, Pending>();
  private grants = new Map<string, Set<string>>();
  private d: GateDeps;

  constructor(deps: GateDeps) {
    this.d = deps;
  }

  async check(sessionId: string, agent: string, root: string, action: GateAction): Promise<boolean> {
    const v = decide(action, root, this.d.mode());
    if (v.decision === 'allow') return true;
    if (v.decision === 'deny') return false;
    if (this.grants.get(sessionId)?.has(grantKey(action))) return true;
    const req: ApprovalRequest = { id: randomUUID(), sessionId, agent, action, reason: v.reason };
    return new Promise((resolveOk) => {
      this.pending.set(req.id, { req, resolve: resolveOk });
      this.d.ask(req);
    });
  }

  answer(id: string, ans: ApprovalAnswer) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (ans === 'session') {
      const set = this.grants.get(p.req.sessionId) ?? new Set();
      set.add(grantKey(p.req.action));
      this.grants.set(p.req.sessionId, set);
    }
    p.resolve(ans !== 'deny');
    this.d.resolved(id, this.pending.size);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  dropSession(sessionId: string) {
    this.grants.delete(sessionId);
    for (const [id, p] of this.pending) if (p.req.sessionId === sessionId) this.answer(id, 'deny');
  }
}
