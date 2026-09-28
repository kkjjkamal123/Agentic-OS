import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Note } from '../render/notes.ts';

export const USER_MARKER = '%% brain:user — write your own notes below this line; brain-sync keeps them %%';
const MARKER_RE = /^%% brain:user\b.*$/m;

function read(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Text after the marker line (the user's own notes), or '' if none. */
export function userTail(existing: string | null): string {
  if (!existing) return '';
  const m = MARKER_RE.exec(existing);
  return m ? existing.slice(m.index + m[0].length) : '';
}

export const hasUserContent = (existing: string | null) => userTail(existing).trim().length > 0;

export function compose(body: string, existing: string | null): string {
  const tail = userTail(existing);
  return `${body.replace(/\n+$/, '')}\n\n${USER_MARKER}${tail || '\n'}`;
}

function atomicWrite(p: string, content: string) {
  mkdirSync(dirname(p), { recursive: true });
  // Dot-prefixed temp name: Obsidian ignores hidden files, so it never sees a half-written note.
  const tmp = join(dirname(p), `.${process.pid}.brain-sync.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

/** Removes now-empty folders up to (not including) the vault root. */
function pruneEmptyDirs(vault: string, from: string) {
  let d = from;
  while (d.startsWith(vault + '/') && d !== vault) {
    try {
      if (readdirSync(d).filter((n) => n !== '.DS_Store').length) return;
      try {
        unlinkSync(join(d, '.DS_Store'));
      } catch {
        // none
      }
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}

export interface WriteResult {
  written: number;
  renamed: number;
  archived: number;
  deleted: number;
  /** key → vault-relative path for everything generated this run. */
  index: Record<string, string>;
}

/**
 * Writes notes, only touching files whose content changed. `prev` is the key→path map from the
 * last run: moved keys are renamed (keeping user text); vanished keys are deleted, or moved to
 * `Archive/` when the user wrote something in them. Files brain-sync never generated are left alone.
 */
export function writeVault(vault: string, notes: Note[], prev: Record<string, string>): WriteResult {
  const res: WriteResult = { written: 0, renamed: 0, archived: 0, deleted: 0, index: {} };
  const current = new Set(notes.map((n) => n.path));

  for (const n of notes) {
    const abs = join(vault, n.path);
    const old = prev[n.key];
    if (old && old !== n.path && !current.has(old) && existsSync(join(vault, old)) && !existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      renameSync(join(vault, old), abs);
      pruneEmptyDirs(vault, dirname(join(vault, old)));
      res.renamed++;
    }
    const existing = read(abs);
    const content = compose(n.body, existing);
    if (content !== existing) {
      atomicWrite(abs, content);
      res.written++;
    }
    res.index[n.key] = n.path;
  }

  for (const [key, path] of Object.entries(prev)) {
    if (key in res.index || current.has(path)) continue;
    const abs = join(vault, path);
    const existing = read(abs);
    if (existing === null) continue;
    if (hasUserContent(existing)) {
      // Keep only the user's text: the generated part links to notes that are gone now.
      const dest = join(vault, 'Archive', path);
      const source = /^path: (".*")$/m.exec(existing)?.[1];
      const header = [
        `# ${basename(path, '.md')} (archived)`,
        `> Source ${source ? `\`${JSON.parse(source)}\`` : 'note'} disappeared on ${new Date().toISOString().slice(0, 10)}; your notes are below.`,
      ].join('\n');
      atomicWrite(dest, `${header}\n${userTail(existing)}`);
      unlinkSync(abs);
      res.archived++;
    } else {
      unlinkSync(abs);
      res.deleted++;
    }
    pruneEmptyDirs(vault, dirname(abs));
  }
  return res;
}
