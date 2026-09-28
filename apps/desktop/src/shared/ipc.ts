import type { AccountId, AccountStatus } from './accounts';
import type { AgentBatch, Role, Routed, RuntimeCatalog, SessionInfo, StartOpts } from './agents';
import type { Mission, MissionEvent, MissionStart, TestState } from './missions';
import type { ApprovalAnswer, ApprovalRequest, CommandRun, DirEntry, Workspace } from './workspace';
import type { SecretId, SecretStatus } from './secrets';
import type { Quality, Settings, SettingsPatch } from './settings';

export interface AppInfo {
  name: string;
  version: string;
  versions: { electron: string; chrome: string; node: string };
  platform: string;
  userData: string;
  encryption: 'keychain' | 'insecure-dev';
}

/**
 * The whole renderer ↔ main surface. Each method maps to one `ipcMain.handle` channel named
 * `<namespace>:<method>`; the preload builds `window.aos` from this list, main validates inputs.
 */
export interface AosApi {
  app: {
    info(): Promise<AppInfo>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
  };
  accounts: {
    /** Detects subscription CLIs (installed? signed in? which plan?). Cached unless `refresh`. */
    list(refresh?: boolean): Promise<AccountStatus[]>;
    /** Opens Terminal running the vendor's official login (or install) command. */
    openTerminal(id: AccountId, action: 'login' | 'install'): Promise<void>;
  };
  agents: {
    catalog(refresh?: boolean): Promise<RuntimeCatalog[]>;
    route(role: Role, quality?: Quality): Promise<Routed | null>;
    start(role: Role, opts?: StartOpts): Promise<SessionInfo>;
    prompt(sessionId: string, text: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
  };
  workspaces: {
    list(): Promise<Workspace[]>;
    create(name: string): Promise<Workspace>;
    tree(id: string, rel?: string): Promise<DirEntry[]>;
    read(id: string, rel: string): Promise<{ text: string | null; size: number }>;
    diff(id: string): Promise<string>;
    reveal(id: string): Promise<void>;
    openTerminal(id: string): Promise<void>;
  };
  missions: {
    list(): Promise<Mission[]>;
    events(id: string): Promise<MissionEvent[]>;
    start(input: MissionStart): Promise<Mission>;
    cancel(id: string): Promise<void>;
    /** Launches the finished product: preview window, Mac app, or Terminal. */
    test(id: string): Promise<void>;
    stopTest(id: string): Promise<void>;
  };
  approvals: {
    list(): Promise<ApprovalRequest[]>;
    answer(id: string, answer: ApprovalAnswer): Promise<void>;
  };
  terminal: {
    history(): Promise<CommandRun[]>;
  };
  secrets: {
    list(): Promise<SecretStatus[]>;
    set(id: SecretId, value: string): Promise<SecretStatus>;
    remove(id: SecretId): Promise<SecretStatus>;
  };
  system: {
    chooseDirectory(defaultPath?: string): Promise<string | null>;
    openPath(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
}

/** Events pushed main → renderer. */
export interface AosEvents {
  'settings:changed': Settings;
  'agents:events': AgentBatch;
  'agents:catalog': RuntimeCatalog[];
  'approvals:changed': ApprovalRequest[];
  'terminal:runs': CommandRun[];
  'workspaces:changed': Workspace[];
  'missions:changed': Mission;
  'missions:event': MissionEvent;
  'accounts:changed': AccountStatus[];
  'missions:test': TestState;
}

export const INVOKE_CHANNELS = {
  app: ['info'],
  settings: ['get', 'update'],
  accounts: ['list', 'openTerminal'],
  agents: ['catalog', 'route', 'start', 'prompt', 'cancel', 'stop'],
  workspaces: ['list', 'create', 'tree', 'read', 'diff', 'reveal', 'openTerminal'],
  missions: ['list', 'events', 'start', 'cancel', 'test', 'stopTest'],
  approvals: ['list', 'answer'],
  terminal: ['history'],
  secrets: ['list', 'set', 'remove'],
  system: ['chooseDirectory', 'openPath', 'openExternal'],
} as const satisfies { [K in keyof AosApi]: readonly (keyof AosApi[K])[] };

export const EVENT_CHANNELS = ['settings:changed', 'agents:events', 'agents:catalog', 'approvals:changed', 'terminal:runs', 'workspaces:changed', 'missions:changed', 'missions:event', 'accounts:changed', 'missions:test'] as const satisfies readonly (keyof AosEvents)[];

export type Channel = {
  [K in keyof typeof INVOKE_CHANNELS]: `${K}:${(typeof INVOKE_CHANNELS)[K][number]}`;
}[keyof typeof INVOKE_CHANNELS];

export interface AosBridge extends AosApi {
  on<E extends keyof AosEvents>(event: E, cb: (payload: AosEvents[E]) => void): () => void;
}
