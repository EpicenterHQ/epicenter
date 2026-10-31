/**
 * Capture end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`):
 *
 * Capture has two views (decision 76): "On this device" (`/`), this
 * browser's files, and "Synced" (`/synced`), the person's repository.
 *
 * 1. Signed out, captures are added on this device (opening at Add a
 *    thought), given thoughts, edited and deleted in the browser (OPFS), as
 *    Markdown notes at `captures/<id>.md`, and are still there after a
 *    reload; "Synced" asks for a sign-in.
 * 2. Signed in, they upload on their own: each leaves "On this device" and
 *    the browser's files, and appears in "Synced". One added on this device
 *    while signed in follows; one added in "Synced", and a thought added
 *    there, go to the repository.
 * 3. `epicenter clone` holds them byte for byte, and `epicenter check`
 *    passes against the published contract.
 * 4. A thought added on the desktop and synced shows in the capture open in
 *    "Synced" with no reload; a thought added there reaches the desktop.
 * 5. A note the desktop wrote that does not read as a capture is listed in
 *    "Synced" with its text; Save refuses a fix that still does not fit and
 *    repairs it with one that does.
 * 6. Signing out leaves this browser with no captures, and "Synced" asks for
 *    a sign-in again.
 * 7. (Chromium) The page opens with no network, through its service worker,
 *    and a capture added then is kept in the browser.
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
	recordUploaderStarts,
	stackTest,
	sync,
	uploaderStarts,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const test = stackTest('CAPTURE_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let milk: string;
let milkFile: string;
let train: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `capture-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
		// The steps here run without the service worker; step 7 opens
		// offline in a context of its own.
		serviceWorkers: 'block',
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const views = () => page.getByRole('navigation', { name: 'Views' });
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

test('1. signed out, captures are added, given thoughts, edited and deleted in the browser', async ({
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
	await expect(page.getByText('No captures yet')).toBeVisible();
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this device\./,
	);

	milk = await add('Buy oat milk');
	await row(milk).click();
	await addThought('Ask about soy');
	await addThought('Two cartons');
	await page.getByLabel('Capture text').fill('Buy oat milk, unsweetened');
	await expect
		.poll(() => opfsText(page, `captures/${milk}.md`))
		.toContain('unsweetened');
	const text = await opfsText(page, `captures/${milk}.md`);
	const capturedAt = capturedAtOf(text);
	expect(Date.now() - new Date(capturedAt).getTime()).toBeLessThan(120_000);
	milkFile = captureFile(
		capturedAt,
		'\nBuy oat milk, unsweetened\n\n## Thoughts\n\n- Ask about soy\n- Two cartons\n',
	);
	expect(text).toBe(milkFile);

	// Moving a thought rewrites the list in the file.
	await thoughts()
		.nth(1)
		.getByRole('button', { name: 'Thought actions' })
		.click();
	await page.getByRole('menuitem', { name: 'Move up' }).click();
	await expect(thoughts()).toHaveText([/Two cartons/, /Ask about soy/]);
	await thoughts()
		.nth(1)
		.getByRole('button', { name: 'Thought actions' })
		.click();
	await page.getByRole('menuitem', { name: 'Move up' }).click();
	await expect(thoughts()).toHaveText([/Ask about soy/, /Two cartons/]);
	await expect.poll(() => opfsText(page, `captures/${milk}.md`)).toBe(milkFile);
	await back();

	const gone = await add('Never mind');
	await row(gone).click();
	await page.getByRole('button', { name: 'More capture actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete capture…' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);
	await expect(rows()).toHaveCount(1);
	expect(
		Object.keys(await opfsFiles(page)).filter((path) =>
			path.startsWith('captures/'),
		),
	).toEqual([`captures/${milk}.md`]);

	// Still there after a reload.
	await page.reload();
	await expect(row(milk)).toContainText('Buy oat milk, unsweetened');
	await expect(row(milk)).toContainText('2 thoughts');

	// "Synced" is the repository's, which needs a sign-in.
	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(
		page.getByText('Sign in to see the captures in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(rows()).toHaveCount(1);
});

test('2. signed in, the captures upload: each leaves this device and appears in Synced', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await recordUploaderStarts(context);
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	// The callback page only finishes sign-in: no repository, no uploader.
	const uploaders = await uploaderStarts(page);
	expect(uploaders.length).toBeGreaterThan(0);
	expect(uploaders.filter((path) => path.includes('/auth/callback'))).toEqual(
		[],
	);

	// The uploader moves them: this device's view and files empty.
	await expect(row(milk)).toHaveCount(0);
	await expect(page.getByText('No captures yet')).toBeVisible();
	await expect.poll(() => opfsFiles(page)).toEqual({});

	// One added on this device while signed in follows on its own: it opens,
	// then leaves this device for the repository.
	await page
		.getByLabel('New capture', { exact: true })
		.fill('Idea on the train');
	await page
		.getByLabel('New capture', { exact: true })
		.press('ControlOrMeta+Enter');
	await expect(
		page.getByText('it uploaded to your repository and is under Synced'),
	).toBeVisible();
	await expect.poll(() => opfsFiles(page)).toEqual({});
	await back();
	await expect(rows()).toHaveCount(0);

	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(views().getByRole('link', { name: 'Synced' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Synced\./);
	await expect(row(milk)).toContainText('Buy oat milk, unsweetened');
	await expect(row(milk)).toContainText('2 thoughts');
	const trainRow = rows().filter({ hasText: 'Idea on the train' });
	await expect(trainRow).toHaveCount(1);
	train = (await trainRow.getAttribute('data-id')) as string;

	// A thought added in "Synced" goes to the repository.
	await trainRow.click();
	await addThought('Written in Synced');
	await back();

	// One added in "Synced" goes to the repository, never this device.
	await add('Call the bakery');
	await expect(rows()).toHaveCount(3);
	expect(await opfsFiles(page)).toEqual({});
});

test('3. a desktop clone holds the captures as written, and the folder fits the contract', async ({
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
	const trainFile = await readFile(join(clone, `captures/${train}.md`), 'utf8');
	expect(trainFile).toBe(
		captureFile(
			capturedAtOf(trainFile),
			'\nIdea on the train\n\n## Thoughts\n\n- Written in Synced\n',
		),
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

test('4. a thought added on the desktop shows in the capture open in Synced with no reload, and one added there reaches the desktop', async ({
	stack,
	person,
}) => {
	await row(milk).click();
	await expect(thoughts()).toHaveCount(2);

	const path = join(clone, `captures/${milk}.md`);
	await writeFile(path, `${await readFile(path, 'utf8')}- From the desktop\n`);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(thoughts()).toHaveText([
		/Ask about soy/,
		/Two cartons/,
		/From the desktop/,
	]);

	await addThought('From the web');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toBe(
			milkFile.replace(
				'- Two cartons\n',
				'- Two cartons\n- From the desktop\n- From the web\n',
			),
		);
	await back();
});

test('5. a note that does not read as a capture is listed in Synced with its text, and repaired there', async ({
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
});

test('6. signed out, the browser holds no captures, and Synced asks for a sign-in', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to see the captures in your Epicenter repository.'),
	).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('No captures yet')).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});

test('7. the page opens with no network through its service worker, and a capture is kept in the browser', async ({
	playwright,
	browserName,
	launchOptions,
	stack,
}) => {
	// WebKit's offline emulation also fails OPFS reads.
	test.skip(browserName !== 'chromium', 'Chromium only');
	const own = await mkdtemp(join(tmpdir(), `capture-offline-${browserName}-`));
	const offlineContext = await playwright[browserName].launchPersistentContext(
		own,
		{ ...launchOptions, serviceWorkers: 'allow' },
	);
	try {
		const tab = offlineContext.pages()[0] ?? (await offlineContext.newPage());
		const errors: string[] = [];
		tab.on('pageerror', (error) => errors.push(error.message));
		await tab.goto(`${stack.app}/`);
		await expect(tab.getByLabel('New capture', { exact: true })).toBeVisible();
		await tab.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		// The worker controls the page once it reloads.
		await tab.reload();
		await expect
			.poll(() =>
				tab.evaluate(() => navigator.serviceWorker.controller !== null),
			)
			.toBe(true);

		await offlineContext.setOffline(true);
		await tab.reload();
		await tab
			.getByLabel('New capture', { exact: true })
			.fill('Written with no network');
		await tab
			.getByLabel('New capture', { exact: true })
			.press('ControlOrMeta+Enter');
		await expect(tab.getByLabel('Add a thought')).toBeFocused();
		const written = async () => {
			const path = Object.keys(await opfsFiles(tab)).find((one) =>
				one.startsWith('captures/'),
			);
			return path ? opfsText(tab, path) : null;
		};
		await expect.poll(written).toContain('\nWritten with no network\n');
		expect(errors).toEqual([]);
	} finally {
		await offlineContext.close();
		await rm(own, { recursive: true, force: true });
	}
});
