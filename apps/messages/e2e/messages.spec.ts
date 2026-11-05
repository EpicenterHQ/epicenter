/**
 * Messages end to end, per engine, served by its local program with a fake
 * Beeper behind it (see `serve.ts`). Messages is a program on this
 * computer (ADR-0784): its drafts are files in a directory the program
 * owns (`E2E_FOLDER` here), which the page reaches only through it, so the
 * spec reads and writes that directory as another program would.
 *
 * 1. A draft is a note in Messages' directory: the first keystroke creates
 *    it, edits follow, a reload keeps it, and emptying it clears it (its
 *    note stays, with an empty body) and the list's preview.
 * 2. While the program cannot be reached, a draft waits, the page says so,
 *    and it lands once the program answers.
 * 3. A demo send records its attempt before Beeper is asked; one with no
 *    confirmation shows Check send, and checking it keeps the text as a draft.
 * 4. A draft another program broke shows its text, with what is wrong as
 *    typed; text that still does not fit is saved as typed and stays to
 *    repair, and saving fixed text repairs it.
 * 5. The directory fits the published contract (`epicenter check`).
 * 6. Live Beeper goes through the local program: connect, read, send.
 * 7. A browser holding none of the site's data shows the drafts: they are
 *    the program's, not this browser's.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from 'playwright/test';
import { run } from '../../../packages/cli/src/app-e2e.test-support.ts';
import { E2E_FOLDER } from './folder.ts';

const app = 'http://127.0.0.1:5189';
const cli = resolve(import.meta.dirname, '../../../packages/cli/src/bin.ts');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
	({ context, page } = await open(browser));
});

test.afterAll(async () => {
	await context?.close();
});

/** A browser context with no site data, and its page. */
async function open(browser: Browser) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	return { context, page: await context.newPage() };
}

/** The text of `path` in Messages' directory, or null when it is not there. */
const fileText = (path: string) =>
	readFile(join(E2E_FOLDER, path), 'utf8').catch(() => null);

/** The paths of the files below `directory` in Messages' directory. */
const filesIn = (directory: string) =>
	readdir(join(E2E_FOLDER, directory)).then(
		(names) => names.map((name) => `${directory}/${name}`),
		() => [],
	);

/** The id of a draft and its attempt, as `draftId` names them. */
const draftId = (mode: string, profile: string, chatId: string) =>
	`${mode}-${createHash('sha256')
		.update(JSON.stringify([mode, profile, chatId]))
		.digest('hex')}`;
const maya = draftId('demo', 'fictional-v1', 'demo-maya');
const noah = draftId('demo', 'fictional-v1', 'demo-noah');
const draftNote = (body: string, chatId = 'demo-maya') =>
	`---\nchatId: ${chatId}\nprofile: fictional-v1\nmode: demo\n---\n${body}`;

const conversation = (title: string, on = page) =>
	on
		.getByRole('complementary', { name: 'Conversations' })
		.getByRole('button', { name: title });
const composer = () => page.getByLabel('Message', { exact: true });

test('1. a draft is a note in Messages’ directory: created by the first keystroke, edited, kept across a reload, and cleared when emptied', async () => {
	// The engines share one program: start from an empty directory.
	await rm(join(E2E_FOLDER, 'drafts'), { recursive: true, force: true });
	await rm(join(E2E_FOLDER, 'attempts'), { recursive: true, force: true });
	await page.goto(`${app}/`);
	await expect(page.getByText('Demo · fictional conversations')).toBeVisible();

	await conversation('Maya Chen').click();
	await expect(composer()).toHaveValue('');
	// Selecting a conversation makes no file.
	expect(await filesIn('drafts')).toEqual([]);

	await composer().fill('See you Saturday');
	await expect
		.poll(() => fileText(`drafts/${maya}.md`))
		.toBe(draftNote('See you Saturday'));
	await composer().fill('See you Saturday at ten');
	await expect
		.poll(() => fileText(`drafts/${maya}.md`))
		.toBe(draftNote('See you Saturday at ten'));
	await expect(conversation('Maya Chen')).toContainText(
		'Draft: See you Saturday at ten',
	);

	await page.reload();
	await conversation('Maya Chen').click();
	await expect(composer()).toHaveValue('See you Saturday at ten');

	// Emptying the composer clears the draft: its note stays, with no body.
	await composer().fill('');
	await expect.poll(() => fileText(`drafts/${maya}.md`)).toBe(draftNote(''));
	await expect(conversation('Maya Chen')).not.toContainText('Draft:');
});

test('2. while the program cannot be reached, a draft waits and lands once it answers', async () => {
	const folder = (url: URL) => url.pathname.startsWith('/folder/');
	await context.route(folder, (route) => route.abort('connectionrefused'));
	try {
		await conversation('Noah Patel').click();
		await expect(composer()).toHaveValue('');
		await composer().fill('Route looks good');
		await expect(
			page.getByText('Your changes will save once they can be reached.'),
		).toBeVisible();
		// The composer keeps the text while its save waits.
		await composer().fill('Route looks good, see you there');
		expect(await fileText(`drafts/${noah}.md`)).toBeNull();
	} finally {
		await context.unroute(folder);
	}
	await expect
		.poll(() => fileText(`drafts/${noah}.md`))
		.toBe(draftNote('Route looks good, see you there', 'demo-noah'));
	await expect(page.getByTestId('unreachable')).toHaveCount(0);
	await page.reload();
	await expect(conversation('Noah Patel')).toContainText(
		'Draft: Route looks good, see you there',
	);
	await conversation('Maya Chen').click();
	await expect(composer()).toHaveValue('');
});

test('3. a demo send records its attempt first, and an unconfirmed one waits for a check', async () => {
	await composer().fill('Ten works');
	await page.getByRole('button', { name: 'Send demo reply' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Demo message sent.' }),
	).toBeVisible();
	await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
		'Ten works',
	);
	await expect(composer()).toHaveValue('');
	expect(await fileText(`attempts/${maya}.md`)).toMatch(
		/^---\nchatId: demo-maya\nprofile: fictional-v1\nmode: demo\nstate: accepted\nattemptId: \S+\npendingId: \S+\n---\nTen works$/,
	);
	await expect.poll(() => fileText(`drafts/${maya}.md`)).toBe(draftNote(''));

	await page.getByRole('button', { name: 'Simulate send failure' }).click();
	await composer().fill('Maybe eleven?');
	await page.getByRole('button', { name: 'Send demo reply' }).click();
	await expect(
		page.getByText('This send has no saved confirmation.'),
	).toBeVisible();
	await expect(conversation('Maya Chen')).toContainText(
		'Check send: Maybe eleven?',
	);
	expect(await fileText(`attempts/${maya}.md`)).toContain('state: sending');
	await expect(
		page.getByRole('button', { name: 'Send demo reply' }),
	).toBeDisabled();

	await page.getByRole('button', { name: 'I checked: keep as draft' }).click();
	await expect(composer()).toHaveValue('Maybe eleven?');
	await expect
		.poll(() => fileText(`attempts/${maya}.md`))
		.toContain('state: acknowledged');
	await expect(conversation('Maya Chen')).toContainText('Draft: Maybe eleven?');
});

test('4. a draft another program broke shows its text, and is repaired', async () => {
	const broken = '---\nchatId: [demo-maya\n---\nMaybe eleven?';
	await writeFile(join(E2E_FOLDER, `drafts/${maya}.md`), broken);
	await page.reload();
	await conversation('Maya Chen').click();

	const repair = page.getByRole('region', { name: 'Draft to repair' });
	const text = repair.getByLabel(`Text of drafts/${maya}.md`);
	await expect(text).toHaveValue(broken);
	await expect(composer()).toHaveCount(0);

	// What is wrong follows the text as typed; text that still does not fit
	// is saved as typed, and the draft stays to repair.
	const stillBroken =
		'---\nchatId: demo-maya\nprofile: fictional-v1\n---\nMaybe eleven?';
	await text.fill(stillBroken);
	await expect(repair.getByRole('list', { name: 'Problems' })).toContainText(
		'mode is missing',
	);
	await repair.getByRole('button', { name: 'Save repair' }).click();
	// The page has the save back once Discard goes; the file may have it first.
	await expect(repair.getByRole('button', { name: 'Discard' })).toHaveCount(0);
	await expect.poll(() => fileText(`drafts/${maya}.md`)).toBe(stillBroken);
	await expect(repair.getByRole('list', { name: 'Problems' })).toContainText(
		'mode',
	);
	await expect(composer()).toHaveCount(0);

	await text.fill(draftNote('Maybe eleven?'));
	await expect(repair.getByText('This text reads.')).toBeVisible();
	await repair.getByRole('button', { name: 'Save repair' }).click();
	await expect(composer()).toHaveValue('Maybe eleven?');
	await expect(repair).toHaveCount(0);
	expect(await fileText(`drafts/${maya}.md`)).toBe(draftNote('Maybe eleven?'));
});

test('5. Messages’ directory fits the published contract', async () => {
	expect(await filesIn('drafts')).toEqual(
		expect.arrayContaining([`drafts/${maya}.md`]),
	);
	expect(await filesIn('attempts')).toEqual([`attempts/${maya}.md`]);
	const checked = await run(
		['bun', '--no-install', cli, 'check', `${app}/contract.json`, E2E_FOLDER],
		{
			cwd: E2E_FOLDER,
			env: { ...process.env } as Record<string, string>,
		},
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('6. live Beeper goes through the local program', async () => {
	await page.getByRole('button', { name: 'Connect Beeper' }).click();
	await page.getByLabel('Beeper access token').fill('test-token');
	await page.getByRole('button', { name: 'Connect to live Beeper' }).click();
	await expect(page.getByText('Live Beeper', { exact: true })).toBeVisible();
	await expect(conversation('Maya Chen')).toHaveCount(0);

	await conversation('Ada Test').click();
	await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
		'Are you there?',
	);
	await composer().fill('Here now');
	const ada = draftId('live', 'fake-test-installation', 'live-ada');
	await expect
		.poll(() => fileText(`drafts/${ada}.md`))
		.toBe(
			'---\nchatId: live-ada\nprofile: fake-test-installation\nmode: live\n---\nHere now',
		);
	await page.getByRole('button', { name: 'Send reply' }).click();
	await expect(page.getByText('Accepted by Beeper.')).toBeVisible();
	await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
		'Here now',
	);
	expect(await fileText(`attempts/${ada}.md`)).toContain('state: accepted');

	await page.getByRole('button', { name: 'Disconnect' }).click();
	await expect(page.getByText('Demo · fictional conversations')).toBeVisible();
});

test('7. a browser holding none of the site’s data shows the drafts', async ({
	browser,
}) => {
	const elsewhere = await open(browser);
	try {
		await elsewhere.page.goto(`${app}/`);
		await expect(conversation('Noah Patel', elsewhere.page)).toContainText(
			'Draft: Route looks good, see you there',
		);
		await expect(conversation('Maya Chen', elsewhere.page)).toContainText(
			'Draft: Maybe eleven?',
		);
	} finally {
		await elsewhere.context.close();
	}
});
