import { useEffect, useState } from 'react';
import { appById } from '../apps/registry';
import { ACTIVE, useMissions } from '../lib/missions';
import { focusedWindow, useWindows } from './windows';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setTimeout(() => setNow(new Date()), 60_000 - (now.getTime() % 60_000) + 50);
    return () => clearTimeout(t);
  }, [now]);
  return (
    <time dateTime={now.toISOString()} className="tabular-nums">
      {now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
      {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
}

export function MenuBar() {
  const top = useWindows((s) => focusedWindow(s.windows));
  const running = useMissions((s) => s.missions?.filter((m) => ACTIVE.has(m.status)).length ?? 0);
  return (
    <header className="drag relative z-[100001] flex h-9 shrink-0 items-center gap-4 border-b border-line bg-surface pl-[84px] pr-4 text-[13px]">
      <span className="font-semibold tracking-tight">Agentic OS</span>
      {top && <span className="text-muted">{appById(top.id).title}</span>}
      <div className="ml-auto flex items-center gap-4 text-muted">
        <span className="flex items-center gap-1.5">
          <span className={running ? 'h-1.5 w-1.5 rounded-full bg-accent' : 'h-1.5 w-1.5 rounded-full bg-success'} />
          {running ? `${running} mission${running > 1 ? 's' : ''} running` : 'Idle'}
        </span>
        <Clock />
      </div>
    </header>
  );
}
