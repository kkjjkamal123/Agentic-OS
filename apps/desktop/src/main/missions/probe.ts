import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1_500;

const EMPTY = `(() => {
  const b = document.body;
  return !b || (!b.innerText.trim() && !document.querySelector('canvas,svg,img,video,input,button,textarea,select'));
})()`;

const REFS = `[...document.querySelectorAll('script[src],link[rel=stylesheet][href],img[src]')].map((e) => e.src || e.href)`;

// Chromium logs nothing for a missing local file, so check every script, stylesheet and image the page names.
async function missing(refs: string[], page: string): Promise<string[]> {
  const origin = page.startsWith('file:') ? 'file:' : new URL(page).origin;
  const out: string[] = [];
  for (const u of new Set(refs)) {
    if (origin === 'file:' && u.startsWith('file:')) {
      if (!existsSync(fileURLToPath(u))) out.push(`Missing file: ${basename(fileURLToPath(u))}`);
    } else if (origin !== 'file:' && u.startsWith(origin)) {
      const ok = await fetch(u, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
      if (!ok) out.push(`Missing file: ${new URL(u).pathname}`);
    }
  }
  return out;
}

/**
 * Opens the built page off-screen once and reports what a user would hit first: script errors,
 * missing files, a crash or a blank page. Closed straight after, so it costs a second of CPU.
 */
export async function probePage(url: string): Promise<string[]> {
  const errors: string[] = [];
  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    webPreferences: { partition: 'probe', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    if (e.level === 'error') errors.push(`${e.message}${e.sourceId ? ` (${basename(e.sourceId)}:${e.lineNumber})` : ''}`);
  });
  wc.on('did-fail-load', (_e, _code, desc, _u, isMain) => isMain && errors.push(`The page failed to load: ${desc}`));
  wc.on('render-process-gone', (_e, d) => errors.push(`The page crashed: ${d.reason}`));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  try {
    await Promise.race([wc.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error(`The page took over ${LOAD_TIMEOUT_MS / 1000}s to load.`)), LOAD_TIMEOUT_MS))]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (!win.isDestroyed()) {
      errors.push(...(await missing(await wc.executeJavaScript(REFS), url)));
      if (await wc.executeJavaScript(EMPTY)) errors.push('The page shows nothing: no text and no visible elements.');
    }
  } catch (e) {
    errors.push((e as Error).message);
  } finally {
    // destroy() kills the renderer mid-flight and breaks the next probe's reuse of the process; close cleanly.
    if (!win.isDestroyed()) {
      await Promise.race([new Promise<void>((r) => (win.once('closed', () => r()), win.close())), new Promise((r) => setTimeout(r, 2_000))]);
      if (!win.isDestroyed()) win.destroy();
    }
  }
  return [...new Set(errors)].slice(0, 20);
}
