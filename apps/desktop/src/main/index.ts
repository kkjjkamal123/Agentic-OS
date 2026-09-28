import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, Notification, safeStorage, session, shell } from 'electron';
import { defaultSettings } from '@shared/settings';
import { Accounts } from './accounts';
import { Catalog } from './agents/catalog';
import { AgentManager } from './agents/manager';
import { loadPolicies } from './agents/policies';
import { broadcast, registerIpc } from './ipc';
import { recordMission } from './missions/brain';
import { Launcher } from './missions/launcher';
import { probePage } from './missions/probe';
import { Connectivity } from './net';
import { Missions } from './missions/orchestrator';
import { Gate } from './tools/gate';
import { TerminalFeed } from './tools/terminal';
import { Workspaces } from './workspace/workspaces';
import { openDb } from './store/db';
import { insecureDevEncryptor, SecretStore, type Encryptor } from './store/secrets';
import { SettingsStore } from './store/settings';

// Isolated profile for tests / multiple dev instances.
if (process.env.AOS_USER_DATA) app.setPath('userData', process.env.AOS_USER_DATA);

const isDev = !app.isPackaged;
const devUrl = process.env.ELECTRON_RENDERER_URL;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function encryptor(): Encryptor {
  if (isDev && process.env.AOS_INSECURE_SECRETS === '1') return insecureDevEncryptor;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption (Keychain) is unavailable — refusing to store API keys in plaintext');
  return {
    kind: 'keychain',
    encrypt: (p) => safeStorage.encryptString(p),
    decrypt: (c) => safeStorage.decryptString(c),
  };
}

// Only when you're elsewhere: a finished mission or a pending approval is worth one banner.
function notify(title: string, body: string) {
  const w = BrowserWindow.getAllWindows()[0];
  if (!Notification.isSupported() || w?.isFocused()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (w?.isMinimized()) w.restore();
    w?.show();
    w?.focus();
  });
  n.show();
}

// The product under test runs in its own window and session, so our app's CSP and preload never touch it.
function previewWindow(url: string, title: string, onClose: () => void) {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    title,
    backgroundColor: '#ffffff',
    webPreferences: { partition: 'preview', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const origin = url.startsWith('file:') ? 'file:' : new URL(url).origin;
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('https://')) void shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!(origin === 'file:' ? u.startsWith('file:') : u.startsWith(origin))) e.preventDefault();
  });
  win.on('closed', onClose);
  void win.loadURL(url);
  return { close: () => !win.isDestroyed() && win.close() };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Agentic OS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 11 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#eef0f4',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // No in-app navigation or popups: https links go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  void app.whenReady().then(() => {
    if (!isDev) {
      session.defaultSession.webRequest.onHeadersReceived((d, cb) =>
        cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [CSP] } }),
      );
    }

    const db = openDb(join(app.getPath('userData'), 'agentic-os.db'));
    const defaults = defaultSettings(homedir());
    // Test profiles keep their workspaces inside the throwaway profile, never in the real folder.
    if (process.env.AOS_USER_DATA) defaults.workspaceRoot = join(app.getPath('userData'), 'workspaces');
    const settings = new SettingsStore(db, defaults);
    const enc = encryptor();
    const secrets = new SecretStore(db, enc);

    nativeTheme.themeSource = settings.get().theme;
    settings.onChange((s) => (nativeTheme.themeSource = s.theme));

    const accounts = new Accounts();
    const scratchDir = join(app.getPath('userData'), 'agents');
    const fakeAgent = isDev ? process.env.AOS_FAKE_AGENT : undefined;
    const catalog = new Catalog({ db, accounts, secrets, settings, scratchDir, fakeAgent });
    const workspaces = new Workspaces(db, () => settings.get().workspaceRoot);
    const feed = new TerminalFeed(({ runs }) => broadcast('terminal:runs', runs));
    const gate = new Gate({
      mode: () => settings.get().approvalMode,
      ask: (req) => {
        notify(`${req.agent} needs your approval`, req.action.command ?? req.reason);
        broadcast('approvals:changed', gate.list());
        app.dock?.setBadge(String(gate.list().length));
        BrowserWindow.getAllWindows()[0]?.flashFrame(true);
      },
      resolved: (_id, left) => {
        broadcast('approvals:changed', gate.list());
        app.dock?.setBadge(left ? String(left) : '');
      },
    });
    let policies: ReturnType<typeof loadPolicies> | null = null;
    const agents = new AgentManager({
      catalog, secrets, settings, workspaces, gate, feed, scratchDir,
      policies: () => (policies ??= loadPolicies()),
      send: (batch) => broadcast('agents:events', batch),
    });
    const lastStatus = new Map<string, string>();
    const launcher = new Launcher({
      feed,
      show: previewWindow,
      openApp: async (p) => void (await shell.openPath(p)),
      send: (t) => broadcast('missions:test', t),
      probe: probePage,
    });
    const connectivity = new Connectivity();
    const missions = new Missions({
      launcher,
      net: connectivity,
      db, agents, workspaces, gate, feed, settings,
      send: (m) => {
        broadcast('missions:changed', m);
        const prev = lastStatus.get(m.id);
        lastStatus.set(m.id, m.status);
        if (prev && prev !== m.status && ['done', 'failed'].includes(m.status)) {
          notify(m.status === 'done' ? 'Mission shipped' : 'Mission needs attention', `${m.goal.slice(0, 90)}${m.error ? `: ${m.error.slice(0, 80)}` : ''}`);
        }
        if (prev && prev !== 'paused' && m.status === 'paused' && m.pause?.reason === 'offline') notify('Mission paused: no internet', 'It continues by itself when you are back online.');
      },
      event: (e) => broadcast('missions:event', e),
      workspacesChanged: () => broadcast('workspaces:changed', workspaces.list()),
      record: (m, path) => settings.get().recordToBrain && !fakeAgent && recordMission(m, path),
    });
    missions.recoverInterrupted();
    registerIpc({ settings, secrets, accounts, catalog, agents, workspaces, gate, feed, missions, launcher, connectivity, encryption: enc.kind });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    app.on('will-quit', () => {
      launcher.stopAll();
      agents.stopAll();
      db.close();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
