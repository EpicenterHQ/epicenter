/**
 * The demo end to end, per engine, as one person in one persistent browser
 * profile with a desktop sandbox beside it (see `stack.ts`):
 *
 * 1. Signed out, a recording stays in the browser (OPFS), marked "not
 *    uploaded yet".
 * 2. Signed in, it uploads on its own. The first write's reply is lost after
 *    the server commits, and later writes are held: the browser keeps every
 *    file until a receipt arrives, then lets go and the mark clears.
 * 3. `epicenter clone` and `git lfs pull` give the bytes the browser
 *    recorded, and `epicenter check` passes against the published contract.
 * 4. A title edited on the desktop and synced shows on the web after a
 *    reload.
 * 5. A web rename over a note the desktop changed meanwhile is refused as
 *    `Conflict`; the draft stays, and saving again lands it beside the
 *    desktop's edit.
 * 6. Shared read only with a second person (`epicenter share`), the
 *    recording shows and plays in their own signed-in browser, opened with
 *    `?repository=<owner>/recorder-demo`.
 * 7. WebKit only, in an ephemeral context (no OPFS, as in Safari's private
 *    windows): a recording the device cannot keep stays in the page, to
 *    save again or download.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BrowserContext,
	test as base,
	expect,
	type Page,
} from 'playwright/test';
import type { Person, Stack } from './stack.ts';

/** Which microphone a project records from: the engine's capture device, or `?fixture=tone`. */
export type DemoOptions = { microphone: 'device' | 'tone' };

const test = base.extend<
	object,
	DemoOptions & { stack: Stack; person: Person }
>({
	microphone: ['device', { option: true, scope: 'worker' }],
	stack: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern.
		async ({}, use) => {
			const state = process.env.RECORDER_DEMO_E2E_STATE;
			if (!state) throw new Error('globalSetup did not start the stack');
			await use(JSON.parse(await readFile(state, 'utf8')) as Stack);
		},
		{ scope: 'worker' },
	],
	person: [
		async ({ stack }, use, workerInfo) => {
			const person = stack.people[workerInfo.project.name];
			if (!person) throw new Error(`no person for ${workerInfo.project.name}`);
			await use(person);
		},
		{ scope: 'worker' },
	],
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

/** Every file in this origin's OPFS but the device's staging area, by path, as sha256. */
function opfsFiles(): Promise<Record<string, string>> {
	return page.evaluate(async () => {
		type Directory = {
			entries(): AsyncIterable<
				[string, { kind: 'file' | 'directory' } & FileSystemHandle]
			>;
		};
		const files: Record<string, string> = {};
		async function walk(directory: Directory, prefix: string) {
			for await (const [name, handle] of directory.entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					await walk(handle as unknown as Directory, `${path}/`);
					continue;
				}
				const file = await (handle as FileSystemFileHandle).getFile();
				const digest = await crypto.subtle.digest(
					'SHA-256',
					await file.arrayBuffer(),
				);
				files[path] = [...new Uint8Array(digest)]
					.map((byte) => byte.toString(16).padStart(2, '0'))
					.join('');
			}
		}
		await walk(
			(await navigator.storage.getDirectory()) as unknown as Directory,
			'',
		);
		for (const path of Object.keys(files))
			if (path.startsWith('.epicenter/staging/')) delete files[path];
		return files;
	});
}

function run(
	command: string[],
	{ cwd, env }: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(command[0] as string, command.slice(1), { cwd, env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk;
		});
		child.on('close', (code) => done({ code, stdout, stderr }));
	});
}

/** The `epicenter` command from this checkout, in the person's desktop sandbox. */
function epicenter(stack: Stack, person: Person, ...args: string[]) {
	return run([stack.bun, '--no-install', stack.cli, ...args], {
		cwd: person.home,
		env: person.env,
	});
}

/** `epicenter sync` until it has synced; exit 1 means run again. */
async function sync(stack: Stack, person: Person, folder: string) {
	for (let round = 1; ; round++) {
		const synced = await epicenter(stack, person, 'sync', folder);
		if (synced.code !== 1 || round === 5) {
			expect(synced.code, `${synced.stdout}\n${synced.stderr}`).toBe(0);
			return;
		}
	}
}

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const row = (where?: 'device' | 'repository') =>
	page.locator(
		where
			? `li[data-id="${id}"][data-where="${where}"]`
			: `li[data-id="${id}"]`,
	);

test('1. signed out, a recording stays in the browser, not uploaded yet', async ({
	stack,
	microphone,
}) => {
	await page.goto(
		`${stack.app}/${microphone === 'tone' ? '?fixture=tone' : ''}`,
	);
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

	await page.getByRole('button', { name: 'Record' }).click();
	await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
	await page.waitForTimeout(1500);
	await page.getByRole('button', { name: 'Stop' }).click();

	const recording = page.locator('li[data-where="device"]');
	await expect(recording).toHaveCount(1);
	await expect(recording).toContainText('not uploaded yet');
	id = (await recording.getAttribute('data-id')) as string;
	expect(id).toBeTruthy();

	recorded = await opfsFiles();
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

	await recording.getByRole('button', { name: 'Play' }).click();
	await expect(recording.locator('audio')).toHaveAttribute('src', /^blob:/);
});

test('2. signed in, it uploads on its own, and the browser lets go only after the receipt', async ({
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
	// The server committed, but no receipt reached the browser: it keeps all.
	expect(await opfsFiles()).toEqual(recorded);
	await expect(row()).toContainText('not uploaded yet');

	held.resolve();
	await expect(row('repository')).toBeVisible({ timeout: 60_000 });
	await expect(row()).not.toContainText('not uploaded yet');
	expect(await opfsFiles()).toEqual({});
	await context.unroute('**/epicenter/writes');

	// Played from the repository: the bytes come down through Git LFS.
	await row('repository').getByRole('button', { name: 'Play' }).click();
	await expect(row('repository').locator('audio')).toHaveAttribute(
		'src',
		/^blob:/,
	);
});

test('3. a desktop clone holds the bytes the browser recorded, and the folder fits the contract', async ({
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

test('4. a title edited on the desktop shows on the web', async ({
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

	await page.reload();
	await expect(row('repository').getByLabel('Title')).toHaveValue(
		'Desktop title',
	);
});

test('5. a web rename over a desktop edit is refused, keeps its draft, and both land on a second save', async ({
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
	const title = row('repository').getByLabel('Title');
	await title.fill('Web title');

	// The desktop's edit lands first, so the title the web shows is stale.
	await sync(stack, person, clone);
	const status = row('repository').getByTestId('status');
	const save = row('repository').getByRole('button', { name: 'Save title' });
	await save.click();
	// The client refuses a write over a note that moved since it was read
	// (`Conflict`); the row says so, shows the note as it is now, and keeps
	// the draft, so saving again writes the title over that version.
	await expect(status).toHaveText(/^Changed elsewhere/);
	await expect(title).toHaveValue('Web title');
	await expect(row('repository').getByTestId('duration')).toHaveText('4.2 s');
	await save.click();
	await expect(status).toHaveText('Saved');

	// The desktop brings in whatever landed after its own push.
	await sync(stack, person, clone);
	const merged = await readFile(notePath, 'utf8');
	expect(merged).toMatch(/^title: Web title$/m);
	expect(merged).toMatch(/^durationMs: 4242$/m);
	expect(merged).toContain('Desktop notes.');
	expect(merged).not.toContain('<<<<<<<');

	await page.reload();
	await expect(title).toHaveValue('Web title');
	await expect(row('repository').getByTestId('duration')).toHaveText('4.2 s');

	const checked = await epicenter(
		stack,
		person,
		'check',
		`${stack.app}/contract.json`,
		clone,
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('6. shared with a second person, the recording shows and plays in their browser', async ({
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
		const theirs = guestPage.locator(
			`li[data-id="${id}"][data-where="repository"]`,
		);
		await expect(theirs.getByLabel('Title')).toHaveValue('Web title');
		await theirs.getByRole('button', { name: 'Play' }).click();
		await expect(theirs.locator('audio')).toHaveAttribute('src', /^blob:/);
	} finally {
		await guestContext.close();
		await rm(guestProfile, { recursive: true, force: true });
	}
});

test('7. where the browser keeps no files, a recording is not lost: it stays in memory to save again or download', async ({
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
