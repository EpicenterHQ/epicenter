/**
 * The demo end to end, per engine, as one person in one persistent browser
 * profile, served by `vite preview` (see `playwright.config.ts`). The demo
 * keeps its recordings in this browser's files (OPFS), with no account, and
 * nothing moves anywhere else (ADR-0700).
 *
 * 1. With no sign-in offered and no request leaving the page's origin, a
 *    recording lands in OPFS as its audio, which grows while it records
 *    (decision 84), and its note; it plays, is renamed, and another is
 *    deleted; all of it survives a reload.
 * 2. Offline, it still records and renames.
 * 3. This browser's files fit the published contract (`epicenter check`).
 * 4. WebKit only, in an ephemeral context (no OPFS, as in Safari's private
 *    windows): the demo, which writes a recording as it records, refuses to
 *    record and says why, before any microphone opens.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Request,
	test,
} from 'playwright/test';
import {
	emptyOpfs,
	fakeMicrophone,
	goOffline,
	opfsFiles,
	opfsText,
	run,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

const app = 'http://localhost:5214';
const cli = resolve(import.meta.dirname, '../../../packages/cli/src/bin.ts');

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let kept: string;
let walk: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `recorder-demo-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(
		profile,
		launchOptions,
	);
	await fakeMicrophone(context);
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

/** The sha256 of no bytes: what an empty recording would hash to. */
const EMPTY_SHA =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const onBrowser = () => page.getByRole('region', { name: 'On this browser' });
const rows = (view: Locator) => view.locator('li[data-id]');
const row = (view: Locator, id: string) => view.locator(`li[data-id="${id}"]`);
const ids = (view: Locator) =>
	rows(view).evaluateAll((items) =>
		items.map((item) => item.getAttribute('data-id') as string),
	);

/** Record about a second in `view`; answers the new row's id. */
async function record(view: Locator) {
	const before = new Set(await ids(view));
	await view.getByRole('button', { name: 'Record' }).click();
	await expect(view.getByRole('button', { name: 'Stop' })).toBeVisible();
	await page.waitForTimeout(1000);
	await view.getByRole('button', { name: 'Stop' }).click();
	await expect(rows(view)).toHaveCount(before.size + 1);
	await expect(view.getByRole('button', { name: 'Record' })).toBeEnabled();
	await expect(view.getByRole('alert')).toHaveCount(0);
	const made = (await ids(view)).find((each) => !before.has(each));
	if (!made) throw new Error('no new recording');
	return made;
}

/** Rename the recording `id` in `view` and wait for the save. */
async function rename(view: Locator, id: string, title: string) {
	await row(view, id).getByLabel('Title').fill(title);
	await row(view, id).getByRole('button', { name: 'Save title' }).click();
	await expect(row(view, id).getByTestId('status')).toHaveText('Saved');
}

/** The recording paths in this origin's OPFS (the device's own hidden files left out). */
async function recordingFiles() {
	return Object.keys(await opfsFiles(page))
		.filter((path) => path.startsWith('recordings/'))
		.sort();
}

/** The audio path of `id` among `paths`, whatever its extension. */
function audioOf(paths: string[], id: string) {
	const audio = paths.find(
		(path) => path.includes(`${id}.`) && !path.endsWith('.md'),
	);
	if (!audio) throw new Error(`no audio for ${id} in ${paths.join(', ')}`);
	return audio;
}

test('1. a recording lands in OPFS as its audio and its note, is played, renamed and deleted, and survives a reload', async () => {
	const elsewhere: string[] = [];
	const listen = (request: Request) => {
		const url = request.url();
		if (/^https?:/.test(url) && !url.startsWith(`${app}/`)) elsewhere.push(url);
	};
	page.on('request', listen);
	try {
		// WebKit keeps OPFS outside the profile directory, so an earlier
		// run's files may still be there: start from an empty origin.
		await page.goto(`${app}/`);
		await emptyOpfs(page);
		await page.goto(`${app}/`);
		// The demo needs no account, and offers none.
		await expect(page.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
		await expect(onBrowser().getByText('No recordings yet.')).toBeVisible();

		// The audio is in this browser's files while it records, and grows.
		await onBrowser().getByRole('button', { name: 'Record' }).click();
		await expect(
			onBrowser().getByRole('button', { name: 'Stop' }),
		).toBeVisible();
		const growing = async () =>
			Object.entries(await opfsFiles(page)).find(([path]) =>
				/^recordings\/[^/]+\.(m4a|webm)$/.test(path),
			)?.[1];
		await expect.poll(growing).toBeDefined();
		const firstPiece = await growing();
		await expect.poll(growing, { timeout: 10_000 }).not.toBe(firstPiece);
		await onBrowser().getByRole('button', { name: 'Stop' }).click();
		await expect(rows(onBrowser())).toHaveCount(1);
		await expect(
			onBrowser().getByRole('button', { name: 'Record' }),
		).toBeEnabled();
		kept = (await ids(onBrowser()))[0]!;
		// Two files: the audio, and its note at Stop.
		await expect.poll(recordingFiles).toHaveLength(2);
		const files = await recordingFiles();
		const audio = audioOf(files, kept);
		expect(audio).toMatch(/\.(m4a|webm)$/);
		expect(files).toEqual([audio, `recordings/${kept}.md`].sort());
		expect((await opfsFiles(page))[audio]).not.toBe(EMPTY_SHA);

		await row(onBrowser(), kept).getByRole('button', { name: 'Play' }).click();
		await expect(row(onBrowser(), kept).locator('audio')).toHaveAttribute(
			'src',
			/^blob:/,
		);

		await rename(onBrowser(), kept, 'Morning walk');
		await expect
			.poll(() => opfsText(page, `recordings/${kept}.md`))
			.toMatch(/^title: Morning walk$/m);

		const discarded = await record(onBrowser());
		await expect.poll(recordingFiles).toHaveLength(4);
		await row(onBrowser(), discarded)
			.getByRole('button', { name: 'Delete' })
			.click();
		await expect(row(onBrowser(), discarded)).toHaveCount(0);
		await expect.poll(recordingFiles).toEqual(files);

		await page.reload();
		await expect(row(onBrowser(), kept).getByLabel('Title')).toHaveValue(
			'Morning walk',
		);
		await expect(rows(onBrowser())).toHaveCount(1);
	} finally {
		page.off('request', listen);
	}
	// The page reached nothing beyond its own origin: no sign-in, no upload.
	expect(elsewhere).toEqual([]);
});

test('2. offline, it still records and renames', async () => {
	const back = await goOffline(context);
	try {
		walk = await record(onBrowser());
		await rename(onBrowser(), walk, 'Offline walk');
		await expect
			.poll(() => opfsText(page, `recordings/${walk}.md`))
			.toMatch(/^title: Offline walk$/m);
	} finally {
		await back();
	}
	await expect.poll(recordingFiles).toHaveLength(4);
	await page.reload();
	await expect(rows(onBrowser())).toHaveCount(2);
	await expect(row(onBrowser(), walk).getByLabel('Title')).toHaveValue(
		'Offline walk',
	);
});

test('3. the files in this browser fit the published contract', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'recorder-demo-device-'));
	try {
		const paths = await recordingFiles();
		expect(paths).toEqual(
			expect.arrayContaining([
				`recordings/${kept}.md`,
				`recordings/${walk}.md`,
			]),
		);
		for (const path of paths) {
			await mkdir(dirname(join(folder, path)), { recursive: true });
			// The contract names audio by its path alone; a note is checked whole.
			await writeFile(
				join(folder, path),
				path.endsWith('.md') ? ((await opfsText(page, path)) ?? '') : '',
			);
		}
		const checked = await run(
			['bun', '--no-install', cli, 'check', `${app}/contract.json`, folder],
			{ cwd: folder, env: { ...process.env } as Record<string, string> },
		);
		expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});

test('4. where the browser keeps no files, the demo refuses to record and says why, before any microphone opens', async ({
	browserName,
	playwright,
}) => {
	// WebKit's ephemeral contexts reject `getDirectory()`, as Safari's
	// private windows do; Chromium has no such context to test with.
	test.skip(browserName !== 'webkit', 'only WebKit refuses OPFS here');
	const ephemeral = await playwright.webkit.launch();
	try {
		const tabContext = await ephemeral.newContext();
		await fakeMicrophone(tabContext);
		const tab = await tabContext.newPage();
		await tab.goto(`${app}/`);
		await tab.getByRole('button', { name: 'Record' }).click();
		const refused = tab.getByText('Could not start recording:');
		await expect(refused).toContainText(
			'The recording could not be saved there',
		);
		await expect(refused).toContainText('no private file storage');
		await expect(tab.getByRole('button', { name: 'Stop' })).toHaveCount(0);
		await expect(tab.getByRole('button', { name: 'Record' })).toBeEnabled();
	} finally {
		await ephemeral.close();
	}
});
