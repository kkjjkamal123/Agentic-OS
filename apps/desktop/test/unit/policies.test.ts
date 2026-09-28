import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAVEMAN_PATH, cavemanUltra, loadPolicies, PONYTAIL_PATH, systemPrompt } from '../../src/main/agents/policies';

const SKILL = `---
name: caveman
---
Intro.

## Rules

Drop articles.

## Intensity

| Level | What change |
|-------|------------|
| **full** | Classic caveman |
| **ultra** | Strip conjunctions. One word when enough |

## Auto-Clarity

Drop caveman when:
- Security warnings

## Boundaries

Write normal prose code.`;

describe('policies', () => {
  it('extracts caveman ultra without examples', () => {
    const out = cavemanUltra(SKILL);
    expect(out).toContain('level ultra');
    expect(out).toContain('Drop articles.');
    expect(out).toContain('Ultra: Strip conjunctions. One word when enough');
    expect(out).toContain('- Security warnings');
    expect(out).toContain('Write normal prose code.');
    expect(out).not.toContain('Classic caveman');
  });

  it('falls back when files are missing', () => {
    const p = loadPolicies('/nope/a.md', '/nope/b.md');
    expect(p.caveman).toMatch(/terse/);
    expect(p.ponytail).toMatch(/YAGNI/);
  });

  it('adds ponytail only for code-writing roles and is stable', () => {
    const p = { caveman: 'CAVE', ponytail: 'PONY' };
    expect(systemPrompt('code', p)).toContain('PONY');
    expect(systemPrompt('plan', p)).not.toContain('PONY');
    expect(systemPrompt('plan', p)).toBe(systemPrompt('plan', p));
  });

  it.runIf(existsSync(CAVEMAN_PATH) && existsSync(PONYTAIL_PATH))('parses the installed skills', () => {
    const p = loadPolicies();
    expect(p.caveman).toContain('level ultra');
    expect(p.caveman).toContain('Ultra: ');
    expect(p.ponytail).toContain('lazy senior developer');
  });
});
