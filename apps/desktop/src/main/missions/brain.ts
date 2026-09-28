import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mission } from '@shared/missions';

const BRAIN_HOME = join(homedir(), '.brain-sync');

/** Hands the finished mission to brain-sync, which owns the Obsidian vault and renders the note. */
export function recordMission(m: Mission, workspacePath: string, home = BRAIN_HOME) {
  const dir = join(home, 'missions');
  mkdirSync(dir, { recursive: true });
  const record = {
    id: m.id, goal: m.goal, status: m.status, workspacePath, workspaceName: m.workspaceName, quality: m.quality, planner: m.planner,
    tasks: m.tasks.map(({ id, title, status, coder, reviewer, note }) => ({ id, title, status, coder, reviewer, note })),
    checks: m.checks, report: m.report, error: m.error, usage: m.usage, createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
  writeFileSync(join(dir, `${m.id}.json`), JSON.stringify(record, null, 2));
  const bin = join(home, 'bin', 'brain-sync');
  if (existsSync(bin)) spawn(bin, ['sync', '--quiet'], { detached: true, stdio: 'ignore' }).unref();
}
