/**
 * Messages end to end, per engine, in one persistent browser profile, served
 * by its local program with a fake Beeper behind it (see `serve.ts`).
 * Messages is local only (ADR-0700): its drafts are kept in this browser's
 * files (OPFS), with no account.
 *
 * 1. A draft is a note in this browser: the first keystroke creates it,
 *    edits follow, a reload keeps it, and emptying it clears it (its note
 *    stays, with an empty body) and the list's preview.
 * 2. Offline, demo mode still creates and edits a draft, and it is there
 *    after a reload.
 * 3. A demo send records its attempt before Beeper is asked; one with no
 *    confirmation shows Check send, and checking it keeps the text as a draft.
 * 4. A draft another program broke shows its text, with what is wrong as
 *    typed, and saving fixed text repairs it.
 * 5. This browser's files fit the published contract (`epicenter check`).
 * 6. Live Beeper goes through the local program: connect, read, send.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type BrowserContext, expect, type Page, test } from 'playwright/test';
import {
	emptyOpfs,
	goOffline,
	opfsFiles,
	opfsText,
	run,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const app = 'http://127.0.0.1:5189';
const cli = resolve(import.meta.dirname, '../../../packages/cli/src/bin.ts');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `messages-${browserName}-`));
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

/** The id of a draft and its attempt, as `draftId` names them. */
const draftId = (mode: string, profile: string, chatId: string) =>
	`${mode}-${createHash('sha256')
		.update(JSON.stringify([mode, profile, chatId]))
		.digest('hex')}`;
const maya = draftId('demo', 'fictional-v1', 'demo-maya');
const noah = draftId('demo', 'fictional-v1', 'demo-noah');
const draftNote = (body: string, chatId = 'demo-maya') =>
	`---\nchatId: ${chatId}\nprofile: fictional-v1\nmode: demo\n---\n${body}`;

const conversation = (title: string) =>
	page
		.getByRole('complementary', { name: 'Conversations' })
		.getByRole('button', { name: title });
const composer = () => page.getByLabel('Message', { exact: true });

test('1. a draft is a note in this browser: created by the first keystroke, edited, kept across a reload, and cleared when emptied', async () => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${app}/`);
	await emptyOpfs(page);
	await page.goto(`${app}/`);
	await expect(page.getByText('Demo · fictional conversations')).toBeVisible();

	await conversation('Maya Chen').click();
	await expect(composer()).toHaveValue('');
	// Selecting a conversation makes no file.
	expect(
		Object.keys(await opfsFiles(page)).filter((path) =>
			path.startsWith('drafts/'),
		),
	).toEqual([]);

	await composer().fill('See you Saturday');
	await expect
		.poll(() => opfsText(page, `drafts/${maya}.md`))
		.toBe(draftNote('See you Saturday'));
	await composer().fill('See you Saturday at ten');
	await expect
		.poll(() => opfsText(page, `drafts/${maya}.md`))
		.toBe(draftNote('See you Saturday at ten'));
	await expect(conversation('Maya Chen')).toContainText(
		'Draft: See you Saturday at ten',
	);

	await page.reload();
	await conversation('Maya Chen').click();
	await expect(composer()).toHaveValue('See you Saturday at ten');

	// Emptying the composer clears the draft: its note stays, with no body.
	await composer().fill('');
	await expect
		.poll(() => opfsText(page, `drafts/${maya}.md`))
		.toBe(draftNote(''));
	await expect(conversation('Maya Chen')).not.toContainText('Draft:');
});

test('2. offline, demo mode still creates and edits a draft', async () => {
	const online = await goOffline(context);
	try {
		await conversation('Noah Patel').click();
		await expect(composer()).toHaveValue('');
		await composer().fill('Route looks good');
		await expect
			.poll(() => opfsText(page, `drafts/${noah}.md`))
			.toBe(draftNote('Route looks good', 'demo-noah'));
		await composer().fill('Route looks good, see you there');
		await expect
			.poll(() => opfsText(page, `drafts/${noah}.md`))
			.toBe(draftNote('Route looks good, see you there', 'demo-noah'));
		await expect(conversation('Noah Patel')).toContainText(
			'Draft: Route looks good, see you there',
		);
	} finally {
		await online();
	}
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
	expect(await opfsText(page, `attempts/${maya}.md`)).toMatch(
		/^---\nchatId: demo-maya\nprofile: fictional-v1\nmode: demo\nstate: accepted\nattemptId: \S+\npendingId: \S+\n---\nTen works$/,
	);
	await expect
		.poll(() => opfsText(page, `drafts/${maya}.md`))
		.toBe(draftNote(''));

	await page.getByRole('button', { name: 'Simulate send failure' }).click();
	await composer().fill('Maybe eleven?');
	await page.getByRole('button', { name: 'Send demo reply' }).click();
	await expect(
		page.getByText('This send has no saved confirmation.'),
	).toBeVisible();
	await expect(conversation('Maya Chen')).toContainText(
		'Check send: Maybe eleven?',
	);
	expect(await opfsText(page, `attempts/${maya}.md`)).toContain(
		'state: sending',
	);
	await expect(
		page.getByRole('button', { name: 'Send demo reply' }),
	).toBeDisabled();

	await page.getByRole('button', { name: 'I checked: keep as draft' }).click();
	await expect(composer()).toHaveValue('Maybe eleven?');
	await expect
		.poll(() => opfsText(page, `attempts/${maya}.md`))
		.toContain('state: acknowledged');
	await expect(conversation('Maya Chen')).toContainText('Draft: Maybe eleven?');
});

test('4. a draft another program broke shows its text, and is repaired', async () => {
	const broken = '---\nchatId: [demo-maya\n---\nMaybe eleven?';
	await page.evaluate(
		async ([name, text]) => {
			const root = await navigator.storage.getDirectory();
			const drafts = await root.getDirectoryHandle('drafts');
			const writable = await (
				await drafts.getFileHandle(name)
			).createWritable();
			await writable.write(text);
			await writable.close();
		},
		[`${maya}.md`, broken],
	);
	await page.reload();
	await conversation('Maya Chen').click();

	const repair = page.getByRole('region', { name: 'Draft to repair' });
	const text = repair.getByLabel(`Text of drafts/${maya}.md`);
	await expect(text).toHaveValue(broken);
	await expect(composer()).toHaveCount(0);

	// What is wrong follows the text as typed; text that still does not fit is refused.
	await text.fill(
		'---\nchatId: demo-maya\nprofile: fictional-v1\n---\nMaybe eleven?',
	);
	await expect(repair.getByRole('list', { name: 'Problems' })).toContainText(
		'mode is missing',
	);
	await repair.getByRole('button', { name: 'Save repair' }).click();
	await expect(
		repair.getByRole('alert').filter({ hasText: 'Not saved' }),
	).toBeVisible();

	await text.fill(draftNote('Maybe eleven?'));
	await expect(repair.getByText('This text reads.')).toBeVisible();
	await repair.getByRole('button', { name: 'Save repair' }).click();
	await expect(composer()).toHaveValue('Maybe eleven?');
	await expect(repair).toHaveCount(0);
	expect(await opfsText(page, `drafts/${maya}.md`)).toBe(
		draftNote('Maybe eleven?'),
	);
});

test('5. the files in this browser fit the published contract', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'messages-device-'));
	try {
		const paths = Object.keys(await opfsFiles(page));
		expect(paths).toEqual(
			expect.arrayContaining([`drafts/${maya}.md`, `attempts/${maya}.md`]),
		);
		for (const path of paths) {
			const text = await opfsText(page, path);
			await mkdir(dirname(join(folder, path)), { recursive: true });
			await writeFile(join(folder, path), text ?? '');
		}
		const checked = await run(
			['bun', '--no-install', cli, 'check', `${app}/contract.json`, folder],
			{
				cwd: folder,
				env: { ...process.env } as Record<string, string>,
			},
		);
		expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
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
		.poll(() => opfsText(page, `drafts/${ada}.md`))
		.toBe(
			'---\nchatId: live-ada\nprofile: fake-test-installation\nmode: live\n---\nHere now',
		);
	await page.getByRole('button', { name: 'Send reply' }).click();
	await expect(page.getByText('Accepted by Beeper.')).toBeVisible();
	await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
		'Here now',
	);
	expect(await opfsText(page, `attempts/${ada}.md`)).toContain(
		'state: accepted',
	);

	await page.getByRole('button', { name: 'Disconnect' }).click();
	await expect(page.getByText('Demo · fictional conversations')).toBeVisible();
});
