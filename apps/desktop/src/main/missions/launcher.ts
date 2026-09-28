import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Mission, RunSpec, TestState } from '@shared/missions';
import { agentEnv } from '../env';
import { runInTerminal, shellQuote } from '../terminalApp';
import { runSandboxed } from '../tools/sandbox';
import type { TerminalFeed } from '../tools/terminal';

const START_TIMEOUT_MS = 45_000;

/** Opens a URL somewhere the user can see it; Electron's BrowserWindow in the app, a stub in tests. */
export type Show = (url: string, title: string, onClose: () => void) => { close(): void };
export type OpenApp = (path: string) => Promise<void>;

export interface LauncherDeps {
  feed: TerminalFeed;
  show: Show;
  openApp: OpenApp;
  send: (s: TestState) => void;
  terminal?: (command: string) => Promise<void>;
}

async function waitFor(url: string, signal: AbortSignal): Promise<boolean> {
  const until = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < until && !signal.aborted) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

export function describeRun(run: RunSpec): string {
  if (run.kind === 'macos-app') return `Mac app ${run.open ?? ''}`.trim();
  if (run.kind === 'cli') return `Terminal: ${run.start ?? ''}`.trim();
  return run.start ? `Web app: ${run.start} → ${run.url ?? ''}` : `Web app: ${run.open ?? 'index.html'}`;
}

const inside = (root: string, rel: string) => {
  const p = join(root, rel);
  return p.startsWith(root) ? p : null;
};

export class Launcher {
  private live = new Map<string, { abort: AbortController; view?: { close(): void } }>();
  private d: LauncherDeps;

  constructor(deps: LauncherDeps) {
    this.d = deps;
  }

  /** Part of verification: the product must actually start, not just compile. */
  async check(run: RunSpec | undefined, root: string, sessionId: string): Promise<{ ok: true } | { ok: false; output: string }> {
    if (!run) return { ok: true };
    if (run.open) {
      const p = inside(root, run.open);
      if (!p || !existsSync(p)) return { ok: false, output: `The launch target ${run.open} does not exist after the build.` };
      if (run.kind === 'macos-app' && !(statSync(p).isDirectory() && existsSync(join(p, 'Contents', 'MacOS')))) {
        return { ok: false, output: `${run.open} is not a runnable .app bundle (missing Contents/MacOS).` };
      }
      return { ok: true };
    }
    if (run.kind === 'web' && run.start && run.url) {
      const abort = new AbortController();
      const id = this.d.feed.start(sessionId, 'Launch check', root, run.start);
      const proc = runSandboxed(run.start, root, await agentEnv(), { signal: abort.signal, timeoutMs: START_TIMEOUT_MS + 5_000, onData: (c) => this.d.feed.append(id, c) });
      const up = await waitFor(run.url, abort.signal);
      abort.abort();
      const r = await proc;
      this.d.feed.finish(id, up ? 0 : (r.exitCode ?? 1));
      return up ? { ok: true } : { ok: false, output: `Started \`${run.start}\` but ${run.url} never responded.\n${r.output.slice(-4000)}` };
    }
    return { ok: true };
  }

  isRunning(id: string) {
    return this.live.has(id);
  }

  async test(m: Mission, root: string): Promise<void> {
    this.stop(m.id);
    const run = m.run;
    const send = (state: TestState['state'], extra: Partial<TestState> = {}) => this.d.send({ missionId: m.id, state, ...extra });
    if (!run) return send('error', { message: 'This mission has no launch instructions. Run it again to get them.' });
    const title = `Test · ${m.product ?? m.goal}`.slice(0, 120);
    send('starting', { message: describeRun(run) });

    if (run.kind === 'macos-app' && run.open) {
      const p = inside(root, run.open);
      if (!p || !existsSync(p)) return send('error', { message: `${run.open} was not found; the build may have failed.` });
      await this.d.openApp(p);
      return send('running', { message: `Launched ${run.open}` });
    }
    if (run.kind === 'cli' && run.start) {
      // CLI programs often need a keyboard: give them a real terminal.
      await (this.d.terminal ?? runInTerminal)(`cd ${shellQuote(root)} && ${run.start}`);
      return send('running', { message: 'Opened in Terminal' });
    }
    if (run.start && run.url) {
      const abort = new AbortController();
      const entry: { abort: AbortController; view?: { close(): void } } = { abort };
      this.live.set(m.id, entry);
      const id = this.d.feed.start(m.id, 'Test', root, run.start);
      void runSandboxed(run.start, root, await agentEnv(), { signal: abort.signal, timeoutMs: 12 * 60 * 60_000, onData: (c) => this.d.feed.append(id, c) }).then((r) => {
        this.d.feed.finish(id, r.exitCode);
        if (this.live.get(m.id) === entry) {
          this.live.delete(m.id);
          entry.view?.close();
          send(abort.signal.aborted ? 'stopped' : 'error', { message: abort.signal.aborted ? undefined : `The app stopped (exit ${r.exitCode}). See Terminal.` });
        }
      });
      if (!(await waitFor(run.url, abort.signal))) {
        this.stop(m.id);
        return send('error', { message: `${run.url} did not respond within ${START_TIMEOUT_MS / 1000}s. See Terminal for the output.` });
      }
      entry.view = this.d.show(run.url, title, () => this.stop(m.id));
      return send('running', { url: run.url });
    }
    const p = inside(root, run.open ?? 'index.html');
    if (!p || !existsSync(p)) return send('error', { message: `${run.open ?? 'index.html'} was not found.` });
    const url = pathToFileURL(p).href;
    const entry = { abort: new AbortController(), view: undefined as { close(): void } | undefined };
    this.live.set(m.id, entry);
    entry.view = this.d.show(url, title, () => this.stop(m.id));
    send('running', { url });
  }

  stop(id: string) {
    const e = this.live.get(id);
    if (!e) return;
    this.live.delete(id);
    e.abort.abort();
    e.view?.close();
    this.d.send({ missionId: id, state: 'stopped' });
  }

  stopAll() {
    for (const id of [...this.live.keys()]) this.stop(id);
  }
}
