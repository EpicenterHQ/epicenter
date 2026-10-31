/**
 * Vocab end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`):
 *
 * Vocab has two views (decision 76): "On this device" (`/`), this browser's
 * files, and "Synced" (`/synced`), the learner's repository.
 *
 * 1. Signed out, words are added, noted, staged and deleted on this device
 *    (OPFS), as Markdown notes at `entries/<sha256 of the text>.md`, the
 *    learner's note in the body; "Synced" asks for a sign-in.
 * 2. Signed in, they upload on their own: each leaves "On this device" and
 *    the browser's files, and appears in "Synced". One added on this device
 *    while signed in follows; a word and a chat started in "Synced" go to the
 *    repository.
 * 3. `epicenter clone` holds them as written (the chat's focus a nested
 *    list), and `epicenter check` passes against the published contract.
 * 4. A stage changed on the desktop shows in "Synced" with no reload; a note
 *    edited there reaches the desktop.
 * 5. A word note the desktop wrote that does not read is listed in "Synced"
 *    with its text, and saving fixed text there repairs it.
 * 6. Signing out leaves this browser with no words, and "Synced" asks for a
 *    sign-in again.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const test = stackTest('VOCAB_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let lucidSaved: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `vocab-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
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

/** A word's id: the SHA-256 of its exact text. */
const idOf = (text: string) => createHash('sha256').update(text).digest('hex');
const card = (text: string) => page.locator(`article[data-id="${idOf(text)}"]`);
const noteOf = (text: string) => page.getByLabel(`Your note for ${text}`);
const where = () => page.getByTestId('where');
const views = () => page.getByRole('navigation', { name: 'Views' });
const signInToSee = () =>
	page.getByText(
		'Sign in to see the words and chats in your Epicenter repository.',
	);
const wordNote = (text: string, stage: string, createdAt: string, note = '') =>
	`---\ntext: ${text}\nstage: ${stage}\ncreatedAt: "${createdAt}"\n---\n${note}`;

async function add(text: string) {
	await page.getByLabel('New expression').fill(text);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(card(text)).toBeVisible();
}

/** When the word was saved, from its file. */
const createdAtOf = (text: string) =>
	(text.match(/^createdAt: "(.+)"$/m) as RegExpMatchArray)[1] as string;

async function account(action: 'Sign in' | 'Sign out') {
	await page.getByRole('button', { name: 'Account' }).click();
	await page.getByRole('button', { name: action }).click();
}

test('1. signed out, words are added, noted, staged and deleted on this device', async ({
	stack,
}) => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${stack.app}/`);
	await emptyOpfs(page);
	await page.goto(`${stack.app}/`);
	await expect(
		views().getByRole('link', { name: 'On this device' }),
	).toHaveAttribute('aria-current', 'page');
	await expect(where()).toHaveText('On this device');

	await add('lucid');
	const path = `entries/${idOf('lucid')}.md`;
	const written = (await opfsText(page, path)) as string;
	lucidSaved = createdAtOf(written);
	expect(written).toBe(wordNote('lucid', 'new', lucidSaved));

	await noteOf('lucid').fill('clear and easy to follow');
	await expect
		.poll(() => opfsText(page, path))
		.toBe(wordNote('lucid', 'new', lucidSaved, 'clear and easy to follow'));
	await card('lucid').getByRole('button', { name: 'Understand' }).click();
	await expect
		.poll(() => opfsText(page, path))
		.toBe(
			wordNote('lucid', 'understood', lucidSaved, 'clear and easy to follow'),
		);

	await add('candid');
	await add('gone');
	await card('gone').getByRole('button', { name: 'Delete' }).click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(card('gone')).toHaveCount(0);
	expect(
		Object.keys(await opfsFiles(page))
			.filter((file) => file.startsWith('entries/'))
			.sort(),
	).toEqual([`entries/${idOf('candid')}.md`, path].sort());

	await page.reload();
	await expect(card('lucid')).toBeVisible();
	await expect(noteOf('lucid')).toHaveValue('clear and easy to follow');
	await expect(card('candid')).toBeVisible();

	// "Synced" is the repository's, which needs a sign-in.
	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(signInToSee()).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(card('lucid')).toBeVisible();
	await expect(card('candid')).toBeVisible();
});

test('2. signed in, the words upload: each leaves this device and appears in Synced', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await recordUploaderStarts(context);
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await account('Sign in');
	await expect(where()).toHaveText('On this device');

	// The uploader moves them: this device's view and files empty.
	await expect(card('lucid')).toHaveCount(0);
	await expect(card('candid')).toHaveCount(0);
	await expect(page.getByText('Your words will appear here')).toBeVisible();
	await expect.poll(() => opfsFiles(page)).toEqual({});
	// The callback page only finished sign-in: no repository, no uploader.
	const uploaders = await uploaderStarts(page);
	expect(uploaders.length).toBeGreaterThan(0);
	expect(uploaders.filter((path) => path.includes('/auth/callback'))).toEqual(
		[],
	);

	// One added on this device while signed in follows on its own.
	await page.getByLabel('New expression').fill('nuance');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByLabel('New expression')).toHaveValue('');
	await expect(page.locator('article[data-id]')).toHaveCount(0);
	await expect.poll(() => opfsFiles(page)).toEqual({});

	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(views().getByRole('link', { name: 'Synced' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(where()).toHaveText('Synced');
	await expect(card('lucid')).toBeVisible();
	await expect(noteOf('lucid')).toHaveValue('clear and easy to follow');
	await expect(
		card('lucid').getByRole('button', { name: 'Understand' }),
	).toHaveAttribute('aria-pressed', 'true');
	await expect(card('candid')).toBeVisible();
	await expect(card('nuance')).toBeVisible();

	// A word and a chat started in "Synced" go to the repository, never this device.
	await add('eager');
	await card('lucid')
		.getByRole('checkbox', { name: 'Choose lucid for chat' })
		.click();
	await card('candid')
		.getByRole('checkbox', { name: 'Choose candid for chat' })
		.click();
	await page.getByRole('button', { name: 'Start chat' }).click();
	await expect(
		page
			.getByRole('complementary', { name: 'Chat history' })
			.getByRole('button', { name: 'lucid, candid' }),
	).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
	await page
		.getByRole('navigation', { name: 'Sections' })
		.getByRole('button', { name: 'Words' })
		.click();
});

test('3. a desktop clone holds the words and the chat as written, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'vocab');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/vocab`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	expect(
		await readFile(join(clone, `entries/${idOf('lucid')}.md`), 'utf8'),
	).toBe(
		wordNote('lucid', 'understood', lucidSaved, 'clear and easy to follow'),
	);
	const [chat] = await readdir(join(clone, 'chats'));
	expect(await readFile(join(clone, 'chats', chat as string), 'utf8')).toMatch(
		new RegExp(
			`^---\\ncreatedAt: "\\S+"\\nfocus:\\n  - entryId: "${idOf('lucid')}"\\n    text: lucid\\n  - entryId: "${idOf('candid')}"\\n    text: candid\\n---\\n$`,
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

test('4. a stage changed on the desktop shows in Synced with no reload, and a note edited there reaches the desktop', async ({
	stack,
	person,
}) => {
	const path = join(clone, `entries/${idOf('candid')}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/^stage: .*$/m, 'stage: usable'),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(
		card('candid').getByRole('button', { name: 'Use', exact: true }),
	).toHaveAttribute('aria-pressed', 'true');

	await noteOf('candid').fill('frank and honest');
	await expect
		.poll(async () => {
			await sync(stack, person, clone);
			return readFile(path, 'utf8');
		})
		.toMatch(
			/^---\ntext: candid\nstage: usable\ncreatedAt: "\S+"\n---\nfrank and honest$/,
		);
});

test('5. a word note that does not read is listed in Synced with its text, and repaired there', async ({
	stack,
	person,
}) => {
	const broken = '---\ntext: [opaque\n---\nhard to see through\n';
	await writeFile(join(clone, 'entries/broken.md'), broken);
	await sync(stack, person, clone);

	const repairs = page.getByRole('region', { name: 'Words that need repair' });
	await expect(repairs).toContainText('entries/broken.md');
	await repairs.getByRole('button', { name: 'Repair as text' }).click();
	const repair = page.getByRole('region', { name: 'Repair entries/broken.md' });
	const text = repair.getByLabel('Text of entries/broken.md');
	await expect(text).toHaveValue(broken);

	// What is wrong follows the text as typed; text that still does not fit is refused.
	await text.fill('---\ntext: opaque\n---\nhard to see through\n');
	await expect(repair.getByRole('list', { name: 'Problems' })).toContainText(
		'stage is missing',
	);
	await repair.getByRole('button', { name: 'Save repair' }).click();
	await expect(repair.getByRole('alert')).toContainText('Not saved');

	const fixed =
		'---\ntext: opaque\nstage: new\ncreatedAt: "2026-10-31T00:00:00.000Z"\n---\nhard to see through\n';
	await text.fill(fixed);
	await repair.getByRole('button', { name: 'Save repair' }).click();
	await expect(repair).toHaveCount(0);
	await expect(repairs).toHaveCount(0);
	await expect(page.locator('article[data-id="broken"]')).toBeVisible();
	await expect(page.getByLabel('Your note for opaque')).toHaveValue(
		'hard to see through\n',
	);

	await sync(stack, person, clone);
	expect(await readFile(join(clone, 'entries/broken.md'), 'utf8')).toBe(fixed);
});

test('6. signed out, the browser holds no words, and Synced asks for a sign-in', async () => {
	await account('Sign out');
	await expect(signInToSee()).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(where()).toHaveText('On this device');
	await expect(page.getByText('Your words will appear here')).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
