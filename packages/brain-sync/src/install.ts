import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, type Config } from './config.ts';

export const LABEL = 'com.brain-sync.watch';
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');
const HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd', 'PostToolUse'] as const;
/** Matches our hook command, quoted or not: `"…/brain-sync" hook`. */
const HOOK_RE = /brain-sync"?\s+hook\b/;

export const wrapperPath = (cfg: Config) => join(cfg.home, 'bin', 'brain-sync');

function which(cmd: string): string | null {
  try {
    return execFileSync('/bin/zsh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** A space-free launcher so hooks/launchd never have to quote the repo path. */
function writeWrapper(cfg: Config): string {
  const p = wrapperPath(cfg);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${CLI}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

function writeConfigFile(cfg: Config) {
  const p = join(cfg.home, 'config.json');
  if (existsSync(p)) return false;
  const base = defaultConfig(cfg.home);
  const claude = which('claude');
  const { home: _home, ...rest } = base;
  writeFileSync(p, JSON.stringify({ ...rest, summarize: { ...rest.summarize, command: claude ?? 'claude' } }, null, 2) + '\n');
  return true;
}

export type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

export const isOurs = (h: HookEntry) => h.hooks?.some((x) => HOOK_RE.test(x.command ?? ''));

export function installHooks(cfg: Config): string {
  let settings: Record<string, any> = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
    copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + '.brain-sync.bak');
  }
  settings.hooks ??= {};
  const command = `"${wrapperPath(cfg)}" hook`;
  for (const ev of HOOK_EVENTS) {
    const list: HookEntry[] = (settings.hooks[ev] ?? []).filter((h: HookEntry) => !isOurs(h));
    const entry: HookEntry = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (ev === 'PostToolUse') entry.matcher = 'Write|Edit|MultiEdit|NotebookEdit';
    list.push(entry);
    settings.hooks[ev] = list;
  }
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return CLAUDE_SETTINGS;
}

export function uninstallHooks(): boolean {
  if (!existsSync(CLAUDE_SETTINGS)) return false;
  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
  if (!settings.hooks) return false;
  let changed = false;
  for (const ev of Object.keys(settings.hooks)) {
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter((h: HookEntry) => !isOurs(h));
    if (settings.hooks[ev].length !== before) changed = true;
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (changed) writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

export function hooksInstalled(): boolean {
  try {
    const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
    return HOOK_EVENTS.every((ev) => (s.hooks?.[ev] ?? []).some(isOurs));
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function installLaunchAgent(cfg: Config): string {
  const logs = join(cfg.home, 'logs');
  mkdirSync(logs, { recursive: true });
  const path = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(wrapperPath(cfg))}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc([...new Set(path)].join(':'))}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(join(logs, 'watch.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, 'watch.log'))}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
  const uid = process.getuid!();
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // wasn't loaded
  }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
  return PLIST;
}

export function uninstallLaunchAgent(): boolean {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // not loaded
  }
  if (!existsSync(PLIST)) return false;
  unlinkSync(PLIST);
  return true;
}

export function launchAgentRunning(): boolean {
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid!()}/${LABEL}`], { encoding: 'utf8' });
    return /state = running/.test(out);
  } catch {
    return false;
  }
}

export function setup(cfg: Config, opts: { hooks: boolean; launchd: boolean }) {
  const steps: string[] = [];
  mkdirSync(cfg.home, { recursive: true });
  if (writeConfigFile(cfg)) steps.push(`wrote ${join(cfg.home, 'config.json')}`);
  steps.push(`launcher ${writeWrapper(cfg)}`);
  if (opts.hooks) steps.push(`Claude Code hooks → ${installHooks(cfg)} (backup: settings.json.brain-sync.bak)`);
  if (opts.launchd) steps.push(`background watcher → ${installLaunchAgent(cfg)}`);
  return steps;
}
