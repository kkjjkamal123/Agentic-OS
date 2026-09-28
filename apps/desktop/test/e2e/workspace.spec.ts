import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, newProfile, shot } from './app';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => ({ app, page } = await launch(newProfile())));
test.afterAll(async () => app?.close());

const dock = (name: string) => page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name });

test('workspace, gated agent commands, terminal feed, approvals, files', async () => {
  await dock('Files').click();
  const files = page.getByRole('dialog', { name: 'Files' });
  await files.getByLabel('New workspace name').fill('E2E Todo App');
  await files.getByRole('button', { name: 'Create workspace' }).click();
  await expect(files.getByLabel('Workspace', { exact: true })).toHaveValue(/.+/);
  await expect(files.getByRole('button', { name: '.gitignore' })).toBeVisible();

  await dock('Agents').click();
  const agents = page.getByRole('dialog', { name: 'Agents' });
  await agents.getByLabel('Workspace', { exact: true }).selectOption({ label: 'E2E Todo App' });
  await agents.getByLabel('Quality').selectOption('max');
  await expect(agents.getByTestId('route-preview')).toContainText('high effort');
  await agents.getByRole('button', { name: 'Start' }).click();
  await expect(agents.getByText('It works inside the chosen workspace')).toBeVisible();

  await agents.getByLabel('Message').fill('please build it');
  await agents.getByLabel('Message').press('Enter');
  await expect(agents.getByText('Echo: please build it')).toBeVisible();

  await agents.getByLabel('Message').fill('now push');
  await agents.getByLabel('Message').press('Enter');
  const approval = page.getByRole('alertdialog', { name: 'Approval needed' });
  await expect(approval).toContainText('git push origin main');
  await expect(approval).toContainText('pushes to a remote');
  await shot(page, '07-approval');
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect(approval).toBeHidden();
  await expect(agents.getByText('Echo: now push')).toBeVisible();

  await agents.getByLabel('Message').fill('push again');
  await agents.getByLabel('Message').press('Enter');
  await approval.getByRole('button', { name: 'Deny' }).click();
  await expect(agents.getByText('Echo: push again')).toBeVisible();

  await dock('Terminal').click();
  const term = page.getByRole('dialog', { name: 'Terminal' });
  await term.getByText('$ npm run build').click();
  await expect(term.getByText('✓ built in 212ms')).toBeVisible();
  await expect(term.locator('summary', { hasText: 'git push origin main' })).toHaveCount(2);
  await expect(term.getByText('exit 1')).toBeVisible();
  await shot(page, '08-terminal');

  await dock('Files').click();
  await files.getByRole('button', { name: 'Changes' }).click();
  await expect(files.getByText('No changes since the last commit.')).toBeVisible();
  await files.getByRole('button', { name: '.gitignore' }).click();
  await expect(files.getByText('node_modules/')).toBeVisible();
  await shot(page, '09-files');
});
