/**
 * Vocab end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Vocab is online web only: the learner's `vocab` repository, behind
 * sign-in, with none of the learner's words or chats kept in the browser
 * (ADR-0700). The sandbox's CLI stands in for a desktop that clones and
 * syncs the repository.
 *
 * 1. Signed out, Vocab asks for a sign-in. Signed in, the repository is
 *    empty; words are added, noted, staged and deleted, and a chat is
 *    started, there and never in this browser's files, and a reload shows
 *    them again.
 * 2. `epicenter clone` holds them as written (`entries/<sha256 of the
 *    text>.md`, the learner's note in the body, the chat's focus a nested
 *    list), and `epicenter check` passes against the published contract.
 * 3. A stage changed on the desktop and synced shows with no reload; a note
 *    edited in the browser reaches the desktop.
 * 4. A word note the desktop wrote that does not read is listed with its
 *    text, and saving fixed text repairs it.
 * 5. Signing out asks for a sign-in again, and the browser holds nothing.
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
	stackTest,
	sync,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const test = stackTest('VOCAB_E2E_STATE');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let lucidFile: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `vocab-${browserName}-`));
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

/** A word's id: the SHA-256 of its exact text. */
const idOf = (text: string) => createHash('sha256').update(text).digest('hex');
const card = (text: string) => page.locator(`article[data-id="${idOf(text)}"]`);
const noteOf = (text: string) => page.getByLabel(`Your note for ${text}`);
const status = () => page.getByTestId('status');
const chatButton = (title: string) =>
	page
		.getByRole('complementary', { name: 'Chat history' })
		.getByRole('button', { name: title });
const section = (name: 'Words' | 'Chat') =>
	page
		.getByRole('navigation', { name: 'Sections' })
		.getByRole('button', { name });
const signInPrompt = () =>
	page.getByText(
		'Sign in to use the words and chats in your Epicenter repository.',
	);
const wordNote = (text: string, stage: string, createdAt: string, note = '') =>
	`---\ntext: ${text}\nstage: ${stage}\ncreatedAt: "${createdAt}"\n---\n${note}`;
/** When the word was saved, from its file. */
const createdAtOf = (text: string) =>
	(text.match(/^createdAt: "(.+)"$/m) as RegExpMatchArray)[1] as string;

async function add(text: string) {
	await page.getByLabel('New expression').fill(text);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(card(text)).toBeVisible();
}

test('1. signed in, words are added, noted, staged and deleted and a chat is started in the repository, never in the browser', async ({
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
	await expect(status()).toHaveText('Online');
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect(page.getByText('Your words will appear here')).toBeVisible();

	await add('lucid');
	await noteOf('lucid').fill('clear and easy to follow');
	await card('lucid').getByRole('button', { name: 'Understand' }).click();
	await expect(
		card('lucid').getByRole('button', { name: 'Understand' }),
	).toHaveAttribute('aria-pressed', 'true');

	await add('candid');
	await add('gone');
	await card('gone').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('alertdialog')).toContainText(
		'Its Git history keeps them',
	);
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(card('gone')).toHaveCount(0);

	await card('lucid')
		.getByRole('checkbox', { name: 'Choose lucid for chat' })
		.click();
	await card('candid')
		.getByRole('checkbox', { name: 'Choose candid for chat' })
		.click();
	await page.getByRole('button', { name: 'Start chat' }).click();
	await expect(chatButton('lucid, candid')).toBeVisible();
	await section('Words').click();
	// Nothing is kept in this browser.
	expect(await opfsFiles(page)).toEqual({});

	// The repository still has them after a reload, the note as typed.
	await page.reload();
	await expect(status()).toHaveText('Online');
	await expect(noteOf('lucid')).toHaveValue('clear and easy to follow');
	await expect(
		card('lucid').getByRole('button', { name: 'Understand' }),
	).toHaveAttribute('aria-pressed', 'true');
	await expect(card('candid')).toBeVisible();
	await expect(page.locator('article[data-id]')).toHaveCount(2);
	await section('Chat').click();
	await expect(chatButton('lucid, candid')).toBeVisible();
	await section('Words').click();
	expect(await opfsFiles(page)).toEqual({});
});

test('2. a desktop clone holds the words and the chat as written, and the folder fits the contract', async ({
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

	const lucid = await readFile(
		join(clone, `entries/${idOf('lucid')}.md`),
		'utf8',
	);
	lucidFile = wordNote(
		'lucid',
		'understood',
		createdAtOf(lucid),
		'clear and easy to follow',
	);
	expect(lucid).toBe(lucidFile);
	const candid = await readFile(
		join(clone, `entries/${idOf('candid')}.md`),
		'utf8',
	);
	expect(candid).toBe(wordNote('candid', 'new', createdAtOf(candid)));
	expect((await readdir(join(clone, 'entries'))).sort()).toEqual(
		[`${idOf('candid')}.md`, `${idOf('lucid')}.md`].sort(),
	);

	const chats = await readdir(join(clone, 'chats'));
	expect(chats).toHaveLength(1);
	expect(
		await readFile(join(clone, 'chats', chats[0] as string), 'utf8'),
	).toMatch(
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

test('3. a stage changed on the desktop shows with no reload, and a note edited in the browser reaches the desktop', async ({
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
	expect(
		await readFile(join(clone, `entries/${idOf('lucid')}.md`), 'utf8'),
	).toBe(lucidFile);
	expect(await opfsFiles(page)).toEqual({});
});

test('4. a word note that does not read is listed with its text, and repaired', async ({
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
	expect(await opfsFiles(page)).toEqual({});
});

test('5. signed out, Vocab asks for a sign-in again, and the browser holds nothing', async () => {
	await page.getByRole('button', { name: 'Account' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(signInPrompt()).toBeVisible();
	await expect(page.locator('article[data-id]')).toHaveCount(0);
	expect(await opfsFiles(page)).toEqual({});
});
