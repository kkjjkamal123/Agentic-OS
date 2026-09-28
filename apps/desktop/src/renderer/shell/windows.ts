import { create } from 'zustand';

export type AppId = 'mission' | 'agents' | 'files' | 'terminal' | 'timeline' | 'settings';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WinState extends Rect {
  id: AppId;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

export const MIN_W = 360;
export const MIN_H = 240;
const STORAGE_KEY = 'aos.windows.v1';

interface WindowStore {
  windows: WinState[];
  topZ: number;
  open(id: AppId, initial: Rect): void;
  close(id: AppId): void;
  focus(id: AppId): void;
  minimize(id: AppId): void;
  toggleMaximize(id: AppId): void;
  setRect(id: AppId, rect: Rect): void;
}

function load(): Pick<WindowStore, 'windows' | 'topZ'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const windows = JSON.parse(raw) as WinState[];
      if (Array.isArray(windows)) return { windows, topZ: Math.max(0, ...windows.map((w) => w.z)) };
    }
  } catch {
    // storage unavailable or corrupt — start clean
  }
  return { windows: [], topZ: 0 };
}

export const useWindows = create<WindowStore>((set, get) => ({
  ...load(),
  open(id, initial) {
    const existing = get().windows.find((w) => w.id === id);
    const z = get().topZ + 1;
    if (existing) {
      set({ topZ: z, windows: get().windows.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)) });
      return;
    }
    // Cascade new windows so they don't stack exactly on top of each other.
    const n = get().windows.length;
    set({ topZ: z, windows: [...get().windows, { id, ...initial, x: initial.x + n * 28, y: initial.y + n * 24, z, minimized: false, maximized: false }] });
  },
  close(id) {
    set({ windows: get().windows.filter((w) => w.id !== id) });
  },
  focus(id) {
    const w = get().windows.find((x) => x.id === id);
    if (!w || w.z === get().topZ) return;
    const z = get().topZ + 1;
    set({ topZ: z, windows: get().windows.map((x) => (x.id === id ? { ...x, z } : x)) });
  },
  minimize(id) {
    set({ windows: get().windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)) });
  },
  toggleMaximize(id) {
    const z = get().topZ + 1;
    set({ topZ: z, windows: get().windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized, z } : w)) });
  },
  setRect(id, rect) {
    set({ windows: get().windows.map((w) => (w.id === id ? { ...w, ...rect, maximized: false } : w)) });
  },
}));

useWindows.subscribe((s) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s.windows));
  } catch {
    // layout persistence is a convenience only
  }
});

/** The visible, top-most window (drives the menu bar title). */
export const focusedWindow = (ws: WinState[]) =>
  ws.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];

/** Keeps a window's title bar reachable inside the desktop area. */
export function clampRect(r: Rect, bounds: { w: number; h: number }): Rect {
  const w = Math.max(MIN_W, Math.min(r.w, bounds.w));
  const h = Math.max(MIN_H, Math.min(r.h, bounds.h));
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, 80 - w), bounds.w - 80),
    y: Math.min(Math.max(r.y, 0), bounds.h - 44),
  };
}
