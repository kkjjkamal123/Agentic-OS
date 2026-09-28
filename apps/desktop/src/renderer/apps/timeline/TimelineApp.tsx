import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MissionEvent } from '@shared/missions';
import { cx } from '../../components/ui';
import { useMissions } from '../../lib/missions';

const KIND_COLOR: Record<MissionEvent['kind'], string> = {
  plan: 'bg-accent', dispatch: 'bg-accent', task: 'bg-accent', handoff: 'bg-success', switch: 'bg-warning', review: 'bg-warning', merge: 'bg-success', check: 'bg-muted', fix: 'bg-warning', ship: 'bg-success', error: 'bg-danger', info: 'bg-faint',
};

export function TimelineApp() {
  const missions = useMissions((s) => s.missions);
  const events = useMissions((s) => s.events);
  const loadEvents = useMissions((s) => s.loadEvents);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? missions?.[0]?.id ?? null;
  useEffect(() => {
    if (id && !events[id]) void loadEvents(id);
  }, [id, events, loadEvents]);
  if (!missions?.length) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-center">
        <div className="max-w-sm">
          <History size={22} className="mx-auto mb-3 text-accent" />
          <h2 className="text-base font-semibold">Every mission step is recorded here</h2>
          <p className="mt-1.5 text-[13px] text-muted">Plans, model assignments, reviews, merges, checks and fixes, in order.</p>
        </div>
      </div>
    );
  }
  const list = (id && events[id]) || [];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <select
          aria-label="Mission"
          value={id ?? ''}
          onChange={(e) => setPicked(e.target.value)}
          className="h-8 w-full rounded-lg border border-line-strong bg-surface-solid px-2 text-[13px] text-fg focus:border-accent focus:outline-none"
        >
          {missions.map((m) => <option key={m.id} value={m.id}>{m.goal.slice(0, 90)}</option>)}
        </select>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {list.map((e, i) => (
          <li key={i} className="relative flex gap-3 pb-4 pl-5">
            <span className={cx('absolute left-0 top-1.5 h-2 w-2 rounded-full', KIND_COLOR[e.kind])} />
            {i < list.length - 1 && <span className="absolute bottom-0 left-[3.5px] top-4 w-px bg-line" />}
            <time className="w-16 shrink-0 text-xs tabular-nums text-faint">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            <span className="text-[13px]" data-selectable>{e.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
