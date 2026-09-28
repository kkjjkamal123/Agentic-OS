import { Brain, Info, KeyRound, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../components/ui';
import { useSettings } from '../../lib/settings';
import { AboutSection, AgentsSection, BrainSection, GeneralSection } from './sections';
import { ProvidersSection } from './ProvidersSection';

const TABS: { id: string; label: string; icon: LucideIcon; Component: () => React.JSX.Element | null }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, Component: GeneralSection },
  { id: 'providers', label: 'Accounts & keys', icon: KeyRound, Component: ProvidersSection },
  { id: 'agents', label: 'Agents & safety', icon: ShieldCheck, Component: AgentsSection },
  { id: 'brain', label: 'Brain vault', icon: Brain, Component: BrainSection },
  { id: 'about', label: 'About', icon: Info, Component: AboutSection },
];

export function SettingsApp() {
  const [tab, setTab] = useState(TABS[0].id);
  const { settings, error, clearError } = useSettings();
  const Active = TABS.find((t) => t.id === tab)!.Component;

  return (
    <div className="flex h-full">
      <nav aria-label="Settings sections" className="w-52 shrink-0 border-r border-line bg-surface-2/50 p-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              clearError();
            }}
            aria-current={tab === t.id ? 'page' : undefined}
            className={cx(
              'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
              tab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-3 hover:text-fg',
            )}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto px-8 py-6">
        {error && (
          <div role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}
        {settings ? <Active /> : <div className="text-muted">Loading…</div>}
      </div>
    </div>
  );
}
