/**
 * Honeycrisp Browser Smoke Test
 *
 * Builds the shell as it ships and drives Honeycrisp in it, in Chromium and WebKit, with a
 * persistent profile: the page opens its repository through the browser
 * host, so notes live in SQLite in OPFS, owned by the tab's worker, and sync
 * through a local server.
 *
 * Key behaviors:
 * - A new note's title and body survive a reload and reach the server
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { opened, startWorld, TIMEOUT, type World } from '../support.js';

let world: World;
beforeAll(async () => {
	world = await startWorld(['ada']);
}, 180_000);
afterAll(() => world?.stop());

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			"a new note's title and body survive a reload and reach the server",
			async () => {
				const { page, cleanup } = await world.open(
					browser,
					'ada',
					'honeycrisp',
				);
				try {
					await page.getByRole('button', { name: 'New note' }).click();
					const title = page.getByLabel('Title', { exact: true });
					await title.fill(`Groceries ${engine}`);
					await page
						.getByRole('region', { name: 'Note' })
						.locator('.cm-content')
						.click();
					await page.keyboard.type('Milk');
					await page.keyboard.press('Enter');
					// The list shows the editor's typing, stored or not; a reload keeps what the page has not stored yet (`leaving` in the browser host).
					await page
						.getByRole('region', { name: 'Notes' })
						.locator('[data-note]', { hasText: `Groceries ${engine}` })
						.filter({ hasText: 'Milk' })
						.waitFor();
					await page.reload();
					await opened(page, 'honeycrisp');
					await page
						.getByRole('region', { name: 'Notes' })
						.getByText(`Groceries ${engine}`)
						.click();
					await expect(title.inputValue()).resolves.toBe(`Groceries ${engine}`);
					const path = await page
						.getByRole('region', { name: 'Notes' })
						.locator('[data-note]', { hasText: `Groceries ${engine}` })
						.getAttribute('data-note');
					for (
						let tries = 0;
						tries < 100 && !(await world.read(path ?? ''))?.includes('Milk');
						tries++
					)
						await Bun.sleep(50);
					expect(await world.read(path ?? '')).toContain(
						`title: Groceries ${engine}`,
					);
					expect(await world.read(path ?? '')).toContain('Milk\n');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
