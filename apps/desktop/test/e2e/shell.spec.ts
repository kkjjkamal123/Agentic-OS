import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch as boot, newProfile, shot as snap } from './app';

let app: ElectronApplication;
let page: Page;

async function launch(userData: string) {
  ({ app, page } = await boot(userData));
}

const shot = (name: string) => snap(page, name);

test.describe('desktop shell', () => {
  const userData = newProfile();

  test.beforeAll(async () => launch(userData));
  test.afterAll(async () => app?.close());

  test('boots with Mission Control open and a full dock', async () => {
    await expect(page.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
    for (const name of ['Mission Control', 'Agents', 'Files', 'Terminal', 'Timeline', 'Settings']) {
      await expect(page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name })).toBeVisible();
    }
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
    await shot('01-desktop');
  });

  test('windows open, focus, minimize, maximize and close', async () => {
    const dock = page.getByRole('navigation', { name: 'Dock' });
    await dock.getByRole('button', { name: 'Agents' }).click();
    const agents = page.getByRole('dialog', { name: 'Agents' });
    await expect(agents).toBeVisible();
    await agents.getByRole('button', { name: 'Maximize Agents' }).click();
    await expect(agents.getByRole('button', { name: 'Restore Agents' })).toBeVisible();
    await agents.getByRole('button', { name: 'Minimize Agents' }).click();
    await expect(agents).toBeHidden();
    await dock.getByRole('button', { name: 'Agents' }).click();
    await expect(agents).toBeVisible();
    await agents.getByRole('button', { name: 'Close Agents' }).click();
    await expect(agents).toHaveCount(0);
  });

  test('dragging the title bar moves a window', async () => {
    const win = page.getByRole('dialog', { name: 'Mission Control' });
    const before = (await win.boundingBox())!;
    const bar = win.locator('header');
    const b = (await bar.boundingBox())!;
    await page.mouse.move(b.x + 60, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 160, b.y + b.height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    const after = (await win.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBe(100);
    expect(Math.round(after.y - before.y)).toBe(50);
  });

  test('settings persist through the main process and SQLite', async () => {
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await shot('02-settings-general');

    await settings.getByRole('radio', { name: 'Dark' }).click();
    await expect(settings.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await settings.getByRole('button', { name: 'Agents & safety' }).click();
    await settings.getByRole('radio', { name: /Saver/ }).click();
    const budget = settings.getByLabel('Token budget per mission in thousands');
    await budget.fill('1500');
    await budget.press('Enter');
    await expect.poll(() => page.evaluate(() => window.aos.settings.get().then((s) => [s.missionTokenBudget, s.quality]))).toEqual([1500, 'saver']);

    await budget.fill('-3');
    await budget.press('Enter');
    await expect(settings.getByRole('alert')).toHaveText('Token budget per mission must be 0 or more');
    await expect(budget).toHaveValue('1500');
    await shot('03-settings-agents');
  });

  test('API keys are stored but never readable from the renderer', async () => {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Accounts & keys' }).click();
    await expect(settings.getByRole('alert')).toHaveCount(0); // stale error cleared on tab switch
    await expect(settings.getByRole('heading', { name: 'Subscriptions' })).toBeVisible();
    await expect(settings.locator('[data-account]')).toHaveCount(4);
    await expect(settings.getByText('NVIDIA NIM', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Add key' }).first().click();
    await settings.getByLabel('Anthropic API key').fill('sk-ant-test-key-abcd9876');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(settings.getByText('Stored ···· 9876')).toBeVisible();
    const everything = await page.evaluate(async () => JSON.stringify(await window.aos.secrets.list()));
    expect(everything).not.toContain('sk-ant-test-key');
    await shot('04-settings-keys');
  });

  test('state survives a restart', async () => {
    await app.close();
    await launch(userData);
    const s = await page.evaluate(() => window.aos.settings.get());
    expect(s).toMatchObject({ theme: 'dark', missionTokenBudget: 1500, quality: 'saver' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const keys = await page.evaluate(() => window.aos.secrets.list());
    expect(keys.find((k) => k.id === 'anthropic')).toMatchObject({ stored: true, hint: '9876' });
    // Window layout came back too (Settings was open when we quit).
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await shot('05-after-restart-dark');
  });
});
