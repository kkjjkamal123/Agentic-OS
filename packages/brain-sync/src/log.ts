import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LOG = 5 * 1024 * 1024;

/** Line logger to stdout and/or a file (truncated when it grows past 5 MB). */
export function makeLogger(opts: { file?: string; quiet?: boolean }) {
  if (opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true });
    try {
      if (statSync(opts.file).size > MAX_LOG) truncateSync(opts.file, 0);
    } catch {
      // new log
    }
  }
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (!opts.quiet) console.log(line);
    if (opts.file) {
      try {
        appendFileSync(opts.file, line + '\n');
      } catch {
        // logging must never break a sync
      }
    }
  };
}
