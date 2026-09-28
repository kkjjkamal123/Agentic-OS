import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const rgb = (hex: number) => ({ a: 1, rgb: hex });

const GRAPH = {
  'collapse-filter': false,
  search: '',
  showTags: false,
  showAttachments: false,
  hideUnresolved: true,
  showOrphans: true,
  'collapse-color-groups': false,
  colorGroups: [
    { query: 'tag:#brain/home', color: rgb(0xf5b800) },
    { query: 'tag:#brain/tool', color: rgb(0x9b59b6) },
    { query: 'tag:#brain/project', color: rgb(0x3498db) },
    { query: 'tag:#brain/session', color: rgb(0xe67e22) },
    { query: 'tag:#brain/mission', color: rgb(0xe74c3c) },
    { query: 'tag:#brain/folder', color: rgb(0x95a5a6) },
    { query: 'tag:#brain/file', color: rgb(0x1abc9c) },
  ],
  'collapse-display': false,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1.2,
  lineSizeMultiplier: 1,
  'collapse-forces': false,
  centerStrength: 0.45,
  repelStrength: 12,
  linkStrength: 1,
  linkDistance: 180,
  scale: 0.4,
  close: false,
};

/** Seeds `.obsidian/` (graph colours etc.) once; never overwrites the user's own tweaks. */
export function ensureVaultConfig(vault: string): boolean {
  const dir = join(vault, '.obsidian');
  if (existsSync(dir)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH, null, 2));
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: 'folder', newFileFolderPath: 'Inbox', showFrontmatter: false }, null, 2),
  );
  writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ theme: 'obsidian' }, null, 2));
  return true;
}

const OBSIDIAN_JSON = join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');

/** Adds the vault to Obsidian's vault list so it shows in the switcher. Safe to call repeatedly. */
export function registerVault(vault: string): 'added' | 'present' {
  let data: { vaults?: Record<string, { path: string; ts: number; open?: boolean }> } = {};
  try {
    data = JSON.parse(readFileSync(OBSIDIAN_JSON, 'utf8'));
  } catch {
    // Obsidian never launched yet
  }
  data.vaults ??= {};
  if (Object.values(data.vaults).some((v) => v.path === vault)) return 'present';
  data.vaults[randomBytes(8).toString('hex')] = { path: vault, ts: Date.now(), open: true };
  mkdirSync(join(OBSIDIAN_JSON, '..'), { recursive: true });
  writeFileSync(OBSIDIAN_JSON, JSON.stringify(data));
  return 'added';
}
