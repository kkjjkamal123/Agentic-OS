import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Mission, TestState } from '@shared/missions';
import { Launcher } from '../../src/main/missions/launcher';
import { TerminalFeed } from '../../src/main/tools/terminal';

const tmp = () => mkdtempSync(join(tmpdir(), 'aos-launch-'));
const mission = (run: Mission['run']): Mission =>
  ({ id: 'm1', goal: 'Hangman', product: 'Hangman game', run, tasks: [{ status: 'done' }] }) as unknown as Mission;

function setup() {
  const states: TestState[] = [];
  const shown: string[] = [];
  const closed = vi.fn();
  const opened: string[] = [];
  const terminal = vi.fn(async () => {});
  const l = new Launcher({
    feed: new TerminalFeed(() => {}),
    show: (url) => (shown.push(url), { close: closed }),
    openApp: async (p) => void opened.push(p),
    send: (s) => states.push(s),
    terminal,
  });
  return { l, states, shown, closed, opened, terminal };
}

describe('launch check (part of verification)', () => {
  it('fails when the product to open is missing, passes when it exists', async () => {
    const root = tmp();
    const { l } = setup();
    expect(await l.check({ kind: 'web', open: 'index.html' }, root, 's')).toMatchObject({ ok: false });
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>');
    expect(await l.check({ kind: 'web', open: 'index.html' }, root, 's')).toEqual({ ok: true });
  });

  it('requires a real .app bundle for Mac apps', async () => {
    const root = tmp();
    const { l } = setup();
    mkdirSync(join(root, 'build/Hangman.app'), { recursive: true });
    expect(await l.check({ kind: 'macos-app', open: 'build/Hangman.app' }, root, 's')).toMatchObject({ ok: false });
    mkdirSync(join(root, 'build/Hangman.app/Contents/MacOS'), { recursive: true });
    expect(await l.check({ kind: 'macos-app', open: 'build/Hangman.app' }, root, 's')).toEqual({ ok: true });
  });

  it('starts a web server, waits for it to answer, then stops it', async () => {
    const root = tmp();
    writeFileSync(join(root, 'index.html'), 'ok');
    const { l } = setup();
    const port = 41000 + Math.floor(Math.random() * 1000);
    const r = await l.check({ kind: 'web', start: `python3 -m http.server ${port} --bind 127.0.0.1`, url: `http://127.0.0.1:${port}` }, root, 's');
    expect(r).toEqual({ ok: true });
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 30_000);
});

describe('Test button', () => {
  it('opens a static web app in a preview', async () => {
    const root = tmp();
    writeFileSync(join(root, 'index.html'), '<h1>Hangman</h1>');
    const { l, shown, states } = setup();
    await l.test(mission({ kind: 'web', open: 'index.html' }), root);
    expect(shown[0]).toMatch(/^file:\/\/.*index\.html$/);
    expect(states.at(-1)).toMatchObject({ state: 'running' });
  });

  it('serves a web app, previews the URL, and Stop shuts the server down', async () => {
    const root = tmp();
    writeFileSync(join(root, 'index.html'), 'live');
    const { l, shown, states, closed } = setup();
    const port = 42000 + Math.floor(Math.random() * 1000);
    await l.test(mission({ kind: 'web', start: `python3 -m http.server ${port} --bind 127.0.0.1`, url: `http://127.0.0.1:${port}` }), root);
    expect(shown).toEqual([`http://127.0.0.1:${port}`]);
    expect(await (await fetch(`http://127.0.0.1:${port}/index.html`)).text()).toBe('live');
    l.stop('m1');
    expect(closed).toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ state: 'stopped' });
    await vi.waitFor(() => expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).rejects.toThrow(), { timeout: 5000 });
  }, 30_000);

  it('launches Mac apps directly and CLIs in Terminal', async () => {
    const root = tmp();
    mkdirSync(join(root, 'Hangman.app/Contents/MacOS'), { recursive: true });
    const { l, opened, terminal } = setup();
    await l.test(mission({ kind: 'macos-app', open: 'Hangman.app' }), root);
    expect(opened[0]).toBe(join(root, 'Hangman.app'));
    await l.test(mission({ kind: 'cli', start: 'python3 hangman.py' }), root);
    expect(terminal).toHaveBeenCalledWith(expect.stringMatching(/^cd '.*' && python3 hangman\.py$/));
  });
});
