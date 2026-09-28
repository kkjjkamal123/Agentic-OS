#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import {
  hooksInstalled, launchAgentRunning, setup, uninstallHooks, uninstallLaunchAgent,
} from './install.ts';
import { makeLogger } from './log.ts';
import { loadState } from './state.ts';
import type { SummaryMode } from './summarize.ts';
import { sync } from './sync.ts';
import { registerVault } from './vault/obsidian.ts';
import { startWatch } from './watch.ts';

const HELP = `brain-sync — mirror every project, file and AI session into one Obsidian vault

Usage:
  brain-sync [sync] [--full] [--summaries auto|all|none] [--final <log>] [--quiet]
  brain-sync install [--no-hooks] [--no-launchd] [--no-open]
  brain-sync uninstall
  brain-sync status
  brain-sync watch          (foreground; normally run by launchd)
  brain-sync hook           (called by Claude Code hooks; reads hook JSON on stdin)

Config: ~/.brain-sync/config.json`;

function args(argv: string[]) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (v !== undefined) flags.set(k, v);
      else if (['summaries', 'final'].includes(k) && next && !next.startsWith('--')) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else rest.push(a);
  }
  return { cmd: rest[0] ?? 'sync', flags };
}

async function readStdin(timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function main() {
  const { cmd, flags } = args(process.argv.slice(2));
  const cfg = loadConfig();
  const syncLog = join(cfg.home, 'logs', 'sync.log');

  switch (cmd) {
    case 'sync': {
      const quiet = flags.has('quiet');
      const log = makeLogger({ quiet, file: quiet ? syncLog : undefined });
      const final = flags.get('final');
      const r = await sync({
        config: cfg,
        full: flags.has('full'),
        summaries: (flags.get('summaries') as SummaryMode) ?? 'auto',
        finalLogs: typeof final === 'string' ? [final] : [],
        log,
      });
      if (!r.ran) log('another sync is running — queued a follow-up pass');
      else log(`${r.projects} projects · ${r.files} files · ${r.sessions} sessions → ${r.notes} notes (${r.written} written, ${r.renamed} renamed, ${r.deleted} deleted, ${r.archived} archived, ${r.summarized} summarized) in ${r.ms} ms → ${cfg.vault}`);
      break;
    }

    case 'hook': {
      // Must be instant and silent: Claude Code waits on this and SessionStart stdout enters context.
      if (process.env.BRAIN_SYNC_CHILD) return;
      let input: any = {};
      try {
        input = JSON.parse((await readStdin()) || '{}');
      } catch {
        // no/invalid payload — plain sync
      }
      const a = [fileURLToPath(import.meta.url), 'sync', '--quiet'];
      if (input.hook_event_name === 'SessionEnd' && input.transcript_path) a.push('--final', input.transcript_path);
      const out = openSync(syncLog, 'a');
      spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...a], {
        detached: true,
        stdio: ['ignore', out, out],
      }).unref();
      return;
    }

    case 'watch': {
      const log = makeLogger({});
      log(`brain-sync watcher started (pid ${process.pid}) → ${cfg.vault}`);
      const stop = startWatch(cfg, log);
      const bye = () => {
        stop();
        process.exit(0);
      };
      process.on('SIGTERM', bye);
      process.on('SIGINT', bye);
      return;
    }

    case 'install': {
      console.log('Installing brain-sync…');
      for (const s of setup(cfg, { hooks: !flags.has('no-hooks'), launchd: !flags.has('no-launchd') })) console.log(' ✓ ' + s);
      console.log(' … first full sync (this also summarizes every past session, may take a minute)');
      const r = await sync({ config: cfg, full: true, summaries: 'all', log: (m) => console.log('   ' + m) });
      console.log(` ✓ ${r.notes} notes in ${cfg.vault} (${r.summarized} summaries, ${r.ms} ms)`);
      console.log(` ✓ Obsidian vault ${registerVault(cfg.vault)}`);
      if (!flags.has('no-open')) spawn('open', [`obsidian://open?path=${encodeURIComponent(join(cfg.vault, '🧠 Home.md'))}`], { stdio: 'ignore', detached: true }).unref();
      break;
    }

    case 'uninstall': {
      console.log(uninstallHooks() ? ' ✓ removed Claude Code hooks' : ' · no hooks to remove');
      console.log(uninstallLaunchAgent() ? ' ✓ removed background watcher' : ' · no watcher installed');
      console.log(` · vault left in place: ${cfg.vault}`);
      break;
    }

    case 'status': {
      const st = loadState(cfg.home);
      const lr = st.lastRun;
      console.log([
        `vault        ${cfg.vault}${existsSync(cfg.vault) ? '' : ' (missing)'}`,
        `projects     ${cfg.projectsRoot}`,
        `sessions     ${cfg.sessionSources.map((s) => `${s.kind}:${s.dir}`).join('  ')}`,
        `hooks        ${hooksInstalled() ? 'installed' : 'not installed'}`,
        `watcher      ${launchAgentRunning() ? 'running' : 'not running'}`,
        `notes        ${Object.keys(st.notes).length}`,
        `summaries    ${Object.keys(st.summaries).length}`,
        `last sync    ${lr ? `${lr.at} (${lr.ms} ms, ${lr.written} written)` : 'never'}`,
      ].join('\n'));
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
