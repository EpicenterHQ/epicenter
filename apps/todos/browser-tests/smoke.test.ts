/**
 * Todos Browser Smoke Test
 *
 * Builds Todos as it ships (`vite build`), serves the static site from
 * 127.0.0.1, and drives it in Chromium and WebKit with persistent profiles:
 * the page opens the repository through the browser host, so todos live in
 * SQLite in OPFS, owned by the tab's worker. No server is set, so nothing
 * syncs.
 *
 * Key behaviors:
 * - Create, edit, complete, and delete a todo
 * - Each survives a reload
 * - A todo's source shows a schema mismatch as it is typed, and it clears when fixed
 * - Its notes and its source are two views of one editor
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { buildTodos, notesOf, opened, serveSite } from './support.js';

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
				const dir = await mkdtemp(join(tmpdir(), 'todos-smoke-'));
				// Wide enough for the list and the open todo side by side.
				const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 800 } });
				try {
					const page = context.pages()[0] ?? (await context.newPage());
					page.on('pageerror', (error) => console.error('page error:', error));
					await page.goto(server.url.href);
					await opened(page);
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
					await context.close();
					await rm(dir, { recursive: true, force: true });
				}
			},
			90_000,
		);

		test(
			"a todo's source shows a schema mismatch as it is typed, and the issue clears when fixed",
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'todos-smoke-'));
				const context = await browser.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 800 } });
				try {
					const page = context.pages()[0] ?? (await context.newPage());
					page.on('pageerror', (error) => console.error('page error:', error));
					await page.goto(server.url.href);
					await opened(page);
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
					await context.close();
					await rm(dir, { recursive: true, force: true });
				}
			},
			90_000,
		);
	});
}
