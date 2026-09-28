import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { defaultConfig, type Config } from '../src/config.ts';

export function tmp(prefix = 'brain-sync-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function put(root: string, rel: string, content: string | Buffer): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Isolated config: everything under one temp dir, summaries off. */
export function testConfig(base = tmp()): Config {
  const cfg = defaultConfig(join(base, 'home'));
  cfg.vault = join(base, 'vault');
  cfg.projectsRoot = join(base, 'Projects');
  cfg.sessionSources = [
    { kind: 'claude', dir: join(base, 'claude') },
    { kind: 'codex', dir: join(base, 'codex') },
    { kind: 'omp', dir: join(base, 'omp') },
  ];
  cfg.extraRoots = [{ tool: 'Agentic OS', dir: join(base, 'aos-workspaces') }];
  cfg.missionsDir = join(base, 'missions');
  cfg.summarize.enabled = false;
  mkdirSync(cfg.projectsRoot, { recursive: true });
  return cfg;
}

export function mdFiles(vault: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md')) out.push(relative(vault, p));
    }
  };
  walk(vault);
  return out.sort();
}

/** Every `[[target|label]]` whose target isn't a note in the vault. */
export function danglingLinks(vault: string): string[] {
  const files = new Set(mdFiles(vault));
  const bad: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(vault, f), 'utf8');
    for (const m of text.matchAll(/(?<!\\)\[\[([^\]|\\]+)(?:\\?\|[^\]]*)?\]\]/g)) {
      if (!files.has(m[1])) bad.push(`${f} -> ${m[1]}`);
    }
  }
  return bad;
}
