import { APPS } from '../apps/registry';
import { cx } from '../components/ui';
import { useWindows, type AppId } from './windows';

export function Dock({ onLaunch }: { onLaunch: (id: AppId) => void }) {
  const windows = useWindows((s) => s.windows);
  return (
    <nav aria-label="Dock" className="pointer-events-none absolute inset-x-0 bottom-3 z-[100000] flex justify-center">
      <ul
        className="pointer-events-auto flex items-end gap-1.5 rounded-2xl border border-line bg-surface p-1.5"
        style={{ boxShadow: 'var(--shadow-dock)' }}
      >
        {APPS.map((a, i) => {
          const running = windows.some((w) => w.id === a.id);
          const Icon = a.icon;
          return (
            <li key={a.id} className={cx(a.id === 'settings' && 'ml-1 border-l border-line pl-2.5')}>
              <button
                aria-label={a.title}
                title={`${a.title}  ⌘${i + 1}`}
                onClick={() => onLaunch(a.id)}
                className="group relative flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-all hover:-translate-y-0.5 hover:bg-accent-soft hover:text-accent"
              >
                <Icon size={21} strokeWidth={1.75} />
                <span className={cx('absolute -bottom-1 h-1 w-1 rounded-full bg-accent transition-opacity', running ? 'opacity-100' : 'opacity-0')} />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
