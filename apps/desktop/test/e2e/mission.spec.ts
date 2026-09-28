import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, newProfile, shot } from './app';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => ({ app, page } = await launch(newProfile())));
test.afterAll(async () => app?.close());

test('a mission plans, builds in parallel, reviews, checks and ships', async () => {
  const mc = page.getByRole('dialog', { name: 'Mission Control' });
  await mc.getByLabel('Mission goal').fill('Make two text files');
  await mc.getByRole('button', { name: 'Launch mission' }).click();
  await expect(mc.locator('[data-task]')).toHaveCount(2, { timeout: 30_000 });
  await expect(mc.getByText('Tasks · 2/2 merged')).toBeVisible({ timeout: 30_000 });
  await expect(mc.getByRole('heading', { name: 'Shipped' })).toBeVisible({ timeout: 30_000 });
  await expect(mc.getByRole('list', { name: 'Missions' }).getByText('done')).toBeVisible();
  await expect(mc.getByText('passed')).toHaveCount(2);
  await expect(page.getByText('Idle')).toBeVisible();
  await expect(mc.getByText('starts', { exact: true })).toBeVisible();
  await expect(mc.getByText('A tiny page that shows two files.')).toBeVisible();
  await shot(page, '10-mission');

  const preview = app.waitForEvent('window');
  await mc.getByRole('button', { name: 'Test', exact: true }).click();
  const win = await preview;
  await expect(win.getByRole('heading', { name: 'Fake app is live' })).toBeVisible();
  await expect(mc.getByRole('button', { name: 'Stop' })).toBeVisible();
  await mc.getByRole('button', { name: 'Stop' }).click();
  await expect(mc.getByRole('button', { name: 'Test', exact: true })).toBeVisible();

  await mc.getByLabel('Change request').fill('Also add t3');
  await mc.getByRole('button', { name: 'Send' }).click();
  await expect(mc.getByText('Change to: A tiny page that shows two files.')).toBeVisible();
  await expect(mc.getByRole('list', { name: 'Missions' }).getByText('done')).toHaveCount(2, { timeout: 30_000 });
  await shot(page, '10b-change');
  page.once('dialog', (d) => void d.accept());
  await mc.getByRole('button', { name: 'Undo' }).click();
  await expect(mc.getByText('undone', { exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Timeline' }).click();
  const tl = page.getByRole('dialog', { name: 'Timeline' });
  await expect(tl.getByText('Shipped.')).toBeVisible();
  await expect(tl.getByText(/planned 1 task/)).toBeVisible();
});
