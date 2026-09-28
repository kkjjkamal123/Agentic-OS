import { net } from 'electron';

// Apple's captive-portal probe: tiny, and it tells a real connection from a Wi-Fi login page.
const PROBE = 'http://captive.apple.com/hotspot-detect.html';
const RECHECK_MS = 30_000;

export interface Net {
  online(): Promise<boolean>;
  waitOnline(signal: AbortSignal): Promise<void>;
}

export class Connectivity implements Net {
  private waiters = new Set<() => void>();

  async online(): Promise<boolean> {
    if (!net.isOnline()) return false;
    try {
      const r = await fetch(PROBE, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
      return (await r.text()).includes('Success');
    } catch {
      return false;
    }
  }

  /** Checks again on every OS network change, with a slow timer only while something is waiting. */
  async waitOnline(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !(await this.online())) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, RECHECK_MS);
        this.waiters.add(done);
        signal.addEventListener('abort', done);
      });
    }
  }

  changed() {
    for (const w of [...this.waiters]) w();
  }
}
