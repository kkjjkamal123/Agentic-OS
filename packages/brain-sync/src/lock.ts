import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Single-flight lock. If another sync holds it we leave a "pending" flag and bail; the holder
 * re-runs once when it finishes, so bursts of triggers (every edit, every turn) coalesce.
 */
export class SyncLock {
  private lock: string;
  private pending: string;

  constructor(home: string) {
    mkdirSync(home, { recursive: true });
    this.lock = join(home, 'sync.lock');
    this.pending = join(home, 'sync.pending');
  }

  acquire(): boolean {
    try {
      writeFileSync(this.lock, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let holder = NaN;
      try {
        holder = Number(readFileSync(this.lock, 'utf8'));
      } catch {
        // vanished between calls — retry once
      }
      if (!holder || !alive(holder)) {
        try {
          unlinkSync(this.lock);
        } catch {
          // someone else cleaned it
        }
        try {
          writeFileSync(this.lock, String(process.pid), { flag: 'wx' });
          return true;
        } catch {
          // lost the race
        }
      }
      writeFileSync(this.pending, String(Date.now()));
      return false;
    }
  }

  /** True (and clears the flag) if someone asked for a sync while we held the lock. */
  takePending(): boolean {
    if (!existsSync(this.pending)) return false;
    try {
      unlinkSync(this.pending);
    } catch {
      // cleared concurrently
    }
    return true;
  }

  release() {
    try {
      if (readFileSync(this.lock, 'utf8') === String(process.pid)) unlinkSync(this.lock);
    } catch {
      // already gone
    }
  }
}
