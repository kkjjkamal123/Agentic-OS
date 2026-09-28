import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Config } from '../config.ts';
import type { State } from '../state.ts';
import type { FileAnalysis, Project, ProjectFile } from '../types.ts';
import { IgnoreStack, isHiddenSkipped, makeIgnore } from './ignore.ts';
import { langOf } from './lang.ts';
import { extractLinkCandidates, extractOutline, resolveLinks } from './outline.ts';

const toPosix = (p: string) => p.split(sep).join('/');

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** `<projectsRoot>/<Tool>/<Project>` pairs, plus `<dir>/<Project>` for each extra root. */
export function discoverProjects(projectsRoot: string, extraRoots: { tool: string; dir: string }[] = []): { tool: string; name: string; root: string }[] {
  return [
    ...listDirs(projectsRoot).flatMap((tool) => listDirs(join(projectsRoot, tool)).map((name) => ({ tool, name, root: join(projectsRoot, tool, name) }))),
    ...extraRoots.flatMap(({ tool, dir }) => listDirs(dir).map((name) => ({ tool, name, root: join(dir, name) }))),
  ];
}

function isBinary(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readText(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function analyze(abs: string, lang: string, tooBig: boolean, root: string): FileAnalysis {
  if (tooBig) return { binary: isBinary(abs), lines: 0, outline: [], linkCandidates: [] };
  if (isBinary(abs)) return { binary: true, lines: 0, outline: [], linkCandidates: [] };
  const text = readText(abs) ?? '';
  return {
    binary: false,
    lines: text ? text.split('\n').length : 0,
    outline: extractOutline(lang, text),
    linkCandidates: extractLinkCandidates(lang, abs, text, root),
  };
}

/** Languages that count toward a project's stack, with display names. */
const CODE_LANGS: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', jupyter: 'Jupyter', swift: 'Swift',
  objc: 'Objective-C', c: 'C', cpp: 'C++', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', csharp: 'C#',
  ruby: 'Ruby', php: 'PHP', lua: 'Lua', shell: 'Shell', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', metal: 'Metal', latex: 'LaTeX',
};

function detectStack(root: string, files: ProjectFile[]): string[] {
  const rels = new Set(files.map((f) => f.rel));
  const stack = new Set<string>();
  const pkg = readText(join(root, 'package.json'));
  if (pkg) {
    stack.add('Node.js');
    try {
      const j = JSON.parse(pkg);
      const deps = { ...j.dependencies, ...j.devDependencies };
      for (const [dep, label] of [
        ['typescript', 'TypeScript'], ['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['svelte', 'Svelte'],
        ['electron', 'Electron'], ['vite', 'Vite'], ['express', 'Express'], ['tailwindcss', 'Tailwind'],
      ] as const) if (dep in deps) stack.add(label);
    } catch {
      // malformed package.json
    }
  }
  if (rels.has('requirements.txt') || rels.has('pyproject.toml') || rels.has('setup.py')) stack.add('Python');
  if (rels.has('Package.swift')) stack.add('Swift Package');
  try {
    if (readdirSync(root).some((n) => n.endsWith('.xcodeproj'))) stack.add('Xcode');
  } catch {
    // unreadable root
  }
  if (rels.has('Cargo.toml')) stack.add('Rust');
  if (rels.has('go.mod')) stack.add('Go');
  if (rels.has('Dockerfile') || rels.has('docker-compose.yml')) stack.add('Docker');
  const langs = new Map<string, number>();
  for (const f of files) {
    if (!f.analysis.binary && CODE_LANGS[f.lang]) langs.set(f.lang, (langs.get(f.lang) ?? 0) + 1);
  }
  const top = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => CODE_LANGS[l]);
  for (const l of top) if (![...stack].some((s) => s.toLowerCase() === l.toLowerCase())) stack.add(l);
  return [...stack];
}

function readmeGist(root: string, files: ProjectFile[]): string {
  const readme = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f.rel));
  if (!readme) return '';
  const text = readText(readme.abs) ?? '';
  const paras = text
    .replace(/<[^>]+>/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#') && !p.startsWith('![') && !p.startsWith('[!') && !p.startsWith('```'));
  return (paras[0] ?? '').slice(0, 700);
}

export function scanProject(
  p: { tool: string; name: string; root: string },
  cfg: Config,
  state: State,
  seen: Set<string>,
): Project {
  const files: ProjectFile[] = [];
  const dirs = new Set<string>(['']);
  let truncated = 0;
  let lastModified = 0;

  const walk = (dir: string, ig: IgnoreStack) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const gi = entries.some((e) => e.name === '.gitignore') ? readText(join(dir, '.gitignore')) : null;
    const relDir = toPosix(relative(p.root, dir));
    const layer = relDir ? ig.child(relDir, gi) : ig;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isHiddenSkipped(e.name) || e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (layer.ignores(rel + '/')) continue;
        dirs.add(rel);
        walk(abs, layer);
      } else if (e.isFile()) {
        if (layer.ignores(rel)) continue;
        if (files.length >= cfg.maxFilesPerProject) {
          truncated++;
          continue;
        }
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        const lang = langOf(abs);
        const tooBig = st.size > cfg.maxFileBytes;
        const cached = state.files[abs];
        const analysis =
          cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size
            ? cached.analysis
            : analyze(abs, lang, tooBig, p.root);
        state.files[abs] = { mtimeMs: st.mtimeMs, size: st.size, analysis };
        seen.add(abs);
        lastModified = Math.max(lastModified, st.mtimeMs);
        files.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs, lang, tooBig, analysis, links: [] });
      }
    }
  };

  const rootGi = readText(join(p.root, '.gitignore'));
  walk(p.root, new IgnoreStack(makeIgnore([...cfg.extraIgnore, ...(rootGi ? rootGi.split('\n') : [])])));

  const known = new Set(files.map((f) => f.abs));
  for (const f of files) f.links = resolveLinks(f.analysis.linkCandidates, f.abs, (a) => known.has(a));

  // Drop dirs that ended up with no files beneath them (e.g. only ignored content).
  const used = new Set<string>(['']);
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i++) used.add(parts.slice(0, i).join('/'));
  }

  return {
    ...p,
    files,
    dirs: [...dirs].filter((d) => used.has(d)).sort(),
    stack: detectStack(p.root, files),
    readme: readmeGist(p.root, files),
    truncated,
    lastModified,
  };
}
