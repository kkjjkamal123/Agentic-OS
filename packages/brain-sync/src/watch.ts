import { existsSync, watch, type FSWatcher } from 'node:fs';
import type { Config } from './config.ts';
import { sync } from './sync.ts';

/** Paths inside these never matter — builds churn them constantly. */
const NOISY = /(^|\/)(node_modules|\.git|\.worktrees|DerivedData|\.build|build|dist|out|target|__pycache__|\.venv|venv|\.next|\.cache|\.swiftpm|xcuserdata|Pods)(\/|$)|\.DS_Store$|\.brain-sync\.tmp$/;

const DEBOUNCE_MS = 4_000;
const MAX_WAIT_MS = 30_000;
const TICK_MS = 5 * 60_000; // periodic pass: catches idle sessions that are now due a summary

export function startWatch(cfg: Config, log: (m: string) => void): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let firstEventAt = 0;
  let running = false;
  let again = false;

  const run = async (why: string) => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const r = await sync({ config: cfg, log });
      if (r.ran && (r.written || r.summarized || r.deleted || r.archived)) {
        log(`sync (${why}): ${r.written} written, ${r.summarized} summarized, ${r.deleted + r.archived} removed — ${r.notes} notes in ${r.ms} ms`);
      }
    } catch (e) {
      log(`sync failed: ${(e as Error).stack ?? e}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule('queued');
      }
    }
  };

  const schedule = (why: string) => {
    const now = Date.now();
    if (!timer) firstEventAt = now;
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstEventAt + MAX_WAIT_MS - now));
    timer = setTimeout(() => {
      timer = undefined;
      void run(why);
    }, wait);
  };

  const dirs = [cfg.projectsRoot, ...cfg.extraRoots.map((r) => r.dir), cfg.missionsDir, ...cfg.sessionSources.map((s) => s.dir)];
  const attach = () => {
    for (const d of dirs) {
      if (watchers.some((w) => (w as any).__dir === d) || !existsSync(d)) continue;
      try {
        const w = watch(d, { recursive: true }, (_ev, name) => {
          const n = name?.toString() ?? '';
          if (n && NOISY.test(n)) return;
          schedule(`change in ${d}`);
        });
        (w as any).__dir = d;
        w.on('error', (e) => {
          log(`watcher error on ${d}: ${e.message}`);
          w.close();
          watchers.splice(watchers.indexOf(w), 1);
        });
        watchers.push(w);
        log(`watching ${d}`);
      } catch (e) {
        log(`cannot watch ${d}: ${(e as Error).message}`);
      }
    }
  };

  attach();
  void run('startup');
  const tick = setInterval(() => {
    attach(); // picks up session dirs created after startup (e.g. first Codex run)
    void run('periodic');
  }, TICK_MS);

  return () => {
    clearInterval(tick);
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
