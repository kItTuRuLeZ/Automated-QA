import { expect, test } from '@playwright/test';

/** The app's API refuses requests without this header, which a page can only send from the app itself. */
const API = { 'x-qa-request': '1' };

test('a reviewer writes a quiz answer key in plain lines, and it is stored exactly, as a provisional draft', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { headers: API, data: { name: 'UI quiz project' } })).json();
  await page.goto(`/#/projects/${project.id}/rules`);
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Name').fill('Capital city question');
  await page.getByLabel('This screen is a quiz question, and I have its answer key').check();
  await page.getByLabel('Answer key (one case per line)').fill('Right | correct | Paris | Well done \\| next | Score: 100\nWrong | incorrect | London; Rome | Not quite.');
  await page.getByLabel('Retry button (optional)').fill('Try again');
  await page.getByRole('button', { name: 'Save rule' }).click();

  const row = page.getByRole('listitem').filter({ hasText: 'Capital city question' });
  await expect(row).toContainText('version 1');
  await expect(row).toContainText('provisional');

  const [rule] = await (await request.get(`/api/projects/${project.id}/behavior-rules`)).json();
  expect(rule.assessment.cases).toEqual([
    { name: 'Right', correct: true, answers: ['Paris'], feedback: 'Well done | next', score: 'Score: 100' },
    { name: 'Wrong', correct: false, answers: ['London', 'Rome'], feedback: 'Not quite.' },
  ]);
  expect(rule.assessment.retry).toEqual({ control: 'Try again' });
  // With no click list typed, the rule's steps are the correct answer, then Submit.
  expect(rule.requiredItems).toEqual([{ label: 'Paris' }, { label: 'Submit' }]);
});

test('an empty answer key is refused with a message, not saved', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { headers: API, data: { name: 'UI empty key' } })).json();
  await page.goto(`/#/projects/${project.id}/rules`);
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Name').fill('No key yet');
  await page.getByLabel('This screen is a quiz question, and I have its answer key').check();
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('Add at least one line to the answer key');
  expect(await (await request.get(`/api/projects/${project.id}/behavior-rules`)).json()).toEqual([]);
});

test('the browser check on Help reflects a real start of the scanning browser', async ({ page, request }) => {
  const caps = await (await request.get('/api/capabilities')).json();
  const browser = caps.find((c: { id: string }) => c.id === 'browser');
  expect(['available', 'blocked']).toContain(browser.status);
  await page.goto('/#/help');
  await page.getByText(/Technical details: what this installation can and cannot do/).click();
  // The row in the status table: the same words can also appear in a warning above it when the browser is blocked.
  const row = page.getByRole('row', { name: /Scanning browser \(Chromium\)/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(browser.detail.slice(0, 40));
});
