import { basename, dirname, sep } from 'node:path';
import type { Summary } from '../state.ts';
import type { MissionRecord, Project, ProjectFile, SessionData } from '../types.ts';
import {
  escapeMd, fileUrl, fmtBytes, fmtDate, fmtDuration, frontmatter, link, quote, seg, segs, truncate,
} from './md.ts';

export interface Note {
  /** Stable identity across renames (e.g. a session whose title changed). */
  key: string;
  path: string;
  body: string;
}

export const HOME = '🧠 Home.md';
const MISSION_TOOL = 'Agentic OS';

const TOOL_NAMES: Record<SessionData['kind'], string> = { claude: 'Claude', codex: 'Codex', omp: 'omp' };
const RESUME: Record<SessionData['kind'], (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  omp: (id) => `omp --resume ${id}`,
};

const projectDir = (p: Project) => `Projects/${seg(p.tool)}/${seg(p.name)}`;
export const projectNote = (p: Project) => `${projectDir(p)}/📦 ${seg(p.name)}.md`;
export const folderNote = (p: Project, rel: string) =>
  rel ? `${projectDir(p)}/${segs(rel)}/📁 ${seg(rel.split('/').pop()!)}.md` : projectNote(p);
export const fileNote = (p: Project, rel: string) => `${projectDir(p)}/${segs(rel)}.md`;
const toolNote = (tool: string) => `Tools/${seg(tool)}.md`;

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

export interface RenderInput {
  projects: Project[];
  sessions: SessionData[];
  missions?: MissionRecord[];
  summaries: Record<string, Summary>;
  summarizeEnabled: boolean;
}

export interface SessionRef {
  s: SessionData;
  path: string;
  tool: string;
  projects: Project[];
}

export const sessionKey = (s: SessionData) => `session:${s.kind}:${s.id}`;

/** Longest project root containing `abs`. */
function projectFor(abs: string, roots: Project[]): Project | undefined {
  return roots.find((p) => abs === p.root || abs.startsWith(p.root + sep));
}

export function renderAll(input: RenderInput): Note[] {
  const { projects, sessions } = input;
  const missions = input.missions ?? [];
  const notes: Note[] = [];
  const byRootLen = [...projects].sort((a, b) => b.root.length - a.root.length);

  // Tool names: project folders win, so "claude" sessions join the "Claude" tool note.
  const toolNames = new Map<string, string>();
  for (const p of projects) toolNames.set(p.tool.toLowerCase(), p.tool);
  const toolFor = (s: SessionData) => toolNames.get(s.kind) ?? TOOL_NAMES[s.kind];

  // ---- session paths & project mapping
  const used = new Set<string>();
  const refs: SessionRef[] = sessions.map((s) => {
    const d = new Date(s.started);
    const stamp = fmtDate(d).replace(':', '');
    const tool = toolFor(s);
    let path = `Sessions/${seg(tool)}/${stamp} ${seg(s.title, 60)}.md`;
    if (used.has(path)) path = path.replace(/\.md$/, ` (${s.id.slice(0, 8)}).md`);
    used.add(path);
    const ps = new Set<Project>();
    const home = s.cwd ? projectFor(s.cwd, byRootLen) : undefined;
    if (home) ps.add(home);
    for (const f of s.touched) {
      const p = projectFor(f, byRootLen);
      if (p) ps.add(p);
    }
    return { s, path, tool, projects: [...ps] };
  });
  refs.sort((a, b) => (a.s.started < b.s.started ? 1 : -1)); // newest first everywhere

  const sessionsByFile = new Map<string, SessionRef[]>();
  for (const r of refs) for (const f of r.s.touched) sessionsByFile.set(f, [...(sessionsByFile.get(f) ?? []), r]);
  const sessionsByProject = new Map<Project, SessionRef[]>();
  for (const r of refs) for (const p of r.projects) sessionsByProject.set(p, [...(sessionsByProject.get(p) ?? []), r]);

  const fileIndex = new Map<string, { p: Project; f: ProjectFile }>();
  for (const p of projects) for (const f of p.files) fileIndex.set(f.abs, { p, f });

  const sessionLine = (r: SessionRef) => {
    const model = r.s.models.at(-1)?.replace(/^.*\//, '') ?? '';
    return `- ${fmtDate(r.s.started).slice(0, 10)} · ${link(r.path, r.s.title)} · ${r.tool}${model ? ` · \`${model}\`` : ''}`;
  };

  // ---- home
  const tools = [...new Set([...projects.map((p) => p.tool), ...refs.map((r) => r.tool), ...(missions.length ? [MISSION_TOOL] : [])])].sort();
  const missionPaths = new Map<string, string>();
  for (const m of missions) {
    let path = `Missions/${fmtDate(m.createdAt).replace(':', '')} ${seg(m.goal, 60)}.md`;
    if ([...missionPaths.values()].includes(path)) path = path.replace(/\.md$/, ` (${m.id.slice(0, 8)}).md`);
    missionPaths.set(m.id, path);
  }
  const missionLine = (m: MissionRecord) => `- ${fmtDate(m.createdAt).slice(0, 10)} · ${link(missionPaths.get(m.id)!, truncate(m.goal, 80))} · ${m.status}`;
  const totalFiles = projects.reduce((n, p) => n + p.files.length, 0);
  const spend = refs.reduce((n, r) => n + (r.s.costUsd ?? 0), 0);
  notes.push({
    key: 'home',
    path: HOME,
    body: [
      frontmatter({ type: 'home', tags: ['brain/home'] }),
      '# 🧠 Brain',
      '> Every project, file and AI session — one graph. Generated by **brain-sync**; open Graph view to explore.',
      '',
      '## Tools',
      ...tools.map((t) => {
        const np = projects.filter((p) => p.tool === t).length;
        const ns = refs.filter((r) => r.tool === t).length;
        return `- 🛠 ${link(toolNote(t), t)} — ${np} project${np === 1 ? '' : 's'} · ${ns} session${ns === 1 ? '' : 's'}`;
      }),
      '',
      '## Projects',
      '| Project | Tool | Stack | Files | Sessions | Last change |',
      '|---|---|---|---:|---:|---|',
      ...[...projects]
        .sort((a, b) => b.lastModified - a.lastModified)
        .map((p) =>
          `| ${link(projectNote(p), p.name + (p.missing ? ' (deleted)' : ''), true)} | ${p.tool} | ${p.stack.join(', ') || '—'} | ${p.files.length} | ${sessionsByProject.get(p)?.length ?? 0} | ${p.lastModified ? fmtDate(p.lastModified).slice(0, 10) : '—'} |`,
        ),
      '',
      ...(missions.length ? ['## Recent missions', ...missions.slice(0, 10).map(missionLine), ''] : []),
      '## Recent sessions',
      ...refs.slice(0, 15).map(sessionLine),
      '',
      '## Stats',
      `- ${projects.length} projects · ${totalFiles} files · ${refs.length} sessions${missions.length ? ` · ${missions.length} missions` : ''}`,
      spend ? `- Claude Code spend recorded: $${spend.toFixed(2)}` : '',
      '',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
  });

  // ---- tools
  for (const t of tools) {
    const tp = projects.filter((p) => p.tool === t);
    const tr = refs.filter((r) => r.tool === t);
    const models = [...new Set(tr.flatMap((r) => r.s.models))].sort();
    notes.push({
      key: `tool:${t}`,
      path: toolNote(t),
      body: [
        frontmatter({ type: 'tool', tool: t, tags: ['brain/tool'] }),
        `# 🛠 ${t}`,
        `🧠 ${link(HOME, 'Home')}`,
        '',
        '## Projects',
        ...(tp.length ? tp.map((p) => `- 📦 ${link(projectNote(p), p.name)}${p.stack.length ? ` — ${p.stack.join(', ')}` : ''}`) : ['_None yet._']),
        '',
        '## Sessions',
        ...(tr.length ? tr.map(sessionLine) : ['_None recorded locally._']),
        ...(t === MISSION_TOOL && missions.length ? ['', '## Missions', ...missions.map(missionLine)] : []),
        ...(models.length ? ['', '## Models used', ...models.map((m) => `- \`${m}\``)] : []),
        '',
      ].join('\n'),
    });
  }

  // ---- projects, folders, files
  for (const p of projects) {
    const children = (dir: string) => ({
      dirs: p.dirs.filter((d) => d && parentOf(d) === dir),
      files: p.files.filter((f) => parentOf(f.rel) === dir),
    });
    const listing = (dir: string) => {
      const c = children(dir);
      return [
        ...c.dirs.map((d) => `- 📁 ${link(folderNote(p, d), d.split('/').pop()! + '/')}`),
        ...c.files.map((f) => `- ${link(fileNote(p, f.rel), basename(f.rel))} — ${f.lang}${f.analysis.lines ? ` · ${f.analysis.lines} lines` : ` · ${fmtBytes(f.size)}`}`),
      ];
    };
    const ps = sessionsByProject.get(p) ?? [];
    const recent = [...p.files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);

    notes.push({
      key: `project:${p.root}`,
      path: projectNote(p),
      body: [
        frontmatter({
          type: 'project', tool: p.tool, project: p.name, path: p.root, stack: p.stack,
          status: p.missing ? 'deleted' : 'active', tags: ['brain/project'],
        }),
        `# 📦 ${p.name}`,
        `🧠 ${link(HOME, 'Home')} · 🛠 ${link(toolNote(p.tool), p.tool)}`,
        '',
        ...(p.missing ? ['> [!warning] This folder no longer exists — kept so its sessions stay linked.', ''] : []),
        `**Path** \`${p.root}\`${p.missing ? '' : ` · [Open folder](${fileUrl(p.root)})`}`,
        `**Stack** ${p.stack.join(', ') || '—'} · **Files** ${p.files.length}${p.truncated ? ` (+${p.truncated} not indexed)` : ''} · **Last change** ${p.lastModified ? fmtDate(p.lastModified) : '—'}`,
        ...(p.readme ? ['', '## About', quote(p.readme)] : []),
        '',
        '## Structure',
        ...(listing('').length ? listing('') : [p.missing ? '_Deleted._' : '_Empty — nothing indexed yet._']),
        ...(ps.length ? ['', '## Sessions', ...ps.map(sessionLine)] : []),
        ...(recent.length ? ['', '## Recently changed', ...recent.map((f) => `- ${link(fileNote(p, f.rel), f.rel)} — ${fmtDate(f.mtimeMs)}`)] : []),
        '',
      ].join('\n'),
    });

    for (const d of p.dirs) {
      if (!d) continue;
      const up = parentOf(d);
      notes.push({
        key: `dir:${p.root}/${d}`,
        path: folderNote(p, d),
        body: [
          frontmatter({ type: 'folder', tool: p.tool, project: p.name, path: `${p.root}/${d}`, tags: ['brain/folder'] }),
          `# 📁 ${d}`,
          `⬆️ ${link(folderNote(p, up), up ? up.split('/').pop()! + '/' : p.name)} · 📦 ${link(projectNote(p), p.name)}`,
          '',
          ...listing(d),
          '',
        ].join('\n'),
      });
    }

    for (const f of p.files) {
      const up = parentOf(f.rel);
      const a = f.analysis;
      const fs = sessionsByFile.get(f.abs) ?? [];
      const facts = [
        f.lang,
        a.binary ? 'binary' : a.lines ? `${a.lines} lines` : '',
        fmtBytes(f.size),
        `modified ${fmtDate(f.mtimeMs)}`,
        f.tooBig ? 'too large to outline' : '',
      ].filter(Boolean);
      notes.push({
        key: `file:${f.abs}`,
        path: fileNote(p, f.rel),
        body: [
          frontmatter({
            type: 'file', tool: p.tool, project: p.name, path: f.abs, lang: f.lang, size: f.size,
            modified: new Date(f.mtimeMs).toISOString(), tags: ['brain/file', `lang/${f.lang.replace(/[^\w-]/g, '')}`],
          }),
          `# ${basename(f.rel)}`,
          `⬆️ ${link(folderNote(p, up), up ? up.split('/').pop()! + '/' : p.name)} · 📦 ${link(projectNote(p), p.name)}`,
          '',
          `\`${f.rel}\` · ${facts.join(' · ')}`,
          `[Open file](${fileUrl(f.abs)}) · [Reveal folder](${fileUrl(dirname(f.abs))})`,
          ...(a.outline.length ? ['', '## Outline', ...a.outline.map((o) => `- ${o.kind} \`${o.name.replace(/`/g, "'")}\``)] : []),
          ...(f.links.length
            ? ['', '## Links to', ...f.links.map((l) => {
                const t = fileIndex.get(l);
                return t ? `- ${link(fileNote(t.p, t.f.rel), t.f.rel)}` : `- \`${l}\``;
              })]
            : []),
          ...(fs.length ? ['', '## Sessions', ...fs.map(sessionLine)] : []),
          '',
        ].join('\n'),
      });
    }
  }

  // ---- sessions
  for (const r of refs) {
    const s = r.s;
    const sum = input.summaries[sessionKey(s)];
    const started = new Date(s.started).getTime();
    const ended = new Date(s.ended).getTime();
    const touchedLines = s.touched.map((abs) => {
      const t = fileIndex.get(abs);
      return t ? `- ${link(fileNote(t.p, t.f.rel), `${t.p.name}/${t.f.rel}`)}` : `- \`${abs}\``;
    });
    const summary = sum
      ? escapeMd(sum.text)
      : input.summarizeEnabled
        ? '_Summary pending — written once the session is idle or ends._'
        : '_Summaries are turned off._';
    notes.push({
      key: sessionKey(s),
      path: r.path,
      body: [
        frontmatter({
          type: 'session', tool: r.tool, agent: s.kind, session_id: s.id, title: s.title, cwd: s.cwd,
          projects: r.projects.map((p) => p.name), models: s.models, started: s.started, ended: s.ended,
          cost_usd: s.costUsd !== undefined ? Number(s.costUsd.toFixed(4)) : undefined,
          tags: ['brain/session', `agent/${s.kind}`],
        }),
        `# ${escapeMd(s.title)}`,
        [`🛠 ${link(toolNote(r.tool), r.tool)}`, ...r.projects.map((p) => `📦 ${link(projectNote(p), p.name)}`)].join(' · '),
        '',
        [
          `**Started** ${fmtDate(s.started)}`,
          fmtDuration(ended - started) && `**Duration** ${fmtDuration(ended - started)}`,
          s.models.length && `**Models** ${s.models.map((m) => `\`${m}\``).join(', ')}`,
          s.costUsd !== undefined && `**Cost** $${s.costUsd.toFixed(2)}`,
        ].filter(Boolean).join(' · '),
        `**Working dir** \`${s.cwd || '?'}\` · **Resume** \`${RESUME[s.kind](s.id)}\` · [Raw log](${fileUrl(s.logPath)})`,
        '',
        '## Summary',
        summary,
        '',
        `## Prompts (${s.prompts.length})`,
        ...s.prompts.slice(0, 60).flatMap((p, i) =>
          !p.includes('\n') && p.length <= 90
            ? [`> [!quote] ${i + 1}. ${escapeMd(p)}`, '']
            : [`> [!quote]- ${i + 1}. ${escapeMd(truncate(p.split('\n')[0], 90))}`, quote(truncate(p, 1500)), '']),
        ...(s.prompts.length > 60 ? [`_…and ${s.prompts.length - 60} more._`, ''] : []),
        ...(touchedLines.length ? [`## Files touched (${touchedLines.length})`, ...touchedLines, ''] : []),
        ...(s.lastReply ? ['> [!note]- Last reply', quote(truncate(s.lastReply, 2500)), ''] : []),
      ].join('\n'),
    });
  }

  const modelName = (r?: { runtime: string; model: string }) => (r ? `${r.runtime} · ${r.model.replace(/^google-antigravity\//, '')}` : '');
  for (const m of missions) {
    const p = projects.find((x) => x.root === m.workspacePath);
    const models = [...new Set([m.planner, ...m.tasks.flatMap((t) => [t.coder, t.reviewer])].filter(Boolean).map((r) => modelName(r)))];
    notes.push({
      key: `mission:${m.id}`,
      path: missionPaths.get(m.id)!,
      body: [
        frontmatter({
          type: 'mission', tool: MISSION_TOOL, status: m.status, goal: m.goal, workspace: m.workspacePath, quality: m.quality,
          models, created: m.createdAt, tags: ['brain/mission'],
        }),
        `# 🎯 ${escapeMd(truncate(m.goal, 120))}`,
        [`🛠 ${link(toolNote(MISSION_TOOL), MISSION_TOOL)}`, p ? `📦 ${link(projectNote(p), p.name)}` : `📦 \`${m.workspacePath}\``].join(' · '),
        '',
        `**Status** ${m.status}${m.error ? ` · ${escapeMd(m.error)}` : ''} · **Quality** ${m.quality} · **Started** ${fmtDate(m.createdAt)}`,
        `**Tokens** ${m.usage.input.toLocaleString()} in · ${m.usage.output.toLocaleString()} out · ${m.usage.cached.toLocaleString()} cached${m.planner ? ` · **Planner** ${modelName(m.planner)}` : ''}`,
        '',
        '## Goal',
        quote(m.goal),
        '',
        '## Tasks',
        ...m.tasks.map((t) => `- **${escapeMd(t.title)}**: ${t.status}${t.coder ? ` · coded by ${modelName(t.coder)}` : ''}${t.reviewer ? ` · reviewed by ${modelName(t.reviewer)}` : ''}${t.note ? ` · ${escapeMd(truncate(t.note, 160))}` : ''}`),
        ...(m.checks.length ? ['', '## Checks', ...m.checks.map((c) => `- ${c.name}: \`${c.command.replace(/`/g, "'")}\` → ${c.exitCode === 0 ? 'passed' : `exit ${c.exitCode ?? '—'}`}`)] : []),
        ...(m.report ? ['', '## Ship report', escapeMd(m.report)] : []),
        '',
      ].join('\n'),
    });
  }

  return notes;
}
