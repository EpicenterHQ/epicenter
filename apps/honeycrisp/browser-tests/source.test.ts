/**
 * Honeycrisp Source Editor Browser Tests
 *
 * The built site in Chromium and WebKit, two persistent profiles as two
 * people (alice and bob), syncing through the repository's development
 * server. Every note on the server parses (the server admits no other), so
 * a note whose frontmatter breaks is broken on a device: alice breaks one
 * in its source by typing, and repairs it.
 *
 * Key behaviors:
 * - The source names the line that breaks; text that does not parse is saved on this device and held, not sent
 * - Each step of the repair that parses is sent; a schema mismatch shows its issue and clears when fixed
 * - A note that does not read as one is listed for repair on the other profile, and becomes a normal note again
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Page, webkit } from 'playwright';
import { openProfile, startWorld, TIMEOUT, type World } from './support.js';

let world: World;
beforeAll(async () => {
	world = await startWorld(['alice', 'bob']);
}, 180_000);
afterAll(() => world?.stop());

/** Poll until `check` holds. */
async function until(check: () => Promise<boolean>, what: string, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

const statusOf = (page: Page) => page.getByTestId('editor-status');
const statusSays = (page: Page, text: string) => async () => ((await statusOf(page).textContent()) ?? '').includes(text);
const serverHas = (path: string, text: string) => async () => (await world.read(path))?.includes(text) ?? false;

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			"a note broken in its source is held on the device, and its repair reaches another profile",
			async () => {
				const alice = await openProfile(browser, world.url('alice'));
				const bob = await openProfile(browser, world.url('bob'));
				try {
					const title = `Plan ${engine}`;
					await alice.page.getByRole('button', { name: 'New note' }).click();
					await alice.page.getByLabel('Title', { exact: true }).fill(title);
					const row = alice.page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: title });
					await row.waitFor();
					const path = (await row.getAttribute('data-note')) ?? '';
					const stem = path.slice('notes/'.length, -'.md'.length);
					await until(serverHas(path, `title: ${title}\n`), 'the note on the server');
					const bobsNotes = bob.page.getByRole('region', { name: 'Notes' });
					await until(async () => (await bobsNotes.locator(`[data-note="${path}"]`, { hasText: title }).count()) > 0, 'the note for bob');

					await alice.page.getByRole('button', { name: 'Edit source' }).click();
					const source = alice.page.getByRole('textbox', { name: `Source of ${stem}.md` });
					await source.waitFor();
					await until(statusSays(alice.page, 'Matches the schema'), 'the schema status');

					// Retyping the title line passes through text that does not parse: saved here and held, not sent.
					await source.locator('.cm-line', { hasText: `title: ${title}` }).click();
					await alice.page.keyboard.press('End');
					await alice.page.keyboard.press('Shift+Home');
					await alice.page.keyboard.type('title: [Broken');
					await until(statusSays(alice.page, "Frontmatter doesn't parse"), 'the parse status');
					await until(statusSays(alice.page, 'not sent'), 'the held text');
					// Steps that parsed on the way were sent; the broken text never is.
					await Bun.sleep(500);
					expect(await world.read(path)).not.toContain('[Broken');

					// Closing the bracket makes it parse, and it is sent, but a list is not a title.
					await alice.page.keyboard.type(']');
					await until(statusSays(alice.page, '/title must be string'), 'the schema issue');
					await until(serverHas(path, 'title: [Broken]\n'), 'the parsing step on the server');
					// On bob's profile it does not read as a note, so it is listed for repair.
					await until(async () => ((await bobsNotes.textContent()) ?? '').includes(path), 'the repair listing for bob');

					await alice.page.keyboard.press('Shift+Home');
					await alice.page.keyboard.type('title: Fixed');
					await until(statusSays(alice.page, 'Matches the schema'), 'the schema to match');
					await until(serverHas(path, 'title: Fixed\n'), 'the repaired note on the server');

					// On bob's profile it is a normal note again, under its title.
					await until(async () => (await bobsNotes.locator(`[data-note="${path}"]`, { hasText: 'Fixed' }).count()) > 0, 'the note for bob');
					await expect(bobsNotes.textContent()).resolves.not.toContain(path);
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
