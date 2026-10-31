/**
 * Whispering end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`):
 *
 * 1. Signed out, recordings are kept in the browser (OPFS) as a note and
 *    its audio (`m4a` or `webm`), queued to upload; a title is edited, a
 *    recording is transcribed (over a stubbed endpoint), and one is
 *    deleted with its files.
 * 2. Signed in, they upload on their own; the browser lets go of the notes
 *    and keeps the audio as a cache, which plays with no download.
 * 3. `epicenter clone` and `git lfs pull` give the bytes the browser
 *    recorded and the notes as edited, and `epicenter check` passes against
 *    the published contract.
 * 4. A title edited on the desktop and synced shows on the web, with no
 *    reload.
 * 5. A transcript the desktop wrote that does not read shows on the web
 *    with its text, and saving fixed text there repairs it.
 * 6. Signing out leaves this browser with nothing.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page } from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	opfsFiles,
	opfsText,
	run,
	stackTest,
	sync,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

/** Which microphone a project records from: the engine's capture device, or `?fixture=tone`. */
export type WhisperingOptions = { microphone: 'device' | 'tone' };

const test = stackTest('WHISPERING_E2E_STATE').extend<
	object,
	WhisperingOptions
>({
	microphone: ['device', { option: true, scope: 'worker' }],
});

test.describe.configure({ mode: 'serial' });

/** The transcription endpoint the browser is set up with, answered by the test. */
const TRANSCRIBE = 'https://transcribe.example/v1';

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let kept: string;
let audioPath: string;
let audioSha: string;
let clone: string;
let transcribed = 0;
/** What the page logged, attached to a failed step. */
const consoled: string[] = [];

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `whispering-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
	});
	await context.route(`${TRANSCRIBE}/**`, (route) => {
		transcribed += 1;
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': '*' },
			body: JSON.stringify({ text: 'hello from the stub' }),
		});
	});
	page = context.pages()[0] ?? (await context.newPage());
	page.on('console', (message) =>
		consoled.push(`${message.type()}: ${message.text()}`),
	);
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const row = (id: string) =>
	page.locator(`[data-testid="recording-row"][data-id="${id}"]`);
const detail = () => page.getByTestId('recording-detail');

/** The recordings this origin's OPFS holds, by id. */
async function recordingIds() {
	return Object.keys(await opfsFiles(page))
		.filter((path) => /^recordings\/[^/]+\.md$/.test(path))
		.map((path) => path.slice('recordings/'.length, -'.md'.length))
		.sort();
}

/** Record about a second and a half from the home page; answers the new recording's id. */
async function record() {
	const before = await recordingIds();
	await page.getByTestId('start-recording').click();
	await expect(page.getByTestId('stop-recording')).toBeVisible();
	await page.waitForTimeout(1500);
	await page.getByTestId('stop-recording').click();
	await expect(page.getByTestId('start-recording')).toBeVisible();
	await expect
		.poll(async () => (await recordingIds()).length)
		.toBe(before.length + 1);
	const id = (await recordingIds()).find((id) => !before.includes(id));
	expect(id).toBeTruthy();
	return id as string;
}

/** Open recording `id`'s details from the Recordings page. */
async function open(id: string) {
	await row(id).locator('button[data-recording]').click();
	await expect(detail()).toHaveAttribute('data-recording-id', id);
}

/** Open Settings, where the account is. */
async function settings() {
	await page.getByRole('button', { name: 'Settings' }).click();
	return page.getByTestId('account-status');
}

test('1. signed out, recordings are kept in the browser, edited, transcribed and deleted', async ({
	stack,
	microphone,
}) => {
	const app = `${stack.app}/${microphone === 'tone' ? '?fixture=tone' : ''}`;
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(app);
	await emptyOpfs(page);
	await page.evaluate((baseUrl) => {
		localStorage.clear();
		localStorage.setItem(
			'whispering.connections',
			JSON.stringify({ transcription: { baseUrl, model: 'whisper-1' } }),
		);
	}, TRANSCRIBE);
	await page.goto(app);
	await expect(page.getByTestId('status-summary')).toHaveAttribute(
		'aria-label',
		/In this browser/,
	);

	kept = await record();
	const gone = await record();

	const files = await opfsFiles(page);
	audioPath = Object.keys(files).find(
		(path) => path.startsWith(`recordings/${kept}.`) && !path.endsWith('.md'),
	) as string;
	// AAC where the engine records it, else Opus in WebM (decision 56).
	expect(audioPath).toMatch(/\.(m4a|webm)$/);
	audioSha = files[audioPath] as string;
	// Not empty: the sha256 of no bytes.
	expect(audioSha).not.toBe(
		'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);
	expect(
		Object.keys(files).filter((path) => path.startsWith('.epicenter/outbox/')),
	).toHaveLength(2);
	expect(await opfsText(page, `recordings/${kept}.md`)).toMatch(
		new RegExp(
			`^capture: ${microphone === 'tone' ? 'fixture' : 'microphone'}$`,
			'm',
		),
	);

	await page.getByRole('link', { name: 'Recordings' }).first().click();
	await expect(row(kept)).toHaveAttribute('data-where', 'device');
	await expect(row(gone)).toHaveAttribute('data-where', 'device');

	await open(kept);
	await detail().getByLabel('Recording title').fill('Standup notes');
	await expect
		.poll(() => opfsText(page, `recordings/${kept}.md`))
		.toMatch(/^title: Standup notes$/m);
	await expect(detail().getByTestId('audio-player')).toHaveAttribute(
		'data-audio-where',
		'device',
	);

	await detail().getByTestId('transcribe').click();
	await expect(detail().getByTestId('transcript-text')).toHaveValue(
		/hello from the stub/,
	);
	expect(transcribed).toBe(1);
	await expect
		.poll(async () =>
			Object.keys(await opfsFiles(page)).filter((path) =>
				path.startsWith('transcriptions/'),
			),
		)
		.toHaveLength(1);

	await open(gone);
	await detail().getByTestId('delete-recording').click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);
	await expect
		.poll(async () =>
			Object.keys(await opfsFiles(page)).filter((path) =>
				path.startsWith(`recordings/${gone}.`),
			),
		)
		.toEqual([]);

	// Still there after a reload.
	await page.reload();
	await expect(row(kept)).toContainText('Standup notes');
});

test('2. signed in, recordings upload; the browser keeps only the audio, as a cache that plays with no download', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await (await settings()).getByRole('button', { name: 'Sign in' }).click();
	try {
		await expect(row(kept)).toHaveAttribute('data-where', 'repository', {
			timeout: 60_000,
		});
	} catch (cause) {
		// Kept with the failed step's results: the page's log, status and files.
		await writeFile(
			test.info().outputPath('diagnosis.json'),
			JSON.stringify(
				{
					status: await page
						.getByTestId('status-summary')
						.getAttribute('aria-label'),
					opfs: await opfsFiles(page),
					console: consoled,
				},
				null,
				2,
			),
		);
		throw cause;
	}
	await expect(page.getByTestId('status-summary')).toHaveAttribute(
		'aria-label',
		/In your repository/,
	);
	// The notes went (they are the repository's) and the outbox emptied; the
	// audio stays as a cache, outside the contract's paths, byte for byte.
	await expect
		.poll(() => opfsFiles(page))
		.toEqual({ [`.epicenter/cache/${audioPath}`]: audioSha });

	// Played from the cache: nothing comes down through Git LFS.
	const lfs: string[] = [];
	const listen = (request: { url(): string }) => {
		if (request.url().includes('/info/lfs/')) lfs.push(request.url());
	};
	page.on('request', listen);
	await open(kept);
	const player = detail().getByTestId('audio-player');
	await expect(player).toHaveAttribute('data-audio-where', 'repository');
	await expect(player).toHaveAttribute('data-audio-cached', 'true');
	await expect(player).toHaveAttribute('src', /^blob:/);
	page.off('request', listen);
	expect(lfs).toEqual([]);
	await expect(detail().getByTestId('transcription-result')).toHaveAttribute(
		'data-where',
		'repository',
	);
});

test('3. a desktop clone holds the bytes the browser recorded and the notes as edited, and fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'whispering');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/whispering`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);
	const pulled = await run(['git', 'lfs', 'pull'], {
		cwd: clone,
		env: person.env,
	});
	expect(pulled.code, pulled.stderr).toBe(0);

	expect(sha256(await readFile(join(clone, audioPath)))).toBe(audioSha);
	expect(await readFile(join(clone, `recordings/${kept}.md`), 'utf8')).toMatch(
		/^title: Standup notes$/m,
	);
	const listed = await run(['git', 'ls-files', 'transcriptions'], {
		cwd: clone,
		env: person.env,
	});
	const [transcript] = listed.stdout.trim().split('\n');
	const text = await readFile(join(clone, transcript as string), 'utf8');
	// House style quotes a value YAML would otherwise read as something else.
	expect(text).toMatch(new RegExp(`^recordingId: "?${kept}"?$`, 'm'));
	expect(text).toMatch(/hello from the stub\n$/);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('4. a title edited on the desktop shows on the web with no reload', async ({
	stack,
	person,
}) => {
	const path = join(clone, `recordings/${kept}.md`);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(
			/^title: .*$/m,
			'title: Edited on the desktop',
		),
	);
	await sync(stack, person, clone);

	// The repository hears main move (a poll until the notify Durable Object).
	await expect(row(kept)).toContainText('Edited on the desktop');
});

test('5. a transcript the desktop wrote that does not read shows with its text, and is repaired on the web', async ({
	stack,
	person,
}) => {
	const broken = '---\nrecordingId: [oops\n---\nsome text\n';
	await writeFile(join(clone, 'transcriptions/broken.md'), broken);
	await sync(stack, person, clone);

	const repairs = page.getByTestId('recording-repairs');
	await expect(repairs).toContainText('transcriptions/broken.md');
	const text = repairs.getByLabel('Text of transcriptions/broken.md');
	await expect(text).toHaveValue(broken);

	// Text that still does not fit is refused, and stays to fix.
	await text.fill(`---\nrecordingId: ${kept}\n---\nsome text\n`);
	await repairs.getByRole('button', { name: 'Save repair' }).click();
	await expect(repairs.getByRole('alert')).toContainText('createdAt');

	await text.fill(
		`---\nrecordingId: ${kept}\ncreatedAt: '2026-10-31T09:30:00.000Z'\nmodel: whisper-1\nendpoint: https://api.openai.com/v1\n---\nsome text\n`,
	);
	await repairs.getByRole('button', { name: 'Save repair' }).click();
	await expect(repairs).toHaveCount(0);

	await sync(stack, person, clone);
	const repaired = await readFile(
		join(clone, 'transcriptions/broken.md'),
		'utf8',
	);
	expect(repaired).toMatch(/^model: whisper-1$/m);
	expect(repaired).toMatch(/some text\n$/);
	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('6. signed out, the browser holds nothing', async () => {
	await (await settings()).getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByTestId('status-summary')).toHaveAttribute(
		'aria-label',
		/In this browser/,
	);
	await expect.poll(() => opfsFiles(page)).toEqual({});
	await expect(page.getByText('No recordings yet')).toBeVisible();
});
