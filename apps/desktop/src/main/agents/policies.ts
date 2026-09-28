import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@shared/agents';

export const CAVEMAN_PATH = join(homedir(), '.claude/skills/caveman/SKILL.md');
export const PONYTAIL_PATH = join(homedir(), '.claude/plugins/marketplaces/ponytail/AGENTS.md');

const CAVEMAN_FALLBACK = `Respond terse. All technical substance stay, fluff die. Drop articles, filler, pleasantries, hedging. Fragments OK. One fact once. No tool-call narration. Keep code, API names, commands, error strings exact. Never drop not/never/no/only. Write code, comments, commits and docs in normal prose.`;
const PONYTAIL_FALLBACK = `Lazy senior dev: best code is code never written. Before writing: YAGNI, reuse existing code, stdlib, platform feature, installed dependency, one line. Only then minimum code that works. No unrequested abstractions or dependencies. Shortest correct diff. Not lazy about validation, security, data-loss handling.`;

const ROLE_BRIEF: Record<Role, string> = {
  chat: 'You are an agent inside Agentic OS.',
  plan: 'You are the planner in Agentic OS. Split the goal into small independent tasks with acceptance checks.',
  code: 'You are a coder in Agentic OS. Implement the assigned task only.',
  review: 'You are the reviewer in Agentic OS. Check the diff against the acceptance checks. Report defects only.',
  test: 'You are the tester in Agentic OS. Run the checks, report failures with the shortest decisive output.',
  summarize: 'You are the summarizer in Agentic OS.',
};

const CODE_ROLES: Role[] = ['code', 'test'];

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function section(md: string, heading: string): string {
  const m = md.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

/** Caveman at its highest non-wenyan level, trimmed to the parts an agent needs (no examples). */
export function cavemanUltra(md: string | null): string {
  if (!md) return CAVEMAN_FALLBACK;
  const rules = section(md, 'Rules');
  const ultra = md.match(/^\| \*\*ultra\*\* \| (.+) \|$/m)?.[1];
  const clarity = section(md, 'Auto-Clarity').split('\n').filter((l) => l.startsWith('- ')).join('\n');
  const bounds = section(md, 'Boundaries');
  if (!rules || !ultra) return CAVEMAN_FALLBACK;
  return [`Communication style: caveman, level ultra.`, rules, `Ultra: ${ultra}`, clarity && `Drop caveman when:\n${clarity}`, bounds].filter(Boolean).join('\n\n');
}

export function ponytail(md: string | null): string {
  if (!md) return PONYTAIL_FALLBACK;
  return md.replace(/^\(Yes, this file also applies[\s\S]*$/m, '').trim();
}

export interface Policies {
  caveman: string;
  ponytail: string;
}

export function loadPolicies(cavemanPath = CAVEMAN_PATH, ponytailPath = PONYTAIL_PATH): Policies {
  return { caveman: cavemanUltra(read(cavemanPath)), ponytail: ponytail(read(ponytailPath)) };
}

// Stable per role so provider prompt caches hit across sessions.
export function systemPrompt(role: Role, p: Policies): string {
  return [ROLE_BRIEF[role], p.caveman, CODE_ROLES.includes(role) && `# Coding policy\n\n${p.ponytail}`].filter(Boolean).join('\n\n');
}
