import { pathToFileURL } from 'node:url';

/** One path segment safe for Obsidian filenames and wikilinks. */
export function seg(name: string, max = 100): string {
  let s = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim();
  if (s.startsWith('.')) s = '_' + s.slice(1);
  if (s.length > max) s = s.slice(0, max).trimEnd();
  return s || '_';
}

export const segs = (rel: string) => rel.split('/').map((p) => seg(p)).join('/');

/** `[[path|label]]`; pass `inTable` to escape the pipe for table cells. */
export function link(path: string, label: string, inTable = false): string {
  const l = label.replace(/[|[\]]/g, ' ').trim() || path;
  return `[[${path}${inTable ? '\\|' : '|'}${l}]]`;
}

export const fileUrl = (abs: string) => pathToFileURL(abs).href;

/** Neutralises markdown that would create stray links, tags, comments or HTML in quoted text. */
export function escapeMd(s: string): string {
  return s
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\]\]/g, '\\]\\]')
    .replace(/%%/g, '\\%\\%')
    .replace(/</g, '&lt;')
    .replace(/(^|\s)#(?=[\w/-])/g, '$1\\#')
    .replace(/!\[/g, '!\\[');
}

export function quote(s: string): string {
  return escapeMd(s).split('\n').map((l) => `> ${l}`).join('\n');
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);

export function frontmatter(obj: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(x)}`));
    } else {
      lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-time `YYYY-MM-DD HH:mm`. */
export function fmtDate(d: Date | string | number): string {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function fmtDuration(ms: number): string {
  if (!(ms > 0)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
