import { create } from 'zustand';
import type { ApprovalRequest, CommandRun, Workspace } from '@shared/workspace';

interface OsState {
  workspaces: Workspace[] | null;
  approvals: ApprovalRequest[];
  runs: CommandRun[];
  loadWorkspaces(): Promise<void>;
  loadRuns(): Promise<void>;
}

export const useOs = create<OsState>((set) => ({
  workspaces: null,
  approvals: [],
  runs: [],
  async loadWorkspaces() {
    set({ workspaces: await window.aos.workspaces.list() });
  },
  async loadRuns() {
    set({ runs: await window.aos.terminal.history() });
  },
}));

if (typeof window !== 'undefined' && window.aos) {
  window.aos.on('workspaces:changed', (workspaces) => useOs.setState({ workspaces }));
  window.aos.on('approvals:changed', (approvals) => useOs.setState({ approvals }));
  window.aos.on('terminal:runs', (changed) =>
    useOs.setState((s) => {
      const byId = new Map(s.runs.map((r) => [r.id, r]));
      for (const r of changed) byId.set(r.id, r);
      return { runs: [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-200) };
    }),
  );
  void window.aos.approvals.list().then((approvals) => useOs.setState({ approvals }));
}
