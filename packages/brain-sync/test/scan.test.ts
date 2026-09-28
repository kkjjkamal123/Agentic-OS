import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { escapeMd, seg } from '../src/render/md.ts';
import { scanProject } from '../src/scan/projects.ts';
import { emptyState } from '../src/state.ts';
import { put, testConfig } from './helpers.ts';

test('scan skips build output, deps, hidden + gitignored files, binaries get no outline', () => {
  const cfg = testConfig();
  const root = join(cfg.projectsRoot, 'Claude', 'App');
  put(root, 'src/main.ts', "import { helper } from './util.js';\nexport function main() {}\nexport class App {}\n");
  put(root, 'src/util.ts', 'export const helper = 1;\n');
  put(root, 'node_modules/x/index.js', 'x');
  put(root, '.build/debug/a.o', 'x');
  put(root, 'Vox.xcodeproj/project.pbxproj', 'x');
  put(root, 'thing.o', 'x');
  put(root, '.env', 'SECRET=1');
  put(root, '.gitignore', 'secret/\n*.tmp\n');
  put(root, 'secret/keys.txt', 'x');
  put(root, 'notes.tmp', 'x');
  put(root, 'logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  put(root, 'README.md', '# App\n\nA tiny demo app.\n');

  const p = scanProject({ tool: 'Claude', name: 'App', root }, cfg, emptyState(), new Set());
  assert.deepEqual(p.files.map((f) => f.rel), ['.gitignore', 'logo.png', 'README.md', 'src/main.ts', 'src/util.ts']);
  const main = p.files.find((f) => f.rel === 'src/main.ts')!;
  assert.deepEqual(main.analysis.outline, [{ kind: 'function', name: 'main' }, { kind: 'class', name: 'App' }]);
  assert.deepEqual(main.links, [join(root, 'src/util.ts')]);
  assert.equal(p.files.find((f) => f.rel === 'logo.png')!.analysis.binary, true);
  assert.equal(p.readme, 'A tiny demo app.');
  assert.ok(p.stack.includes('TypeScript'));
});

test('nested .gitignore applies only beneath its folder', () => {
  const cfg = testConfig();
  const root = join(cfg.projectsRoot, 'Codex', 'Py');
  put(root, 'pkg/.gitignore', 'gen.py\n');
  put(root, 'pkg/gen.py', 'x = 1\n');
  put(root, 'gen.py', 'from pkg import core\n');
  put(root, 'pkg/__init__.py', '');
  put(root, 'pkg/core.py', 'def run():\n    pass\n');
  const p = scanProject({ tool: 'Codex', name: 'Py', root }, cfg, emptyState(), new Set());
  const rels = p.files.map((f) => f.rel);
  assert.ok(rels.includes('gen.py'));
  assert.ok(!rels.includes('pkg/gen.py'));
  assert.ok(p.files.find((f) => f.rel === 'gen.py')!.links.includes(join(root, 'pkg/core.py')));
});

test('analysis cache is reused when mtime/size are unchanged', () => {
  const cfg = testConfig();
  const root = join(cfg.projectsRoot, 'Claude', 'C');
  put(root, 'a.py', 'def one():\n  pass\n');
  const state = emptyState();
  scanProject({ tool: 'Claude', name: 'C', root }, cfg, state, new Set());
  state.files[join(root, 'a.py')].analysis.outline = [{ kind: 'def', name: 'cached' }];
  const p = scanProject({ tool: 'Claude', name: 'C', root }, cfg, state, new Set());
  assert.equal(p.files[0].analysis.outline[0].name, 'cached');
});

test('seg and escapeMd keep Obsidian links/tags clean', () => {
  assert.equal(seg('a/b#c|d[e]'), 'a-b-c-d-e-');
  assert.equal(seg('.github'), '_github');
  assert.equal(escapeMd('see [[x]] #tag <b> %%'), 'see \\[\\[x\\]\\] \\#tag &lt;b> \\%\\%');
});
