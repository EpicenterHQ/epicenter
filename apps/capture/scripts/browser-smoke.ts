/**
 * End-to-end check of the browser build's file model, in real Chromium.
 *
 *   bun run --cwd apps/capture smoke:browser
 *
 * Starts the Capture dev server on a free loopback port and drives two pages
 * of one browser profile, which share its local folder in IndexedDB: the
 * second page is the other tab that edits a file behind the first. A third,
 * fresh profile holds a folder an earlier build kept in OPFS, and still opens
 * the current IndexedDB folder. No account, no server besides Vite, and no data outside the
 * disposable profiles.
 *
 * It needs to bind a local port and launch Chromium (`bun x playwright
 * install chromium` once). It does not cover the desktop build: see
 * the desktop shell, and the folder package's desktop tests.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const root = join(import.meta.dir, '../../..');

// Other checks regenerate SvelteKit files. Give this browser its own app
// directory so those writes cannot reload it during an interaction.
const scratch = join(root, '.scratch');
mkdirSync(scratch, { recursive: true });
const appDirectory = mkdtempSync(join(scratch, 'capture-smoke-'));
const sourceApp = join(root, 'apps/capture');
cpSync(sourceApp, appDirectory, {
	recursive: true,
	filter: (path) =>
		!['node_modules', '.svelte-kit', 'build', 'dist'].includes(basename(path)),
});
symlinkSync(
	join(sourceApp, 'node_modules'),
	join(appDirectory, 'node_modules'),
	'dir',
);
const artifacts = process.env.CAPTURE_SMOKE_ARTIFACT_DIR;
if (artifacts) mkdirSync(artifacts, { recursive: true });

async function freeOrigin() {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	return origin;
}

const app = await freeOrigin();
const logs: string[] = [];
const vite: ChildProcess = spawn(
	process.execPath,
	[
		'run',
		'--cwd',
		appDirectory,
		'dev',
		'--host',
		'127.0.0.1',
		'--port',
		new URL(app).port,
		'--strictPort',
	],
	{
		cwd: root,
		detached: true,
		env: {
			...process.env,
			PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
vite.stdout?.on('data', (chunk) => logs.push(String(chunk)));
vite.stderr?.on('data', (chunk) => logs.push(String(chunk)));

async function ready(url: string) {
	for (let attempt = 0; attempt < 300; attempt++) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {}
		assert.equal(vite.exitCode, null, `${url} exited`);
		await Bun.sleep(100);
	}
	throw new Error(`Timed out starting ${url}`);
}

let browser: Browser | undefined;
const errors: string[] = [];

async function saved(page: Page) {
	try {
		await page
			.locator('header [role="status"]')
			.filter({ hasText: /^Saved$/ })
			.waitFor();
	} catch (cause) {
		console.error(
			'Save wait failed at',
			page.url(),
			await page.locator('body').innerText(),
		);
		if (artifacts)
			await page.screenshot({
				path: join(artifacts, 'browser-failure.png'),
				fullPage: true,
			});
		throw cause;
	}
}

/** The open capture's file, read through Edit as text, then back to the capture. */
async function source(page: Page) {
	await page
		.getByRole('button', { name: 'Edit as text', exact: true })
		.first()
		.click();
	const text = await fileText(page).inputValue();
	await page
		.getByRole('button', { name: 'Open as capture', exact: true })
		.click();
	await page.getByLabel('Capture text').waitFor();
	return text;
}

const fileText = (page: Page) => page.getByLabel(/^Contents of captures\//);

/** Open the capture whose timeline entry shows `text`. */
async function openFromTimeline(page: Page, text: string) {
	await page
		.getByLabel('Timeline captures')
		.getByRole('button')
		.filter({ hasText: text })
		.first()
		.click();
	await page.getByLabel('Capture text').waitFor();
}

const thoughts = (page: Page) =>
	page
		.getByLabel('Thoughts', { exact: true })
		.locator('li p')
		.evaluateAll((items) =>
			items.map((item) => (item as HTMLElement).innerText),
		);

async function act(page: Page, index: number, action: string) {
	await page
		.getByLabel('Thoughts', { exact: true })
		.locator('li')
		.nth(index)
		.getByRole('button', { name: 'Thought actions' })
		.click();
	await page.getByRole('menuitem', { name: action }).click();
}

try {
	await ready(app);
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const first = await context.newPage();
	first.on('pageerror', (error) => errors.push(`first: ${error.message}`));

	// 1. No sign-in: the timeline opens directly.
	await first.goto(app);
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();

	// 2. New capture text is the form's until Add: a reload neither asks nor
	// keeps it, and nothing was written.
	const text = 'Dinner with Sebastian\nFriday at seven\nBring the invitation.';
	let firstAsked = 0;
	first.on('dialog', (dialog) => {
		firstAsked++;
		void dialog.dismiss();
	});
	await first.getByLabel('New capture').fill('Typed, never added');
	await first.reload();
	assert.equal(firstAsked, 0, 'text not added yet does not prompt');
	assert.equal(await first.getByLabel('New capture').inputValue(), '');
	await first.getByText('No captures yet').waitFor();
	// Ctrl+Enter adds it, and the new capture opens ready for a thought.
	await first.getByLabel('New capture').fill(text);
	await first.getByLabel('New capture').press('Control+Enter');
	await first
		.getByRole('button', { name: 'Edit as text', exact: true })
		.waitFor();
	await first.waitForFunction(
		() => document.activeElement?.id === 'new-thought',
	);
	// The file is in the form a save writes: plain YAML frontmatter.
	const created = await source(first);
	const line =
		/^---\n(capturedAt: "?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"?)\n---\n\nDinner with Sebastian\nFriday at seven\nBring the invitation\.\n\n## Thoughts\n$/.exec(
			created,
		)?.[1];
	assert(line, `unexpected created source:\n${created}`);
	const head = `---\n${line}\n---`;

	// 3. Multiline thoughts: add, edit as text, reorder, delete. The file is the list.
	for (const thought of [
		'Owning the outcome',
		'Moving to Singapore\nA longer thought',
		'A question for next time',
	]) {
		await first.getByLabel('Add a thought').fill(thought);
		await first.getByRole('button', { name: 'Add thought' }).click();
		// Focus returns to the field, so the next thought needs no pointer.
		assert(
			await first
				.getByLabel('Add a thought')
				.evaluate((field) => field === document.activeElement),
		);
	}
	// Edit as text opens the file with the thought's lines selected; typing
	// replaces them, unfinished or not, and saves as typed.
	await act(first, 0, 'Edit as text');
	assert.equal(
		await fileText(first).evaluate((field) => {
			const box = field as HTMLTextAreaElement;
			return box.value.slice(box.selectionStart, box.selectionEnd);
		}),
		'- Owning the outcome',
	);
	await first.keyboard.type('- Owning the outcome, edited');
	await saved(first);
	await first
		.getByRole('button', { name: 'Open as capture', exact: true })
		.click();
	await first.getByLabel('Capture text').waitFor();
	await act(first, 2, 'Move up');
	await act(first, 0, 'Delete thought…');
	await first.getByRole('button', { name: 'Delete thought' }).click();
	assert.deepEqual(await thoughts(first), [
		'A question for next time',
		'Moving to Singapore\nA longer thought',
	]);
	await saved(first);
	assert.equal(
		await source(first),
		`${head}\n\n${text}\n\n## Thoughts\n\n- A question for next time\n- Moving to Singapore\n  A longer thought\n`,
	);

	// 4. Edit as text saves the complete file as typed, frontmatter included,
	// and Open as capture goes back.
	await first
		.getByRole('button', { name: 'Edit as text', exact: true })
		.click();
	const edited = `${head.replace(/\n---$/, '\nunknownKey: kept\n---')}\n\n${text}\n\n## Thoughts\n\n- A question for next time\n  - nested point\n- Moving to Singapore\n  A longer thought\n- Typed in source\n\nTrailing note.\n`;
	await fileText(first).fill(edited);
	await saved(first);
	await first
		.getByRole('button', { name: 'Open as capture', exact: true })
		.click();
	await first.getByLabel('Capture text').waitFor();
	assert.deepEqual(await thoughts(first), [
		'A question for next time\n- nested point',
		'Moving to Singapore\nA longer thought',
		'Typed in source',
	]);

	if (artifacts)
		await first.screenshot({
			path: join(artifacts, 'browser-capture.png'),
			fullPage: true,
		});

	// 5. Reload: the page returns to the timeline, and the saved file is what
	// comes back.
	await first.reload();
	await openFromTimeline(first, 'Dinner with Sebastian');
	assert.equal(await source(first), edited);

	// 6. Another page's save reaches the clean first page. Wait for that
	// source to be observed before starting a new draft on the first page.
	const second = await context.newPage();
	second.on('pageerror', (error) => errors.push(`second: ${error.message}`));
	await second.goto(app);
	await openFromTimeline(second, 'Dinner with Sebastian');
	await second.getByLabel('Capture text').fill('Changed in the other window');
	await saved(second);
	await first.waitForFunction(
		() =>
			document.querySelector<HTMLTextAreaElement>('#capture-text')?.value ===
			'Changed in the other window',
	);
	await first.getByLabel('Capture text').fill('Mine');
	await saved(first);

	// 7. The next edit writes on top of the file as it is now.
	await first.getByLabel('Capture text').fill('Saved over it');
	await saved(first);
	await first
		.getByRole('button', { name: 'Edit as text', exact: true })
		.click();
	assert(
		(await fileText(first).inputValue()).includes('\n\nSaved over it\n\n'),
	);
	// The local folder keeps no history and syncs nowhere: no Save version.
	assert.equal(
		await first.getByRole('button', { name: 'Save version' }).count(),
		0,
	);
	await first.getByRole('button', { name: 'Back to timeline' }).click();
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();

	// 8. A thought not added yet is the view's; it neither prompts nor survives a reload.
	let asked = 0;
	second.on('dialog', (dialog) => {
		asked++;
		void dialog.dismiss();
	});
	await second.getByLabel('Add a thought').fill('typed, not added');
	await second.reload();
	assert.equal(asked, 0, 'unsubmitted thought text does not prompt');
	await openFromTimeline(second, 'Saved over it');
	assert.equal(await second.getByLabel('Add a thought').inputValue(), '');
	await second.getByRole('button', { name: 'Back to timeline' }).click();

	// 9. Ambiguous Thoughts markup opens as text, with why.
	await second
		.getByLabel('New capture')
		.fill('Pasted article\n\n## Thoughts\n\n- belongs to the article');
	await second.getByRole('button', { name: 'Add capture' }).click();
	await second.getByRole('status', { name: 'Needs repair' }).waitFor();
	assert(
		(await fileText(second).inputValue()).includes(
			'- belongs to the article\n\n## Thoughts\n',
		),
	);

	// 10. Deleting asks, then removes the file.
	await second.getByRole('button', { name: 'Delete…' }).click();
	await second.getByRole('button', { name: 'Delete', exact: true }).click();
	await second.getByRole('heading', { name: 'Timeline' }).waitFor();
	assert.equal(
		await second.getByLabel('Timeline captures').getByRole('button').count(),
		1,
	);

	// 11. A narrow screen does not scroll sideways.
	await second.setViewportSize({ width: 390, height: 844 });
	assert(
		await second.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	);

	if (artifacts)
		await second.screenshot({
			path: join(artifacts, 'browser-timeline.png'),
			fullPage: true,
		});

	// 12. An earlier OPFS folder does not block the current timeline.
	const earlier = await (await browser.newContext()).newPage();
	earlier.on('pageerror', (error) => errors.push(`earlier: ${error.message}`));
	await earlier.goto(app);
	await earlier.getByRole('heading', { name: 'Timeline' }).waitFor();
	await earlier.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		await root.getDirectoryHandle('so.epicenter.capture', { create: true });
	});
	await earlier.reload();
	await earlier.getByRole('heading', { name: 'Timeline' }).waitFor();
	await earlier.getByText('No captures yet').waitFor();
	assert(
		await earlier.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			return Boolean(await root.getDirectoryHandle('so.epicenter.capture'));
		}),
	);

	// 13. A full-disk Add writes nothing and keeps the text; Add again adds it once.
	const fillDisk = async () =>
		earlier.evaluate(() => {
			const target = window as typeof window & {
				restoreCaptureWrites?: () => void;
			};
			const put = IDBObjectStore.prototype.put;
			target.restoreCaptureWrites = () => {
				IDBObjectStore.prototype.put = put;
			};
			IDBObjectStore.prototype.put = () => {
				throw new DOMException('Disk is full', 'QuotaExceededError');
			};
		});
	const restoreDisk = async () =>
		earlier.evaluate(() => {
			(
				window as typeof window & { restoreCaptureWrites?: () => void }
			).restoreCaptureWrites?.();
		});
	await earlier
		.getByLabel('New capture')
		.fill('Writing retained through failures');
	await fillDisk();
	await earlier.getByRole('button', { name: 'Add capture' }).click();
	await earlier
		.getByText('The capture was not added', { exact: true })
		.waitFor();
	assert.equal(
		await earlier.getByLabel('New capture').inputValue(),
		'Writing retained through failures',
	);
	await restoreDisk();
	await earlier.getByText('No captures yet').waitFor();
	await earlier.getByRole('button', { name: 'Add capture' }).click();
	await earlier.getByLabel('Add a thought').waitFor();
	assert.equal((await source(earlier)).match(/^## Thoughts$/gm)?.length, 1);
	await earlier.getByRole('button', { name: 'Back to timeline' }).click();
	assert.equal(
		await earlier.getByLabel('Timeline captures').getByRole('button').count(),
		1,
	);

	// 14. A saved draft from an earlier version uses the same whole-file editor.
	// Seed its on-disk shape through ordinary file editing, without a test API.
	await openFromTimeline(earlier, 'Writing retained through failures');
	await earlier
		.getByRole('button', { name: 'Edit as text', exact: true })
		.click();
	const previous = await fileText(earlier).inputValue();
	const draftHead =
		previous.slice(0, previous.indexOf('\n---\n') + 1) +
		'draft: true\nunknownKey: kept\n---\n';
	const raw = '\n  Saved draft writing  \nsecond line\n';
	const legacyDraft = draftHead + raw;
	await fileText(earlier).fill(legacyDraft);
	await saved(earlier);
	await earlier.getByRole('button', { name: 'Back to timeline' }).click();
	await earlier.reload();
	await earlier.getByLabel('Draft captures').getByRole('button').click();
	assert.equal(await fileText(earlier).inputValue(), legacyDraft);
	assert.equal(
		await earlier
			.getByRole('button', { name: 'Open as capture', exact: true })
			.count(),
		0,
	);

	// A frontmatter typo never replaces the text box with a different view.
	await fileText(earlier).fill(
		legacyDraft.replace('draft: true', 'draft: tru'),
	);
	await earlier.getByRole('status', { name: 'Needs repair' }).waitFor();
	assert.equal(await fileText(earlier).count(), 1);
	await fileText(earlier).fill(legacyDraft);
	await saved(earlier);

	// Failed autosave and failed Finish keep the same whole-file input.
	await fillDisk();
	const revisedDraft = legacyDraft.replace(
		'second line',
		'second line, edited',
	);
	await fileText(earlier).fill(revisedDraft);
	await earlier.getByText('Your edit is not saved', { exact: true }).waitFor();
	assert.equal(await fileText(earlier).inputValue(), revisedDraft);
	await restoreDisk();
	await earlier.getByRole('button', { name: 'Save again' }).click();
	await saved(earlier);
	await fillDisk();
	await earlier
		.getByRole('button', { name: 'Add capture', exact: true })
		.click();
	await earlier
		.getByText('The capture was not added', { exact: true })
		.waitFor();
	assert.equal(await fileText(earlier).inputValue(), revisedDraft);
	await restoreDisk();
	await earlier
		.getByRole('button', { name: 'Add capture', exact: true })
		.click();
	await earlier.getByLabel('Add a thought').waitFor();
	const finishedDraft = await source(earlier);
	assert.equal(finishedDraft.match(/^## Thoughts$/gm)?.length, 1);
	assert(!finishedDraft.includes('draft:'));
	assert(finishedDraft.includes('unknownKey: kept'));
	assert(finishedDraft.includes('second line, edited'));

	// Confirmed discard removes an existing draft, including after reload.
	await earlier
		.getByRole('button', { name: 'Edit as text', exact: true })
		.click();
	await fileText(earlier).fill(legacyDraft);
	await saved(earlier);
	await earlier.getByRole('button', { name: 'Back to timeline' }).click();
	await earlier.reload();
	await earlier.getByLabel('Draft captures').getByRole('button').click();
	await earlier
		.getByRole('button', { name: 'Discard draft…', exact: true })
		.click();
	await earlier
		.getByRole('button', { name: 'Discard draft', exact: true })
		.click();
	await earlier.getByText('No captures yet').waitFor();
	await earlier.reload();
	await earlier.getByText('No captures yet').waitFor();

	assert.deepEqual(errors, []);
	console.log(
		'Capture browser check passed: no sign-in, exact saved Markdown, text not added yet neither prompting nor surviving a reload, multiline thoughts added, edited as text from their own lines, reordered, and deleted, Edit as text, reload persistence, clean cross-tab refresh followed by a save from the observed source, no Save version, full-disk Add recovery, saved drafts reopened as full files, repaired without replacing the editor, retried after failed autosave and Finish, finished once, and discarded across reload, an ambiguous capture opened as text, deletion, and an earlier OPFS folder that does not block opening.',
	);
} catch (cause) {
	console.error(cause);
	console.error('Browser errors:', errors);
	for (const context of browser?.contexts() ?? []) {
		for (const page of context.pages()) {
			console.error(
				'Page:',
				page.url(),
				await page
					.locator('body')
					.innerText({ timeout: 5000 })
					.catch(() => 'Page unavailable'),
			);
		}
	}
	console.error(logs.slice(-35).join(''));
	throw cause;
} finally {
	await browser?.close();
	if (vite.pid) {
		try {
			process.kill(-vite.pid, 'SIGTERM');
		} catch (cause) {
			if (
				!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
			)
				console.error('Could not stop the dev server.', cause);
		}
	}
	rmSync(appDirectory, { recursive: true, force: true });
}
