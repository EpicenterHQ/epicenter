/**
 * Whispering end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Whispering's web build is its local variant: recordings live in this
 * browser's files (OPFS) for good, and nothing ever moves to a repository
 * (ADR-0700). Signing in is optional and grants capabilities only.
 *
 * 1. On this browser, with no account, a recording is kept as its audio
 *    (`m4a` or `webm`) and its note and nothing else; its title and
 *    transcript are edited, it is transcribed over a custom endpoint (a
 *    stub), one is deleted with its files, and all of it survives a reload.
 * 2. Offline, recording and editing still work, and survive a reload.
 * 3. Transcription over the Epicenter account needs a sign-in; signed in, it
 *    sends the account's API token (to a stub) and keeps the transcript
 *    here. Signing in moved nothing: this browser's files are as they were,
 *    and the person has no `whispering` repository (`epicenter repos`).
 * 4. Signing out keeps every recording.
 */
import { mkdtemp, rm } from 'node:fs/promises';
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

/** The custom transcription endpoint the browser is set up with, answered by the test. */
const TRANSCRIBE = 'https://transcribe.example/v1';

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let app: string;
let kept: string;
let offline: string;
/** This browser's files, as the last step left them. */
let localFiles: Record<string, string>;
let transcribed = 0;

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
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

/** A page, from the sidebar. */
const pageLink = (name: 'Home' | 'Recordings') =>
	page.getByRole('link', { name, exact: true }).first();
const status = () => page.getByTestId('status-summary');
const row = (id: string) =>
	page.locator(`[data-testid="recording-row"][data-id="${id}"]`);
const detail = () => page.getByTestId('recording-detail');
const account = () => page.getByTestId('account-status');

/** The recordings this origin's OPFS holds a note for, by id. */
async function recordingIds() {
	return Object.keys(await opfsFiles(page))
		.flatMap((path) => /^recordings\/([^/]+)\.md$/.exec(path)?.[1] ?? [])
		.sort();
}

/** The paths of this origin's OPFS files under `prefix`. */
async function pathsUnder(prefix: string) {
	return Object.keys(await opfsFiles(page))
		.filter((path) => path.startsWith(prefix))
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

/** Open Settings, where the connections and the optional sign-in are; Escape closes it. */
async function settings() {
	await page.getByTestId('settings').click();
	await expect(account()).toBeVisible();
}

test('1. on this browser, a recording is kept as its audio and note, edited, transcribed and deleted, with no account', async ({
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
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this browser\./,
	);
	// One variant: no other view to switch to.
	await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Synced' })).toHaveCount(0);

	kept = await record();
	const gone = await record();

	// Each recording is two files, its audio and its note, and nothing else
	// is written: no outbox, no cache.
	const files = await opfsFiles(page);
	const audioPath = Object.keys(files).find(
		(path) => path.startsWith(`recordings/${kept}.`) && !path.endsWith('.md'),
	) as string;
	// AAC where the engine records it, else Opus in WebM (decision 56).
	expect(audioPath).toMatch(/\.(m4a|webm)$/);
	expect(Object.keys(files).sort()).toEqual(
		[
			`recordings/${kept}.md`,
			audioPath,
			`recordings/${gone}.md`,
			audioPath.replace(kept, gone),
		].sort(),
	);
	// Not empty: the sha256 of no bytes.
	expect(files[audioPath]).not.toBe(
		'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);
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
	await detail().getByTestId('file-details').click();
	await expect(detail().getByTestId('kept-in')).toHaveText('This browser');

	await detail().getByTestId('transcribe').click();
	const transcript = detail().getByTestId('transcript-text');
	await expect(transcript).toHaveValue(/hello from the stub/);
	expect(transcribed).toBe(1);
	await expect.poll(() => pathsUnder('transcriptions/')).toHaveLength(1);
	const [transcriptPath] = await pathsUnder('transcriptions/');

	// The transcript is the body of its own note, saved as it is typed.
	await transcript.fill('hello, edited by hand');
	await expect
		.poll(() => opfsText(page, transcriptPath as string))
		.toMatch(/\nhello, edited by hand\n?$/);

	await open(gone);
	await detail().getByTestId('delete-recording').click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);
	await expect.poll(() => pathsUnder(`recordings/${gone}.`)).toEqual([]);

	// Still there after a reload.
	await page.reload();
	await expect(row(kept)).toContainText('Standup notes');
	await open(kept);
	await expect(detail().getByTestId('transcript-text')).toHaveValue(
		/hello, edited by hand/,
	);
});

test('2. offline, recording and editing still work, and survive a reload', async () => {
	// Online, load both pages this step moves between (with the fixture
	// microphone the URL asks for); offline, nothing more can load.
	await page.goto(app);
	await pageLink('Recordings').click();
	await expect(row(kept)).toBeVisible();
	await pageLink('Home').click();
	await expect(page.getByTestId('start-recording')).toBeVisible();

	const online = await goOffline(context);
	try {
		offline = await record();
		await pageLink('Recordings').click();
		await open(offline);
		await detail().getByLabel('Recording title').fill('Offline take');
		await expect
			.poll(() => opfsText(page, `recordings/${offline}.md`))
			.toMatch(/^title: Offline take$/m);
		await expect(status()).toHaveAttribute(
			'aria-label',
			/^Status: On this browser\./,
		);
	} finally {
		await online();
	}
	await page.reload();
	await expect(row(offline)).toContainText('Offline take');
	await expect(row(kept)).toContainText('Standup notes');
});

test('3. signing in enables hosted transcription and moves nothing', async ({
	stack,
	person,
}) => {
	// The deployment's transcription route, answered by the test: the stack
	// has no provider behind it.
	const hosted = `${stack.origin}/v1/audio/transcriptions`;
	const sent: (string | null)[] = [];
	const cors = {
		'access-control-allow-origin': stack.app,
		'access-control-allow-headers': 'authorization, content-type',
		'access-control-allow-methods': 'POST',
	};
	await context.route(hosted, (route) => {
		if (route.request().method() === 'OPTIONS')
			return route.fulfill({ status: 204, headers: cors });
		sent.push(route.request().headers().authorization ?? null);
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			headers: cors,
			body: JSON.stringify({ text: 'hello from Epicenter' }),
		});
	});

	// Transcription over the Epicenter account is refused until signed in.
	await settings();
	await page
		.getByTestId('connection-transcription')
		.getByRole('button', { name: 'Use Epicenter account' })
		.click();
	await expect(
		page.getByTestId('connection-transcription-status'),
	).toContainText(`${stack.origin}/v1`);
	await page.keyboard.press('Escape');
	await open(kept);
	await detail().getByTestId('transcribe').click();
	await expect(detail().getByTestId('run-error')).toContainText(
		'Sign in to Epicenter',
	);
	expect(sent).toEqual([]);
	await detail().getByTestId('dismiss-run').click();

	localFiles = await opfsFiles(page);

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await settings();
	const callback = page.waitForURL(/\/auth\/callback/, { waitUntil: 'commit' });
	await account().getByRole('button', { name: 'Sign in' }).click();
	await callback;
	await page.waitForURL((url) => !url.pathname.startsWith('/auth/'));
	await settings();
	await expect(account()).toContainText('Signed in to');
	await page.keyboard.press('Escape');

	// Signing in moved nothing.
	await expect(status()).toHaveAttribute(
		'aria-label',
		/^Status: On this browser\./,
	);
	expect(await opfsFiles(page)).toEqual(localFiles);

	// Signed in, the account's API token goes with the audio, and the
	// transcript is kept here, newest first.
	await pageLink('Recordings').click();
	await open(kept);
	await detail().getByTestId('transcribe').click();
	const transcripts = detail().getByTestId('transcript-text');
	await expect(transcripts).toHaveCount(2);
	await expect(transcripts.first()).toHaveValue(/hello from Epicenter/);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatch(/^Bearer ep_at_/);
	expect(transcribed).toBe(1);
	await expect
		.poll(async () =>
			Promise.all(
				(await pathsUnder('transcriptions/')).map((path) =>
					opfsText(page, path),
				),
			),
		)
		.toContainEqual(expect.stringMatching(/\nhello from Epicenter\n?$/));
	// The new transcript is the only change to this browser's files.
	const after = await opfsFiles(page);
	expect(
		Object.keys(after).filter((path) => !(path in localFiles)),
	).toHaveLength(1);
	for (const [path, sha] of Object.entries(localFiles))
		expect(after[path], path).toBe(sha);
	localFiles = after;

	// The person has no whispering repository: nothing was ever sent to one.
	const listed = await epicenter(stack, person, 'repos', '--json');
	expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(0);
	const listing = JSON.parse(listed.stdout) as {
		namespaces: { repositories: { name: string }[] }[];
	};
	expect(
		listing.namespaces.flatMap((namespace) =>
			namespace.repositories.map((repository) => repository.name),
		),
	).not.toContain('whispering');
});

test('4. signing out keeps every recording', async () => {
	await settings();
	await account().getByRole('button', { name: 'Sign out' }).click();
	await expect(account()).toContainText('Optional: sign in');
	await page.keyboard.press('Escape');
	expect(await opfsFiles(page)).toEqual(localFiles);
	await page.reload();
	await expect(row(kept)).toContainText('Standup notes');
	await expect(row(offline)).toContainText('Offline take');
	expect(await opfsFiles(page)).toEqual(localFiles);
});
