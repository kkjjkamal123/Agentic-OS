import { create } from 'zustand';
import type { AgentBatch, AgentEvent, Role, RuntimeCatalog, SessionInfo, StartOpts } from '@shared/agents';
import { ipcError } from './settings';

export interface Tool {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface Msg {
  role: 'user' | 'agent';
  text: string;
  thought?: string;
  tools?: Tool[];
  usage?: Extract<AgentEvent, { t: 'usage' }>;
  error?: string;
  stop?: string;
  switches?: string[];
}

export interface Chat {
  info: SessionInfo;
  messages: Msg[];
  busy: boolean;
}

interface AgentsState {
  catalog: RuntimeCatalog[] | null;
  /** Latest line of work per session, including mission agents not open as chats. */
  activity: Record<string, string>;
  loadingCatalog: boolean;
  chats: Record<string, Chat>;
  order: string[];
  active: string | null;
  starting: boolean;
  error: string | null;
  loadCatalog(refresh?: boolean): Promise<void>;
  start(role: Role, opts?: StartOpts): Promise<void>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  close(id: string): Promise<void>;
  select(id: string): void;
}

function apply(msg: Msg, e: AgentEvent): Msg {
  switch (e.t) {
    case 'text': return { ...msg, text: msg.text + e.text };
    case 'thought': return { ...msg, thought: (msg.thought ?? '') + e.text };
    case 'tool': {
      const tools = msg.tools ?? [];
      const i = tools.findIndex((t) => t.id === e.id);
      const merged = { ...tools[i], ...Object.fromEntries(Object.entries(e).filter(([k, v]) => k !== 't' && v !== undefined)) } as Tool;
      return { ...msg, tools: i < 0 ? [...tools, merged] : tools.map((t, j) => (j === i ? merged : t)) };
    }
    case 'usage': return { ...msg, usage: e };
    case 'done': return { ...msg, stop: e.stop };
    case 'error': return { ...msg, error: e.message };
    case 'switch': return { ...msg, switches: [...(msg.switches ?? []), `Switched to ${e.ref.runtime} · ${e.ref.model}: ${e.reason}`] };
  }
}

export const useAgents = create<AgentsState>((set, get) => ({
  catalog: null,
  activity: {},
  loadingCatalog: false,
  chats: {},
  order: [],
  active: null,
  starting: false,
  error: null,

  async loadCatalog(refresh = false) {
    set({ loadingCatalog: true });
    try {
      set({ catalog: await window.aos.agents.catalog(refresh) });
    } finally {
      set({ loadingCatalog: false });
    }
  },

  async start(role, opts) {
    set({ starting: true, error: null });
    try {
      const info = await window.aos.agents.start(role, opts);
      set((s) => ({ chats: { ...s.chats, [info.id]: { info, messages: [], busy: false } }, order: [info.id, ...s.order], active: info.id }));
    } catch (e) {
      set({ error: ipcError(e) });
    } finally {
      set({ starting: false });
    }
  },

  async send(text) {
    const id = get().active;
    if (!id) return;
    set((s) => ({ chats: { ...s.chats, [id]: { ...s.chats[id], busy: true, messages: [...s.chats[id].messages, { role: 'user', text }, { role: 'agent', text: '' }] } } }));
    try {
      await window.aos.agents.prompt(id, text);
    } catch (e) {
      onBatch({ sessionId: id, events: [{ t: 'error', message: ipcError(e) }] });
    } finally {
      set((s) => (s.chats[id] ? { chats: { ...s.chats, [id]: { ...s.chats[id], busy: false } } } : s));
    }
  },

  async cancel() {
    const id = get().active;
    if (id) await window.aos.agents.cancel(id);
  },

  async close(id) {
    await window.aos.agents.stop(id);
    set((s) => {
      const { [id]: _, ...chats } = s.chats;
      const order = s.order.filter((x) => x !== id);
      return { chats, order, active: s.active === id ? (order[0] ?? null) : s.active };
    });
  },

  select(id) {
    set({ active: id });
  },
}));

function lastActivity(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.t === 'tool' && e.title) return e.title;
    if (e.t === 'text' && e.text.trim()) return e.text.trim().split('\n').pop()!.slice(0, 160);
    if (e.t === 'thought') return 'Thinking…';
  }
}

function onBatch({ sessionId, events }: AgentBatch) {
  useAgents.setState((s) => {
    const chat = s.chats[sessionId];
    const act = lastActivity(events);
    if (!chat) return act ? { activity: { ...s.activity, [sessionId]: act } } : s;
    const messages = [...chat.messages];
    let last = messages[messages.length - 1];
    if (!last || last.role !== 'agent') messages.push((last = { role: 'agent', text: '' }));
    for (const e of events) last = apply(last, e);
    messages[messages.length - 1] = last;
    const sw = events.findLast((e) => e.t === 'switch');
    const info = sw && sw.t === 'switch' ? { ...chat.info, ref: sw.ref } : chat.info;
    return { chats: { ...s.chats, [sessionId]: { ...chat, info, messages } } };
  });
}

if (typeof window !== 'undefined' && window.aos) {
  window.aos.on('agents:events', onBatch);
  window.aos.on('agents:catalog', (catalog) => useAgents.setState({ catalog }));
}
