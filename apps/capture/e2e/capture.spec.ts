/**
 * Capture end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Capture is online web only: the person's `capture` repository, behind
 * sign-in, with nothing kept in the browser (ADR-0700). The sandbox's CLI
 * stands in for a desktop that clones and syncs the repository.
 *
 * 1. Signed out, Capture asks for a sign-in. Signed in, the repository is
 *    empty; captures are added (opening at Add a thought), given thoughts,
 *    edited, downloaded and deleted there, never in this browser's files,
 *    and a reload shows them again.
 * 2. `epicenter clone` holds them byte for byte, and `epicenter check`
 *    passes against the published contract.
 * 3. A thought added on the desktop and synced shows in the open capture
 *    with no reload; a thought added in the browser reaches the desktop.
 * 4. A note the desktop wrote that does not read as a capture is listed
 *    with its text; Save refuses a fix that still does not fit and repairs
 *    it with one that does.
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

const test = stackTest('CAPTURE_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let milk: string;
let milkFile: string;
let bakery: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `capture-${browserName}-`));
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
	page.getByText('Sign in to use the captures in your Epicenter repository.');
const status = () => page.getByTestId('status-summary');
const rows = () => page.locator('[data-id]');
const row = (id: string) => page.locator(`[data-id="${id}"]`);
const back = () =>
	page.getByRole('button', { name: 'Back to timeline' }).first().click();
const thoughts = () =>
	page.getByRole('list', { name: 'Thoughts' }).getByRole('listitem');

/** Add a capture with `text`, which opens it at Add a thought; answers its id, from the timeline. */
async function add(text: string) {
	const before = await rows().evaluateAll((all) =>
		all.map((one) => one.getAttribute('data-id')),
	);
	await page.getByLabel('New capture', { exact: true }).fill(text);
	await page
		.getByLabel('New capture', { exact: true })
		.press('ControlOrMeta+Enter');
	await expect(page.getByLabel('Add a thought')).toBeFocused();
	await expect(page.getByLabel('Capture text')).toHaveValue(text);
	await back();
	const added = rows().filter({ hasText: text });
	await expect(added).toHaveCount(1);
	const id = (await added.getAttribute('data-id')) as string;
	expect(before).not.toContain(id);
	return id;
}

/** Add `text` as a thought to the open capture. */
async function addThought(text: string) {
	await page.getByLabel('Add a thought').fill(text);
	await page.getByLabel('Add a thought').press('ControlOrMeta+Enter');
	await expect(thoughts().filter({ hasText: text })).toHaveCount(1);
}

/** The capture file Capture writes, for a time the file holds and a body. */
const captureFile = (capturedAt: string, body: string) =>
	`---\ncapturedAt: "${capturedAt}"\n---\n${body}`;

/** The `capturedAt` a capture file holds. */
const capturedAtOf = (text: string | null) =>
	text?.match(/^capturedAt: "(.+)"$/m)?.[1] ?? '';

test('1. signed in, captures are added, given thoughts, edited, downloaded and deleted in the repository, never in the browser', async ({
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
	await expect(page.getByText('No captures yet')).toBeVisible();

	milk = await add('Buy oat milk');
	await row(milk).click();
	await addThought('Ask about soy');
	await addThought('Two cartons');
	await page.getByLabel('Capture text').fill('Buy oat milk, unsweetened');

	// Moving a thought rewrites the list in the note.
	await thoughts()
		.nth(1)
		.getByRole('button', { name: 'Thought actions' })
		.click();
	await page.getByRole('menuitem', { name: 'Move up' }).click();
	await expect(thoughts()).toHaveText([/Two cartons/, /Ask about soy/]);

	// Download file hands over the note's text once the shown body has saved.
	await page.getByRole('button', { name: 'More capture actions' }).click();
	const downloading = page.waitForEvent('download');
	await page.getByRole('menuitem', { name: 'Download file' }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe(`${milk}.md`);
	const text = await readFile(await download.path(), 'utf8');
	const capturedAt = capturedAtOf(text);
	expect(Date.now() - new Date(capturedAt).getTime()).toBeLessThan(120_000);
	milkFile = captureFile(
		capturedAt,
		'\nBuy oat milk, unsweetened\n\n## Thoughts\n\n- Two cartons\n- Ask about soy\n',
	);
	expect(text).toBe(milkFile);
	await back();

	const gone = await add('Never mind');
	await row(gone).click();
	await page.getByRole('button', { name: 'More capture actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete capture…' }).click();
	await expect(page.getByRole('alertdialog')).toContainText(
		'Its Git history keeps them',
	);
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);

	bakery = await add('Call the bakery');
	await expect(rows()).toHaveCount(2);
	// Nothing is kept in this browser.
	expect(await opfsFiles(page)).toEqual({});

	// The repository still has them after a reload.
	await page.reload();
	await expect(row(milk)).toContainText('Buy oat milk, unsweetened');
	await expect(row(milk)).toContainText('2 thoughts');
	await expect(row(bakery)).toContainText('Call the bakery');
	await expect(rows()).toHaveCount(2);
	expect(await opfsFiles(page)).toEqual({});
});

test('2. a desktop clone holds the captures byte for byte, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'capture');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/capture`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	expect(await readFile(join(clone, `captures/${milk}.md`), 'utf8')).toBe(
		milkFile,
	);
	const bakeryFile = await readFile(
		join(clone, `captures/${bakery}.md`),
		'utf8',
	);
	expect(bakeryFile).toBe(
		captureFile(capturedAtOf(bakeryFile), '\nCall the bakery\n\n## Thoughts\n'),
	);
	expect((await readdir(join(clone, 'captures'))).sort()).toEqual(
		[`${bakery}.md`, `${milk}.md`].sort(),
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

test('3. a thought added on the desktop shows in the open capture with no reload, and one added in the browser reaches the desktop', async ({
	stack,
	person,
}) => {
	await row(milk).click();
	await expect(thoughts()).toHaveCount(2);

	const path = join(clone, `captures/${milk}.md`);
	await writeFile(path, `${milkFile}- From the desktop\n`);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(thoughts()).toHaveText([
		/Two cartons/,
		/Ask about soy/,
		/From the desktop/,
	]);

	await addThought('From the web');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe(`${milkFile}- From the desktop\n- From the web\n`);
	await back();
});

test('4. a note that does not read as a capture is listed with its text, and repaired', async ({
	stack,
	person,
}) => {
	const broken =
		'---\ncapturedAt: last tuesday\n---\n\nFound note\n\n## Thoughts\n';
	await writeFile(join(clone, 'captures/found.md'), broken);
	await sync(stack, person, clone);

	const repair = page.getByRole('alert', { name: 'Files to repair' });
	await expect(repair).toContainText('captures/found.md');
	await repair
		.getByRole('button', { name: 'Edit captures/found.md as text' })
		.click();
	const text = page.getByLabel('Contents of captures/found.md');
	await expect(text).toHaveValue(broken);
	await expect(
		page.getByRole('status', { name: 'Needs repair' }),
	).toBeVisible();

	// Text that still does not fit is refused, says why, and stays to fix.
	await text.fill(
		'---\ncapturedAt: 2026-10-30\n---\n\nFound note\n\n## Thoughts\n',
	);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('alert', { name: 'Not saved' })).toContainText(
		'capturedAt',
	);
	await expect(text).toHaveValue(
		'---\ncapturedAt: 2026-10-30\n---\n\nFound note\n\n## Thoughts\n',
	);

	await text.fill(
		'---\ncapturedAt: 2026-10-30T09:00:00Z\n---\n\nFound note\n\n## Thoughts\n',
	);
	await expect(page.getByRole('status', { name: 'Needs repair' })).toHaveCount(
		0,
	);
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	// It reads as a capture now, and opens as one.
	await expect(page.getByLabel('Capture text')).toHaveValue('Found note');
	await back();
	await expect(repair).toHaveCount(0);
	await expect(row('found')).toContainText('Found note');

	await sync(stack, person, clone);
	expect(await readFile(join(clone, 'captures/found.md'), 'utf8')).toBe(
		'---\ncapturedAt: "2026-10-30T09:00:00Z"\n---\n\nFound note\n\n## Thoughts\n',
	);
	expect((await readdir(join(clone, 'captures'))).sort()).toEqual(
		['found.md', `${bakery}.md`, `${milk}.md`].sort(),
	);
	expect(await opfsFiles(page)).toEqual({});
});

test('5. signed out, Capture asks for a sign-in again, and the browser holds nothing', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(signInPrompt()).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
