import { ArrowUp, Bot, ChevronRight, RefreshCw, Square, Wrench, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ROLES, RUNTIMES, type ModelRef, type Role, type Routed, type RuntimeCatalog } from '@shared/agents';
import type { Quality } from '@shared/settings';
import { Badge, Button, cx } from '../../components/ui';
import { useAgents, type Chat, type Msg } from '../../lib/agents';
import { useSettings } from '../../lib/settings';
import { useOs } from '../../lib/workspace';
import { NewWorkspace } from '../files/FilesApp';

const ROLE_LABEL: Record<Role, string> = { chat: 'Chat', plan: 'Plan', code: 'Code', review: 'Review', test: 'Test', summarize: 'Summarize' };
const SOURCE_LABEL = { subscription: 'Subscriptions', api: 'API keys', local: 'Local' } as const;

const refLabel = (r: ModelRef) => `${RUNTIMES[r.runtime].label} · ${r.model}`;
const SELECT = 'h-8 w-full rounded-lg border border-line-strong bg-surface-solid px-2 text-[13px] text-fg focus:border-accent focus:outline-none';

function ModelSelect({ catalog, value, onChange }: { catalog: RuntimeCatalog[]; value: string; onChange: (v: string) => void }) {
  const groups = (['subscription', 'api', 'local'] as const).map((src) => ({
    src,
    runtimes: catalog.filter((c) => RUNTIMES[c.runtime].source === src),
  }));
  return (
    <select aria-label="Model" value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      <option value="auto">Auto: best available for the role</option>
      {groups.map(({ src, runtimes }) => (
        <optgroup key={src} label={SOURCE_LABEL[src]}>
          {runtimes.flatMap((c) =>
            c.available && c.models.length
              ? c.models.slice(0, 60).map((m) => (
                  <option key={`${c.runtime}|${m.id}`} value={`${c.runtime}|${m.id}`}>
                    {RUNTIMES[c.runtime].label} · {m.name}
                  </option>
                ))
              : [
                  <option key={c.runtime} disabled value={`off|${c.runtime}`}>
                    {RUNTIMES[c.runtime].label}: {c.reason ?? 'unavailable'}
                  </option>,
                ],
          )}
        </optgroup>
      ))}
    </select>
  );
}

function Launcher() {
  const { catalog, loadingCatalog, loadCatalog, start, starting, error } = useAgents();
  const [role, setRole] = useState<Role>('chat');
  const [model, setModel] = useState('auto');
  const [preview, setPreview] = useState<Routed | null | undefined>(undefined);
  const defaultQuality = useSettings((s) => s.settings?.quality ?? 'balanced');
  const [quality, setQuality] = useState<Quality | null>(null);
  const q = quality ?? defaultQuality;
  const { workspaces, loadWorkspaces } = useOs();
  const [ws, setWs] = useState('');

  useEffect(() => {
    if (!catalog) void loadCatalog();
    if (!workspaces) void loadWorkspaces();
  }, [catalog, loadCatalog, workspaces, loadWorkspaces]);

  useEffect(() => {
    if (!catalog || model !== 'auto') return;
    let live = true;
    void window.aos.agents.route(role, q).then((r) => live && setPreview(r));
    return () => void (live = false);
  }, [catalog, role, model, q]);

  const launch = () => {
    const [runtime, ...rest] = model.split('|');
    const ref = model === 'auto' ? undefined : { runtime: runtime as ModelRef['runtime'], model: rest.join('|') };
    void start(role, { ref, quality: q, workspaceId: ws || undefined });
  };

  return (
    <div className="space-y-2.5 border-b border-line p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-faint">New session</span>
        <button
          aria-label="Refresh models"
          title="Re-check models (spawns each CLI once)"
          onClick={() => void loadCatalog(true)}
          disabled={loadingCatalog}
          className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={13} className={loadingCatalog ? 'animate-spin' : ''} />
        </button>
      </div>
      <select aria-label="Workspace" value={ws} onChange={(e) => setWs(e.target.value)} className={SELECT}>
        <option value="">Scratch folder (no project)</option>
        {workspaces?.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
      <NewWorkspace onCreated={setWs} />
      <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className={SELECT}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {catalog ? <ModelSelect catalog={catalog} value={model} onChange={setModel} /> : <div className="h-8 text-xs leading-8 text-muted">Checking models…</div>}
      <select aria-label="Quality" value={q} onChange={(e) => setQuality(e.target.value as Quality)} className={SELECT}>
        <option value="saver">Saver: stretch quotas</option>
        <option value="balanced">Balanced</option>
        <option value="max">Max quality</option>
      </select>
      {model === 'auto' && preview !== undefined && (
        <div className="text-xs text-muted" data-testid="route-preview">
          {preview ? <>→ {refLabel(preview)} <span className="text-faint">({preview.effort} effort)</span></> : 'No model available yet'}
        </div>
      )}
      <Button variant="primary" className="w-full" onClick={launch} disabled={!catalog || starting}>
        {starting ? 'Starting…' : 'Start'}
      </Button>
      {error && <div role="alert" className="text-xs text-danger">{error}</div>}
    </div>
  );
}

function SessionList() {
  const { chats, order, active, select, close } = useAgents();
  if (!order.length) return null;
  return (
    <ul className="min-h-0 flex-1 overflow-auto p-2" aria-label="Sessions">
      {order.map((id) => {
        const c = chats[id];
        return (
          <li key={id}>
            <div
              className={cx('group flex items-center gap-2 rounded-lg px-2 py-1.5', id === active ? 'bg-accent-soft' : 'hover:bg-surface-3')}
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => select(id)}>
                <div className={cx('truncate text-[13px] font-medium', id === active ? 'text-accent' : 'text-fg')}>{RUNTIMES[c.info.ref.runtime].label}</div>
                <div className="truncate text-xs text-muted">
                  {ROLE_LABEL[c.info.role]} · {c.info.ref.model}
                </div>
              </button>
              {c.busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="working" />}
              <button aria-label="End session" onClick={() => void close(id)} className="rounded p-0.5 text-faint opacity-0 hover:text-danger group-hover:opacity-100">
                <X size={13} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AgentMessage({ m }: { m: Msg }) {
  return (
    <div className="space-y-1.5">
      {m.thought && (
        <details className="group text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-fg">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" /> Thinking
          </summary>
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3" data-selectable>{m.thought}</div>
        </details>
      )}
      {m.switches?.map((w, i) => (
        <div key={i} className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning">{w}</div>
      ))}
      {m.tools?.map((t) => (
        <div key={t.id} className="flex items-center gap-1.5 text-xs text-muted">
          <Wrench size={12} />
          <span className="truncate">{t.title ?? t.kind ?? 'tool'}</span>
          {t.status && <Badge tone={t.status === 'completed' ? 'success' : t.status === 'failed' ? 'danger' : 'neutral'}>{t.status}</Badge>}
        </div>
      ))}
      {m.text && <div className="whitespace-pre-wrap text-[13px] leading-relaxed" data-selectable>{m.text}</div>}
      {m.error && <div role="alert" className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{m.error}</div>}
      {(m.usage || m.stop === 'cancelled') && (
        <div className="text-[11px] text-faint">
          {m.usage && <>{m.usage.input.toLocaleString()} in · {m.usage.output.toLocaleString()} out{m.usage.cacheRead ? ` · ${m.usage.cacheRead.toLocaleString()} cached` : ''}</>}
          {m.stop === 'cancelled' && ' · stopped'}
        </div>
      )}
    </div>
  );
}

function Transcript({ chat }: { chat: Chat }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [chat.messages]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-5 overflow-auto px-6 py-5"
      aria-live="polite"
    >
      {chat.messages.length === 0 && (
        <p className="text-[13px] text-muted">
          Session ready on {refLabel(chat.info.ref)}.{' '}
          {chat.info.workspaceId ? 'It works inside the chosen workspace; anything outside it, or risky, asks you first.' : 'It works in a scratch folder. Pick a workspace to build a real project.'}
        </p>
      )}
      {chat.messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-[13px]" data-selectable>
            {m.text}
          </div>
        ) : (
          <AgentMessage key={i} m={m} />
        ),
      )}
      {chat.busy && !chat.messages.at(-1)?.text && <div className="text-xs text-muted">Working…</div>}
    </div>
  );
}

function Composer({ chat }: { chat: Chat }) {
  const { send, cancel } = useAgents();
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t || chat.busy) return;
    setText('');
    void send(t);
  };
  return (
    <div className="border-t border-line p-3">
      <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-surface-solid p-1.5 focus-within:border-accent">
        <textarea
          aria-label="Message"
          rows={1}
          value={text}
          placeholder={`Message ${RUNTIMES[chat.info.ref.runtime].label}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-fg placeholder:text-faint focus:outline-none"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
        {chat.busy ? (
          <Button aria-label="Stop reply" onClick={() => void cancel()} className="h-8 w-8 px-0">
            <Square size={13} />
          </Button>
        ) : (
          <Button variant="primary" aria-label="Send" onClick={submit} disabled={!text.trim()} className="h-8 w-8 px-0">
            <ArrowUp size={15} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function AgentsApp() {
  const { chats, active } = useAgents();
  const chat = active ? chats[active] : null;
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface-2/50">
        <Launcher />
        <SessionList />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {chat ? (
          <>
            <header className="flex items-center gap-2 border-b border-line px-4 py-2 text-[13px]">
              <span className="font-medium">{RUNTIMES[chat.info.ref.runtime].label}</span>
              <span className="truncate text-muted">{chat.info.ref.model}</span>
              <Badge tone="accent">{ROLE_LABEL[chat.info.role]}</Badge>
              <Badge>{chat.info.effort} effort</Badge>
              <Badge tone={RUNTIMES[chat.info.ref.runtime].source === 'subscription' ? 'success' : 'neutral'}>
                {SOURCE_LABEL[RUNTIMES[chat.info.ref.runtime].source]}
              </Badge>
            </header>
            <Transcript chat={chat} />
            <Composer chat={chat} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-10 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Bot size={20} />
              </div>
              <h2 className="text-base font-semibold">Talk to any agent</h2>
              <p className="mt-1.5 text-[13px] text-muted">
                Pick a role and leave the model on Auto. The router uses your subscriptions first, then API keys, then local models.
                Planning and review get the strongest model, and routine work gets a fast one.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
