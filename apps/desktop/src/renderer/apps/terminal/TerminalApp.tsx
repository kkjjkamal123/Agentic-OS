import { ChevronRight, SquareTerminal } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CommandRun } from '@shared/workspace';
import { Badge, cx } from '../../components/ui';
import { useOs } from '../../lib/workspace';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function Run({ r, last }: { r: CommandRun; last: boolean }) {
  const status = r.exitCode === null ? <Badge tone="accent">running</Badge> : r.exitCode === 0 ? <Badge tone="success">exit 0</Badge> : <Badge tone="danger">exit {r.exitCode}</Badge>;
  return (
    <details open={last || r.exitCode === null || (r.exitCode ?? 0) !== 0} className="group border-b border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-surface-2">
        <ChevronRight size={12} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <span className="shrink-0 text-[11px] text-faint">{r.agent}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">$ {r.command}</code>
        {status}
      </summary>
      {r.output && (
        <pre className={cx('max-h-80 overflow-auto whitespace-pre-wrap break-all bg-surface-2 px-4 py-2 font-mono text-[11.5px] leading-[1.45] text-muted')} data-selectable>
          {stripAnsi(r.output)}
        </pre>
      )}
    </details>
  );
}

export function TerminalApp() {
  const { runs, loadRuns } = useOs();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void loadRuns(), [loadRuns]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [runs]);
  if (!runs.length) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-center">
        <div className="max-w-sm">
          <SquareTerminal size={22} className="mx-auto mb-3 text-accent" />
          <h2 className="text-base font-semibold">Every command agents run shows up here</h2>
          <p className="mt-1.5 text-[13px] text-muted">
            Installs, builds and test runs from any agent, with live output. Commands from the built-in tool loop run in a macOS sandbox that can only write inside the workspace.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div ref={box} className="h-full overflow-auto" aria-live="polite">
      {runs.map((r, i) => <Run key={r.id} r={r} last={i === runs.length - 1} />)}
    </div>
  );
}
