import type { ModelRef } from '@shared/agents';
import type { Mission, MissionTask, VerifyStep } from '@shared/missions';

// Prompts are short and structured: every token here is paid on every task.

const DIFF_CAP = 40_000;
const OUTPUT_TAIL = 6_000;

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

export function planPrompt(goal: string, files: string[]): string {
  return `Goal: ${goal}

Existing files:
${files.length ? files.join('\n') : '(empty repository)'}

Make a build plan for a finished product the user opens with one click. Do not create or change files.
Reply with ONE json block:
{"product":"what the user gets, one sentence","stack":"languages and frameworks","summary":"approach and key decisions","tasks":[{"id":"t1","title":"...","spec":"what to build, files to create/touch, interfaces other tasks rely on","deps":[],"acceptance":["checkable outcome"],"complexity":"light|normal|hard"}],"verify":{"setup":"install command or empty","build":"build command or empty","test":"test command"},"run":{"kind":"web|macos-app|cli","open":"file or .app to open, relative path","start":"long-running start command","url":"http://localhost:PORT"}}

Rules:
- Games and apps with any UI must be graphical, never terminal-only, unless the goal explicitly asks for a CLI. Default to a polished single-page web app (index.html + CSS + JS, no build step, no network dependencies) with keyboard and mouse controls; use a native macOS app only if the goal asks for one.
- run says how to launch the finished product: web with no server -> {"kind":"web","open":"index.html"}; web with a server -> {"kind":"web","start":"...","url":"http://localhost:PORT"}; macOS app -> {"kind":"macos-app","open":"path/To.app"} built by verify.build; CLI tools -> {"kind":"cli","start":"command"}.
- 1-8 tasks, each small enough for one agent. Prefer independent tasks; add deps only when a task needs another's code.
- Make it look and feel finished: clear layout, readable typography, win/lose or empty/error states, no placeholder text.
- complexity decides which model builds the task: light = config, boilerplate, docs, small edits; normal = a typical feature; hard = tricky logic, concurrency, security, performance or cross-cutting design.
- verify commands run non-interactively from the repo root on macOS, finish within minutes, exit non-zero on failure. Include at least one real automated test of the core logic.`;
}

const who = (r?: ModelRef) => (r ? `${r.runtime}/${r.model.replace(/^google-antigravity\//, '')}` : 'unassigned');

/** Who is doing what, so each agent knows its teammates' scope the moment it is assigned. */
export function teamBrief(m: Mission, self: MissionTask): string {
  return m.tasks
    .filter((t) => t.id !== self.id)
    .map((t) => `- ${t.id} ${t.title} [${t.status}] ${who(t.coder ?? t.plannedCoder)}`)
    .join('\n');
}

/** Hand-off notes from finished tasks this one builds on (or all of them when `ids` is omitted). */
export function handoffBrief(m: Mission, ids?: string[]): string {
  return m.tasks
    .filter((t) => t.handoff && (!ids || ids.includes(t.id)))
    .map((t) => `- ${t.id} (${who(t.coder)}): ${t.handoff}`)
    .join('\n');
}

export function dispatchPrompt(m: Mission, options: Map<string, { coders: [string, string][]; reviewers: [string, string][] }>): string {
  const tasks = m.tasks.map((t) => {
    const o = options.get(t.id)!;
    return `${t.id} [${t.complexity}] ${t.title}${t.deps.length ? ` (after ${t.deps.join(',')})` : ''}
  coders: ${o.coders.map(([id, d]) => `${id}=${d}`).join('; ')}
  reviewers: ${o.reviewers.map(([id, d]) => `${id}=${d}`).join('; ')}`;
  });
  return `Assign one coder and one reviewer per task, using only the option ids listed for that task.
${tasks.join('\n')}

Rules: match model strength to difficulty; spread tasks that can run at the same time across different pools; reviewer vendor must differ from coder vendor when possible; prefer subscriptions over paid APIs.
Reply with ONE json block: {"assign":[{"task":"t1","coder":"c1","reviewer":"r1","why":"few words"}]}`;
}

export function codePrompt(goal: string, summary: string, t: MissionTask, files: string[], conflictNote: string, team = '', handoffs = ''): string {
  return `Project goal: ${goal}
Plan: ${summary}

Your task (${t.id}): ${t.title}
${t.spec}

Acceptance:
${list(t.acceptance)}
${team ? `\nTeam (parallel, separate branches; do not do their work):\n${team}\n` : ''}${handoffs ? `\nHand-offs from tasks you build on:\n${handoffs}\n` : ''}
Files in repo:
${files.length ? files.join('\n') : '(empty)'}
${conflictNote ? `\n${conflictNote}\n` : ''}
Other tasks run in parallel on separate branches; stay within this task. Write the code in this folder and do not commit.
Finish with one line: DONE: <what changed> or BLOCKED: <why>.`;
}

export function reviewPrompt(t: MissionTask, diff: string): string {
  return `Review the change for task "${t.title}".
Acceptance:
${list(t.acceptance)}
${t.handoff ? `Coder's note: ${t.handoff}\n` : ''}
Diff:
\`\`\`diff
${diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n…[diff truncated]` : diff}
\`\`\`

Check correctness, acceptance, real bugs and security. Ignore style and naming.
Reply with ONE json block: {"approve":true|false,"issues":["specific, actionable issue"]}`;
}

export const fixReviewPrompt = (issues: string[]) =>
  `Reviewer requested fixes:\n${list(issues)}\n\nFix them in this folder. Finish with one line: DONE: <what changed> or BLOCKED: <why>.`;

export function fixChecksPrompt(goal: string, step: VerifyStep, output: string, handoffs = ''): string {
  return `Project goal: ${goal}
The ${step.name} check failed: \`${step.command}\` exited ${step.exitCode ?? 'abnormally'}.
${handoffs ? `\nWhat each task built:\n${handoffs}\n` : ''}
Output (tail):
\`\`\`
${tail(output, OUTPUT_TAIL)}
\`\`\`

Fix the code so the check passes. Do not weaken or delete tests. Finish with one line: DONE: <what changed>.`;
}

export function shipPrompt(m: Mission): string {
  const checks = m.checks.map((c) => `${c.name}: \`${c.command}\` → exit ${c.exitCode ?? 'n/a'}`).join('\n') || 'no automated checks';
  const tasks = m.tasks.map((t) => `${t.title}: ${t.status}${t.handoff ? ` · ${t.handoff}` : ''}${t.note ? ` (${t.note})` : ''}`).join('\n');
  return `Write the ship report for this finished mission, for the user.
Goal: ${m.goal}
Tasks:
${tasks}
Checks:
${checks}

Look at the repository. Markdown, under 250 words, with these headings: ## What you got (what it does and how it looks), ## How to use it (controls or steps; the Test button in Agentic OS launches it), ## Under the hood (stack, main files), ## Checks, ## Known gaps. No preamble.`;
}

export const takeoverPrompt = (reason: string, next: string) =>
  `The previous agent on this task stopped (${reason}). Continue from the files already in this folder; do not start over.\n\n${next}`;
