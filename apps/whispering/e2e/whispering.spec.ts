/**
 * Whispering end to end, per engine, as one person in one persistent
 * browser profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * Whispering's web build is online (ADR-0786): recordings live in the
 * person's `whispering` repository, behind sign-in, and nothing is kept in
 * this browser. The desktop build is the Tauri window's folder; the
 * sandbox's CLI stands in for it here.
 *
 * 1. Signed out, Whispering asks for a sign-in. Signed in, a recording
 *    lands as its audio (`m4a` or `webm`) and its note; its title and
 *    transcript are edited, it is transcribed over a custom endpoint (a
 *    stub), one is deleted, and all of it is there after a reload.
 * 2. A take lands whole at Stop (ADR-0779): nothing is sent while it
 *    records, and leaving the page mid-recording (past the leave guard,
 *    where the engine shows it) loses the take, which the web does not
 *    promise to keep (ADR-0780).
 * 3. Transcription over the Epicenter account sends the account's API
 *    token (to a stub) and keeps the transcript in the repository.
 * 4. A desktop clone holds the recordings as written, audio included, and
 *    the folder fits the published contract.
 * 5. Signing out asks for a sign-in again, and the browser holds nothing.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BrowserContext,
	type Dialog,
	expect,
	type Page,
} from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	fakeMicrophone,
	opfsFiles,
	stackTest,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const test = stackTest('WHISPERING_E2E_STATE');

test.describe.configure({ mode: 'serial' });

/** The custom transcription endpoint the browser is set up with, answered by the test. */
const TRANSCRIBE = 'https://transcribe.example/v1';

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let app: string;
let kept: string;
let whole: string;
let transcribed = 0;
/** The repository writes the page sent, by method and path. */
const writes: string[] = [];

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `whispering-${browserName}-`));
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
	});
	await fakeMicrophone(context);
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
const rows = () => page.getByTestId('recording-row');
const row = (id: string) =>
	page.locator(`[data-testid="recording-row"][data-id="${id}"]`);
const detail = () => page.getByTestId('recording-detail');
const account = () => page.getByTestId('account-status');

/** The ids of the recordings the Recordings page lists, once it shows its list; then back Home. */
async function listedIds() {
	await pageLink('Recordings').click();
	await expect(
		rows().first().or(page.getByText('No recordings yet')),
	).toBeVisible();
	const ids = await rows().evaluateAll((found) =>
		found.map((row) => row.getAttribute('data-id') ?? ''),
	);
	await pageLink('Home').click();
	await expect(page.getByTestId('start-recording')).toBeVisible();
	return ids.sort();
}

/** Record about a second and a half from the home page; answers the new recording's id. */
async function record() {
	const before = await listedIds();
	await page.getByTestId('start-recording').click();
	await expect(page.getByTestId('stop-recording')).toBeVisible();
	await page.waitForTimeout(1500);
	await page.getByTestId('stop-recording').click();
	await expect(page.getByTestId('start-recording')).toBeVisible();
	await expect
		.poll(async () => (await listedIds()).length)
		.toBe(before.length + 1);
	const id = (await listedIds()).find((id) => !before.includes(id));
	expect(id).toBeTruthy();
	return id as string;
}

/** Open recording `id`'s details from the Recordings page. */
async function open(id: string) {
	await pageLink('Recordings').click();
	await row(id).locator('button[data-recording]').click();
	await expect(detail()).toHaveAttribute('data-recording-id', id);
}

/** Open Settings, where the models, their connections and the sign-in are; Escape closes it. */
async function settings() {
	await page.getByTestId('settings').click();
	await expect(account()).toBeVisible();
}

test('1. signed in, a recording lands in the repository, is edited, transcribed and deleted', async ({
	stack,
	person,
}) => {
	app = `${stack.app}/`;
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(app);
	await emptyOpfs(page);
	await page.evaluate((baseUrl) => {
		localStorage.clear();
		// One saved connection, keyless, chosen for transcription, as Settings
		// would save them in this computer's `connections.md`.
		localStorage.setItem(
			'epicenter.local/connections.md',
			`---\nconnections:\n  - id: stub\n    name: Stub\n    baseUrl: ${baseUrl}\n    models:\n      - whisper-1\n---\n`,
		);
		// This computer's `models.md` (`settings` from `@epicenter/local`).
		localStorage.setItem(
			'epicenter.local/models.md',
			'---\nchoices:\n  - job: transcribe\n    endpoint: stub\n    model: whisper-1\n---\n',
		);
	}, TRANSCRIBE);
	await page.goto(app);
	await expect(
		page.getByText('Sign in to record into your Epicenter repository.'),
	).toBeVisible();
	await expect(page.getByTestId('start-recording')).toHaveCount(0);

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(app);
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);

	kept = await record();
	const gone = await record();

	await open(kept);
	await detail().getByLabel('Recording title').fill('Standup notes');
	await expect(row(kept)).toContainText('Standup notes');
	await detail().getByTestId('file-details').click();
	await expect(detail().getByTestId('kept-in')).toHaveText('Your repository');

	await detail().getByTestId('transcribe').click();
	const transcript = detail().getByTestId('transcript-text');
	await expect(transcript).toHaveValue(/hello from the stub/);
	expect(transcribed).toBe(1);
	// The transcript is the body of its own note, saved as it is typed.
	await transcript.fill('hello, edited by hand');

	await open(gone);
	await detail().getByTestId('delete-recording').click();
	await page
		.getByRole('alertdialog')
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(gone)).toHaveCount(0);

	// Nothing is kept in this browser.
	expect(await opfsFiles(page)).toEqual({});

	// The repository still has them after a reload, once the edits landed.
	await expect(status()).toHaveAttribute('aria-label', /^Status: Online\./);
	await expect
		.poll(async () => {
			await page.reload();
			await open(kept);
			return detail().getByTestId('transcript-text').inputValue();
		})
		.toMatch(/hello, edited by hand/);
	await expect(row(kept)).toContainText('Standup notes');
	await expect(row(gone)).toHaveCount(0);
});

test('2. a take lands whole at Stop, and leaving mid-recording loses it', async ({
	stack,
}) => {
	await page.goto(app);
	const listedBefore = await listedIds();
	// A write is a folder's `commits`, or an attachment's bytes put at its
	// sha256; a read is any other request.
	const heard = (request: { method(): string; url(): string }) => {
		if (!request.url().startsWith(stack.origin)) return;
		const path = new URL(request.url()).pathname;
		if (path.endsWith('/commits') || request.method() === 'PUT')
			writes.push(`${request.method()} ${path}`);
	};
	page.on('request', heard);
	try {
		await page.getByTestId('start-recording').click();
		await expect(page.getByTestId('stop-recording')).toBeVisible();
		// Several pieces in: nothing is sent, its audio or its note.
		await page.waitForTimeout(2500);
		expect(writes).toEqual([]);

		// Leaving while a take runs (past the leave guard, where the engine
		// shows it) loses the take.
		const asked: string[] = [];
		const accept = (dialog: Dialog) => {
			asked.push(dialog.type());
			void dialog.accept();
		};
		page.on('dialog', accept);
		try {
			await page.reload();
		} finally {
			page.off('dialog', accept);
		}
		await expect(page.getByTestId('start-recording')).toBeVisible();
		expect(asked.every((type) => type === 'beforeunload')).toBe(true);
		expect(writes).toEqual([]);
		expect(await listedIds()).toEqual(listedBefore);
	} finally {
		page.off('request', heard);
	}

	// Stopped, a take lands as its audio and its note together.
	whole = await record();
});

test('3. transcription over the Epicenter account sends its token and keeps the transcript', async ({
	stack,
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

	// Epicenter's transcription model, as Settings would save the choice.
	await page.evaluate(() =>
		localStorage.setItem(
			'epicenter.local/models.md',
			'---\nchoices:\n  - job: transcribe\n    endpoint: hosted\n    model: whisper-1\n---\n',
		),
	);
	await page.reload();
	await settings();
	await expect(account()).toContainText('Signed in to');
	await expect(page.getByTestId('model-transcription-status')).toContainText(
		'whisper-1 at Epicenter',
	);
	await page.keyboard.press('Escape');

	// The account's API token goes with the audio, and the transcript is
	// kept, newest first.
	await open(kept);
	await detail().getByTestId('transcribe').click();
	const transcripts = detail().getByTestId('transcript-text');
	await expect(transcripts).toHaveCount(2);
	await expect(transcripts.first()).toHaveValue(/hello from Epicenter/);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatch(/^Bearer ep_at_/);
	expect(transcribed).toBe(1);
});

test('4. a desktop clone holds the recordings as written, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	const clone = join(person.home, 'whispering');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/whispering`,
		clone,
		// Outside the library, a clone names its link (ADR-0736).
		'--name',
		'My recordings',
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	const recordings = (await readdir(join(clone, 'recordings'))).sort();
	for (const id of [kept, whole]) {
		expect(recordings).toContain(`${id}.md`);
		// AAC where the engine records it, else Opus in WebM (decision 56).
		const audio = recordings.find(
			(name) => name.startsWith(`${id}.`) && !name.endsWith('.md'),
		);
		expect(audio).toMatch(/\.(m4a|webm)$/);
		expect(
			(await stat(join(clone, 'recordings', audio!))).size,
		).toBeGreaterThan(0);
	}
	expect(recordings).toHaveLength(4);
	expect(await readFile(join(clone, `recordings/${kept}.md`), 'utf8')).toMatch(
		/^title: Standup notes$/m,
	);
	const transcripts = await Promise.all(
		(await readdir(join(clone, 'transcriptions'))).map((name) =>
			readFile(join(clone, 'transcriptions', name), 'utf8'),
		),
	);
	expect(transcripts).toContainEqual(
		expect.stringMatching(/\nhello, edited by hand\n?$/),
	);
	expect(transcripts).toContainEqual(
		expect.stringMatching(/\nhello from Epicenter\n?$/),
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

test('5. signed out, Whispering asks for a sign-in again, and the browser holds nothing', async () => {
	await settings();
	await account().getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByText('Sign in to record into your Epicenter repository.'),
	).toBeVisible();
	expect(await opfsFiles(page)).toEqual({});
});
