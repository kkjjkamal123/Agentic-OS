import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { useRef, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { cx } from '../components/ui';
import { clampRect, useWindows, type Rect, type WinState } from './windows';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const EDGES: { edge: Edge; className: string }[] = [
  { edge: 'n', className: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { edge: 'e', className: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize' },
  { edge: 'w', className: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize' },
  { edge: 'ne', className: 'top-0 right-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'nw', className: 'top-0 left-0 h-3 w-3 cursor-nwse-resize' },
  { edge: 'se', className: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize' },
];

function resized(start: Rect, edge: Edge | 'move', dx: number, dy: number): Rect {
  if (edge === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  const r = { ...start };
  if (edge.includes('e')) r.w = start.w + dx;
  if (edge.includes('s')) r.h = start.h + dy;
  if (edge.includes('w')) {
    r.w = start.w - dx;
    r.x = start.x + dx;
  }
  if (edge.includes('n')) {
    r.h = start.h - dy;
    r.y = start.y + dy;
  }
  return r;
}

export function Window({ win, title, icon, focused, bounds, children }: {
  win: WinState;
  title: string;
  icon: ReactNode;
  focused: boolean;
  bounds: { w: number; h: number };
  children: ReactNode;
}) {
  const { focus, close, minimize, toggleMaximize, setRect } = useWindows();
  const drag = useRef<{ edge: Edge | 'move'; px: number; py: number; start: Rect } | null>(null);

  const begin = (edge: Edge | 'move') => (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (edge === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault();
    focus(win.id);
    const start = win.maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : { x: win.x, y: win.y, w: win.w, h: win.h };
    drag.current = { edge, px: e.clientX, py: e.clientY, start };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    let next = resized(d.start, d.edge, e.clientX - d.px, e.clientY - d.py);
    // Pulling a maximized window by its title bar restores it under the cursor.
    if (win.maximized && d.edge === 'move') next = { ...next, w: win.w, h: win.h, x: e.clientX - win.w / 2 };
    setRect(win.id, clampRect(next, bounds));
  };
  const end = (e: RPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const rect = win.maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : win;

  return (
    <section
      role="dialog"
      aria-label={title}
      data-app={win.id}
      onPointerDownCapture={() => focus(win.id)}
      className={cx(
        'absolute flex flex-col overflow-hidden border border-line bg-surface',
        win.maximized ? 'rounded-none' : 'rounded-xl',
        win.minimized && 'hidden',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: win.z, boxShadow: 'var(--shadow-window)' }}
    >
      <header
        onPointerDown={begin('move')}
        onPointerMove={onMove}
        onPointerUp={end}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && toggleMaximize(win.id)}
        className={cx('flex h-10 shrink-0 items-center gap-2 border-b border-line px-3', focused ? 'bg-surface-2/60' : 'bg-transparent')}
      >
        <span className={cx('flex items-center gap-2 text-[13px] font-medium', focused ? 'text-fg' : 'text-muted')}>
          <span className={focused ? 'text-accent' : 'text-faint'}>{icon}</span>
          {title}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button aria-label={`Minimize ${title}`} onClick={() => minimize(win.id)} className="rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-fg">
            <Minus size={14} />
          </button>
          <button aria-label={win.maximized ? `Restore ${title}` : `Maximize ${title}`} onClick={() => toggleMaximize(win.id)} className="rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-fg">
            {win.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button aria-label={`Close ${title}`} onClick={() => close(win.id)} className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger">
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {!win.maximized &&
        EDGES.map(({ edge, className }) => (
          <div key={edge} className={cx('absolute z-10', className)} onPointerDown={begin(edge)} onPointerMove={onMove} onPointerUp={end} />
        ))}
    </section>
  );
}
