import { ChevronRight, File, FolderClosed, FolderOpen, FolderPlus, GitCompare, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DirEntry } from '@shared/workspace';
import { Button, cx, Input } from '../../components/ui';
import { ipcError } from '../../lib/settings';
import { useOs } from '../../lib/workspace';

export function NewWorkspace({ onCreated }: { onCreated?: (id: string) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const w = await window.aos.workspaces.create(name);
      setName('');
      setError(null);
      onCreated?.(w.id);
    } catch (e) {
      setError(ipcError(e));
    }
  };
  return (
    <form className="space-y-1" onSubmit={(e) => (e.preventDefault(), void create())}>
      <div className="flex gap-1.5">
        <Input aria-label="New workspace name" placeholder="New workspace…" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" aria-label="Create workspace" disabled={!name.trim()} className="px-2">
          <FolderPlus size={15} />
        </Button>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </form>
  );
}

function Tree({ wsId, rel, depth, open, onOpen }: { wsId: string; rel: string; depth: number; open: string | null; onOpen: (rel: string) => void }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => void window.aos.workspaces.tree(wsId, rel).then(setEntries), [wsId, rel]);
  if (!entries) return null;
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.rel}>
          <button
            onClick={() => (e.dir ? setExpanded((s) => (s.has(e.rel) ? (s.delete(e.rel), new Set(s)) : new Set(s).add(e.rel))) : onOpen(e.rel))}
            className={cx('flex w-full items-center gap-1.5 rounded-md py-0.5 pr-2 text-left text-[13px] hover:bg-surface-3', open === e.rel && 'bg-accent-soft text-accent')}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            {e.dir ? (
              <>
                <ChevronRight size={12} className={cx('shrink-0 text-faint transition-transform', expanded.has(e.rel) && 'rotate-90')} />
                {expanded.has(e.rel) ? <FolderOpen size={14} className="shrink-0 text-accent" /> : <FolderClosed size={14} className="shrink-0 text-accent" />}
              </>
            ) : (
              <File size={14} className="ml-[18px] shrink-0 text-faint" />
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.dir && expanded.has(e.rel) && <Tree wsId={wsId} rel={e.rel} depth={depth + 1} open={open} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <p className="p-4 text-[13px] text-muted">No changes since the last commit.</p>;
  return (
    <pre className="p-3 font-mono text-[12px] leading-5" data-selectable>
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          className={cx(
            l.startsWith('+') && !l.startsWith('+++') && 'bg-success-soft text-success',
            l.startsWith('-') && !l.startsWith('---') && 'bg-danger-soft text-danger',
            (l.startsWith('diff --git') || l.startsWith('@@')) && 'text-accent',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function FilesApp() {
  const { workspaces, loadWorkspaces } = useOs();
  const [wsId, setWsId] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string | null; size: number } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaces) void loadWorkspaces();
  }, [workspaces, loadWorkspaces]);
  useEffect(() => {
    if (!wsId && workspaces?.length) setWsId(workspaces[0].id);
  }, [workspaces, wsId]);

  const openFile = async (rel: string) => {
    setFile(rel);
    setDiff(null);
    setContent(await window.aos.workspaces.read(wsId!, rel));
  };
  const showDiff = async () => {
    setFile(null);
    setDiff(await window.aos.workspaces.diff(wsId!));
  };
  const ws = workspaces?.find((w) => w.id === wsId);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface-2/50">
        <div className="space-y-2 border-b border-line p-3">
          <select
            aria-label="Workspace"
            value={wsId ?? ''}
            onChange={(e) => (setWsId(e.target.value), setFile(null), setDiff(null))}
            className="h-8 w-full rounded-lg border border-line-strong bg-surface-solid px-2 text-[13px] text-fg focus:border-accent focus:outline-none"
          >
            {!workspaces?.length && <option value="">No workspaces yet</option>}
            {workspaces?.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <NewWorkspace onCreated={setWsId} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5">{wsId && <Tree key={wsId} wsId={wsId} rel="" depth={0} open={file} onOpen={(r) => void openFile(r)} />}</div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {ws ? (
          <>
            <header className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="truncate font-mono text-xs text-muted" data-selectable>{file ?? ws.path.replace(/^\/Users\/[^/]+/, '~')}</span>
              <div className="ml-auto flex gap-1">
                <Button variant="ghost" onClick={() => void showDiff()}><GitCompare size={14} /> Changes</Button>
                <Button variant="ghost" onClick={() => void window.aos.workspaces.openTerminal(ws.id)}><SquareTerminal size={14} /> Terminal</Button>
                <Button variant="ghost" onClick={() => void window.aos.workspaces.reveal(ws.id)}><FolderOpen size={14} /> Finder</Button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              {diff !== null ? (
                <DiffView text={diff} />
              ) : file && content ? (
                content.text === null ? (
                  <p className="p-4 text-[13px] text-muted">Binary or large file ({(content.size / 1024).toFixed(0)} KB). Open it in Finder.</p>
                ) : (
                  <pre className="p-3 font-mono text-[12px] leading-5" data-selectable>
                    {content.text.split('\n').map((l, i) => (
                      <div key={i} className="flex">
                        <span className="w-10 shrink-0 select-none pr-3 text-right text-faint">{i + 1}</span>
                        <span className="whitespace-pre-wrap break-all">{l || ' '}</span>
                      </div>
                    ))}
                  </pre>
                )
              ) : (
                <p className="p-4 text-[13px] text-muted">Pick a file, or open Changes to see what agents edited since the last commit.</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-10 text-center text-[13px] text-muted">
            Create a workspace to give agents a project folder. Each one is its own git repository.
          </div>
        )}
      </section>
    </div>
  );
}
