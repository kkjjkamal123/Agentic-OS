import { AppWindow, Check, ChevronRight, FolderOpen, Globe, Loader2, Play, Plus, RotateCcw, Rocket, Square, SquareTerminal, Target, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RUNTIMES, type ModelRef } from '@shared/agents';
import { ACCOUNTS, type AccountStatus } from '@shared/accounts';
import type { Mission, MissionTask, Stage } from '@shared/missions';
import type { Quality } from '@shared/settings';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, cx } from '../../components/ui';
import { useAgents } from '../../lib/agents';
import { ACTIVE, useMissions } from '../../lib/missions';
import { useSettings } from '../../lib/settings';
import { useOs } from '../../lib/workspace';

const STAGES: { id: Stage; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'review', label: 'Review' },
  { id: 'test', label: 'Test' },
  { id: 'ship', label: 'Ship' },
];
const SELECT = 'h-8 rounded-lg border border-line-strong bg-surface-solid px-2 text-[13px] text-fg focus:border-accent focus:outline-none';

const model = (r?: ModelRef) => (r ? `${RUNTIMES[r.runtime].label} · ${r.model.replace(/^google-antigravity\//, '')}` : '');

function StatusBadge({ status }: { status: Mission['status'] | MissionTask['status'] }) {
  const tone = status === 'done' ? 'success' : status === 'failed' ? 'danger' : status === 'cancelled' || status === 'queued' ? 'neutral' : 'accent';
  return <Badge tone={tone}>{ACTIVE.has(status) || ['coding', 'reviewing', 'fixing', 'merging'].includes(status) ? <Loader2 size={10} className="animate-spin" /> : null}{status}</Badge>;
}

function GettingStarted() {
  const [accounts, setAccounts] = useState<AccountStatus[] | null>(null);
  useEffect(() => {
    void window.aos.accounts.list().then(setAccounts);
    return window.aos.on('accounts:changed', setAccounts);
  }, []);
  const steps = [
    ['Describe the result you want', 'Be concrete: platform, main features, "with tests". One goal per mission.'],
    ['Watch it work', 'Tasks show which model is coding and which is reviewing. Commands appear in Terminal and files in Files.'],
    ['Answer approvals', 'Anything outside the project, or a push or deploy, pops up top-right. Everything else runs on its own.'],
    ['Open the result', 'When it ships, read the report and click Finder. If it fails, Run again continues from what was built.'],
  ];
  return (
    <div className="mt-8 grid gap-4 md:grid-cols-2" aria-label="Getting started">
      <section className="rounded-xl border border-line p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">How it works</h3>
        <ol className="space-y-2.5">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{i + 1}</span>
              <div>
                <div className="text-[13px] font-medium">{t}</div>
                <div className="text-xs text-muted">{d}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-xl border border-line p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Your agents</h3>
        <ul className="space-y-2">
          {ACCOUNTS.map((a) => {
            const st = accounts?.find((x) => x.id === a.id);
            const action = st && !st.installed ? 'install' : st?.signedIn === false ? 'login' : null;
            return (
              <li key={a.id} className="flex items-center gap-2">
                <span className={cx('h-2 w-2 shrink-0 rounded-full', !st ? 'bg-surface-3' : st.signedIn ? 'bg-success' : 'bg-warning')} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{a.label}</div>
                  <div className="truncate text-xs text-muted">{!st ? 'Checking…' : st.signedIn ? (st.plan ?? 'Ready') : st.installed ? 'Not signed in' : 'Not installed'}</div>
                </div>
                {action && <Button onClick={() => void window.aos.accounts.openTerminal(a.id, action)}>{action === 'install' ? 'Install…' : 'Sign in…'}</Button>}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted">More agents means more work in parallel and a second opinion on every change. API keys (NVIDIA, OpenRouter…) go in Settings → Accounts & keys.</p>
      </section>
    </div>
  );
}

function Composer() {
  const start = useMissions((s) => s.start);
  const error = useMissions((s) => s.error);
  const workspaces = useOs((s) => s.workspaces);
  const loadWorkspaces = useOs((s) => s.loadWorkspaces);
  const defaultQuality = useSettings((s) => s.settings?.quality ?? 'balanced');
  const [goal, setGoal] = useState('');
  const [ws, setWs] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const catalog = useAgents((s) => s.catalog);
  useEffect(() => void (!workspaces && loadWorkspaces()), [workspaces, loadWorkspaces]);
  // Pre-flight: can anything plan right now? Re-checked whenever the model catalog changes.
  useEffect(() => {
    let live = true;
    void window.aos.agents.route('plan', quality ?? defaultQuality).then((r) => live && setReady(!!r));
    return () => void (live = false);
  }, [catalog, quality, defaultQuality]);
  const launch = async () => {
    setBusy(true);
    await start({ goal: goal.trim(), workspaceId: ws || undefined, quality: quality ?? defaultQuality });
    setBusy(false);
    setGoal('');
  };
  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-4 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent"><Target size={18} /></div>
        <div>
          <h2 className="text-base font-semibold">What should the agents build?</h2>
          <p className="text-xs text-muted">One goal. A planner splits it into tasks, several models build them in parallel, a different vendor reviews each change, then real tests run until it ships.</p>
        </div>
      </div>
      <textarea
        aria-label="Mission goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && goal.trim().length > 2 && ready !== false && void launch()}
        rows={5}
        placeholder="e.g. A macOS menu-bar Pomodoro timer in SwiftUI with a settings screen and unit tests"
        className="w-full resize-none rounded-xl border border-line-strong bg-surface-solid p-3 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Mission workspace" value={ws} onChange={(e) => setWs(e.target.value)} className={SELECT}>
          <option value="">New workspace from the goal</option>
          {workspaces?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select aria-label="Mission quality" value={quality ?? defaultQuality} onChange={(e) => setQuality(e.target.value as Quality)} className={SELECT}>
          <option value="saver">Saver</option>
          <option value="balanced">Balanced</option>
          <option value="max">Max quality</option>
        </select>
        <Button variant="primary" className="ml-auto" disabled={goal.trim().length < 3 || busy || ready === false} onClick={() => void launch()}>
          <Rocket size={14} /> {busy ? 'Starting…' : 'Launch mission'}
        </Button>
      </div>
      {ready === false ? (
        <p role="alert" className="mt-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
          No agent is available right now. Sign in to a subscription below, or add an API key in Settings → Accounts &amp; keys.
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-faint">⌘↩ to launch. Anything risky still asks you first.</p>
      )}
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}
      <GettingStarted />
    </div>
  );
}

function Stepper({ m }: { m: Mission }) {
  const current = STAGES.findIndex((s) => s.id === m.stage);
  const finished = m.status === 'done';
  const reviewing = m.tasks.some((t) => t.status === 'reviewing' || t.status === 'fixing');
  return (
    <ol className="flex items-center gap-1.5 text-xs" aria-label="Mission stages">
      {STAGES.map((s, i) => {
        const active = !finished && ACTIVE.has(m.status) && (i === current || (s.id === 'review' && reviewing));
        const done = finished || i < current || (s.id === 'review' && current > 2);
        return (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className={cx('flex items-center gap-1 rounded-md border px-2 py-1 font-medium', active ? 'border-accent bg-accent-soft text-accent' : done ? 'border-success/40 text-success' : 'border-line-strong text-faint')}>
              {done ? <Check size={11} /> : active ? <Loader2 size={11} className="animate-spin" /> : null}
              {s.label}
            </span>
            {i < STAGES.length - 1 && <ChevronRight size={12} className="text-faint" />}
          </li>
        );
      })}
    </ol>
  );
}

function TaskRow({ t, live }: { t: MissionTask; live: boolean }) {
  const activity = useAgents((s) => (t.sessionId ? s.activity[t.sessionId] : undefined));
  return (
    <li className="rounded-xl border border-line" data-task={t.id}>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-3">
          <ChevronRight size={12} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
          <span className="text-[11px] font-medium text-faint">{t.id}</span>
          {t.complexity && t.complexity !== 'normal' && <Badge tone={t.complexity === 'hard' ? 'warning' : 'neutral'}>{t.complexity}</Badge>}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
          {t.rounds > 0 && <Badge>{t.rounds} fix round{t.rounds > 1 ? 's' : ''}</Badge>}
          <StatusBadge status={t.status} />
        </summary>
        <div className="space-y-2 border-t border-line px-3 py-2.5 text-xs text-muted">
          <p className="whitespace-pre-wrap text-fg/90" data-selectable>{t.spec}</p>
          {t.acceptance.length > 0 && (
            <ul className="space-y-0.5">{t.acceptance.map((a, i) => <li key={i}>☐ {a}</li>)}</ul>
          )}
          {t.dispatchNote && t.plannedCoder && <div>Dispatcher picked {model(t.plannedCoder)}: {t.dispatchNote}</div>}
        </div>
      </details>
      <div className="px-3 pb-3 text-[11px] text-muted">
        <div className="flex flex-wrap gap-1.5">
          {t.coder && <span>✎ {model(t.coder)}</span>}
          {t.reviewer && <span>· ✓ reviewed by {model(t.reviewer)}</span>}
          {t.deps.length > 0 && <span>· after {t.deps.join(', ')}</span>}
        </div>
        {live && activity && ['coding', 'fixing'].includes(t.status) && <div className="mt-1.5 truncate font-mono text-faint">{activity}</div>}
        {t.handoff && <div className="mt-1.5 text-xs" data-selectable>↪ {t.handoff}</div>}
        {t.note && <div className="mt-1.5 text-xs">{t.note}</div>}
      </div>
    </li>
  );
}

const RUN_ICON = { web: Globe, 'macos-app': AppWindow, cli: SquareTerminal } as const;

function duration(from: string, to?: string) {
  const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime();
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'under a minute' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function TestButton({ m }: { m: Mission }) {
  const test = useMissions((s) => s.test);
  const stopTest = useMissions((s) => s.stopTest);
  const state = useMissions((s) => s.tests[m.id]);
  if (!m.run || !m.tasks.some((t) => t.status === 'done')) return null;
  const Icon = RUN_ICON[m.run.kind];
  const running = state?.state === 'running' && m.run.kind === 'web';
  const starting = state?.state === 'starting';
  return (
    <div className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft p-3" aria-label="Test the result">
      <Icon size={18} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-xs">
        <div className="text-[13px] font-medium text-fg">{m.run.kind === 'web' ? 'Web app' : m.run.kind === 'macos-app' ? 'Mac app' : 'Command-line program'}</div>
        <div className="truncate text-muted" data-selectable>
          {state?.state === 'error' ? <span className="text-danger">{state.message}</span> : state?.url ? `Running at ${state.url}` : state?.message ?? 'Launch it and try it out.'}
        </div>
      </div>
      {running ? (
        <Button variant="danger" onClick={() => void stopTest(m.id)}><Square size={12} /> Stop</Button>
      ) : (
        <Button variant="primary" disabled={starting || ACTIVE.has(m.status)} onClick={() => void test(m.id)}>
          {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Test
        </Button>
      )}
    </div>
  );
}

function About({ m }: { m: Mission }) {
  if (!m.product && !m.summary) return null;
  const rows: [string, string | undefined][] = [
    ['Stack', m.stack],
    ['Runs as', m.run ? (m.run.kind === 'web' ? (m.run.start ? `web app via \`${m.run.start}\`` : `web page ${m.run.open ?? ''}`) : m.run.kind === 'macos-app' ? `Mac app ${m.run.open ?? ''}` : `terminal program \`${m.run.start ?? ''}\``) : undefined],
    ['Time', m.finishedAt ? `${duration(m.createdAt, m.finishedAt)} (finished ${new Date(m.finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : `started ${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`],
    ['Project', m.stats ? `${m.stats.files} files · ${m.stats.lines.toLocaleString()} lines · ${m.stats.testFiles} test file${m.stats.testFiles === 1 ? '' : 's'}` : undefined],
  ];
  return (
    <section className="rounded-xl border border-line p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">What's being built</h3>
      {m.product && <p className="mb-2 text-[13px] font-medium" data-selectable>{m.product}</p>}
      {m.summary && <p className="mb-3 text-[13px] leading-relaxed text-muted" data-selectable>{m.summary}</p>}
      <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint">{k}</dt>
            <dd className="text-muted" data-selectable>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Detail({ m }: { m: Mission }) {
  const cancel = useMissions((s) => s.cancel);
  const start = useMissions((s) => s.start);
  const events = useMissions((s) => s.events[m.id]);
  const live = ACTIVE.has(m.status);
  const done = m.tasks.filter((t) => t.status === 'done').length;
  return (
    <div className="space-y-5 p-6">
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug" data-selectable>{m.goal}</h2>
          <StatusBadge status={m.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>📁 {m.workspaceName}</span>
          {m.planner && <span>· planned by {model(m.planner)}</span>}
          {m.dispatcher && <span>· assigned by {model(m.dispatcher)}</span>}
          <span>· {m.quality === 'max' ? 'max quality' : m.quality}</span>
          <span>· {m.usage.input.toLocaleString()} in / {m.usage.output.toLocaleString()} out{m.usage.cached ? ` / ${m.usage.cached.toLocaleString()} cached` : ''} tokens</span>
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" onClick={() => void window.aos.workspaces.reveal(m.workspaceId)}><FolderOpen size={14} /> Finder</Button>
            {live && <Button variant="danger" onClick={() => void cancel(m.id)}><Square size={12} /> Cancel</Button>}
            {!live && m.status !== 'done' && (
              <Button onClick={() => void start({ goal: m.goal, workspaceId: m.workspaceId, quality: m.quality })} title="Plan the remaining work on top of what is already committed">
                <RotateCcw size={13} /> Run again
              </Button>
            )}
          </div>
        </div>
        <Stepper m={m} />
      </header>

      <TestButton m={m} />
      {m.error && <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{m.error}</div>}
      <About m={m} />

      {m.tasks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Tasks · {done}/{m.tasks.length} merged</h3>
          <ul className="space-y-2">{m.tasks.map((t) => <TaskRow key={t.id} t={t} live={live} />)}</ul>
        </section>
      )}

      {m.checks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Checks{m.fixRounds ? ` · ${m.fixRounds} automatic fix round${m.fixRounds > 1 ? 's' : ''}` : ''}</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {m.checks.map((c, i) => (
              <li key={i} className="flex items-center gap-2 px-3 py-2">
                <span className="w-14 text-xs text-muted">{c.name}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{c.command}</code>
                {c.exitCode === 0 ? <Badge tone="success">{c.name === 'launch' ? 'starts' : 'passed'}</Badge> : <Badge tone="danger">{c.name === 'launch' ? "didn't start" : `exit ${c.exitCode ?? '—'}`}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {m.report && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Ship report</h3>
          <div className="rounded-xl border border-line bg-surface-2 p-4"><Markdown text={m.report} /></div>
        </section>
      )}

      {events && events.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-faint">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" /> Log ({events.length})
          </summary>
          <ol className="mt-2 space-y-1 text-xs text-muted">
            {events.map((e, i) => (
              <li key={i} className="flex gap-2">
                <time className="shrink-0 tabular-nums text-faint">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <span data-selectable>{e.text}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

export function MissionApp() {
  const missions = useMissions((s) => s.missions);
  const selected = useMissions((s) => s.selected);
  const select = useMissions((s) => s.select);
  const m = missions?.find((x) => x.id === selected);
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface-2/50">
        <div className="border-b border-line p-3">
          <Button variant={m ? 'secondary' : 'primary'} className="w-full" onClick={() => void select(null)}><Plus size={14} /> New mission</Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto p-2" aria-label="Missions">
          {missions?.map((x) => (
            <li key={x.id}>
              <button
                onClick={() => void select(x.id)}
                className={cx('w-full rounded-lg px-2.5 py-2 text-left', x.id === selected ? 'bg-accent-soft' : 'hover:bg-surface-3')}
              >
                <div className={cx('line-clamp-2 text-[13px] font-medium', x.id === selected ? 'text-accent' : 'text-fg')}>{x.goal}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                  <StatusBadge status={x.status} />
                  <span className="truncate">{new Date(x.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </button>
            </li>
          ))}
          {missions?.length === 0 && <li className="p-3 text-xs text-muted">No missions yet.</li>}
        </ul>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">
        {m ? (
          <>
            <div className="flex justify-end px-4 pt-3">
              <button aria-label="Close mission" onClick={() => void select(null)} className="rounded-md p-1 text-muted hover:bg-surface-3"><X size={14} /></button>
            </div>
            <Detail m={m} />
          </>
        ) : (
          <Composer />
        )}
      </section>
    </div>
  );
}
