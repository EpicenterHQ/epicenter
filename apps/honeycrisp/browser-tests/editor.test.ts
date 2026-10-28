/**
 * Honeycrisp Editor Browser Tests
 *
 * The built site in Chromium and WebKit, two persistent profiles as two
 * people (alice and bob), syncing through the local repository server. Each
 * types into the CodeMirror editor with the keyboard, as a person does.
 *
 * Key behaviors:
 * - Headings, bold and a task checkbox render in place, and the checkbox toggles in the file
 * - Two people typing in different paragraphs see each other's text while each cursor stays put
 * - A change from the other person is not undone by Undo
 * - A true overlap shows a conflict card, and resolving it removes the markers from the file
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type BrowserType, chromium, type Page, webkit } from 'playwright';
import { openProfile, startWorld, TIMEOUT, type World } from './support.js';

let world: World;
beforeAll(async () => {
	world = await startWorld(['alice', 'bob']);
}, 180_000);
afterAll(() => world?.stop());

const editorOf = (page: Page) => page.getByRole('region', { name: 'Note' }).locator('.cm-content');
/** The editor's text, line by line, as it reads with the syntax of every line shown or not. */
const shown = (page: Page) => editorOf(page).evaluate((content) => [...content.querySelectorAll('.cm-line')].map((line) => line.textContent ?? ''));

/** Poll until `check` holds. */
async function until(check: () => Promise<boolean>, what: string, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** Create a note titled `title` with `body` typed in one input, and answer its path. */
async function createNote(page: Page, title: string, body: string) {
	await page.getByRole('button', { name: 'New note' }).click();
	await page.getByLabel('Title', { exact: true }).fill(title);
	await editorOf(page).click();
	await page.keyboard.insertText(body);
	const row = page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: title });
	await row.waitFor();
	return (await row.getAttribute('data-note')) ?? '';
}

/** Open the note titled `title` once it has arrived. */
async function openNote(page: Page, title: string) {
	await page.getByRole('region', { name: 'Notes' }).locator('[data-note]', { hasText: title }).click();
	await editorOf(page).waitFor();
}

/** Put the cursor at the end of the line reading `text`. */
async function endOf(page: Page, text: string) {
	await editorOf(page).locator('.cm-line', { hasText: text }).click();
	await page.keyboard.press('End');
}

/** Poll until the editor on `page` shows `lines`, naming what it shows instead. */
async function untilShown(page: Page, lines: string[], what: string) {
	let last: string[] = [];
	try {
		await until(async () => (last = await shown(page)).join('\n') === lines.join('\n'), what);
	} catch {
		throw new Error(`Timed out waiting for ${what}: the editor shows ${JSON.stringify(last)}`);
	}
}

const serverHas = (path: string, text: string) => async () => (await world.read(path))?.includes(text) ?? false;

async function twoPeople(browser: BrowserType) {
	const alice = await openProfile(browser, world.url('alice'));
	const bob = await openProfile(browser, world.url('bob'));
	return {
		alice: alice.page,
		bob: bob.page,
		async cleanup() {
			await alice.cleanup();
			await bob.cleanup();
		},
	};
}

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'headings, bold and a task checkbox render in place, and the checkbox toggles in the file',
			async () => {
				const { page, cleanup } = await openProfile(browser, world.url('alice'));
				try {
					const path = await createNote(page, `Preview ${engine}`, '# Groceries\n\nBuy **oat** milk\n\n- [ ] bread\n\nend');
					// The cursor is on the last line, so every other line shows rendered.
					await untilShown(page, ['Groceries', '', 'Buy oat milk', '', ' bread', '', 'end'], 'the rendered lines');
					await expect(editorOf(page).locator('.cm-md-h1').textContent()).resolves.toBe('Groceries');
					await expect(editorOf(page).locator('.cm-md-strong').textContent()).resolves.toBe('oat');
					const box = editorOf(page).locator('input.cm-md-task');
					await expect(box.isChecked()).resolves.toBe(false);
					// On the line being edited, its syntax shows.
					await endOf(page, 'Buy oat milk');
					await until(async () => (await shown(page))[2] === 'Buy **oat** milk', 'the syntax on the cursor line');

					await box.click();
					await until(async () => (await box.isChecked()) === true, 'the checkbox to show checked');
					await until(serverHas(path, '- [x] bread\n'), 'the toggled task in the file');
					expect(await world.read(path)).toEndWith('\n---\n# Groceries\n\nBuy **oat** milk\n\n- [x] bread\n\nend');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			"two people typing in different paragraphs see each other's text while each cursor stays put",
			async () => {
				const { alice, bob, cleanup } = await twoPeople(browser);
				try {
					const title = `Shared ${engine}`;
					const path = await createNote(alice, title, 'Alpha.\n\nBeta.\n\nGamma.');
					await until(serverHas(path, 'Gamma.'), 'the note on the server');
					await until(async () => (await bob.getByRole('region', { name: 'Notes' }).getByText(title).count()) > 0, 'the note for bob');
					await openNote(bob, title);

					await endOf(alice, 'Alpha.');
					await endOf(bob, 'Gamma.');
					// Both type at once, keystroke by keystroke.
					await Promise.all([alice.keyboard.type(' alice was here', { delay: 40 }), bob.keyboard.type(' bob was here', { delay: 40 })]);
					const expected = ['Alpha. alice was here', '', 'Beta.', '', 'Gamma. bob was here'];
					for (const page of [alice, bob]) await untilShown(page, expected, 'both edits on both screens');
					// Each cursor stayed where its person was typing.
					await Promise.all([alice.keyboard.type('!'), bob.keyboard.type('?')]);
					const after = ['Alpha. alice was here!', '', 'Beta.', '', 'Gamma. bob was here?'];
					for (const page of [alice, bob]) await untilShown(page, after, 'the next keystrokes in place');
					await until(serverHas(path, 'Alpha. alice was here!\n\nBeta.\n\nGamma. bob was here?'), 'both edits on the server');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a change from the other person is not undone by Undo',
			async () => {
				const { alice, bob, cleanup } = await twoPeople(browser);
				try {
					const title = `Undo ${engine}`;
					const path = await createNote(alice, title, 'One.\n\nTwo.');
					await until(serverHas(path, 'Two.'), 'the note on the server');
					await until(async () => (await bob.getByRole('region', { name: 'Notes' }).getByText(title).count()) > 0, 'the note for bob');
					await openNote(bob, title);

					await endOf(alice, 'One.');
					await alice.keyboard.type(' mine');
					await until(serverHas(path, 'One. mine'), "alice's edit on the server");
					await endOf(bob, 'Two.');
					await bob.keyboard.type(' theirs');
					await until(async () => (await shown(alice)).join('|') === 'One. mine||Two. theirs', "bob's edit for alice");

					await alice.keyboard.press('ControlOrMeta+z');
					await until(async () => (await shown(alice)).join('|') === 'One.||Two. theirs', 'undo of alice’s edit only');
					await until(async () => (await shown(bob)).join('|') === 'One.||Two. theirs', 'the undo for bob');
					await until(serverHas(path, 'One.\n\nTwo. theirs'), 'the undo on the server');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a true overlap shows a conflict card, and resolving it removes the markers from the file',
			async () => {
				const { alice, bob, cleanup } = await twoPeople(browser);
				try {
					const title = `Overlap ${engine}`;
					const path = await createNote(alice, title, 'Before.\n\nThe meeting is on Monday.\n\nAfter.');
					await until(serverHas(path, 'After.'), 'the note on the server');
					await until(async () => (await bob.getByRole('region', { name: 'Notes' }).getByText(title).count()) > 0, 'the note for bob');
					await openNote(bob, title);

					world.setOnline('bob', false);
					await endOf(bob, 'Monday.');
					for (let n = 0; n < 'Monday.'.length; n++) await bob.keyboard.press('Backspace');
					await bob.keyboard.type('Tuesday.');
					await endOf(alice, 'Monday.');
					for (let n = 0; n < 'Monday.'.length; n++) await alice.keyboard.press('Backspace');
					await alice.keyboard.type('Wednesday.');
					await until(serverHas(path, 'Wednesday.'), "alice's edit on the server");
					world.setOnline('bob', true);

					await until(serverHas(path, '<<<<<<< '), 'the markers in the file');
					for (const page of [alice, bob]) {
						const card = page.getByRole('group', { name: 'Overlapping edits' });
						await card.waitFor({ timeout: 20_000 });
						await expect(card.textContent()).resolves.toContain('Tuesday.');
						await expect(card.textContent()).resolves.toContain('Wednesday.');
					}
					await alice.getByRole('group', { name: 'Overlapping edits' }).getByRole('button', { name: 'Keep both' }).click();
					await until(async () => !((await world.read(path)) ?? '<<<<<<< ').includes('<<<<<<< '), 'the markers gone from the file');
					const resolved = (await world.read(path)) ?? '';
					expect(resolved).toContain('Wednesday.');
					expect(resolved).toContain('Tuesday.');
					expect(resolved).not.toMatch(/^(=======|\|\|\|\|\|\|\| |>>>>>>> )/m);
					await bob.getByRole('group', { name: 'Overlapping edits' }).waitFor({ state: 'detached', timeout: 20_000 });
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
