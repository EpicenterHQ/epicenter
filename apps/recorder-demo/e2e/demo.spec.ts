/**
 * The demo end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * The demo has two variants, each over one store for the page's life, and
 * nothing moves between them (ADR-0700): "On this browser" (`/`), this
 * browser's files, with no account; and "Online" (`/online`), the person's
 * repository, signed in.
 *
 * 1. On this browser, with no sign-in offered and no request to the server,
 *    a recording lands in OPFS as its audio and its note; it plays, is
 *    renamed, and another is deleted; all of it survives a reload.
 * 2. Offline, the local variant still records and renames.
 * 3. Online asks for a sign-in; signed in, it shows the repository, which
 *    holds none of this browser's recordings. A recording made and renamed
 *    there lands in the repository, plays from it, and never reaches this
 *    browser's files.
 * 4. `epicenter clone` holds the note and the audio as a Git LFS pointer to
 *    the bytes the page played, which `git lfs pull` brings down, and
 *    `epicenter check` passes against the published contract.
 * 5. A title edited on the desktop and synced shows online, with no reload.
 * 6. A rename online over a desktop rename is refused as `Conflict`; the
 *    draft stays, and saving again lands it.
 * 7. Shared read only with a second person (`epicenter share`), the
 *    recording shows and plays online in their own signed-in browser,
 *    opened with `?repository=<owner>/recorder-demo`.
 * 8. Signing in moved nothing: this browser's recordings and files are as
 *    they were, and the repository has none of them. Signing out leaves
 *    them too.
 * 9. WebKit only, in an ephemeral context (no OPFS, as in Safari's private
 *    windows): a recording the browser cannot keep stays in the page, to
 *    save again or download.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	type Request,
} from 'playwright/test';
import {
	emptyOpfs,
	epicenter,
	goOffline,
	opfsFiles,
	opfsText,
	run,
	stackTest,
	sync,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

/** Which microphone a project records from: the engine's capture device, or `?fixture=tone`. */
export type DemoOptions = { microphone: 'device' | 'tone' };

const test = stackTest('RECORDER_DEMO_E2E_STATE').extend<object, DemoOptions>({
	microphone: ['device', { option: true, scope: 'worker' }],
});

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let kept: string;
let walk: string;
/** This browser's files once the local steps are done. */
let localFiles: Record<string, string>;
/** The recording made online, its audio's path, and the sha256 of the bytes the page played. */
let online: string;
let onlineAudio: string;
let playedSha: string;
let clone: string;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	profile = await mkdtemp(join(tmpdir(), `recorder-demo-${browserName}-`));
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(
		profile,
		launchOptions,
	);
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
	if (profile) await rm(profile, { recursive: true, force: true });
});

/** The sha256 of no bytes: what an empty recording would hash to. */
const EMPTY_SHA =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const ways = () =>
	page.getByRole('navigation', { name: 'Ways to use the recorder' });
const onBrowser = () => page.getByRole('region', { name: 'On this browser' });
const onlineView = () => page.getByRole('region', { name: 'Online' });
const signInAsked = () =>
	onlineView().getByText('Sign in to record into your Epicenter repository.');
const rows = (view: Locator) => view.locator('li[data-id]');
const row = (view: Locator, id: string) => view.locator(`li[data-id="${id}"]`);
const ids = (view: Locator) =>
	rows(view).evaluateAll((items) =>
		items.map((item) => item.getAttribute('data-id') as string),
	);

/** `path` on the demo, recording from the tone when the project does. */
function at(
	stack: { app: string },
	microphone: DemoOptions['microphone'],
	path: string,
) {
	return `${stack.app}${path}${microphone === 'tone' ? '?fixture=tone' : ''}`;
}

/** Record about a second in `view`; answers the new row's id. */
async function record(view: Locator) {
	const before = new Set(await ids(view));
	await view.getByRole('button', { name: 'Record' }).click();
	await expect(view.getByRole('button', { name: 'Stop' })).toBeVisible();
	await page.waitForTimeout(1000);
	await view.getByRole('button', { name: 'Stop' }).click();
	await expect(rows(view)).toHaveCount(before.size + 1);
	await expect(view.getByRole('button', { name: 'Record' })).toBeEnabled();
	await expect(view.getByTestId('unsaved')).toHaveCount(0);
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

test('1. on this browser, a recording lands in OPFS as its audio and its note, is played, renamed and deleted, and survives a reload', async ({
	stack,
	microphone,
}) => {
	const server: string[] = [];
	const listen = (request: Request) => {
		if (request.url().startsWith(stack.origin)) server.push(request.url());
	};
	page.on('request', listen);
	try {
		// WebKit keeps OPFS outside the profile directory, so an earlier
		// run's files may still be there: start from an empty origin.
		await page.goto(at(stack, microphone, '/'));
		await emptyOpfs(page);
		await page.goto(at(stack, microphone, '/'));
		await expect(
			ways().getByRole('link', { name: 'On this browser' }),
		).toHaveAttribute('aria-current', 'page');
		// The local variant needs no account, and offers none.
		await expect(page.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
		await expect(onBrowser().getByText('No recordings yet.')).toBeVisible();

		kept = await record(onBrowser());
		// Two writes: the audio, then its note.
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
	// The page never reached the server: no sign-in, no upload.
	expect(server).toEqual([]);
});

test('2. offline, the local variant still records and renames', async () => {
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
	localFiles = await opfsFiles(page);
});

test('3. online, signed in, shows the repository; a recording made and renamed there lands in it and plays from it, never in this browser', async ({
	stack,
	person,
	microphone,
}) => {
	await ways().getByRole('link', { name: 'Online' }).click();
	await expect(page).toHaveURL(`${stack.app}/online`);
	await expect(signInAsked()).toBeVisible();
	await page.goto(at(stack, microphone, '/online'));

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await onlineView().getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await expect(page).toHaveURL(at(stack, microphone, '/online'));
	await expect(ways().getByRole('link', { name: 'Online' })).toHaveAttribute(
		'aria-current',
		'page',
	);
	// The repository is its own store: none of this browser's recordings are in it.
	await expect(onlineView().getByText('No recordings yet.')).toBeVisible();

	online = await record(onlineView());
	await rename(onlineView(), online, 'Web title');

	await row(onlineView(), online).getByRole('button', { name: 'Play' }).click();
	const audio = row(onlineView(), online).locator('audio');
	await expect(audio).toHaveAttribute('src', /^blob:/);
	playedSha = await page.evaluate(
		async (src) => {
			const bytes = await (await fetch(src)).arrayBuffer();
			const digest = await crypto.subtle.digest('SHA-256', bytes);
			return [...new Uint8Array(digest)]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
		},
		(await audio.getAttribute('src')) as string,
	);
	expect(playedSha).not.toBe(EMPTY_SHA);

	// Still there, from the repository, after a reload.
	await page.reload();
	await expect(row(onlineView(), online).getByLabel('Title')).toHaveValue(
		'Web title',
	);
	await expect(rows(onlineView())).toHaveCount(1);
	// Nothing online is kept in this browser.
	expect(await opfsFiles(page)).toEqual(localFiles);
});

test('4. a desktop clone holds the note and the audio the page played, and the folder fits the contract', async ({
	stack,
	person,
}) => {
	clone = join(person.home, 'recorder-demo');
	const cloned = await epicenter(
		stack,
		person,
		'clone',
		`${person.namespace}/recorder-demo`,
		clone,
	);
	expect(cloned.code, `${cloned.stdout}\n${cloned.stderr}`).toBe(0);

	// Only what was recorded online: the note and its audio.
	const listed = (await readdir(join(clone, 'recordings'))).map(
		(name) => `recordings/${name}`,
	);
	onlineAudio = audioOf(listed, online);
	expect(listed.sort()).toEqual(
		[onlineAudio, `recordings/${online}.md`].sort(),
	);
	expect(
		await readFile(join(clone, `recordings/${online}.md`), 'utf8'),
	).toMatch(/^title: Web title$/m);

	// Git holds the audio as an LFS pointer to the bytes the page played.
	const pointer = await run(['git', 'cat-file', '-p', `HEAD:${onlineAudio}`], {
		cwd: clone,
		env: person.env,
	});
	expect(pointer.code, pointer.stderr).toBe(0);
	expect(pointer.stdout).toMatch(/^version https:\/\/git-lfs\.github\.com\//);
	expect(pointer.stdout).toContain(`oid sha256:${playedSha}`);
	const pulled = await run(['git', 'lfs', 'pull'], {
		cwd: clone,
		env: person.env,
	});
	expect(pulled.code, pulled.stderr).toBe(0);
	expect(sha256(await readFile(join(clone, onlineAudio)))).toBe(playedSha);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('5. a title edited on the desktop shows online, with no reload', async ({
	stack,
	person,
}) => {
	const notePath = join(clone, `recordings/${online}.md`);
	const text = await readFile(notePath, 'utf8');
	await writeFile(
		notePath,
		text.replace(/^title: .*$/m, 'title: Desktop title'),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(row(onlineView(), online).getByLabel('Title')).toHaveValue(
		'Desktop title',
	);
});

test('6. a rename online over a desktop rename is refused, keeps its draft, and lands on a second save', async ({
	stack,
	person,
}) => {
	const notePath = join(clone, `recordings/${online}.md`);
	const text = await readFile(notePath, 'utf8');
	expect(text).toMatch(/^title: Desktop title$/m);
	const title = row(onlineView(), online).getByLabel('Title');
	await title.fill('Web again');
	await writeFile(
		notePath,
		text.replace(/^title: .*$/m, 'title: Desktop again'),
	);
	await sync(stack, person, clone);

	const status = row(onlineView(), online).getByTestId('status');
	const save = row(onlineView(), online).getByRole('button', {
		name: 'Save title',
	});
	await save.click();
	// Both renamed: the web's rename is not written over the desktop's.
	await expect(status).toHaveText(/^Changed elsewhere to “Desktop again”/);
	await expect(title).toHaveValue('Web again');
	await sync(stack, person, clone);
	expect(await readFile(notePath, 'utf8')).toMatch(/^title: Desktop again$/m);

	// Having been told, saving again applies the web's title over it.
	await save.click();
	await expect(status).toHaveText('Saved');
	await sync(stack, person, clone);
	const landed = await readFile(notePath, 'utf8');
	expect(landed).toMatch(/^title: Web again$/m);
	expect(landed).not.toContain('<<<<<<<');
});

test('7. shared with a second person, the recording shows and plays online in their browser', async ({
	stack,
	person,
	playwright,
	browserName,
	launchOptions,
}) => {
	const guest = stack.guests[test.info().project.name];
	if (!guest) throw new Error(`no guest for ${test.info().project.name}`);
	const repository = `${person.namespace}/recorder-demo`;
	const shared = await epicenter(
		stack,
		person,
		'share',
		repository,
		guest.namespace,
		'--read',
	);
	expect(shared.code, `${shared.stdout}\n${shared.stderr}`).toBe(0);

	const guestProfile = await mkdtemp(
		join(tmpdir(), `recorder-demo-guest-${browserName}-`),
	);
	const guestContext = await playwright[browserName].launchPersistentContext(
		guestProfile,
		launchOptions,
	);
	try {
		const guestPage = guestContext.pages()[0] ?? (await guestContext.newPage());
		await guestContext.addCookies([{ ...guest.cookie, url: stack.origin }]);
		await guestPage.goto(`${stack.app}/online?repository=${repository}`);
		await guestPage.getByRole('button', { name: 'Sign in' }).click();
		await expect(
			guestPage.getByRole('button', { name: 'Sign out' }),
		).toBeVisible();

		const theirs = guestPage
			.getByRole('region', { name: 'Online' })
			.locator(`li[data-id="${online}"]`);
		await expect(theirs.getByLabel('Title')).toHaveValue('Web again');
		await theirs.getByRole('button', { name: 'Play' }).click();
		await expect(theirs.locator('audio')).toHaveAttribute('src', /^blob:/);
	} finally {
		await guestContext.close();
		await rm(guestProfile, { recursive: true, force: true });
	}
});

test('8. signing in moved nothing: this browser keeps its recordings, the repository has none of them, and signing out keeps them too', async ({
	stack,
	person,
}) => {
	// Newest first.
	const local = [kept, walk].sort().reverse();
	await ways().getByRole('link', { name: 'On this browser' }).click();
	await expect(page).toHaveURL(`${stack.app}/`);
	await expect.poll(() => ids(onBrowser())).toEqual(local);
	expect(await opfsFiles(page)).toEqual(localFiles);

	await sync(stack, person, clone);
	expect((await readdir(join(clone, 'recordings'))).sort()).toEqual(
		[onlineAudio.slice('recordings/'.length), `${online}.md`].sort(),
	);

	await ways().getByRole('link', { name: 'Online' }).click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(signInAsked()).toBeVisible();
	await ways().getByRole('link', { name: 'On this browser' }).click();
	await expect.poll(() => ids(onBrowser())).toEqual(local);
	expect(await opfsFiles(page)).toEqual(localFiles);
});

test('9. where the browser keeps no files, a recording is not lost: it stays in memory to save again or download', async ({
	stack,
	browserName,
	playwright,
}) => {
	// WebKit's ephemeral contexts reject `getDirectory()`, as Safari's
	// private windows do; Chromium has no such context to test with.
	test.skip(browserName !== 'webkit', 'only WebKit refuses OPFS here');
	const ephemeral = await playwright.webkit.launch();
	try {
		const tab = await ephemeral.newPage();
		await tab.goto(`${stack.app}/?fixture=tone`);
		await tab.getByRole('button', { name: 'Record' }).click();
		await expect(tab.getByRole('button', { name: 'Stop' })).toBeVisible();
		await tab.waitForTimeout(1000);
		await tab.getByRole('button', { name: 'Stop' }).click();

		const unsaved = tab.getByTestId('unsaved');
		await expect(unsaved).toContainText('is not saved in this browser');
		const download = unsaved.getByRole('link', { name: 'Download it' });
		const bytes = await tab.evaluate(
			async (href) => (await (await fetch(href)).arrayBuffer()).byteLength,
			(await download.getAttribute('href')) as string,
		);
		expect(bytes).toBeGreaterThan(0);
		// Saving again fails the same way here, and the recording stays.
		await unsaved.getByRole('button', { name: 'Save again' }).click();
		await expect(unsaved).toContainText('is not saved in this browser');
		await expect(download).toBeVisible();
	} finally {
		await ephemeral.close();
	}
});
