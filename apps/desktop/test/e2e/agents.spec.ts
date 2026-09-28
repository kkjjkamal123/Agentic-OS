import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, newProfile, shot } from './app';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => ({ app, page } = await launch(newProfile())));
test.afterAll(async () => app?.close());

test('agents app routes, streams, and cancels', async () => {
  await page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Agents' }).click();
  const w = page.getByRole('dialog', { name: 'Agents' });
  await expect(w.getByTestId('route-preview')).toContainText('omp · fake-fast');
  await w.getByLabel('Role').selectOption('code');
  await expect(w.getByTestId('route-preview')).toContainText('medium effort');

  await w.getByLabel('Model', { exact: true }).selectOption('omp|fake-smart');
  await w.getByRole('button', { name: 'Start' }).click();
  await w.getByLabel('Message').fill('hello OS');
  await w.getByLabel('Message').press('Enter');
  await expect(w.getByText('[fake-smart/medium] Echo: hello OS')).toBeVisible();
  await expect(w.getByText('10 in · 4 out · 4 cached')).toBeVisible();
  await w.getByText('Thinking', { exact: true }).click();
  await expect(w.getByText('thinking', { exact: true })).toBeVisible();

  await w.getByLabel('Message').fill('please edit this');
  await w.getByLabel('Message').press('Enter');
  await expect(w.getByText('Edit file')).toBeVisible();
  await expect(w.getByText('completed')).toBeVisible();

  await w.getByLabel('Message').fill('slow reply with a lot of words to stream out');
  await w.getByLabel('Message').press('Enter');
  await w.getByRole('button', { name: 'Stop reply' }).click();
  await expect(w.getByText('· stopped')).toBeVisible();
  await expect(w.getByRole('button', { name: 'Send' })).toBeVisible();
  await shot(page, '06-agents');

  await expect(w.getByRole('list', { name: 'Sessions' }).getByRole('listitem')).toHaveCount(1);
  await w.getByRole('button', { name: 'End session' }).click({ force: true });
  await expect(w.getByText('Talk to any agent')).toBeVisible();
});
