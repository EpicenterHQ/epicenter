/**
 * Honeycrisp end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Honeycrisp is online web only: the person's `honeycrisp` repository,
 * behind sign-in, with nothing kept in the browser (ADR-0700). The
 * sandbox's CLI stands in for a desktop that clones and syncs the
 * repository.
 *
 * 1. Signed out, Honeycrisp asks for a sign-in. Signed in, the repository is
 *    empty; notes and folders are created, edited, moved, pinned and
 *    deleted there, the body typed into the CodeMirror editor, never in this
 *    browser's files, and a reload shows them again.
 * 2. `epicenter clone` holds them as written, and `epicenter check` passes
 *    against the published contract.
 * 3. A body edited on the desktop and synced shows in the open note with no
 *    reload; text typed in the browser reaches the desktop in house style.
 * 4. A note the desktop wrote that does not read as a note shows with its
 *    text; text that still does not fit is refused, and fixed text repairs
 *    it.
 * 5. Signing out asks for a sign-in again, and the browser holds nothing.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	opfsFiles,
	stackTest,
	sync,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const test = stackTest('HONEYCRISP_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let recipes: string;
let home: string;
/** The note's file as the browser wrote it, read from the clone. */
let recipesText: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `honeycrisp-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context, and
	// the steps look there to show nothing is kept in the browser.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const signInPrompt = () =>
	page.getByText('Sign in to use the notes in your Epicenter repository.');
const list = () => page.getByRole('list', { name: 'Note list' });
const status = () => page.getByTestId('status-summary');
const row = (id: string) => list().locator(`li[data-id="${id}"]`);
const folderRow = (id: string) => page.locator(`[data-folder="${id}"]`);
const detail = () => page.getByRole('region', { name: 'Note', exact: true });
const title = () => detail().getByLabel('Title', { exact: true });
const editor = () => detail().getByRole('textbox', { name: 'Note text' });

/** Make a note with the + button; answers its id, once the new note is open. */
async function newNote() {
	const ids = () =>
		list()
			.locator('li[data-id]')
			.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')));
	const before = await ids();
	await page.getByRole('button', { name: 'New note' }).click();
	let id = '';
	await expect
		.poll(async () => {
			id = (await ids()).find((each) => !before.includes(each)) ?? '';
			return id;
		})
		.not.toBe('');
	// The new note opens.
	await expect(detail().getByTestId('file-path')).toHaveText(`notes/${id}.md`);
	return id;
}

/** Make a folder named `name`; answers its id. */
async function newFolder(name: string) {
	await page.getByRole('button', { name: 'New folder' }).click();
	await page.getByLabel('Folder name').fill(name);
	await page.getByLabel('Folder name').press('Enter');
	const folder = page.locator('[data-folder]', { hasText: name });
	await expect(folder).toHaveCount(1);
	return (await folder.getAttribute('data-folder')) as string;
}

/** Type `text` at the end of the open note's body. */
async function typeAtEnd(text: string) {
	await editor().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

/**
 * What a note's file says, in any key order: its front matter lines sorted,
 * `createdAt`'s time elided, and its body. The move and the pin can race,
 * and the server's merge of the two does not keep house-style order.
 */
function said(text: string) {
	const [, front = '', body = ''] =
		/^---\n([\s\S]*?)---\n([\s\S]*)$/.exec(text) ?? [];
	const keys = front
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => line.replace(/^createdAt: .+$/, 'createdAt: <time>'))
		.sort();
	return { keys, body };
}

/** The file names in the clone's `dir`, sorted. */
const cloned = async (dir: string) => (await readdir(join(clone, dir))).sort();

test('1. signed in, notes and folders are created, edited, moved, pinned and deleted in the repository, never in the browser', async ({
	stack,
	person,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(signInPrompt()).toBeVisible();

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);
	await expect(page.getByText('No notes here yet')).toBeVisible();
	await expect(page.locator('[data-folder]')).toHaveCount(0);

	// A folder, named as it is made.
	home = await newFolder('Home');

	// A note: its title, then its body typed into the editor.
	recipes = await newNote();
	await title().fill('Recipes');
	await typeAtEnd('Apple pie');
	await expect(editor()).toContainText('Apple pie');
	await expect(row(recipes)).toContainText('Recipes');
	await expect(row(recipes)).toContainText('Apple pie');

	// Moved into the folder, and pinned.
	await detail().getByLabel('Folder').selectOption({ label: 'Home' });
	await detail().getByRole('button', { name: 'Pin', exact: true }).click();
	await expect(detail().getByRole('button', { name: 'Unpin' })).toBeVisible();

	// The folder shows the note it holds.
	await folderRow(home).getByRole('button', { name: /^Home/ }).click();
	await expect(list().locator('li[data-id]')).toHaveCount(1);
	await page.getByRole('button', { name: /^All Notes/ }).click();

	// Another note, in a folder deleted under it: the note keeps naming the
	// folder, stays in All Notes, and says its folder was deleted.
	const gone = await newNote();
	await typeAtEnd('Never mind');
	await expect(row(gone)).toContainText('Never mind');
	await newFolder('Trip');
	await detail().getByLabel('Folder').selectOption({ label: 'Trip' });
	await page.getByRole('button', { name: 'Actions for Trip' }).click();
	await page.getByRole('menuitem', { name: 'Delete…' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.locator('[data-folder]', { hasText: 'Trip' })).toHaveCount(
		0,
	);
	await expect(row(gone)).toHaveCount(1);
	await expect(
		detail().getByLabel('Folder').locator('option:checked'),
	).toHaveText('A deleted folder');

	// Deleted for good.
	await detail().getByRole('button', { name: 'Delete' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);
	// Nothing is kept in this browser.
	expect(await opfsFiles(page)).toEqual({});

	// The repository still has them after a reload.
	await page.reload();
	await expect(row(recipes)).toContainText('Recipes');
	await expect(row(recipes)).toContainText('Apple pie');
	await expect(list().locator('li[data-id]')).toHaveCount(1);
	await expect(folderRow(home)).toContainText('Home');
	await expect(page.locator('[data-folder]')).toHaveCount(1);
	expect(await opfsFiles(page)).toEqual({});
});

test('2. a desktop clone holds what was written, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'honeycrisp');
	const made = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/honeycrisp`,
		clone,
	);
	expect(made.code, `${made.stdout}\n${made.stderr}`).toBe(0);

	const path = join(clone, `notes/${recipes}.md`);
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return said(await readFile(path, 'utf8').catch(() => ''));
		})
		.toEqual({
			keys: [
				'createdAt: <time>',
				`folderId: "${home}"`,
				'pinned: true',
				'title: Recipes',
			],
			body: 'Apple pie',
		});
	recipesText = await readFile(path, 'utf8');
	expect(await readFile(join(clone, `folders/${home}.md`), 'utf8')).toBe(
		'---\nname: Home\n---\n',
	);
	// The deleted note and folder are gone.
	expect(await cloned('notes')).toEqual([`${recipes}.md`]);
	expect(await cloned('folders')).toEqual([`${home}.md`]);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('3. a body edited on the desktop shows in the open note with no reload, and text typed in the browser reaches the desktop', async ({
	stack,
	person,
}) => {
	await list().locator(`[data-note="${recipes}"]`).click();
	await expect(title()).toHaveValue('Recipes');

	const path = join(clone, `notes/${recipes}.md`);
	await writeFile(
		path,
		recipesText.replace(/Apple pie$/, 'Apple pie, with cinnamon'),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(editor()).toContainText('Apple pie, with cinnamon');
	await expect(row(recipes)).toContainText('Apple pie, with cinnamon');

	// The browser writes the note in house style, keys in the contract's order.
	const createdAt = /^createdAt: (.+)$/m.exec(recipesText)?.[1];
	await typeAtEnd(' and cream');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe(
			`---\ntitle: Recipes\nfolderId: "${home}"\npinned: true\ncreatedAt: ${createdAt}\n---\nApple pie, with cinnamon and cream`,
		);
});

test('4. a note that does not read as a note shows with its text, and is repaired', async ({
	stack,
	person,
}) => {
	const broken = '---\ntitle: [Call mom\n---\nSunday\n';
	await writeFile(join(clone, 'notes/call.md'), broken);
	await sync(stack, person, clone);

	const repair = page.getByRole('region', { name: 'Needs repair' });
	await expect(repair).toContainText('notes/call.md');
	await repair.locator('[data-invalid="call"]').click();
	await expect(detail().getByTestId('needs-repair')).toBeVisible();
	const text = detail().getByLabel('Text of notes/call.md');
	await expect(text).toHaveValue(broken);

	// Text that still does not fit is refused, and stays to fix.
	await text.fill('---\ntitle: Call mom\n---\nSunday\n');
	await detail().getByRole('button', { name: 'Save repair' }).click();
	await expect(detail().getByRole('alert')).toContainText('createdAt');

	await text.fill(
		'---\ntitle: Call mom\ncreatedAt: 2026-10-31T09:00:00.000Z\n---\nSunday\n',
	);
	await detail().getByRole('button', { name: 'Save repair' }).click();
	await expect(title()).toHaveValue('Call mom');
	await expect(repair).toHaveCount(0);
	await expect(row('call')).toContainText('Call mom');

	await sync(stack, person, clone);
	// Written in house style: the time quoted.
	expect(await readFile(join(clone, 'notes/call.md'), 'utf8')).toBe(
		'---\ntitle: Call mom\ncreatedAt: "2026-10-31T09:00:00.000Z"\n---\nSunday\n',
	);
	expect(await cloned('notes')).toEqual(['call.md', `${recipes}.md`].sort());
	expect(await cloned('folders')).toEqual([`${home}.md`]);
	expect(await opfsFiles(page)).toEqual({});
});

test('5. signed out, Honeycrisp asks for a sign-in again, and the browser holds nothing', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(signInPrompt()).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
