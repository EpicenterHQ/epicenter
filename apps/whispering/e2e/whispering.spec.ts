/**
 * Whispering end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Whispering has two views (decision 76): "On this device" (`/`), this
 * browser's files, and "Synced" (`/synced`), the person's repository, each
 * with the same pages.
 *
 * 1. Signed out, recordings are kept on this device (OPFS) as a note and
 *    its audio (`m4a` or `webm`), queued to upload; a title is edited, a
 *    recording is transcribed (over a stubbed endpoint), and one is deleted
 *    with its files. "Synced" asks for a sign-in.
 * 2. Signed in, they upload on their own: each leaves "On this device" and
 *    the browser's files, keeping only the audio as a cache, and appears in
 *    "Synced", where the cached audio plays with no download. One recorded
 *    while signed in follows, and is transcribed in "Synced".
 * 3. `epicenter clone` and `git lfs pull` give the bytes the browser
 *    recorded and the notes as edited, and `epicenter check` passes against
 *    the published contract.
 * 4. A title edited on the desktop and synced shows in "Synced", with no
 *    reload.
 * 5. A transcript the desktop wrote that does not read shows in "Synced"
 *    with its text, and saving fixed text there repairs it.
 * 6. Signing out leaves this browser with nothing, and "Synced" asks for a
 *    sign-in again.
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
	recordUploaderStarts,
	run,
	stackTest,
	sync,
	uploaderStarts,
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
let app: string;
let kept: string;
let fresh: string;
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

const views = () => page.getByRole('navigation', { name: 'Views' });
/** A page of the open view, from the sidebar. */
const pageLink = (name: 'Home' | 'Recordings') =>
	page.getByRole('link', { name, exact: true }).first();
const status = () => page.getByTestId('status-summary');
const row = (id: string) =>
	page.locator(`[data-testid="recording-row"][data-id="${id}"]`);
const detail = () => page.getByTestId('recording-detail');
const SIGN_IN_TO_SEE =
	'Sign in to see the recordings in your Epicenter repository.';

/**
 * The recordings this origin's OPFS has kept, by id: those still on the
 * device, and those whose audio an upload cached after letting go of them.
 */
async function recordingIds() {
	const ids = Object.keys(await opfsFiles(page)).flatMap((path) => {
		const id =
			/^recordings\/([^/]+)\.md$/.exec(path)?.[1] ??
			/^\.epicenter\/cache\/recordings\/([^/]+)\.[^./]+$/.exec(path)?.[1];
		return id === undefined ? [] : [id];
	});
	return [...new Set(ids)].sort();
}

/** Record about a second and a half from a home page; answers the new recording's id. */
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

/** Open recording `id`'s details from a Recordings page. */
async function open(id: string) {
	await row(id).locator('button[data-recording]').click();
	await expect(detail()).toHaveAttribute('data-recording-id', id);
}

/** Open Settings, where the account is. */
async function settings() {
	await page.getByRole('button', { name: 'Settings' }).click();
	return page.getByTestId('account-status');
}

test('1. signed out, recordings are kept on this device, edited, transcribed and deleted', async ({
	stack,
	microphone,
}) => {
	app = `${stack.app}/${microphone === 'tone' ? '?fixture=tone' : ''}`;
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
	await expect(
		views().getByRole('link', { name: 'On this device' }),
	).toHaveAttribute('aria-current', 'page');
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this device\./,
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

	await pageLink('Recordings').click();
	await expect(row(kept)).toBeVisible();
	await expect(row(gone)).toBeVisible();

	await open(kept);
	await detail().getByLabel('Recording title').fill('Standup notes');
	await expect
		.poll(() => opfsText(page, `recordings/${kept}.md`))
		.toMatch(/^title: Standup notes$/m);
	await expect(detail().getByTestId('audio-player')).toHaveAttribute(
		'data-audio-cached',
		'false',
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

	// "Synced" is the repository's, which needs a sign-in.
	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(page.getByText(SIGN_IN_TO_SEE)).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this device\./,
	);
});

test('2. signed in, recordings upload: each leaves this device and appears in Synced, where its cached audio plays', async ({
	stack,
	person,
}) => {
	// A signed-in session on the API; the real authorization redirect does the rest.
	await recordUploaderStarts(context);
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	const callback = page.waitForURL(/\/auth\/callback/, { waitUntil: 'commit' });
	await (await settings()).getByRole('button', { name: 'Sign in' }).click();
	await callback;
	await page.waitForURL((url) => !url.pathname.startsWith('/auth/'));

	await pageLink('Recordings').click();
	try {
		// The uploader moves it: this device's view and notes empty, and the
		// audio stays as a cache, outside the contract's paths, byte for byte.
		await expect(row(kept)).toHaveCount(0, { timeout: 60_000 });
		await expect
			.poll(() => opfsFiles(page), { timeout: 60_000 })
			.toEqual({ [`.epicenter/cache/${audioPath}`]: audioSha });
	} catch (cause) {
		// Kept with the failed step's results: the page's log, status and files.
		await writeFile(
			test.info().outputPath('diagnosis.json'),
			JSON.stringify(
				{
					status: await status().getAttribute('aria-label'),
					opfs: await opfsFiles(page),
					console: consoled,
				},
				null,
				2,
			),
		);
		throw cause;
	}
	await expect(page.getByText('No recordings yet')).toBeVisible();
	// The callback page only finished sign-in: no repository, no uploader.
	const uploaders = await uploaderStarts(page);
	expect(uploaders.length).toBeGreaterThan(0);
	expect(uploaders.filter((path) => path.includes('/auth/callback'))).toEqual(
		[],
	);

	// One recorded on this device while signed in follows on its own.
	await page.goto(app);
	fresh = await record();
	await expect
		.poll(async () =>
			Object.keys(await opfsFiles(page)).filter((path) =>
				path.startsWith('recordings/'),
			),
		)
		.toEqual([]);

	await views().getByRole('link', { name: 'Synced' }).click();
	await expect(views().getByRole('link', { name: 'Synced' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Synced\./);
	await expect(page.getByTestId('latest-recording')).toBeVisible();
	await pageLink('Recordings').click();
	await expect(row(kept)).toContainText('Standup notes');
	await expect(row(fresh)).toBeVisible();

	// Played from the cache: nothing comes down through Git LFS.
	const lfs: string[] = [];
	const listen = (request: { url(): string }) => {
		if (request.url().includes('/info/lfs/')) lfs.push(request.url());
	};
	page.on('request', listen);
	await open(kept);
	const player = detail().getByTestId('audio-player');
	await expect(player).toHaveAttribute('data-audio-cached', 'true');
	await expect(player).toHaveAttribute('src', /^blob:/);
	await expect(detail().getByTestId('transcript-text')).toHaveValue(
		/hello from the stub/,
	);

	// One transcribed in "Synced" sends its cached audio, and its transcript
	// goes to the repository, never this device.
	await open(fresh);
	await expect(detail().getByTestId('audio-player')).toHaveAttribute(
		'data-audio-cached',
		'true',
	);
	await detail().getByTestId('transcribe').click();
	await expect(detail().getByTestId('transcript-text')).toHaveValue(
		/hello from the stub/,
	);
	page.off('request', listen);
	expect(lfs).toEqual([]);
	expect(transcribed).toBe(2);
	expect(
		Object.keys(await opfsFiles(page)).filter(
			(path) => !path.startsWith('.epicenter/cache/'),
		),
	).toEqual([]);
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
	const transcripts = await Promise.all(
		listed.stdout
			.trim()
			.split('\n')
			.map((path) => readFile(join(clone, path), 'utf8')),
	);
	expect(transcripts).toHaveLength(2);
	// House style quotes a value YAML would otherwise read as something else.
	for (const id of [kept, fresh])
		expect(
			transcripts.find((text) =>
				new RegExp(`^recordingId: "?${id}"?$`, 'm').test(text),
			),
		).toMatch(/hello from the stub\n$/);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('4. a title edited on the desktop shows in Synced with no reload', async ({
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

test('5. a transcript the desktop wrote that does not read shows in Synced with its text, and is repaired there', async ({
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

test('6. signed out, the browser holds nothing, and Synced asks for a sign-in', async () => {
	await (await settings()).getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByText(SIGN_IN_TO_SEE)).toBeVisible();
	await page.getByRole('link', { name: 'On this device' }).click();
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this device\./,
	);
	await expect.poll(() => opfsFiles(page)).toEqual({});
	await pageLink('Recordings').click();
	await expect(page.getByText('No recordings yet')).toBeVisible();
});
