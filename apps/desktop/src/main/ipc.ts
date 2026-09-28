import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { statSync } from 'node:fs';
import { ACCOUNTS } from '@shared/accounts';
import type { AosApi, AosEvents, AppInfo, Channel } from '@shared/ipc';
import { RUNTIME_IDS, RUNTIMES } from '@shared/agents';
import { QualitySchema, RoleSchema, StartOptsSchema } from '@shared/schemas';
import { MissionStartSchema } from '@shared/missions';
import { ApprovalAnswerSchema, RelPathSchema, WorkspaceNameSchema } from '@shared/workspace';
import type { Accounts } from './accounts';
import type { AgentManager } from './agents/manager';
import type { Catalog } from './agents/catalog';
import type { Missions } from './missions/orchestrator';
import type { Launcher } from './missions/launcher';
import type { SecretStore } from './store/secrets';
import type { Gate } from './tools/gate';
import type { TerminalFeed } from './tools/terminal';
import type { Workspaces } from './workspace/workspaces';
import { runInTerminal, shellQuote } from './terminalApp';
import type { SettingsStore } from './store/settings';

type Handlers = { [K in keyof AosApi]: { [M in keyof AosApi[K]]: AosApi[K][M] } };

export interface Services {
  settings: SettingsStore;
  secrets: SecretStore;
  accounts: Accounts;
  catalog: Catalog;
  agents: AgentManager;
  workspaces: Workspaces;
  gate: Gate;
  feed: TerminalFeed;
  missions: Missions;
  launcher: Launcher;
  encryption: AppInfo['encryption'];
}

const AccountArg = z.enum(ACCOUNTS.map((a) => a.id) as [string, ...string[]]);
const TerminalAction = z.enum(['login', 'install']);


const SessionIdArg = z.string().uuid();
const IdArg = z.string().uuid();
const PromptArg = z.string().min(1).max(200_000);
const PathArg = z.string().min(1).max(4096);
const HttpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'only https links open externally');

const runtimesForSecret = (id: string) => RUNTIME_IDS.filter((r) => 'secret' in RUNTIMES[r] && (RUNTIMES[r] as { secret: string }).secret === id);

export function broadcast<E extends keyof AosEvents>(event: E, payload: AosEvents[E]) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(event, payload);
}

/** Registers every channel in the contract. Inputs from the renderer are untrusted: validate. */
export function registerIpc(s: Services) {
  const handlers: Handlers = {
    app: {
      info: async () => ({
        name: app.getName(),
        version: app.getVersion(),
        versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
        platform: process.platform,
        userData: app.getPath('userData'),
        encryption: s.encryption,
      }),
    },
    settings: {
      get: async () => s.settings.get(),
      update: async (patch) => s.settings.update(patch),
    },
    accounts: {
      list: async (refresh) => {
        const list = await s.accounts.list(refresh === true);
        if (refresh === true) void s.catalog.changed();
        return list;
      },
      openTerminal: async (id, action) => {
        const def = ACCOUNTS.find((a) => a.id === AccountArg.parse(id))!;
        await runInTerminal(TerminalAction.parse(action) === 'login' ? def.login : def.install);
        s.accounts.noteLoginStarted();
      },
    },
    agents: {
      catalog: async (refresh) => s.catalog.list(refresh === true),
      route: async (role, quality) => s.agents.route(RoleSchema.parse(role), { quality: quality === undefined ? undefined : QualitySchema.parse(quality) }),
      start: async (role, opts) => s.agents.start(RoleSchema.parse(role), StartOptsSchema.parse(opts ?? {})),
      prompt: async (id, text) => s.agents.prompt(SessionIdArg.parse(id), PromptArg.parse(text)),
      cancel: async (id) => s.agents.cancel(SessionIdArg.parse(id)),
      stop: async (id) => s.agents.stop(SessionIdArg.parse(id)),
    },
    workspaces: {
      list: async () => s.workspaces.list(),
      create: async (name) => {
        const w = await s.workspaces.create(WorkspaceNameSchema.parse(name));
        broadcast('workspaces:changed', s.workspaces.list());
        return w;
      },
      tree: async (id, rel) => s.workspaces.tree(IdArg.parse(id), RelPathSchema.parse(rel ?? '')),
      read: async (id, rel) => s.workspaces.read(IdArg.parse(id), RelPathSchema.parse(rel)),
      diff: async (id) => s.workspaces.diff(IdArg.parse(id)),
      reveal: async (id) => void (await shell.openPath(s.workspaces.get(IdArg.parse(id)).path)),
      openTerminal: async (id) => runInTerminal(`cd ${shellQuote(s.workspaces.get(IdArg.parse(id)).path)}`),
    },
    missions: {
      list: async () => s.missions.list(),
      events: async (id) => s.missions.events(IdArg.parse(id)),
      start: async (input) => s.missions.start(MissionStartSchema.parse(input)),
      cancel: async (id) => s.missions.cancel(IdArg.parse(id)),
      test: async (id) => {
        const m = s.missions.get(IdArg.parse(id));
        await s.launcher.test(m, s.workspaces.get(m.workspaceId).path);
      },
      stopTest: async (id) => s.launcher.stop(IdArg.parse(id)),
    },
    approvals: {
      list: async () => s.gate.list(),
      answer: async (id, ans) => s.gate.answer(IdArg.parse(id), ApprovalAnswerSchema.parse(ans)),
    },
    terminal: {
      history: async () => s.feed.history(),
    },
    secrets: {
      list: async () => s.secrets.list(),
      set: async (id, value) => {
        const st = s.secrets.set(id, value);
        s.catalog.invalidate(runtimesForSecret(st.id));
        return st;
      },
      remove: async (id) => {
        const st = s.secrets.remove(id);
        s.catalog.invalidate(runtimesForSecret(st.id));
        return st;
      },
    },
    system: {
      chooseDirectory: async (defaultPath) => {
        const win = BrowserWindow.getFocusedWindow();
        const opts = { defaultPath: defaultPath ? PathArg.parse(defaultPath) : undefined, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      // Folders only: opening an arbitrary file path would launch apps or scripts.
      openPath: async (path) => {
        const p = PathArg.parse(path);
        if (!statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Only folders can be opened');
        const err = await shell.openPath(p);
        if (err) throw new Error(err);
      },
      openExternal: async (url) => shell.openExternal(HttpsUrl.parse(url)),
    },
  };

  for (const [ns, methods] of Object.entries(handlers)) {
    for (const [method, fn] of Object.entries(methods as Record<string, (...a: unknown[]) => Promise<unknown>>)) {
      const channel = `${ns}:${method}` as Channel;
      ipcMain.handle(channel, (_e, ...args) => fn(...args));
    }
  }

  let ollama = s.settings.get().ollamaBaseUrl;
  s.settings.onChange((next) => {
    broadcast('settings:changed', next);
    if (next.ollamaBaseUrl !== ollama) {
      ollama = next.ollamaBaseUrl;
      s.catalog.invalidate(['ollama']);
    }
  });
  s.catalog.onChange((list) => broadcast('agents:catalog', list));
  app.on('browser-window-focus', () => {
    if (!s.accounts.shouldRefreshOnFocus()) return;
    void s.accounts.list(true).then((accounts) => {
      broadcast('accounts:changed', accounts);
      void s.catalog.changed();
    });
  });
}
