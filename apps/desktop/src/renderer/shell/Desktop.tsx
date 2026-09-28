import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { APPS, appById } from '../apps/registry';
import { useSettings } from '../lib/settings';
import { useTheme } from '../lib/theme';
import { Approvals } from './Approvals';
import { Dock } from './Dock';
import { MenuBar } from './MenuBar';
import { Window } from './Window';
import { clampRect, focusedWindow, useWindows, type AppId } from './windows';

const DOCK_CLEARANCE = 76;

export function Desktop() {
  const area = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ w: 1200, h: 760 });
  const windows = useWindows((s) => s.windows);
  const { open, close, focus } = useWindows();
  const loadSettings = useSettings((s) => s.load);
  useTheme(useSettings((s) => s.settings?.theme));

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBounds({ w: e.contentRect.width, h: e.contentRect.height - DOCK_CLEARANCE }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const launch = useCallback(
    (id: AppId) => {
      const { w, h } = appById(id).size;
      open(id, clampRect({ w, h, x: Math.round((bounds.w - w) / 2), y: Math.max(12, Math.round((bounds.h - h) / 3)) }, bounds));
    },
    [bounds, open],
  );

  // First launch: open Mission Control so the desktop never starts empty.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && useWindows.getState().windows.length === 0) launch('mission');
    seeded.current = true;
  }, [launch]);

  // ⌘1…⌘6 launch apps, ⌘, opens Settings, ⌘W closes the focused window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= APPS.length) {
        e.preventDefault();
        launch(APPS[n - 1].id);
      } else if (e.key === ',') {
        e.preventDefault();
        launch('settings');
      } else if (e.key.toLowerCase() === 'w') {
        const top = focusedWindow(useWindows.getState().windows);
        if (top) {
          e.preventDefault();
          close(top.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [launch, close]);

  const top = focusedWindow(windows);

  return (
    <div className="wallpaper flex h-full flex-col">
      <MenuBar />
      <main ref={area} className="relative flex-1 overflow-hidden" onPointerDown={(e) => e.target === e.currentTarget && top && focus(top.id)}>
        {windows.map((w) => {
          const app = appById(w.id);
          const Icon = app.icon;
          const App = app.component;
          return (
            <Window key={w.id} win={w} title={app.title} icon={<Icon size={15} />} focused={top?.id === w.id} bounds={bounds}>
              <App />
            </Window>
          );
        })}
        <Dock onLaunch={launch} />
        <Approvals />
      </main>
    </div>
  );
}
