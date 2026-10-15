/**
 * End-to-end check of the browser build's file model, in real Chromium.
 *
 *   bun run --cwd apps/capture smoke:browser
 *
 * Starts the Capture dev server on a free loopback port and drives two pages
 * of one browser profile, which share the OPFS folder: the second page
 * is the "other program" that edits a file behind the first. No account, no
 * server besides Vite, and no data outside the disposable profile.
 *
 * It needs to bind a local port and launch Chromium (`bun x playwright
 * install chromium` once). It does not cover the desktop build: see
 * `src/lib/platform/folder.epicenter-host.test.ts` and the desktop shell.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

const root = join(import.meta.dir, '../../..');
const fixture = join(import.meta.dir, '../fixtures/legacy-bundle.json');
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
		'apps/capture',
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

	// 2. The new-capture text survives closing the dialog, then saves exactly.
	const text = 'Dinner with Sebastian\nFriday at seven\nBring the invitation.';
	await first.getByRole('button', { name: 'New capture' }).click();
	await first.getByLabel('Capture text').fill(text);
	await first.getByLabel('Capture text').press('Escape');
	await first.getByRole('button', { name: 'New capture (draft)' }).click();
	assert.equal(await first.getByLabel('Capture text').inputValue(), text);
	// Ctrl+Enter adds it, and the new capture opens ready for a thought.
	await first.getByLabel('Capture text').press('Control+Enter');
	await first
		.getByRole('button', { name: 'Edit as text', exact: true })
		.waitFor();
	await first.waitForFunction(
		() => document.activeElement?.id === 'new-thought',
	);
	// The file is in the form a save writes: plain YAML frontmatter.
	const created = await source(first);
	const at =
		/^---\ncapturedAt: "(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"\n---\n\nDinner with Sebastian\nFriday at seven\nBring the invitation\.\n\n## Thoughts\n$/.exec(
			created,
		)?.[1];
	assert(at, `unexpected created source:\n${created}`);
	const head = `---\ncapturedAt: "${at}"\n---`;

	// 3. Multiline thoughts: add, edit, reorder, delete. The file is the list.
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
	await act(first, 0, 'Edit');
	await first.getByLabel('Thought text').fill('Owning the outcome, edited');
	await first.getByRole('button', { name: 'Save thought' }).click();
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

	// 6. Another page edits the file. The first page has not read it since, so
	// its next write meets the change and merges with it: both changed the
	// text, so the first page's text wins there (ADR-0548).
	const second = await context.newPage();
	second.on('pageerror', (error) => errors.push(`second: ${error.message}`));
	await second.goto(app);
	await openFromTimeline(second, 'Dinner with Sebastian');
	await second.getByLabel('Capture text').fill('Changed in the other window');
	await saved(second);
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
	// Save version records what is saved; nothing was committed before.
	await first.getByRole('button', { name: 'Save version' }).click();
	await first.getByText('Version saved').waitFor();
	await first.getByRole('button', { name: 'Back to timeline' }).click();
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();

	// 8. Unadded thought text holds a reload back.
	let asked = 0;
	second.on('dialog', (dialog) => {
		asked++;
		void dialog.dismiss();
	});
	await second.getByLabel('Add a thought').fill('typed, not added');
	await second.reload({ timeout: 5000 }).catch(() => {});
	assert.equal(asked, 1, 'unadded thought text is protected');
	assert.equal(
		await second.getByLabel('Add a thought').inputValue(),
		'typed, not added',
	);
	await second.getByLabel('Add a thought').fill('');
	await second.getByRole('button', { name: 'Back to timeline' }).click();

	// 9. Ambiguous Thoughts markup opens as text, with why.
	await second.getByRole('button', { name: 'New capture' }).click();
	await second
		.getByLabel('Capture text')
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

	// 11. Old captures come in from a bundle file, and a second import adds nothing.
	await second
		.getByRole('button', {
			name: 'Bring in captures from before this version…',
		})
		.click();
	await second.getByLabel('From an export file').setInputFiles(fixture);
	await second
		.getByRole('button', { name: 'Import as Markdown files' })
		.click();
	const result = second.getByRole('region', { name: 'Import result' });
	await result.getByText('Import finished').waitFor();
	await result.getByText('6 files created').waitFor();
	await second
		.getByRole('button', { name: 'Import as Markdown files' })
		.click();
	await result.getByText('0 files created').waitFor();
	await result.getByText('6 imported before and left as they are').waitFor();
	await second.getByRole('button', { name: 'Capture', exact: true }).click();
	await second
		.getByLabel('Timeline captures')
		.getByRole('button')
		.filter({ hasText: 'Dinner with Sebastian' })
		.getByText('2 thoughts')
		.waitFor();

	// 12. A narrow screen does not scroll sideways.
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

	assert.deepEqual(errors, []);
	console.log(
		'Capture browser check passed: no sign-in, exact saved Markdown, multiline thoughts added, edited, reordered, and deleted, Edit as text, reload persistence, a write merged with a change from another page, Save version, a leave warning for unadded text, an ambiguous capture opened as text, deletion, and an idempotent import from a bundle file.',
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
}
