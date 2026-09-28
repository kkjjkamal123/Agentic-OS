import { ShieldAlert } from 'lucide-react';
import type { ApprovalAnswer } from '@shared/workspace';
import { Button } from '../components/ui';
import { useOs } from '../lib/workspace';

export function Approvals() {
  const approvals = useOs((s) => s.approvals);
  if (!approvals.length) return null;
  const a = approvals[0];
  const answer = (ans: ApprovalAnswer) => void window.aos.approvals.answer(a.id, ans);
  const detail = a.action.command ?? a.action.paths?.join('\n') ?? a.action.title ?? a.action.kind;
  return (
    <div
      role="alertdialog"
      aria-label="Approval needed"
      className="absolute right-4 top-3 z-[100002] w-[380px] rounded-xl border border-warning/40 bg-surface-solid p-4"
      style={{ boxShadow: 'var(--shadow-window)' }}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {a.agent} wants to {a.action.kind === 'execute' ? 'run a command' : `${a.action.kind} files`}
          </div>
          <div className="mt-0.5 text-xs text-muted">{a.reason}</div>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 font-mono text-[11px] text-fg" data-selectable>
            {detail}
          </pre>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="danger" onClick={() => answer('deny')}>Deny</Button>
        {approvals.length > 1 && <span className="text-xs text-faint">+{approvals.length - 1} waiting</span>}
        <div className="ml-auto flex gap-2">
          <Button onClick={() => answer('session')} title="Allow similar actions from this agent until the session ends">Allow for session</Button>
          <Button variant="primary" onClick={() => answer('once')}>Allow once</Button>
        </div>
      </div>
    </div>
  );
}
