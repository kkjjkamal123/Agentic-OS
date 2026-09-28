import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const APP_DIR = join(import.meta.dirname, '..', '..');
export const FAKE_AGENT = join(APP_DIR, 'test/fixtures/fake-acp-agent.mjs');
export const newProfile = () => mkdtempSync(join(tmpdir(), 'aos-e2e-'));

export async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(APP_DIR, 'out/main/index.js')],
    cwd: APP_DIR,
    // Isolated profile, dev key store, fake agent: no Keychain prompts, no real CLIs, no tokens spent.
    env: { ...process.env, AOS_USER_DATA: userData, AOS_INSECURE_SECRETS: '1', AOS_FAKE_AGENT: FAKE_AGENT, ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('nav[aria-label="Dock"]');
  return { app, page };
}

export const shot = async (page: Page, name: string) =>
  process.env.AOS_SHOTS_DIR && page.screenshot({ path: join(process.env.AOS_SHOTS_DIR, `${name}.png`) });
