/**
 * Honeycrisp end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Honeycrisp has two views (decision 76): "On this device" (`/`), this
 * browser's files, and "Synced" (`/synced`), the person's repository.
 *
 * 1. Signed out, notes and folders are created, edited, moved, pinned and
 *    deleted on this device (OPFS), as Markdown notes at `notes/<id>.md`
 *    and `folders/<id>.md`; the body is typed into the CodeMirror editor.
 *    "Synced" asks for a sign-in.
 * 2. Signed in, they upload on their own: each leaves "On this device" and
 *    the browser's files, and appears in "Synced". One made on this device
 *    while signed in follows; one made in "Synced" goes to the repository.
 * 3. `epicenter clone` holds them as the browser wrote them, and
 *    `epicenter check` passes against the published contract.
 * 4. A body edited on the desktop and synced shows in the note open in
 *    "Synced", with no reload; text typed there reaches the desktop.
 * 5. A note the desktop wrote that does not read as a note shows in
 *    "Synced" with its text; text that still does not fit is refused, and
 *    fixed text repairs it.
 * 6. Signing out leaves this browser with no notes, and "Synced" asks for a
 *    sign-in again.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
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
let groceries: string;
let work: string;
/** The note and folder files as the browser wrote them. */
let groceriesText: string;
let workText: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `honeycrisp-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
		serviceWorkers: 'block',
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const list = () => page.getByRole('list', { name: 'Note list' });
const views = () => page.getByRole('navigation', { name: 'Views' });
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

/** Type `text` at the end of the open note's body. */
async function typeAtEnd(text: string) {
	await editor().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

/** The notes and folders in this origin's OPFS, without the device's own hidden files. */
async function noteFiles() {
	return Object.keys(await opfsFiles(page))
		.filter((path) => path.startsWith('notes/') || path.startsWith('folders/'))
		.sort();
}

test('1. signed out, notes and folders are created, edited, moved, pinned and deleted in the browser', async ({
	stack,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(
		views().getByRole('link', { name: 'On this device' }),
	).toHaveAttribute('aria-current', 'page');
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this device\./,
	);
	await expect(page.getByText('No notes here yet')).toBeVisible();

	// A folder, named as it is made.
	await page.getByRole('button', { name: 'New folder' }).click();
	await page.getByLabel('Folder name').fill('Work');
	await page.getByLabel('Folder name').press('Enter');
	const folder = page.locator('[data-folder]', { hasText: 'Work' });
	await expect(folder).toHaveCount(1);
	work = (await folder.getAttribute('data-folder')) as string;
	workText = '---\nname: Work\n---\n';
	await expect.poll(() => opfsText(page, `folders/${work}.md`)).toBe(workText);

	// A note: its title, then its body typed into the editor.
	groceries = await newNote();
	await title().fill('Groceries');
	await typeAtEnd('Oat milk');
	await expect(editor()).toContainText('Oat milk');
	await expect(row(groceries)).toContainText('Groceries');
	await expect(row(groceries)).toContainText('Oat milk');

	// Moved into the folder, and pinned.
	await detail().getByLabel('Folder').selectOption({ label: 'Work' });
	await detail().getByRole('button', { name: 'Pin', exact: true }).click();
	await expect(detail().getByRole('button', { name: 'Unpin' })).toBeVisible();
	await expect
		.poll(() => opfsText(page, `notes/${groceries}.md`))
		.toMatch(
			new RegExp(
				`^---\\ntitle: Groceries\\nfolderId: "${work}"\\npinned: true\\ncreatedAt: "[^"]+"\\n---\\nOat milk$`,
			),
		);
	groceriesText = (await opfsText(page, `notes/${groceries}.md`)) as string;

	// The folder shows the note it holds.
	await folderRow(work).getByRole('button', { name: /^Work/ }).click();
	await expect(list().locator('li[data-id]')).toHaveCount(1);
	await page.getByRole('button', { name: /^All Notes/ }).click();

	// Another note, in a folder deleted under it: the note keeps naming the
	// folder, stays in All Notes, and says its folder was deleted.
	const gone = await newNote();
	await typeAtEnd('Never mind');
	await expect(row(gone)).toContainText('Never mind');
	await page.getByRole('button', { name: 'New folder' }).click();
	await page.getByLabel('Folder name').fill('Trip');
	await page.getByLabel('Folder name').press('Enter');
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
	expect(await noteFiles()).toEqual(
		[`folders/${work}.md`, `notes/${groceries}.md`].sort(),
	);

	// Still there after a reload.
	await page.reload();
	await expect(row(groceries)).toContainText('Groceries');
	await expect(folderRow(work)).toContainText('Work');

	// "Synced" is the repository's, which needs a sign-in.
	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(
		page.getByText('Sign in to see the notes in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(row(groceries)).toContainText('Groceries');
});

test('2. signed in, the notes upload: each leaves this device and appears in Synced', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

	// The uploader moves them: this device's view and files empty.
	await expect(row(groceries)).toHaveCount(0);
	await expect(folderRow(work)).toHaveCount(0);
	await expect(page.getByText('No notes here yet')).toBeVisible();
	await expect.poll(() => opfsFiles(page)).toEqual({});

	// One made on this device while signed in follows on its own. Its detail
	// opens once it is written; it then leaves with the rest.
	await page.getByRole('button', { name: 'New note' }).click();
	await expect(detail()).toBeVisible();
	await expect(list().locator('li[data-id]')).toHaveCount(0);
	await expect(detail().getByText('This note is no longer here')).toBeVisible();
	await expect.poll(() => opfsFiles(page)).toEqual({});

	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(views().getByRole('link', { name: 'Synced' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Synced\./);
	await expect(row(groceries)).toContainText('Groceries');
	await expect(folderRow(work)).toContainText('Work');
	// Groceries and the one made on this device since.
	await expect(list().locator('li[data-id]')).toHaveCount(2);

	// One made in "Synced" goes to the repository, never this device.
	const later = await newNote();
	await typeAtEnd('Made in Synced');
	await expect(row(later)).toContainText('Made in Synced');
	expect(await opfsFiles(page)).toEqual({});
});

test('3. a desktop clone holds the notes as the browser wrote them, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'honeycrisp');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/honeycrisp`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	expect(await readFile(join(clone, `notes/${groceries}.md`), 'utf8')).toBe(
		groceriesText,
	);
	expect(await readFile(join(clone, `folders/${work}.md`), 'utf8')).toBe(
		workText,
	);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('4. a body edited on the desktop shows in the note open in Synced with no reload, and text typed there reaches the desktop', async ({
	stack,
	person,
}) => {
	await list().locator(`[data-note="${groceries}"]`).click();
	await expect(title()).toHaveValue('Groceries');

	const path = join(clone, `notes/${groceries}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(
			/Oat milk$/,
			'Oat milk, two cartons',
		),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(editor()).toContainText('Oat milk, two cartons');
	await expect(row(groceries)).toContainText('Oat milk, two cartons');

	await typeAtEnd(' and bread');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe(
			groceriesText.replace(/Oat milk$/, 'Oat milk, two cartons and bread'),
		);
});

test('5. a note that does not read as a note shows in Synced with its text, and is repaired there', async ({
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
});

test('6. signed out, the browser holds no notes, and Synced asks for a sign-in', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to see the notes in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('No notes here yet')).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
