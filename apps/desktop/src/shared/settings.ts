export type Theme = 'system' | 'dark' | 'light';
export type ApprovalMode = 'ask' | 'auto-in-workspace' | 'yolo';
export type Quality = 'saver' | 'balanced' | 'max';

export interface Settings {
  theme: Theme;
  /** Every mission gets its own git workspace under this folder. */
  workspaceRoot: string;
  approvalMode: ApprovalMode;
  quality: Quality;
  /** Hard stop per mission, in thousands of new (non-cached) tokens; 0 = no limit. */
  missionTokenBudget: number;
  maxParallelAgents: number;
  ollamaBaseUrl: string;
  brainVault: string;
  recordToBrain: boolean;
}

export type SettingsPatch = Partial<Settings>;

/** Human names for error messages. */
export const SETTING_LABELS: Record<keyof Settings, string> = {
  theme: 'Appearance',
  workspaceRoot: 'Workspaces folder',
  approvalMode: 'Approval policy',
  quality: 'Usage level',
  missionTokenBudget: 'Token budget per mission',
  maxParallelAgents: 'Parallel agents',
  ollamaBaseUrl: 'Ollama server',
  brainVault: 'Vault folder',
  recordToBrain: 'Record missions',
};

export function defaultSettings(home: string): Settings {
  return {
    theme: 'system',
    workspaceRoot: `${home}/AgenticOS/workspaces`,
    approvalMode: 'auto-in-workspace',
    quality: 'balanced',
    missionTokenBudget: 2000,
    maxParallelAgents: 3,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    brainVault: `${home}/Documents/Obsidian/Brain`,
    recordToBrain: true,
  };
}
