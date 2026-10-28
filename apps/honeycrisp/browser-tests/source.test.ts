/**
 * Honeycrisp Source Editor Browser Tests
 *
 * The built site in Chromium and WebKit, two persistent profiles as two
 * people (alice and bob), syncing through the local repository server. A
 * note whose frontmatter does not parse arrives from the server, as an agent
 * can write one, and alice repairs it in the source editor by typing.
 *
 * Key behaviors:
 * - A note that does not parse opens straight into its source, which names the line that breaks
 * - Each step of the repair saves; a schema mismatch shows its issue and clears when fixed
 * - Text that would break the frontmatter again waits in the editor until it parses
 * - The repaired note becomes a normal note on the other profile
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

const statusOf = (page: Page) => page.getByTestId('source-status');
const statusSays = (page: Page, text: string) => async () => ((await statusOf(page).textContent()) ?? '').includes(text);
const serverHas = (path: string, text: string) => async () => (await world.read(path))?.includes(text) ?? false;

const noteText = (title: string) =>
	`---\nfolderId: null\ntitle: ${title}\npinned: false\ncreatedAt: "2026-10-28T12:00:00.000Z"\ndeletedAt: null\n---\nThe body.\n`;

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a note broken on the server is repaired in its source and becomes a normal note on another profile',
			async () => {
				const stem = `broken-${engine}`;
				const path = `notes/${stem}.md`;
				await world.createFile(path, noteText('[Broken'));
				const alice = await openProfile(browser, world.url('alice'));
				const bob = await openProfile(browser, world.url('bob'));
				try {
					const repair = alice.page.locator(`[data-note="${path}"]`);
					await repair.waitFor();
					await repair.click();
					// It opens straight into its source, which names the line where YAML found the break.
					const source = alice.page.getByRole('textbox', { name: `Source of ${stem}.md` });
					await source.waitFor();
					await until(statusSays(alice.page, "Frontmatter doesn't parse (line 4)"), 'the parse status');

					// Closing the bracket makes it parse, but a list is not a title.
					await source.locator('.cm-line', { hasText: 'title: [Broken' }).click();
					await alice.page.keyboard.press('End');
					await alice.page.keyboard.type(']');
					await until(statusSays(alice.page, '/title must be string'), 'the schema issue');
					await until(serverHas(path, 'title: [Broken]\n'), 'the repair step on the server');

					// Retyping the line passes through text that does not parse; it waits in the editor.
					await alice.page.keyboard.press('Home');
					await alice.page.keyboard.press('Shift+End');
					await alice.page.keyboard.type('title');
					await until(statusSays(alice.page, 'Not saved until it parses again'), 'the held-back text');
					expect(await world.read(path)).toContain('title: [Broken]\n');
					await alice.page.keyboard.type(': Fixed');
					await until(statusSays(alice.page, 'Matches the schema'), 'the schema to match');
					await until(serverHas(path, 'title: Fixed\n'), 'the repaired note on the server');

					// On bob's profile it is a normal note now, under its title.
					const notes = bob.page.getByRole('region', { name: 'Notes' });
					await until(async () => (await notes.locator(`[data-note="${path}"]`, { hasText: 'Fixed' }).count()) > 0, 'the note for bob');
					await expect(notes.textContent()).resolves.not.toContain(path);
					expect(await world.read(path)).toBe(noteText('Fixed'));
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
