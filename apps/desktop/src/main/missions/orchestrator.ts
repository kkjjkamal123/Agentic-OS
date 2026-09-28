import { randomUUID } from 'node:crypto';
import { RUNTIMES, vendorOf, type ModelRef, type Role, type Routed, type SessionInfo, type Vendor } from '@shared/agents';
import {
  DispatchSchema, PlanSchema, ReviewSchema,
  type Mission, type MissionEvent, type MissionStart, type MissionTask, type Plan, type VerifyStep,
} from '@shared/missions';
import { agentEnv } from '../env';
import type { AgentManager, Reply } from '../agents/manager';
import { classifyError } from '../agents/router';
import type { Db } from '../store/db';
import type { SettingsStore } from '../store/settings';
import type { Gate } from '../tools/gate';
import { runSandboxed } from '../tools/sandbox';
import type { TerminalFeed } from '../tools/terminal';
import { git, type Workspaces } from '../workspace/workspaces';
import { describeRun, type Launcher } from './launcher';
import { codePrompt, dispatchPrompt, fixChecksPrompt, fixReviewPrompt, handoffBrief, planPrompt, reviewPrompt, shipPrompt, takeoverPrompt, teamBrief } from './prompts';

// How hard each usage level works a mission: review/fix rounds cost the most tokens.
const LEVEL = {
  saver: { reviewRounds: 1, fixRounds: 1, reviewLight: false },
  balanced: { reviewRounds: 2, fixRounds: 3, reviewLight: true },
  max: { reviewRounds: 3, fixRounds: 4, reviewLight: true },
} as const;
const MAX_MODEL_ATTEMPTS = 5;
const MERGE_ATTEMPTS = 2;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const ACTIVE = new Set(['planning', 'building', 'verifying', 'shipping']);

class Cancelled extends Error {}
class OverBudget extends Error {}

/** A short, clean workspace name from a free-text goal. */
export function nameFromGoal(goal: string): string {
  const words = goal.split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')).filter((w) => w && !/[`'"]/.test(w)).slice(0, 5);
  return words.join(' ') || 'Mission';
}

/** The line a coder ends on ("DONE: ..."), used as its hand-off note to the team. */
export function doneLine(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.findLast((l) => /^(DONE|BLOCKED):/i.test(l)) ?? lines.at(-1) ?? '').slice(0, 240);
}

export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  for (const c of [...fenced.reverse(), start >= 0 && end > start ? text.slice(start, end + 1) : '']) {
    try {
      if (c.trim()) return JSON.parse(c);
    } catch {}
  }
  return null;
}

export interface MissionDeps {
  db: Db;
  agents: AgentManager;
  workspaces: Workspaces;
  gate: Gate;
  feed: TerminalFeed;
  settings: SettingsStore;
  send: (m: Mission) => void;
  event: (e: MissionEvent) => void;
  workspacesChanged: () => void;
  record?: (m: Mission, workspacePath: string) => void;
  launcher?: Launcher;
}

interface Ctl {
  cancelled: boolean;
}

export class Missions {
  private d: MissionDeps;
  private ctl = new Map<string, Ctl>();
  private overBudget = new Map<string, string>();
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(deps: MissionDeps) {
    this.d = deps;
  }

  list(): Mission[] {
    return (this.d.db.prepare('SELECT data FROM missions ORDER BY created_at DESC LIMIT 50').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  get(id: string): Mission {
    const row = this.d.db.prepare('SELECT data FROM missions WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) throw new Error('Mission not found');
    return JSON.parse(row.data);
  }

  events(id: string): MissionEvent[] {
    return (this.d.db.prepare('SELECT mission_id AS missionId, ts, kind, text FROM mission_events WHERE mission_id = ? ORDER BY id').all(id) as unknown as MissionEvent[]);
  }

  /** Missions that were running when the app quit can't be resumed mid-agent; mark them honestly. */
  recoverInterrupted() {
    for (const m of this.list()) {
      if (!ACTIVE.has(m.status)) continue;
      m.status = 'failed';
      m.error = 'Interrupted: the app closed while this mission was running. Start it again to continue from the committed work.';
      m.activeSessions = [];
      for (const t of m.tasks) if (!['done', 'failed'].includes(t.status)) t.status = 'cancelled';
      this.save(m);
    }
  }

  async start(input: MissionStart): Promise<Mission> {
    const ws = input.workspaceId
      ? this.d.workspaces.get(input.workspaceId)
      : await this.d.workspaces.create(nameFromGoal(input.goal));
    if (!input.workspaceId) this.d.workspacesChanged();
    const now = new Date().toISOString();
    const m: Mission = {
      id: randomUUID(), goal: input.goal, workspaceId: ws.id, workspaceName: ws.name, quality: input.quality ?? this.d.settings.get().quality,
      status: 'planning', stage: 'plan', tasks: [], verify: {}, checks: [], fixRounds: 0, usage: { input: 0, output: 0, cached: 0 },
      activeSessions: [], createdAt: now, updatedAt: now,
    };
    this.d.db.prepare('INSERT INTO missions (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)').run(m.id, JSON.stringify(m), now, now);
    this.ctl.set(m.id, { cancelled: false });
    this.log(m, 'info', `Mission started in workspace "${ws.name}" (${m.quality === 'max' ? 'max quality' : 'balanced'}).`);
    void this.run(m);
    return m;
  }

  cancel(id: string) {
    const c = this.ctl.get(id);
    if (!c) return;
    c.cancelled = true;
    const m = this.get(id);
    for (const s of m.activeSessions) {
      void this.d.agents.cancel(s).catch(() => {});
      this.d.agents.stop(s);
    }
    this.d.gate.dropSession(id);
  }

  private save(m: Mission) {
    m.updatedAt = new Date().toISOString();
    this.d.db.prepare('UPDATE missions SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(m), m.updatedAt, m.id);
    this.d.send(structuredClone(m));
  }

  private log(m: Mission, kind: MissionEvent['kind'], text: string) {
    const e: MissionEvent = { missionId: m.id, ts: Date.now(), kind, text };
    this.d.db.prepare('INSERT INTO mission_events (mission_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(e.missionId, e.ts, e.kind, e.text);
    this.d.event(e);
  }

  private check(m: Mission) {
    if (this.ctl.get(m.id)?.cancelled) throw new Cancelled();
    const budget = this.overBudget.get(m.id);
    if (budget) throw new OverBudget(budget);
  }

  private addUsage(m: Mission, r: Reply) {
    m.usage.input += r.usage.input;
    m.usage.output += r.usage.output;
    m.usage.cached += r.usage.cached;
    const budget = this.d.settings.get().missionTokenBudget * 1000;
    if (budget && m.usage.input + m.usage.output > budget) {
      throw new OverBudget(`Stopped: the token budget of ${(budget / 1000).toLocaleString()}k new tokens per mission was reached. Raise it in Settings or use Run again.`);
    }
  }

  private stopSession(m: Mission, id: string | undefined) {
    if (!id) return;
    this.d.agents.stop(id);
    m.activeSessions = m.activeSessions.filter((s) => s !== id);
  }

  /**
   * Starts the best agent for the role and sends the prompt. If the model is unavailable,
   * out of credits or rate-limited, the next candidate takes over, so a mission never
   * stalls on one provider.
   */
  private async askBest(
    m: Mission,
    role: Role,
    root: string,
    prompt: string,
    opts: { avoidVendor?: Vendor; readOnly?: boolean; complexity?: MissionTask['complexity']; prefer?: ModelRef; exclude?: Set<string> } = {},
  ): Promise<{ info: SessionInfo; reply: Reply }> {
    const exclude = new Set(opts.exclude);
    let lastError = '';
    for (let i = 0; i < MAX_MODEL_ATTEMPTS; i++) {
      this.check(m);
      const want = { quality: m.quality, complexity: opts.complexity, exclude };
      const ranked = await this.d.agents.candidates(role, { ...want, avoidVendor: opts.avoidVendor });
      // The dispatcher's pick goes first while it is still available (not excluded, limited or cooling).
      const preferred = opts.prefer && ranked.find((r) => r.runtime === opts.prefer!.runtime && r.model === opts.prefer!.model);
      let c = preferred || ranked[0];
      // Only one vendor available: a same-vendor review still beats none.
      if (!c && opts.avoidVendor) [c] = await this.d.agents.candidates(role, want);
      if (!c) break;
      let info: SessionInfo;
      try {
        info = await this.d.agents.start(role, { ref: { runtime: c.runtime, model: c.model }, quality: m.quality, complexity: opts.complexity, root, readOnly: opts.readOnly });
      } catch (e) {
        lastError = (e as Error).message;
        exclude.add(`${c.runtime}|${c.model}`);
        this.log(m, 'error', `${c.runtime}/${c.model} could not start: ${lastError}`);
        continue;
      }
      m.activeSessions.push(info.id);
      this.save(m);
      const reply = await this.d.agents.ask(info.id, prompt);
      this.addUsage(m, reply);
      this.check(m);
      if (reply.error && classifyError(reply.error) !== 'other') {
        lastError = reply.error;
        exclude.add(`${c.runtime}|${c.model}`);
        this.stopSession(m, info.id);
        this.log(m, 'switch', `${c.runtime}/${c.model} failed (${reply.error.slice(0, 160)}); switching to the next best available model.`);
        continue;
      }
      return { info, reply };
    }
    throw new Error(`No working model for ${role}${lastError ? `: ${lastError}` : ''}`);
  }

  private async run(m: Mission) {
    try {
      const plan = await this.plan(m);
      await this.dispatch(m);
      m.status = 'building';
      m.stage = 'build';
      this.save(m);
      await this.build(m, plan);
      const failedTasks = m.tasks.filter((t) => t.status === 'failed');
      if (failedTasks.length === m.tasks.length) throw new Error('Every task failed; see the task notes.');

      m.status = 'verifying';
      m.stage = 'test';
      this.save(m);
      const ok = await this.verifyAndFix(m);

      m.status = 'shipping';
      m.stage = 'ship';
      this.save(m);
      const ws = this.d.workspaces.get(m.workspaceId);
      await this.d.workspaces.commitAll(ws.path, `Mission: ${m.goal.slice(0, 60)}`);
      const { info, reply } = await this.askBest(m, 'summarize', ws.path, shipPrompt(m), { readOnly: true });
      this.stopSession(m, info.id);
      m.report = reply.text.trim();
      m.stats = await this.d.workspaces.stats(ws.path);
      m.finishedAt = new Date().toISOString();
      m.status = ok && !failedTasks.length ? 'done' : 'failed';
      if (!ok) m.error = 'Checks still fail after automatic fixes. The report lists what is left.';
      else if (failedTasks.length) m.error = `${failedTasks.length} task(s) failed; the rest shipped.`;
      this.log(m, 'ship', m.status === 'done' ? 'Shipped.' : m.error!);
    } catch (e) {
      const cancelled = e instanceof Cancelled;
      if (e instanceof OverBudget) this.log(m, 'error', e.message);
      m.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) m.error = (e as Error).message;
      this.overBudget.delete(m.id);
      for (const t of m.tasks) if (!['done', 'failed'].includes(t.status)) t.status = 'cancelled';
      this.log(m, cancelled ? 'info' : 'error', cancelled ? 'Mission cancelled.' : `Mission failed: ${m.error}`);
    } finally {
      for (const s of m.activeSessions) this.d.agents.stop(s);
      m.activeSessions = [];
      this.save(m);
      this.ctl.delete(m.id);
      try {
        this.d.record?.(m, this.d.workspaces.get(m.workspaceId).path);
      } catch {}
    }
  }

  private async plan(m: Mission): Promise<Plan> {
    const ws = this.d.workspaces.get(m.workspaceId);
    const { info, reply } = await this.askBest(m, 'plan', ws.path, planPrompt(m.goal, await this.d.workspaces.files(ws.path)), { readOnly: true });
    m.planner = info.ref;
    let parsed = PlanSchema.safeParse(extractJson(reply.text));
    if (!parsed.success) {
      const retry = await this.d.agents.ask(info.id, `That was not valid plan JSON (${parsed.error.issues[0]?.message}). Reply again with only the JSON block.`);
      this.addUsage(m, retry);
      parsed = PlanSchema.safeParse(extractJson(retry.text));
    }
    this.stopSession(m, info.id);
    if (!parsed.success) throw new Error(`The planner (${info.ref.model}) did not return a usable plan.`);
    const plan = parsed.data;
    const ids = new Set(plan.tasks.map((t) => t.id));
    m.summary = plan.summary;
    m.verify = plan.verify;
    m.product = plan.product;
    m.stack = plan.stack;
    m.run = plan.run;
    m.tasks = plan.tasks.map((t) => ({ ...t, deps: t.deps.filter((d) => ids.has(d) && d !== t.id), status: 'queued', rounds: 0 }));
    this.dropCycles(m);
    this.log(m, 'plan', `${info.ref.model} planned ${m.tasks.length} task(s): ${m.tasks.map((t) => t.title).join('; ')}`);
    this.save(m);
    return plan;
  }

  /**
   * One cheap call (Gemini Flash-Lite on omp when signed in) assigns a coder and reviewer to every
   * task from shortlists the router already vetted. Anything invalid or unavailable falls back to routing.
   */
  private async dispatch(m: Mission) {
    const options = new Map<string, { coders: [string, string][]; reviewers: [string, string][] }>();
    const refs = new Map<string, Routed>();
    let n = 0;
    const label = (r: Routed) => `${r.runtime}/${r.model.replace(/^google-antigravity\//, '')} (${vendorOf(r)}, ${RUNTIMES[r.runtime].source}, ${r.effort})`;
    const opt = (prefix: string, rs: Routed[]): [string, string][] =>
      rs.slice(0, 4).map((r) => {
        const id = `${prefix}${++n}`;
        refs.set(id, r);
        return [id, label(r)];
      });
    for (const t of m.tasks) {
      const coders = await this.d.agents.candidates('code', { quality: m.quality, complexity: t.complexity });
      const reviewers = await this.d.agents.candidates('review', { quality: m.quality });
      options.set(t.id, { coders: opt('c', coders), reviewers: opt('r', reviewers) });
    }
    // Nothing to decide: skip the call.
    if ([...options.values()].every((o) => o.coders.length <= 1 && o.reviewers.length <= 1)) return;
    const ws = this.d.workspaces.get(m.workspaceId);
    try {
      const { info, reply } = await this.askBest(m, 'summarize', ws.path, dispatchPrompt(m, options), { readOnly: true });
      this.stopSession(m, info.id);
      m.dispatcher = info.ref;
      const parsed = DispatchSchema.safeParse(extractJson(reply.text));
      if (!parsed.success) throw new Error('unreadable assignment');
      for (const a of parsed.data.assign) {
        const t = m.tasks.find((x) => x.id === a.task);
        const o = options.get(a.task);
        if (!t || !o) continue;
        const coder = o.coders.some(([id]) => id === a.coder) ? refs.get(a.coder) : undefined;
        const reviewer = a.reviewer && o.reviewers.some(([id]) => id === a.reviewer) ? refs.get(a.reviewer) : undefined;
        if (coder) t.plannedCoder = { runtime: coder.runtime, model: coder.model };
        if (reviewer && (!coder || vendorOf(reviewer) !== vendorOf(coder))) t.plannedReviewer = { runtime: reviewer.runtime, model: reviewer.model };
        t.dispatchNote = a.why;
      }
      this.log(m, 'dispatch', `${info.ref.model} assigned: ${m.tasks.map((t) => `${t.id}→${t.plannedCoder?.model.replace(/^google-antigravity\//, '') ?? 'auto'}`).join(', ')}`);
    } catch (e) {
      if (e instanceof Cancelled || e instanceof OverBudget) throw e;
      this.log(m, 'dispatch', `Dispatcher unavailable (${(e as Error).message.slice(0, 120)}); routing assigns models.`);
    }
    this.save(m);
  }

  // A plan whose deps loop would leave tasks queued forever; drop the edge that closes each cycle.
  private dropCycles(m: Mission) {
    const byId = new Map(m.tasks.map((t) => [t.id, t]));
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (t: MissionTask) => {
      state.set(t.id, 'visiting');
      t.deps = t.deps.filter((d) => {
        if (state.get(d) === 'visiting') return false;
        if (!state.has(d)) visit(byId.get(d)!);
        return true;
      });
      state.set(t.id, 'done');
    };
    for (const t of m.tasks) if (!state.has(t.id)) visit(t);
  }

  private async build(m: Mission, plan: Plan) {
    const running = new Map<string, Promise<void>>();
    const max = this.d.settings.get().maxParallelAgents;
    for (;;) {
      this.check(m);
      for (const t of m.tasks) {
        const bad = t.deps.find((d) => ['failed', 'cancelled'].includes(m.tasks.find((x) => x.id === d)!.status));
        if (t.status === 'queued' && bad) {
          t.status = 'failed';
          t.note = `Skipped: depends on ${bad}, which failed.`;
        }
      }
      const ready = m.tasks.filter((t) => t.status === 'queued' && !running.has(t.id) && t.deps.every((d) => m.tasks.find((x) => x.id === d)!.status === 'done'));
      for (const t of ready.slice(0, Math.max(0, max - running.size))) {
        running.set(
          t.id,
          this.runTask(m, t, plan)
            .catch((e) => {
              if (e instanceof Cancelled || e instanceof OverBudget) {
                if (e instanceof OverBudget) this.overBudget.set(m.id, e.message);
                t.status = 'cancelled';
                return;
              }
              t.status = 'failed';
              t.note = (e as Error).message;
              this.log(m, 'error', `${t.title}: ${t.note}`);
            })
            .finally(() => {
              running.delete(t.id);
              this.save(m);
            }),
        );
      }
      this.save(m);
      if (!running.size) break;
      await Promise.race(running.values());
    }
    this.check(m);
  }

  /** Publishes what the coder did so reviewers, dependent tasks, fixers and the report know. */
  private async postHandoff(m: Mission, t: MissionTask, wt: string, base: string, text: string) {
    const files = await this.d.workspaces.changedFiles(wt, base);
    const note = doneLine(text);
    t.handoff = `${note}${files.length ? ` · files: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` +${files.length - 12}` : ''}` : ''}`;
    this.log(m, 'handoff', `${t.id}: ${t.handoff}`);
    this.save(m);
  }

  private merge(m: Mission, branch: string, message: string): Promise<string[]> {
    const next = this.mergeChain.then(() => this.d.workspaces.mergeWorktree(m.workspaceId, branch, message));
    this.mergeChain = next.catch(() => {});
    return next;
  }

  private async runTask(m: Mission, t: MissionTask, plan: Plan) {
    const ws = this.d.workspaces.get(m.workspaceId);
    let conflictNote = '';
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
      this.check(m);
      const branch = `task/${t.id}-${m.id.slice(0, 6)}-${attempt}`;
      const base = (await git(ws.path, ['rev-parse', 'main'])).trim();
      const wt = await this.d.workspaces.addWorktree(m.workspaceId, branch);
      t.status = 'coding';
      this.save(m);
      const files = await this.d.workspaces.files(wt);
      const brief = codePrompt(m.goal, plan.summary, t, files, conflictNote, teamBrief(m, t), handoffBrief(m, t.deps));
      const { info, reply } = await this.askBest(m, 'code', wt, brief, { complexity: t.complexity, prefer: t.plannedCoder });
      let coderId = info.id;
      t.coder = info.ref;
      t.sessionId = info.id;
      this.log(m, 'task', `${t.title} (${t.complexity}) → ${info.ref.runtime}/${info.ref.model}, ${info.effort} effort`);
      if (reply.error) {
        this.stopSession(m, info.id);
        await this.d.workspaces.removeWorktree(m.workspaceId, branch);
        throw new Error(`Coder failed: ${reply.error}`);
      }
      await this.postHandoff(m, t, wt, base, reply.text);

      const level = LEVEL[m.quality];
      const reviewRounds = t.complexity === 'light' && !level.reviewLight ? 0 : level.reviewRounds;
      for (let round = 0; round < reviewRounds; round++) {
        const diff = await this.d.workspaces.diffSince(wt, base);
        if (!diff.trim()) {
          const last = reply.text.trim().split('\n').pop()?.slice(0, 300) ?? '';
          t.note = `No files changed. Coder said: ${last || '(nothing)'}`;
          this.log(m, 'task', `${t.title}: ${t.note}`);
          break;
        }
        t.status = 'reviewing';
        this.save(m);
        const planned = t.plannedReviewer && vendorOf(t.plannedReviewer) !== vendorOf(t.coder) ? t.plannedReviewer : undefined;
        const rv = await this.askBest(m, 'review', wt, reviewPrompt(t, diff), { avoidVendor: vendorOf(t.coder), readOnly: true, prefer: planned });
        t.reviewer = rv.info.ref;
        this.stopSession(m, rv.info.id);
        const verdict = ReviewSchema.safeParse(extractJson(rv.reply.text));
        if (!verdict.success) {
          this.log(m, 'review', `${t.title}: review by ${rv.info.ref.model} was unreadable; tests will decide.`);
          break;
        }
        if (verdict.data.approve || !verdict.data.issues.length) {
          this.log(m, 'review', `${t.title}: approved by ${rv.info.ref.model}.`);
          break;
        }
        this.log(m, 'review', `${t.title}: ${rv.info.ref.model} requested ${verdict.data.issues.length} fix(es).`);
        t.status = 'fixing';
        t.rounds++;
        this.save(m);
        const fix = await this.d.agents.ask(coderId, fixReviewPrompt(verdict.data.issues));
        this.addUsage(m, fix);
        let fixText = fix.text;
        if (fix.error && classifyError(fix.error) !== 'other') {
          // Coder hit a limit mid-task: the next best model picks up the same files and the same fixes.
          this.stopSession(m, coderId);
          const next = await this.askBest(m, 'code', wt, takeoverPrompt(fix.error.slice(0, 120), `${brief}\n\n${fixReviewPrompt(verdict.data.issues)}`), {
            complexity: t.complexity,
            exclude: new Set([`${t.coder.runtime}|${t.coder.model}`]),
          });
          this.log(m, 'switch', `${t.title}: ${t.coder.model} stopped (${fix.error.slice(0, 80)}); ${next.info.ref.model} took over.`);
          coderId = next.info.id;
          t.coder = next.info.ref;
          t.sessionId = next.info.id;
          fixText = next.reply.text;
        }
        await this.postHandoff(m, t, wt, base, fixText);
      }
      this.stopSession(m, coderId);
      t.status = 'merging';
      this.save(m);
      const conflicts = await this.merge(m, branch, `${t.id}: ${t.title}`);
      if (!conflicts.length) {
        t.status = 'done';
        this.log(m, 'merge', `${t.title} merged.`);
        return;
      }
      await this.d.workspaces.removeWorktree(m.workspaceId, branch);
      conflictNote = `Your previous attempt conflicted with work merged meanwhile in: ${conflicts.join(', ')}. Redo the task on top of the current code.`;
      this.log(m, 'merge', `${t.title}: merge conflict in ${conflicts.join(', ')}; redoing on latest code.`);
    }
    throw new Error('Merge conflicts persisted after a retry.');
  }

  private async runChecks(m: Mission, root: string, skipSetup: boolean): Promise<{ ok: true } | { ok: false; step: VerifyStep; output: string }> {
    const env = await agentEnv();
    for (const name of ['setup', 'build', 'test'] as const) {
      const command = m.verify[name];
      if (!command || (name === 'setup' && skipSetup)) continue;
      this.check(m);
      const step: VerifyStep = { name, command, exitCode: null };
      if (!(await this.d.gate.check(m.id, 'Mission', root, { kind: 'execute', command, title: command }))) {
        m.checks.push(step);
        return { ok: false, step, output: 'The command was denied by the approval policy.' };
      }
      const id = this.d.feed.start(m.id, 'Mission', root, command);
      const r = await runSandboxed(command, root, env, { timeoutMs: CHECK_TIMEOUT_MS, onData: (c) => this.d.feed.append(id, c) });
      this.d.feed.finish(id, r.exitCode);
      step.exitCode = r.exitCode;
      m.checks.push(step);
      this.log(m, 'check', `${name}: \`${command}\` → exit ${r.exitCode ?? 'killed'}`);
      this.save(m);
      if (r.exitCode !== 0) return { ok: false, step, output: r.output };
    }
    // Shipped means it starts: open the product the way the Test button will.
    if (m.run && this.d.launcher) {
      const step: VerifyStep = { name: 'launch', command: describeRun(m.run), exitCode: null };
      const r = await this.d.launcher.check(m.run, root, m.id);
      step.exitCode = r.ok ? 0 : 1;
      m.checks.push(step);
      this.log(m, 'check', `launch: ${step.command} → ${r.ok ? 'starts' : 'failed'}`);
      this.save(m);
      if (!r.ok) return { ok: false, step, output: r.output };
    }
    return { ok: true };
  }

  private async verifyAndFix(m: Mission): Promise<boolean> {
    const ws = this.d.workspaces.get(m.workspaceId);
    if (!m.verify.build && !m.verify.test && !m.run) {
      this.log(m, 'check', 'The plan has no build, test or launch step; skipping checks.');
      return true;
    }
    let res = await this.runChecks(m, ws.path, false);
    while (!res.ok && m.fixRounds < LEVEL[m.quality].fixRounds) {
      m.fixRounds++;
      this.log(m, 'fix', `Fix round ${m.fixRounds}: ${res.step.name} failed.`);
      this.save(m);
      const { info } = await this.askBest(m, 'code', ws.path, fixChecksPrompt(m.goal, res.step, res.output, handoffBrief(m)));
      this.stopSession(m, info.id);
      await this.d.workspaces.commitAll(ws.path, `Fix ${res.step.name} (round ${m.fixRounds})`);
      res = await this.runChecks(m, ws.path, res.step.name !== 'setup');
    }
    return res.ok;
  }
}
