import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sync } from '../src/sync.ts';
import { compose, userTail, USER_MARKER } from '../src/vault/write.ts';
import { danglingLinks, jsonl, mdFiles, put, testConfig } from './helpers.ts';

function fixture() {
  const cfg = testConfig();
  const root = join(cfg.projectsRoot, 'Claude', 'Shop');
  put(root, 'src/cart.ts', "import { price } from './price';\nexport function total() {}\n");
  put(root, 'src/price.ts', 'export const price = 2;\n');
  put(root, 'README.md', '# Shop\n\nA shop.\n');
  put(cfg.sessionSources[0].dir, 'slug/s1.jsonl', jsonl([
    { type: 'user', cwd: root, timestamp: '2026-09-25T10:00:00Z', message: { role: 'user', content: 'add a cart' } },
    { type: 'assistant', cwd: root, timestamp: '2026-09-25T10:10:00Z', message: { model: 'claude-opus-5-5', content: [
      { type: 'tool_use', name: 'Write', input: { file_path: join(root, 'src/cart.ts') } },
    ] } },
    { type: 'ai-title', aiTitle: 'Add a cart' },
  ]));
  // A session in a project folder that has since been deleted.
  put(cfg.sessionSources[0].dir, 'slug2/s2.jsonl', jsonl([
    { type: 'user', cwd: join(cfg.projectsRoot, 'Claude', 'Gone'), timestamp: '2026-09-20T10:00:00Z', message: { role: 'user', content: 'old work' } },
  ]));
  return { cfg, root };
}

test('full sync builds a connected vault with no dangling links', async () => {
  const { cfg } = fixture();
  const r = await sync({ config: cfg });
  assert.equal(r.ran, true);
  const files = mdFiles(cfg.vault);
  for (const expected of [
    '🧠 Home.md',
    'Tools/Claude.md',
    'Projects/Claude/Shop/📦 Shop.md',
    'Projects/Claude/Shop/src/📁 src.md',
    'Projects/Claude/Shop/src/cart.ts.md',
    'Projects/Claude/Gone/📦 Gone.md',
    'Sessions/Claude/' + files.find((f) => f.startsWith('Sessions/Claude/') && f.includes('Add a cart'))!.split('/').pop(),
  ]) assert.ok(files.includes(expected), `missing ${expected}`);
  assert.deepEqual(danglingLinks(cfg.vault), []);

  const cart = readFileSync(join(cfg.vault, 'Projects/Claude/Shop/src/cart.ts.md'), 'utf8');
  assert.match(cart, /\[\[Projects\/Claude\/Shop\/src\/price\.ts\.md\|src\/price\.ts\]\]/); // import edge
  assert.match(cart, /Add a cart/); // session backlink
  assert.match(readFileSync(join(cfg.vault, 'Projects/Claude/Gone/📦 Gone.md'), 'utf8'), /no longer exists/);
  assert.ok(existsSync(join(cfg.vault, '.obsidian/graph.json')));
});

test('second sync with no changes writes nothing', async () => {
  const { cfg } = fixture();
  await sync({ config: cfg });
  const r = await sync({ config: cfg });
  assert.equal(r.written, 0);
});

test('user notes survive re-render; deleted files archive only if annotated', async () => {
  const { cfg, root } = fixture();
  await sync({ config: cfg });
  const cartNote = join(cfg.vault, 'Projects/Claude/Shop/src/cart.ts.md');
  const priceNote = join(cfg.vault, 'Projects/Claude/Shop/src/price.ts.md');
  appendFileSync(cartNote, 'My thoughts on the cart.\n');

  appendFileSync(join(root, 'src/cart.ts'), 'export function extra() {}\n');
  await sync({ config: cfg });
  const text = readFileSync(cartNote, 'utf8');
  assert.match(text, /function `extra`/);
  assert.match(text, /My thoughts on the cart\./);

  rmSync(join(root, 'src/cart.ts'));
  rmSync(join(root, 'src/price.ts'));
  const r = await sync({ config: cfg });
  assert.equal(r.archived, 1);
  const archived = readFileSync(join(cfg.vault, 'Archive/Projects/Claude/Shop/src/cart.ts.md'), 'utf8');
  assert.match(archived, /My thoughts on the cart\./);
  assert.match(archived, /\(archived\)/);
  assert.ok(!existsSync(priceNote));
  assert.ok(!existsSync(join(cfg.vault, 'Projects/Claude/Shop/src')), 'empty folder pruned');
  assert.deepEqual(danglingLinks(cfg.vault), []);
});

test('session note follows its title when the title changes', async () => {
  const { cfg } = fixture();
  await sync({ config: cfg });
  const before = mdFiles(cfg.vault).find((f) => f.includes('Add a cart'))!;
  appendFileSync(join(cfg.vault, before), 'keep me\n');
  appendFileSync(join(cfg.sessionSources[0].dir, 'slug/s1.jsonl'), jsonl([{ type: 'ai-title', aiTitle: 'Cart and checkout' }]));
  const r = await sync({ config: cfg });
  assert.equal(r.renamed, 1);
  const after = mdFiles(cfg.vault).find((f) => f.includes('Cart and checkout'))!;
  assert.ok(!existsSync(join(cfg.vault, before)));
  assert.match(readFileSync(join(cfg.vault, after), 'utf8'), /keep me/);
});

test('notes brain-sync did not create are never touched', async () => {
  const { cfg } = fixture();
  await sync({ config: cfg });
  const mine = join(cfg.vault, 'My idea.md');
  writeFileSync(mine, 'hand written');
  await sync({ config: cfg, full: true });
  assert.equal(readFileSync(mine, 'utf8'), 'hand written');
});

test('compose keeps the user tail verbatim', () => {
  const first = compose('# A', null);
  assert.ok(first.includes(USER_MARKER));
  const edited = first + 'note line\n';
  const again = compose('# A changed', edited);
  assert.equal(userTail(again), userTail(edited));
});

test('Agentic OS workspaces and missions join the graph', async () => {
  const { cfg } = fixture();
  const ws = join(cfg.extraRoots[0].dir, 'greet-cli');
  put(ws, 'greet.py', 'def greet(n):\n    return f"Hello, {n}!"\n');
  put(cfg.missionsDir, 'm1.json', JSON.stringify({
    id: 'm1', goal: 'A tiny Python CLI greet.py', status: 'done', workspacePath: ws, workspaceName: 'greet-cli', quality: 'balanced',
    planner: { runtime: 'claude-code', model: 'opus' },
    tasks: [{ id: 't1', title: 'Create greet.py', status: 'done', coder: { runtime: 'claude-code', model: 'sonnet' }, reviewer: { runtime: 'codex', model: 'gpt-5.6-terra' } }],
    checks: [{ name: 'test', command: 'python3 -m unittest', exitCode: 0 }],
    report: 'Shipped greet.py', usage: { input: 10, output: 20, cached: 30 }, createdAt: '2026-09-28T01:00:00Z', updatedAt: '2026-09-28T01:05:00Z',
  }));
  await sync({ config: cfg });
  const files = mdFiles(cfg.vault);
  const mission = files.find((f) => f.startsWith('Missions/'))!;
  assert.ok(mission);
  assert.ok(files.includes('Projects/Agentic OS/greet-cli/greet.py.md'));
  const text = readFileSync(join(cfg.vault, mission), 'utf8');
  assert.match(text, /\[\[Projects\/Agentic OS\/greet-cli\/📦 greet-cli\.md\|greet-cli\]\]/);
  assert.match(text, /reviewed by codex · gpt-5\.6-terra/);
  assert.match(readFileSync(join(cfg.vault, '🧠 Home.md'), 'utf8'), /## Recent missions/);
  assert.deepEqual(danglingLinks(cfg.vault), []);
});
