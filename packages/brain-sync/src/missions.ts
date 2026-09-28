import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionRecord } from './types.ts';

export function loadMissions(dir: string): MissionRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: MissionRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')));
    } catch {}
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
