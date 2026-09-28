import { create } from 'zustand';
import type { Mission, MissionEvent, MissionStart, TestState } from '@shared/missions';
import { ipcError } from './settings';

interface MissionsState {
  missions: Mission[] | null;
  selected: string | null;
  events: Record<string, MissionEvent[]>;
  tests: Record<string, TestState>;
  error: string | null;
  load(): Promise<void>;
  select(id: string | null): Promise<void>;
  loadEvents(id: string): Promise<void>;
  start(input: MissionStart): Promise<void>;
  cancel(id: string): Promise<void>;
  test(id: string): Promise<void>;
  stopTest(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  undo(id: string): Promise<void>;
}

export const ACTIVE = new Set(['planning', 'building', 'verifying', 'shipping', 'paused']);

export const useMissions = create<MissionsState>((set, get) => ({
  missions: null,
  selected: null,
  events: {},
  tests: {},
  error: null,
  async load() {
    set({ missions: await window.aos.missions.list() });
  },
  async select(id) {
    set({ selected: id });
    if (id) await get().loadEvents(id);
  },
  async loadEvents(id) {
    const events = await window.aos.missions.events(id);
    set((s) => ({ events: { ...s.events, [id]: events } }));
  },
  async start(input) {
    set({ error: null });
    try {
      const m = await window.aos.missions.start(input);
      set((s) => ({ missions: [m, ...(s.missions ?? []).filter((x) => x.id !== m.id)] }));
      await get().select(m.id);
    } catch (e) {
      set({ error: ipcError(e) });
    }
  },
  async cancel(id) {
    await window.aos.missions.cancel(id);
  },
  async test(id) {
    try {
      await window.aos.missions.test(id);
    } catch (e) {
      set((s) => ({ tests: { ...s.tests, [id]: { missionId: id, state: 'error', message: ipcError(e) } } }));
    }
  },
  async stopTest(id) {
    await window.aos.missions.stopTest(id);
  },
  async pause(id) {
    await window.aos.missions.pause(id);
  },
  async resume(id) {
    set({ error: null });
    try {
      const m = await window.aos.missions.resume(id);
      if (m.id !== id) await get().select(m.id);
    } catch (e) {
      set({ error: ipcError(e) });
    }
  },
  async undo(id) {
    set({ error: null });
    try {
      await window.aos.missions.undo(id);
    } catch (e) {
      set({ error: ipcError(e) });
    }
  },
}));

if (typeof window !== 'undefined' && window.aos) {
  window.aos.on('missions:changed', (m) =>
    useMissions.setState((s) => {
      const list = s.missions ?? [];
      const i = list.findIndex((x) => x.id === m.id);
      return { missions: i < 0 ? [m, ...list] : list.map((x, j) => (j === i ? m : x)) };
    }),
  );
  window.aos.on('missions:event', (e) =>
    useMissions.setState((s) => (s.events[e.missionId] ? { events: { ...s.events, [e.missionId]: [...s.events[e.missionId], e] } } : s)),
  );
  window.aos.on('missions:test', (t) => useMissions.setState((s) => ({ tests: { ...s.tests, [t.missionId]: t } })));
  // OS network events are free; they let a mission paused offline resume the moment Wi-Fi is back.
  window.addEventListener('online', () => void window.aos.app.networkChanged());
  void useMissions.getState().load();
}
