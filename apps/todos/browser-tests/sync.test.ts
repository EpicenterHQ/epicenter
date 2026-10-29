/**
 * Todos Sync Browser Tests
 *
 * The built site in Chromium and WebKit, two persistent profiles as two
 * people, each on a site of its own, syncing one repository through the
 * repository's development server on Bun.
 *
 * Key behaviors:
 * - A todo added on one profile reaches the other; a toggle there comes back
 * - Notes typed on one profile reach the other and the server, and survive a reload
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { buildTodos, notesOf, opened, openProfile, serveSite, startServer, TIMEOUT, until } from './support.js';

const sites = { alice: serveSite(), bob: serveSite() };
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
	server = await startServer('todos', [sites.alice.url.origin, sites.bob.url.origin]);
	await buildTodos({ VITE_TODOS_SERVER: server.url });
}, 180_000);
afterAll(async () => {
	sites.alice.stop(true);
	sites.bob.stop(true);
	await server?.stop();
});

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a todo, a toggle and its notes sync between two profiles, and survive a reload',
			async () => {
				const alice = await openProfile(browser, sites.alice.url.href);
				const bob = await openProfile(browser, sites.bob.url.href);
				try {
					const title = `Buy milk ${engine}`;
					await alice.page.getByLabel('New todo title').fill(title);
					await alice.page.getByRole('button', { name: 'Add', exact: true }).click();
					await expect(alice.page.getByLabel('Title', { exact: true }).inputValue()).resolves.toBe(title);

					// Bob sees it, and completes it.
					const bobRow = bob.page.getByRole('checkbox', { name: `Complete ${title}` });
					await bobRow.waitFor({ timeout: 20_000 });
					await bobRow.click();
					await alice.page.getByRole('checkbox', { name: `Reopen ${title}` }).waitFor({ timeout: 20_000 });
					await expect(alice.page.getByRole('checkbox', { name: 'Done' }).getAttribute('aria-checked')).resolves.toBe('true');

					// Alice's notes reach Bob's open todo and the server.
					await bob.page.getByRole('button', { name: title }).click();
					await notesOf(alice.page).click();
					await alice.page.keyboard.type('Two litres');
					await until(async () => (await notesOf(bob.page).innerText()) === 'Two litres', "alice's notes for bob");
					const path = await alice.page.getByTestId('file-path').innerText();
					await until(async () => server.read(path)?.endsWith('---\nTwo litres') ?? false, 'the notes on the server');
					expect(server.read(path)).toBe(`---\ntitle: ${title}\ndone: true\n---\nTwo litres`);

					// A reload opens the same todo, as both left it.
					await bob.page.reload();
					await opened(bob.page);
					await bob.page.getByRole('button', { name: title }).click();
					await until(async () => (await notesOf(bob.page).innerText()) === 'Two litres', 'the notes after a reload');
					await expect(bob.page.getByRole('checkbox', { name: 'Done' }).getAttribute('aria-checked')).resolves.toBe('true');
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
