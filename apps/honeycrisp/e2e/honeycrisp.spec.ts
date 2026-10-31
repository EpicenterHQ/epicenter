/**
 * Honeycrisp end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Honeycrisp has two web variants, each over one store for the page's life,
 * and nothing moves between them (ADR-0700): "On this browser" (`/`), this
 * browser's files, with no account; and "Online" (`/online`), the person's
 * repository, signed in.
 *
 * 1. On this browser, notes and folders are created, edited, moved, pinned
 *    and deleted as Markdown notes at `notes/<id>.md` and `folders/<id>.md`
 *    in OPFS, the body typed into the CodeMirror editor, and survive a
 *    reload. No sign-in is offered.
 * 2. Offline, the local variant still creates and edits a note.
 * 3. Online asks for a sign-in; signed in, it shows the repository, which
 *    holds none of this browser's notes, and a folder and a note made and
 *    edited there land in the repository and never in this browser.
 * 4. `epicenter clone` holds them as written, and `epicenter check` passes
 *    against the published contract.
 * 5. A body edited on the desktop and synced shows in the note open online,
 *    with no reload; text typed there reaches the desktop.
 * 6. A note the desktop wrote that does not read as a note shows online with
 *    its text; text that still does not fit is refused, and fixed text
 *    repairs it.
 * 7. Signing in moved nothing: this browser's notes are where they were, and
 *    the repository has none of them. Signing out leaves them too.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	goOffline,
	opfsFiles,
	opfsText,
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
let errands: string;
/** This browser's notes and folders once the local steps are done. */
let localFiles: Record<string, string>;
/** The note and folder made online, in the repository. */
let groceries: string;
let work: string;
/** The online note's file as the browser wrote it, read from the clone. */
let groceriesText: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `honeycrisp-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
		// No step opens the app offline from a reload, so no service worker:
		// one would answer the page's requests out of sight of the test.
		serviceWorkers: 'block',
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const list = () => page.getByRole('list', { name: 'Note list' });
const ways = () =>
	page.getByRole('navigation', { name: 'Ways to use Honeycrisp' });
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

/** The notes and folders in this origin's OPFS, by path, and no other files. */
async function noteFiles() {
	return Object.fromEntries(
		Object.entries(await opfsFiles(page)).filter(
			([path]) => path.startsWith('notes/') || path.startsWith('folders/'),
		),
	);
}

/** A note's file: front matter `keys` (each ending in `\n`), its `createdAt`, then `body`. */
const noteText = (keys: string, body: string) =>
	new RegExp(`^---\\n${keys}createdAt: "[^"]+"\\n---\\n${body}$`);

/**
 * What a note's file says, in any key order: its front matter lines sorted,
 * `createdAt`'s time elided, and its body. The move and the pin made online
 * can race, and the server's merge of the two does not keep house-style order.
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

test('1. on this browser, notes and folders are created, edited, moved, pinned and deleted, and survive a reload', async ({
	stack,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(
		ways().getByRole('link', { name: 'On this browser' }),
	).toHaveAttribute('aria-current', 'page');
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this browser\./,
	);
	await expect(page.getByText('No notes here yet')).toBeVisible();
	// The local variant needs no account, and offers none.
	await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

	// A folder, named as it is made.
	home = await newFolder('Home');
	await expect
		.poll(() => opfsText(page, `folders/${home}.md`))
		.toBe('---\nname: Home\n---\n');

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
	await expect
		.poll(() => opfsText(page, `notes/${recipes}.md`))
		.toMatch(
			noteText(
				`title: Recipes\\nfolderId: "${home}"\\npinned: true\\n`,
				'Apple pie',
			),
		);

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
	await expect
		.poll(() => opfsText(page, `notes/${gone}.md`))
		.toMatch(/^---\nfolderId: "[^"]+"\ncreatedAt/);

	// Deleted for good.
	await detail().getByRole('button', { name: 'Delete' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);
	expect(Object.keys(await noteFiles()).sort()).toEqual(
		[`folders/${home}.md`, `notes/${recipes}.md`].sort(),
	);

	// Still there after a reload.
	await page.reload();
	await expect(row(recipes)).toContainText('Recipes');
	await expect(folderRow(home)).toContainText('Home');
});

test('2. offline, the local variant still creates and edits a note', async () => {
	const online = await goOffline(context);
	try {
		errands = await newNote();
		await title().fill('Errands');
		await typeAtEnd('Post office');
		await expect
			.poll(() => opfsText(page, `notes/${errands}.md`))
			.toMatch(noteText('title: Errands\\n', 'Post office'));
		await expect(status()).toHaveAttribute(
			'aria-label',
			/^Status: On this browser\./,
		);
	} finally {
		await online();
	}
	await expect(row(errands)).toContainText('Errands');
	await expect(row(recipes)).toContainText('Recipes');
	localFiles = await noteFiles();
	expect(Object.keys(localFiles).sort()).toEqual(
		[`folders/${home}.md`, `notes/${errands}.md`, `notes/${recipes}.md`].sort(),
	);
});

test('3. online, signed in, shows the repository; a folder and a note made and edited there land in it, never in this browser', async ({
	stack,
	person,
}) => {
	await ways().getByRole('link', { name: 'Online' }).click();
	await expect(page).toHaveURL(`${stack.app}/online`);
	await expect(
		page.getByText('Sign in to use the notes in your Epicenter repository.'),
	).toBeVisible();

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(`${stack.app}/online`);
	await expect(ways().getByRole('link', { name: 'Online' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);
	// The repository is its own set of notes: none of this browser's are in it.
	await expect(page.getByText('No notes here yet')).toBeVisible();
	await expect(page.locator('[data-folder]')).toHaveCount(0);

	work = await newFolder('Work');
	groceries = await newNote();
	await title().fill('Groceries');
	await typeAtEnd('Oat milk');
	await expect(row(groceries)).toContainText('Oat milk');
	await detail().getByLabel('Folder').selectOption({ label: 'Work' });
	await detail().getByRole('button', { name: 'Pin', exact: true }).click();
	await expect(detail().getByRole('button', { name: 'Unpin' })).toBeVisible();
	await expect(list().locator('li[data-id]')).toHaveCount(1);

	// Nothing online is kept in this browser.
	expect(await noteFiles()).toEqual(localFiles);
});

test('4. a desktop clone holds what was written online, and the folder fits the contract', async ({
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

	const path = join(clone, `notes/${groceries}.md`);
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return said(await readFile(path, 'utf8').catch(() => ''));
		})
		.toEqual({
			keys: [
				'createdAt: <time>',
				`folderId: "${work}"`,
				'pinned: true',
				'title: Groceries',
			],
			body: 'Oat milk',
		});
	groceriesText = await readFile(path, 'utf8');
	expect(await readFile(join(clone, `folders/${work}.md`), 'utf8')).toBe(
		'---\nname: Work\n---\n',
	);
	// Only what was made online.
	expect(await cloned('notes')).toEqual([`${groceries}.md`]);
	expect(await cloned('folders')).toEqual([`${work}.md`]);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('5. a body edited on the desktop shows in the note open online with no reload, and text typed there reaches the desktop', async ({
	stack,
	person,
}) => {
	await list().locator(`[data-note="${groceries}"]`).click();
	await expect(title()).toHaveValue('Groceries');

	const path = join(clone, `notes/${groceries}.md`);
	await writeFile(
		path,
		groceriesText.replace(/Oat milk$/, 'Oat milk, two cartons'),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(editor()).toContainText('Oat milk, two cartons');
	await expect(row(groceries)).toContainText('Oat milk, two cartons');

	// The browser writes the note in house style, keys in the contract's order.
	const createdAt = /^createdAt: (.+)$/m.exec(groceriesText)?.[1];
	await typeAtEnd(' and bread');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe(
			`---\ntitle: Groceries\nfolderId: "${work}"\npinned: true\ncreatedAt: ${createdAt}\n---\nOat milk, two cartons and bread`,
		);
});

test('6. a note that does not read as a note shows online with its text, and is repaired there', async ({
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
	expect(await noteFiles()).toEqual(localFiles);
});

test('7. signing in moved nothing: this browser keeps its notes, the repository has none of them, and signing out keeps them too', async ({
	stack,
	person,
}) => {
	await ways().getByRole('link', { name: 'On this browser' }).click();
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect(row(recipes)).toContainText('Recipes');
	await expect(row(errands)).toContainText('Errands');
	await expect(list().locator('li[data-id]')).toHaveCount(2);
	await expect(folderRow(home)).toContainText('Home');
	await expect(page.locator('[data-folder]')).toHaveCount(1);
	// Signed in or not, the local variant has no account.
	await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
	expect(await noteFiles()).toEqual(localFiles);

	await sync(stack, person, clone);
	expect(await cloned('notes')).toEqual(['call.md', `${groceries}.md`].sort());
	expect(await cloned('folders')).toEqual([`${work}.md`]);

	await ways().getByRole('link', { name: 'Online' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to use the notes in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this browser' }).click();
	await expect(row(recipes)).toContainText('Recipes');
	await expect(list().locator('li[data-id]')).toHaveCount(2);
	expect(await noteFiles()).toEqual(localFiles);
});
