import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import type { ApprovalMode, Quality, Settings, Theme } from '@shared/settings';
import { Badge, Button, cx, Field, Input, Section, Segmented, Toggle } from '../../components/ui';
import { useSettings } from '../../lib/settings';

/** Text/number input that commits on blur or Enter and reverts on Escape. */
export function CommitInput<K extends keyof Settings>({ k, type = 'text', label, ...rest }: {
  k: K;
  type?: 'text' | 'number';
  label: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  const { settings, update } = useSettings();
  const current = String(settings![k]);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const commit = async () => {
    if (draft === current) return;
    const value = type === 'number' ? Number(draft) : draft;
    if (!(await update({ [k]: value } as Partial<Settings>))) setDraft(current);
  };
  return (
    <Input
      {...rest}
      aria-label={label}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(current);
      }}
    />
  );
}

function FolderField({ k, label }: { k: 'workspaceRoot' | 'brainVault'; label: string }) {
  const { settings, update } = useSettings();
  return (
    <div className="flex gap-2">
      <CommitInput k={k} label={label} className="font-mono text-xs" />
      <Button
        onClick={async () => {
          const dir = await window.aos.system.chooseDirectory(settings![k]);
          if (dir) await update({ [k]: dir });
        }}
      >
        Choose…
      </Button>
      <Button variant="ghost" aria-label={`Reveal ${label} in Finder`} title="Reveal in Finder" onClick={() => void window.aos.system.openPath(settings![k]).catch(() => {})}>
        <FolderOpen size={15} />
      </Button>
    </div>
  );
}

export function GeneralSection() {
  const { settings, update } = useSettings();
  return (
    <Section title="General">
      <Field label="Appearance">
        <Segmented<Theme>
          label="Appearance"
          value={settings!.theme}
          onChange={(theme) => void update({ theme })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Field>
      <Field label="Workspaces folder" hint="Each mission gets its own git repository in this folder.">
        <FolderField k="workspaceRoot" label="Workspaces folder" />
      </Field>
    </Section>
  );
}

export const LEVELS: { value: Quality; title: string; body: string }[] = [
  { value: 'saver', title: 'Saver', body: 'Stretches your quotas: Sonnet-class planning, fast models for simple tasks, low effort, one review and one fix round.' },
  { value: 'balanced', title: 'Balanced', body: 'Opus plans and reviews. Sonnet, Terra or Gemini Pro code by difficulty, and hard tasks get Opus. Up to 2 reviews and 3 fix rounds.' },
  { value: 'max', title: 'Max quality', body: 'Fable 5.1 plans. Opus codes, with Fable taking the hardest tasks at max effort. Up to 3 reviews and 4 fix rounds. Uses your limits fastest.' },
];

const APPROVAL: { value: ApprovalMode; title: string; body: string }[] = [
  { value: 'ask', title: 'Ask every time', body: 'You approve every shell command and every write outside the workspace.' },
  { value: 'auto-in-workspace', title: 'Auto inside the workspace', body: 'Agents act freely in the mission folder. Anything outside it, or anything risky, needs your approval.' },
  { value: 'yolo', title: 'Full autonomy', body: 'Nothing needs approval except blocked commands (sudo, rm -rf /, curl | sh). Use only for throwaway work.' },
];

export function AgentsSection() {
  const { settings, update } = useSettings();
  return (
    <>
      <Section title="Approval policy" description="Default for new missions. The permission gate enforces it on every agent, whichever model it runs.">
        <div role="radiogroup" aria-label="Approval policy" className="grid gap-2 py-4">
          {APPROVAL.map((a) => (
            <button
              key={a.value}
              role="radio"
              aria-checked={settings!.approvalMode === a.value}
              onClick={() => void update({ approvalMode: a.value })}
              className={cx(
                'rounded-xl border p-3 text-left transition-colors',
                settings!.approvalMode === a.value ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-surface-2',
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {a.title}
                {a.value === 'yolo' && <Badge tone="warning">Risky</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-muted">{a.body}</div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Usage level" description="How hard missions and Auto sessions work your subscriptions. The default for new sessions; each mission can override it.">
        <div role="radiogroup" aria-label="Usage level" className="grid gap-2 py-4 md:grid-cols-3">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              role="radio"
              aria-checked={settings!.quality === l.value}
              onClick={() => void update({ quality: l.value })}
              className={cx('rounded-xl border p-3 text-left transition-colors', settings!.quality === l.value ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-surface-2')}
            >
              <div className="text-[13px] font-medium">{l.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{l.body}</div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Limits">
        <Field label="Token budget per mission" hint="Hard stop, in thousands of new tokens across all agents (cached tokens don't count). 0 means no limit.">
          <div className="flex w-44 items-center gap-2">
            <CommitInput k="missionTokenBudget" type="number" label="Token budget per mission in thousands" min={0} max={100000} step={100} />
            <span className="text-muted">k</span>
          </div>
        </Field>
        <Field label="Parallel agents" hint="How many tasks can run at the same time.">
          <div className="w-24">
            <CommitInput k="maxParallelAgents" type="number" label="Parallel agents" min={1} max={16} step={1} />
          </div>
        </Field>
      </Section>
    </>
  );
}

export function BrainSection() {
  const { settings, update } = useSettings();
  return (
    <Section
      title="Brain vault"
      description="Your Obsidian mind-map, kept up to date by brain-sync. Missions will add notes linking their goal, tasks, agents and the files they changed."
    >
      <Field label="Record missions">
        <Toggle label="Record missions to the Brain vault" checked={settings!.recordToBrain} onChange={(recordToBrain) => void update({ recordToBrain })} />
      </Field>
      <Field label="Vault folder">
        <FolderField k="brainVault" label="Vault folder" />
      </Field>
    </Section>
  );
}

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void window.aos.app.info().then(setInfo), []);
  if (!info) return null;
  const rows: [string, React.ReactNode][] = [
    ['Version', info.version],
    ['Electron', info.versions.electron],
    ['Chromium', info.versions.chrome],
    ['Node', info.versions.node],
    ['Key storage', info.encryption === 'keychain' ? <Badge tone="success">macOS Keychain</Badge> : <Badge tone="warning">Insecure dev store</Badge>],
    ['Data folder', <span className="font-mono text-xs" data-selectable>{info.userData}</span>],
  ];
  return (
    <Section title="About Agentic OS">
      {rows.map(([k, v]) => (
        <Field key={k} label={k}>
          <div className="pt-1.5 text-[13px]">{v}</div>
        </Field>
      ))}
    </Section>
  );
}
