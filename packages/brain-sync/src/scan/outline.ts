import { dirname, join, normalize } from 'node:path';
import type { OutlineItem } from '../types.ts';

const MAX_ITEMS = 40;

type Rule = { re: RegExp; kind: (m: RegExpMatchArray) => string; name: (m: RegExpMatchArray) => string };

const js: Rule[] = [
  {
    re: /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gm,
    kind: (m) => m[1].replace('abstract ', '').replace('*', ''),
    name: (m) => m[2],
  },
  { re: /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm, kind: () => 'function', name: (m) => m[1] },
  { re: /^class\s+([A-Za-z_$][\w$]*)/gm, kind: () => 'class', name: (m) => m[1] },
];

const RULES: Record<string, Rule[]> = {
  typescript: js,
  javascript: js,
  vue: js,
  svelte: js,
  python: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: () => 'def', name: (m) => m[1] },
    { re: /^class\s+([A-Za-z_]\w*)/gm, kind: () => 'class', name: (m) => m[1] },
    { re: /^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: () => 'method', name: (m) => m[1] },
  ],
  swift: [
    {
      re: /^(?: {0,4}|\t?)(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate|open|final|static|override|nonisolated|@MainActor)\s+)*(struct|class|enum|protocol|extension|actor|func)\s+([A-Za-z_][\w.]*)/gm,
      kind: (m) => m[1],
      name: (m) => m[2],
    },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: () => 'func', name: (m) => m[1] },
    { re: /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/gm, kind: (m) => m[2], name: (m) => m[1] },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w<>]*)/gm, kind: (m) => m[1], name: (m) => m[2] },
  ],
  java: [{ re: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+)?(class|interface|enum|record)\s+(\w+)/gm, kind: (m) => m[1], name: (m) => m[2] }],
  kotlin: [{ re: /^\s*(?:data\s+|sealed\s+|abstract\s+|open\s+)?(class|interface|object|fun)\s+(\w+)/gm, kind: (m) => m[1], name: (m) => m[2] }],
  csharp: [{ re: /^\s*(?:public|internal|private)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|interface|enum|record|struct)\s+(\w+)/gm, kind: (m) => m[1], name: (m) => m[2] }],
  ruby: [{ re: /^\s*(class|module|def)\s+([\w.:?!]+)/gm, kind: (m) => m[1], name: (m) => m[2] }],
  markdown: [{ re: /^(#{1,3})\s+(.+?)\s*#*$/gm, kind: (m) => 'h' + m[1].length, name: (m) => m[2] }],
  shell: [{ re: /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm, kind: () => 'function', name: (m) => m[1] }],
};

export function extractOutline(lang: string, text: string): OutlineItem[] {
  const rules = RULES[lang];
  if (!rules) return [];
  const found: { at: number; item: OutlineItem }[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      const item = { kind: rule.kind(m), name: rule.name(m).trim() };
      const key = item.kind + ':' + item.name;
      if (seen.has(key) || seen.has('function:' + item.name) || seen.has('def:' + item.name)) continue;
      seen.add(key);
      found.push({ at: m.index ?? 0, item });
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, MAX_ITEMS).map((f) => f.item);
}

const JS_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.json', '.vue', '.svelte',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Finds imports/links from `abs` to other files. Each entry is a list of alternative absolute
 * paths (first existing one wins); resolution happens later against the current file set so a
 * cached analysis still links to files created after it.
 */
export function extractLinkCandidates(lang: string, abs: string, text: string, projectRoot: string): string[][] {
  const dir = dirname(abs);
  const out: string[][] = [];
  const tryPaths = (cands: string[]) => {
    out.push(cands.map((c) => normalize(c)));
  };

  if (lang === 'typescript' || lang === 'javascript' || lang === 'vue' || lang === 'svelte' || lang === 'astro') {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const m of text.matchAll(re)) {
      const base = join(dir, m[1]);
      const stripped = base.replace(/\.(m|c)?js$/, '');
      tryPaths([...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => stripped + e)]);
    }
  } else if (lang === 'python') {
    for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)/gm)) {
      const dots = m[1].length;
      const mod = m[2].replace(/\./g, '/');
      const names = m[3].split(',').map((s) => s.trim()).filter(Boolean);
      const bases = dots
        ? [join(dir, ...Array(Math.max(0, dots - 1)).fill('..'), mod)]
        : [join(dir, mod), join(projectRoot, mod), join(projectRoot, 'src', mod)];
      for (const b of bases) {
        tryPaths([b + '.py', join(b, '__init__.py')]);
        for (const n of names) tryPaths([join(b, n + '.py')]);
      }
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) {
      const mod = m[1].replace(/\./g, '/');
      for (const b of [join(dir, mod), join(projectRoot, mod), join(projectRoot, 'src', mod)]) {
        tryPaths([b + '.py', join(b, '__init__.py')]);
      }
    }
  } else if (lang === 'markdown') {
    for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
      const target = decodeURIComponentSafe(m[1].split('#')[0]);
      if (target) tryPaths([target.startsWith('/') ? join(projectRoot, target) : join(dir, target)]);
    }
  } else if (lang === 'c' || lang === 'cpp' || lang === 'objc') {
    for (const m of text.matchAll(/^\s*#\s*(?:include|import)\s+"([^"]+)"/gm)) {
      tryPaths([join(dir, m[1]), join(projectRoot, m[1]), join(projectRoot, 'include', m[1])]);
    }
  } else if (lang === 'html') {
    for (const m of text.matchAll(/(?:src|href)=["'](?!https?:|\/\/|#|data:)([^"']+)["']/g)) {
      tryPaths([join(dir, m[1].split('?')[0])]);
    }
  }
  return out;
}

export function resolveLinks(cands: string[][], abs: string, exists: (abs: string) => boolean): string[] {
  const out = new Set<string>();
  for (const alts of cands) {
    const hit = alts.find((p) => p !== abs && exists(p));
    if (hit) out.add(hit);
  }
  return [...out].sort();
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
