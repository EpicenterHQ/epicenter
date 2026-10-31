/**
 * The demo end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`).
 *
 * The demo has two views (decision 76): "On this device", this browser's
 * files, and "Synced", the person's repository.
 *
 * 1. Signed out, a recording is kept on this device (OPFS) as one capture;
 *    its title is edited and another recording is deleted there, and
 *    "Synced" asks for a sign-in.
 * 2. Signed in, it uploads on its own. The first write's reply is lost after
 *    the server commits, and later writes are held: the browser keeps the
 *    recording's files until a reply arrives (the resend lands as nothing),
 *    then it leaves "On this device" and appears in "Synced". The browser
 *    keeps only the audio, as a cache, and "Synced" plays it with no
 *    download.
 * 3. Signed in with the server unreachable, a new recording is kept on this
 *    device; once the server is back it uploads too, leaving "On this
 *    device" for "Synced", where it is deleted.
 * 4. `epicenter clone` and `git lfs pull` give the bytes the browser
 *    recorded, and `epicenter check` passes against the published contract.
 * 5. A title edited on the desktop and synced shows in "Synced", with no
 *    reload.
 * 6. A rename in "Synced" over a note the desktop changed meanwhile lands
 *    beside the desktop's edit.
 * 7. A rename in "Synced" over a desktop rename is refused as `Conflict`;
 *    the draft stays, and saving again lands it.
 * 8. Shared read only with a second person (`epicenter share`), the
 *    recording shows and plays under "Synced" in their own signed-in
 *    browser, opened with `?repository=<owner>/recorder-demo`.
 * 9. Signing out drops the cached audio: the browser holds nothing, and
 *    "Synced" asks for a sign-in again.
 * 10. WebKit only, in an ephemeral context (no OPFS, as in Safari's private
 *    windows): a recording the device cannot keep stays in the page, to
 *    save again or download.
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
export type DemoOptions = { microphone: 'device' | 'tone' };

const test = stackTest('RECORDER_DEMO_E2E_STATE').extend<object, DemoOptions>({
	microphone: ['device', { option: true, scope: 'worker' }],
});

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

/** What the first steps learn, for the later ones. */
let id: string;
let audioPath: string;
let audioSha: string;
let recorded: Record<string, string>;
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

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const onDevice = () => page.getByRole('region', { name: 'On this device' });
const synced = () => page.getByRole('region', { name: 'Synced' });
/** A recording's row in one view: the first recording's unless `which` names another. */
const row = (view: () => ReturnType<typeof onDevice>, which = id) =>
	view().locator(`li[data-id="${which}"]`);

/** Record about a second on "On this device"; returns the new row's id. */
async function record() {
	const rows = onDevice().locator('li[data-id]');
	const before = new Set(
		await rows.evaluateAll((items) =>
			items.map((item) => item.getAttribute('data-id')),
		),
	);
	await onDevice().getByRole('button', { name: 'Record' }).click();
	await expect(onDevice().getByRole('button', { name: 'Stop' })).toBeVisible();
	await page.waitForTimeout(1000);
	await onDevice().getByRole('button', { name: 'Stop' }).click();
	await expect(rows).toHaveCount(before.size + 1);
	const ids = await rows.evaluateAll((items) =>
		items.map((item) => item.getAttribute('data-id')),
	);
	const made = ids.find((each) => each !== null && !before.has(each));
	if (!made) throw new Error('no new recording');
	return made;
}

test('1. signed out, recordings are kept, edited and deleted on this device', async ({
	stack,
	microphone,
}) => {
	const app = `${stack.app}/${microphone === 'tone' ? '?fixture=tone' : ''}`;
	// WebKit keeps OPFS outside the profile directory, so an earlier run's
	// files may still be there: start from an empty origin.
	await page.goto(app);
	await emptyOpfs(page);
	await page.goto(app);
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(
		synced().getByText(
			'Sign in to see the recordings in your Epicenter repository.',
		),
	).toBeVisible();
	await expect(onDevice().getByText('No recordings yet.')).toBeVisible();

	id = await record();
	// One capture: the audio, its note, and the outbox entry naming both.
	await expect
		.poll(async () => Object.keys(await opfsFiles(page)).length)
		.toBe(3);
	recorded = await opfsFiles(page);
	audioPath = Object.keys(recorded).find(
		(path) => path.startsWith(`recordings/${id}.`) && !path.endsWith('.md'),
	) as string;
	expect(audioPath).toMatch(/\.(m4a|webm)$/);
	expect(Object.keys(recorded).sort()).toEqual(
		[`.epicenter/outbox/${id}.json`, audioPath, `recordings/${id}.md`].sort(),
	);
	audioSha = recorded[audioPath] as string;
	test.info().annotations.push({ type: 'recorded', description: audioPath });
	// Not empty: the sha256 of no bytes.
	expect(audioSha).not.toBe(
		'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);

	await row(onDevice).getByRole('button', { name: 'Play' }).click();
	await expect(row(onDevice).locator('audio')).toHaveAttribute('src', /^blob:/);

	await row(onDevice).getByLabel('Title').fill('Morning walk');
	await row(onDevice).getByRole('button', { name: 'Save title' }).click();
	await expect(row(onDevice).getByTestId('status')).toHaveText('Saved');
	await expect
		.poll(() => opfsText(page, `recordings/${id}.md`))
		.toMatch(/^title: Morning walk$/m);

	const discarded = await record();
	await row(onDevice, discarded)
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(row(onDevice, discarded)).toHaveCount(0);
	await expect(onDevice().locator('li[data-id]')).toHaveCount(1);
	const left = Object.keys(await opfsFiles(page));
	expect(left.filter((path) => path.startsWith('recordings/')).sort()).toEqual(
		[audioPath, `recordings/${id}.md`].sort(),
	);
	recorded = await opfsFiles(page);
});

test("2. signed in, it uploads on its own: the browser lets go only after the server's reply, and it moves from this device to Synced", async ({
	stack,
	person,
}) => {
	// The first write lands on the server but its reply is lost; later
	// writes wait until this test has looked at the browser's files.
	let lost: number | null = null;
	const held = Promise.withResolvers<void>();
	await context.route('**/epicenter/writes', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		if (lost === null) {
			lost = 0;
			const landed = await route.fetch();
			lost = landed.status();
			return route.abort('failed');
		}
		await held.promise;
		return route.continue();
	});

	// A signed-in session on the API; the real authorization redirect does the rest.
	await context.addCookies([{ ...person.cookie, url: stack.origin }]);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

	await expect.poll(() => lost).toBe(200);
	// The server committed, but no reply reached the browser: it keeps the
	// recording's files, and "On this device" still shows it.
	const kept = await opfsFiles(page);
	for (const path of [audioPath, `recordings/${id}.md`])
		expect(kept[path]).toBe(recorded[path] as string);
	await expect(row(onDevice)).toBeVisible();

	held.resolve();
	await expect(row(onDevice)).toHaveCount(0, { timeout: 60_000 });
	await expect(onDevice().getByText('No recordings yet.')).toBeVisible();
	await expect(row(synced).getByLabel('Title')).toHaveValue('Morning walk');
	// The note went (it is the repository's); the audio stays as a cache,
	// outside the contract's paths, byte for byte what was recorded.
	await expect
		.poll(() => opfsFiles(page))
		.toEqual({ [`.epicenter/cache/${audioPath}`]: audioSha });
	await context.unroute('**/epicenter/writes');

	// Played from the cache: nothing comes down through Git LFS.
	const lfs: string[] = [];
	const listen = (request: { url(): string }) => {
		if (request.url().includes('/info/lfs/')) lfs.push(request.url());
	};
	page.on('request', listen);
	await row(synced).getByRole('button', { name: 'Play' }).click();
	await expect(row(synced).locator('audio')).toHaveAttribute('src', /^blob:/);
	page.off('request', listen);
	expect(lfs).toEqual([]);
});

test('3. signed in and offline, a recording is kept on this device, and uploads once the server is back', async ({
	stack,
}) => {
	// Every request to the server fails, as it does offline. (Playwright's
	// emulated offline mode in WebKit also fails reads of the origin's own
	// private files, so the server is cut off instead.)
	const server = `${stack.origin}/**`;
	await context.route(server, (route) => route.abort('internetdisconnected'));
	let later = '';
	try {
		later = await record();
		await expect(row(onDevice, later)).toBeVisible();
		await expect
			.poll(async () =>
				Object.keys(await opfsFiles(page)).some((path) =>
					path.startsWith(`.epicenter/outbox/${later}`),
				),
			)
			.toBe(true);
	} finally {
		await context.unroute(server);
	}
	// Back: the browser says so, and the uploader runs.
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await expect(row(onDevice, later)).toHaveCount(0, { timeout: 60_000 });
	await expect(row(synced, later)).toBeVisible();
	await expect(row(synced)).toBeVisible();

	// "Synced" edits the repository: deleting there removes it from it.
	await row(synced, later).getByRole('button', { name: 'Delete' }).click();
	await expect(row(synced, later)).toHaveCount(0);
	await page.reload();
	await expect(row(synced)).toBeVisible();
	await expect(row(synced, later)).toHaveCount(0);
});

test('4. a desktop clone holds the bytes the browser recorded, and the folder fits the contract', async ({
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
	const pulled = await run(['git', 'lfs', 'pull'], {
		cwd: clone,
		env: person.env,
	});
	expect(pulled.code, pulled.stderr).toBe(0);

	expect(sha256(await readFile(join(clone, audioPath)))).toBe(audioSha);
	const note = await readFile(join(clone, `recordings/${id}.md`), 'utf8');
	expect(note).toMatch(/^title: /m);

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('5. a title edited on the desktop shows in Synced, with no reload', async ({
	stack,
	person,
}) => {
	const notePath = join(clone, `recordings/${id}.md`);
	const text = await readFile(notePath, 'utf8');
	await writeFile(
		notePath,
		text.replace(/^title: .*$/m, 'title: Desktop title'),
	);
	await sync(stack, person, clone);

	// The remote hears main move (a poll until the notify Durable Object).
	await expect(row(synced).getByLabel('Title')).toHaveValue('Desktop title');
});

test('6. a rename in Synced over a desktop edit of other fields lands at once, and both stay', async ({
	stack,
	person,
}) => {
	const notePath = join(clone, `recordings/${id}.md`);
	const text = await readFile(notePath, 'utf8');
	expect(text).toContain('title: Desktop title');
	await writeFile(
		notePath,
		`${text.replace(/^durationMs: .*$/m, 'durationMs: 4242')}Desktop notes.\n`,
	);
	const title = row(synced).getByLabel('Title');
	await title.fill('Web title');

	// The desktop's edit lands after the typing began, so the rename is
	// made over a note that has moved.
	await sync(stack, person, clone);
	const status = row(synced).getByTestId('status');
	const save = row(synced).getByRole('button', { name: 'Save title' });
	await save.click();
	// The write meets a `Conflict`; the desktop changed other fields, not
	// the title, so the rename is applied again over what is there now.
	await expect(status).toHaveText('Saved');
	await expect(title).toHaveValue('Web title');
	await expect(row(synced).getByTestId('duration')).toHaveText('4.2 s');

	// The desktop brings in whatever landed after its own push.
	await sync(stack, person, clone);
	const merged = await readFile(notePath, 'utf8');
	expect(merged).toMatch(/^title: Web title$/m);
	expect(merged).toMatch(/^durationMs: 4242$/m);
	expect(merged).toContain('Desktop notes.');
	expect(merged).not.toContain('<<<<<<<');

	await page.reload();
	await expect(title).toHaveValue('Web title');
	await expect(row(synced).getByTestId('duration')).toHaveText('4.2 s');

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('7. a web rename over a desktop rename is refused, keeps its draft, and lands on a second save', async ({
	stack,
	person,
}) => {
	const notePath = join(clone, `recordings/${id}.md`);
	const text = await readFile(notePath, 'utf8');
	expect(text).toMatch(/^title: Web title$/m);
	const title = row(synced).getByLabel('Title');
	await title.fill('Web again');
	await writeFile(
		notePath,
		text.replace(/^title: .*$/m, 'title: Desktop again'),
	);
	await sync(stack, person, clone);

	const status = row(synced).getByTestId('status');
	const save = row(synced).getByRole('button', { name: 'Save title' });
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
	expect(landed).toMatch(/^durationMs: 4242$/m);
	expect(landed).not.toContain('<<<<<<<');
});

test('8. shared with a second person, the recording shows and plays under Synced in their browser', async ({
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
		await guestPage.goto(`${stack.app}/`);
		await guestPage.getByRole('button', { name: 'Sign in' }).click();
		await expect(
			guestPage.getByRole('button', { name: 'Sign out' }),
		).toBeVisible();

		await guestPage.goto(`${stack.app}/?repository=${repository}`);
		const theirs = guestPage
			.getByRole('region', { name: 'Synced' })
			.locator(`li[data-id="${id}"]`);
		await expect(theirs.getByLabel('Title')).toHaveValue('Web again');
		await theirs.getByRole('button', { name: 'Play' }).click();
		await expect(theirs.locator('audio')).toHaveAttribute('src', /^blob:/);
	} finally {
		await guestContext.close();
		await rm(guestProfile, { recursive: true, force: true });
	}
});

test('9. signing out drops the cached audio from the browser, and Synced asks for a sign-in', async () => {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	// The walk may meet a file as it is dropped; look again.
	await expect.poll(() => opfsFiles(page).catch(() => null)).toEqual({});
	await expect(page.locator('li[data-id]')).toHaveCount(0);
	await expect(
		synced().getByText(
			'Sign in to see the recordings in your Epicenter repository.',
		),
	).toBeVisible();
});

test('10. where the browser keeps no files, a recording is not lost: it stays in memory to save again or download', async ({
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
		await expect(unsaved).toContainText('not kept on this device');
		const download = unsaved.getByRole('link', { name: 'Download it' });
		const bytes = await tab.evaluate(
			async (href) => (await (await fetch(href)).arrayBuffer()).byteLength,
			(await download.getAttribute('href')) as string,
		);
		expect(bytes).toBeGreaterThan(0);
		// Saving again fails the same way here, and the recording stays.
		await unsaved.getByRole('button', { name: 'Save again' }).click();
		await expect(unsaved).toContainText('not kept on this device');
		await expect(download).toBeVisible();
	} finally {
		await ephemeral.close();
	}
});
