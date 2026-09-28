import { create } from 'zustand';
import { SETTING_LABELS, type Settings, type SettingsPatch } from '@shared/settings';

interface SettingsState {
  settings: Settings | null;
  error: string | null;
  load(): Promise<void>;
  update(patch: SettingsPatch): Promise<boolean>;
  clearError(): void;
}

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper and zod JSON noise. */
export function ipcError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
  try {
    const issues = JSON.parse(msg) as { path: (string | number)[]; message: string }[];
    if (Array.isArray(issues)) {
      return issues
        .map((i) => {
          const key = String(i.path[0] ?? '');
          const label = SETTING_LABELS[key as keyof Settings] ?? key;
          return label ? `${label} ${i.message}` : i.message;
        })
        .join('; ');
    }
  } catch {
    // not a zod payload
  }
  return msg;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  error: null,
  clearError: () => set({ error: null }),
  async load() {
    set({ settings: await window.aos.settings.get() });
  },
  async update(patch) {
    try {
      set({ settings: await window.aos.settings.update(patch), error: null });
      return true;
    } catch (e) {
      set({ error: ipcError(e) });
      return false;
    }
  },
}));

// Changes made elsewhere (another window, main process) flow back in.
if (typeof window !== 'undefined' && window.aos) {
  window.aos.on('settings:changed', (s) => useSettings.setState({ settings: s }));
}
