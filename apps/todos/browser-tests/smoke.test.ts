/**
 * Todos Browser Smoke Test
 *
 * Builds Todos as it ships (`vite build`), serves the static site from
 * 127.0.0.1, and drives it in Chromium and WebKit with persistent profiles:
 * the person makes a repository kept on this device in the repository
 * chooser, which the page opens through the browser host, so todos live in
 * SQLite in OPFS, owned by the tab's worker. Nothing syncs.
 *
 * Key behaviors:
 * - Create, edit, complete, and delete a todo
 * - Each survives a reload
 * - A todo's source shows a schema mismatch as it is typed, and it clears when fixed
 * - Its notes and its source are two views of one editor
 * - The chooser lists this browser's repositories, opens the last one again after a reload, switches, and removes one
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { buildTodos, createRepository, notesOf, opened, openProfile, serveSite } from './support.js';

let server: ReturnType<typeof serveSite>;

beforeAll(async () => {
	await buildTodos();
	server = serveSite();
}, 120_000);
afterAll(() => server?.stop(true));

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'create, edit, complete, and delete a todo, each surviving a reload',
			async () => {
				const { page, cleanup } = await openProfile(browser, server.url.href);
				try {
					await expect(page.getByText('No todos yet').isVisible()).resolves.toBe(true);

					await page.getByLabel('New todo title').fill('Buy milk');
					await page.getByRole('button', { name: 'Add', exact: true }).click();
					const title = page.getByLabel('Title', { exact: true });
					await expect(title.inputValue()).resolves.toBe('Buy milk');

					await title.fill('Buy oat milk');
					await notesOf(page).click();
					await page.keyboard.type('Two litres');
					// A reload before the tab's worker stored the last keystrokes can lose them.
					await page.getByTestId('editor-status').getByText('Saved', { exact: true }).waitFor();
					await page.getByRole('checkbox', { name: 'Done' }).click();
					await page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).waitFor();

					await page.reload();
					await opened(page);
					await expect(title.inputValue()).resolves.toBe('Buy oat milk');
					await notesOf(page).waitFor();
					await expect(notesOf(page).innerText()).resolves.toBe('Two litres');
					await expect(page.getByRole('checkbox', { name: 'Done' }).getAttribute('aria-checked')).resolves.toBe('true');
					await expect(page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).getAttribute('aria-checked')).resolves.toBe('true');

					await page.getByRole('button', { name: 'Delete', exact: true }).click();
					await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
					await page.getByText('No todos yet').waitFor();

					await page.reload();
					await opened(page);
					await page.getByText('No todos yet').waitFor();
					await expect(page.getByRole('checkbox', { name: 'Reopen Buy oat milk' }).count()).resolves.toBe(0);
				} finally {
					await cleanup();
				}
			},
			90_000,
		);

		test(
			"a todo's source shows a schema mismatch as it is typed, and the issue clears when fixed",
			async () => {
				const { page, cleanup } = await openProfile(browser, server.url.href);
				try {
					await page.getByLabel('New todo title').fill('Water plants');
					await page.getByRole('button', { name: 'Add', exact: true }).click();
					await page.getByRole('button', { name: 'Edit source' }).click();

					const source = page.getByRole('textbox', { name: /^Source of todos\// });
					const status = page.getByTestId('editor-status');
					await status.getByText('Matches the schema').waitFor();
					await source.locator('.cm-line', { hasText: 'done: false' }).click();
					await page.keyboard.press('End');
					for (let n = 0; n < 'false'.length; n++) await page.keyboard.press('Backspace');
					await page.keyboard.type('maybe');
					await status.getByText('/done must be boolean').waitFor();
					// The todo no longer reads as one, so the list asks for its repair.
					await page.getByRole('region', { name: 'Needs repair' }).waitFor();

					for (let n = 0; n < 'maybe'.length; n++) await page.keyboard.press('Backspace');
					await page.keyboard.type('true');
					await status.getByText('Matches the schema').waitFor();
					await page.getByRole('button', { name: 'Open as todo' }).click();
					await expect(page.getByRole('checkbox', { name: 'Done' }).getAttribute('aria-checked')).resolves.toBe('true');
					await expect(page.getByRole('region', { name: 'Needs repair' }).count()).resolves.toBe(0);
				} finally {
					await cleanup();
				}
			},
			90_000,
		);

		test(
			"the chooser lists this browser's repositories, opens the last one after a reload, switches, and removes one",
			async () => {
				// Unique names: Playwright's WebKit shares this origin's storage across profiles, so other tests' repositories are listed too.
				const home = `Home ${crypto.randomUUID().slice(0, 8)}`;
				const work = `Work ${crypto.randomUUID().slice(0, 8)}`;
				const { page, cleanup } = await openProfile(browser, server.url.href, { name: home });
				try {
					await page.getByLabel('New todo title').fill('Water plants');
					await page.getByRole('button', { name: 'Add', exact: true }).click();
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();

					// A reload opens the last repository again.
					await page.reload();
					await opened(page);
					await page.getByRole('checkbox', { name: 'Complete Water plants' }).waitFor();

					// Another repository, made from the chooser, has its own todos.
					await page.getByRole('button', { name: /switch repository/ }).click();
					const repositories = page.getByRole('list', { name: 'Repositories in this browser' });
					const row = (name: string) => repositories.getByRole('listitem').filter({ hasText: name });
					await row(home).waitFor();
					await createRepository(page, { name: work });
					await page.getByText('No todos yet').waitFor();

					// Removing one asks first, and says what is only here.
					await page.getByRole('button', { name: /switch repository/ }).click();
					await row(home).getByRole('button', { name: `Remove ${home}` }).click();
					await row(home).getByRole('button', { name: 'Remove', exact: true }).click();
					await row(home).getByRole('alert').filter({ hasText: 'only in this browser' }).waitFor();
					await row(home).getByRole('button', { name: 'Remove anyway' }).click();
					await row(home).waitFor({ state: 'detached' });
					await page.reload();
					await row(work).waitFor();
					await expect(row(home).count()).resolves.toBe(0);

					await row(work).getByRole('button', { name: 'Open' }).click();
					await page.getByText('No todos yet').waitFor();
				} finally {
					await cleanup();
				}
			},
			90_000,
		);
	});
}
