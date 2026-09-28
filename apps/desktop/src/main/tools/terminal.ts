import { randomUUID } from 'node:crypto';
import type { CommandRun } from '@shared/workspace';

const KEEP = 200;
const FLUSH_MS = 150;
const MAX_OUTPUT = 60_000;

export type TerminalBatch = { runs: CommandRun[] };

// Every command an agent runs, whichever runtime ran it, lands in one feed for the Terminal app.
export class TerminalFeed {
  private runs: CommandRun[] = [];
  private dirty = new Map<string, CommandRun>();
  private timer?: NodeJS.Timeout;
  private send: (b: TerminalBatch) => void;

  constructor(send: (b: TerminalBatch) => void) {
    this.send = send;
  }

  start(sessionId: string, agent: string, cwd: string, command: string, id: string = randomUUID()): string {
    const existing = this.runs.find((r) => r.id === id);
    if (existing) return id;
    const run: CommandRun = { id, sessionId, agent, cwd, command: command.replace(/^\$\s+/, ''), output: '', exitCode: null, startedAt: Date.now() };
    this.runs.push(run);
    if (this.runs.length > KEEP) this.runs.splice(0, this.runs.length - KEEP);
    this.touch(run);
    return id;
  }

  append(id: string, chunk: string) {
    const r = this.runs.find((x) => x.id === id);
    if (!r || r.output.length >= MAX_OUTPUT) return;
    r.output += chunk.slice(0, MAX_OUTPUT - r.output.length);
    this.touch(r);
  }

  finish(id: string, exitCode: number | null, output?: string) {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    if (output !== undefined && !r.output) r.output = output.slice(0, MAX_OUTPUT);
    r.exitCode = exitCode ?? -1;
    this.touch(r);
  }

  history(): CommandRun[] {
    return this.runs;
  }

  private touch(r: CommandRun) {
    this.dirty.set(r.id, r);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const runs = [...this.dirty.values()].map((x) => ({ ...x }));
      this.dirty.clear();
      this.send({ runs });
    }, FLUSH_MS);
  }
}
