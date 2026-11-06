/**
 * Messages end to end, per engine, in one persistent browser profile, served
 * by its local program with the real send owner over a scratch Messages
 * folder and a fake Beeper behind it (see `serve.ts`).
 *
 * 1. Replies open from the folder while Beeper is not connected: a note an
 *    agent wrote shows, and editing it and marking it ready writes the file
 *    and sends nothing.
 * 2. Drafts an earlier Messages kept in this browser stay visible, and one
 *    imports into the folder as a draft, leaving the browser's copy as it was.
 * 3. Connected, a reply saved as ready waits; Send selected sends it once,
 *    and its note leaves the folder when Beeper reports it sent.
 * 4. A send with no answer waits for a person and holds back the next reply
 *    to its chat; a reload reconnects and sends nothing; "not sent" keeps it.
 * 5. The folder fits the published contract (`epicenter check`).
 * 6. The demo sends fictional replies through the same steps.
 * 7. The page, loaded once, reopens offline from its service worker's
 *    cache (decision 85), in demo mode.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, expect, type Page, test } from 'playwright/test';
import {
	emptyOpfs,
	opfsText,
	run,
} from '../../../packages/cli/src/app-e2e.test-support.ts';

let app: string;
const cli = resolve(import.meta.dirname, '../../../packages/cli/src/bin.ts');
/** `E2E_FOLDER` in `serve.ts`, which this cannot import without building. */
let folder: string;

test.describe.configure({ mode: 'serial' });

let profile: string;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
	app = `http://127.0.0.1:${browserName === 'chromium' ? 5189 : 5191}`;
	folder = join(tmpdir(), `epicenter-messages-e2e-${browserName}`, 'Messages');
	profile = join(tmpdir(), `messages-${browserName}-${Date.now()}`);
	// A persistent profile: WebKit refuses OPFS in an ephemeral context.
	context = await playwright[browserName].launchPersistentContext(profile, {
		...launchOptions,
		viewport: { width: 1280, height: 800 },
	});
	page = context.pages()[0] ?? (await context.newPage());
});

test.afterAll(async () => {
	await context?.close();
});

/** Every reply note in the folder, by file name. */
async function replyFiles() {
	const directory = join(folder, 'replies');
	const names = await readdir(directory).catch(() => [] as string[]);
	const files: Record<string, string> = {};
	for (const name of names)
		files[name] = await readFile(join(directory, name), 'utf8');
	return files;
}
const fileWith = async (text: string) =>
	Object.entries(await replyFiles()).find(([, body]) => body.includes(text));

const conversation = (title: string) =>
	page
		.getByRole('complementary', { name: 'Conversations' })
		.getByRole('button', { name: title });
const repliesView = () => page.getByRole('region', { name: 'Replies' });
const replyCard = (text: string) =>
	repliesView().getByRole('article', { name: /^Reply to / }).filter({ hasText: text });
const composer = () => page.getByLabel('Message', { exact: true });
const sendSelected = () =>
	repliesView().getByRole('button', { name: /^Send selected/ });

/**
 * Reload the page once its service worker is ready, so the worker controls
 * it, and answer what the worker cached. In Chromium also reload with the
 * browser offline (`context.setOffline`) and answer whether a request the
 * worker did not cache failed: proof the page came from the cache. WebKit
 * under Playwright blocks an offline navigation before any service worker
 * sees it ("WebKit encountered an internal error"), so there the check is
 * that the worker controls the page and holds every file it needs.
 */
async function reloadOffline(browserName: string) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	await page.reload();
	const cached = await page.evaluate(async () => {
		const name = (await caches.keys()).find((key) =>
			key.startsWith('epicenter-site-'),
		);
		if (name === undefined) return { home: false, scripts: 0 };
		const cache = await caches.open(name);
		const scripts = [
			...document.querySelectorAll('script[src], link[rel="modulepreload"]'),
		].map(
			(element) => element.getAttribute('src') ?? element.getAttribute('href'),
		);
		return {
			home: (await cache.match('/')) !== undefined,
			scripts: (
				await Promise.all(scripts.map((url) => cache.match(url!)))
			).filter((hit) => hit === undefined).length,
		};
	});
	const controlled = await page.evaluate(
		() => navigator.serviceWorker.controller !== null,
	);
	if (browserName !== 'chromium') return { controlled, cached, uncached: null };
	await context.setOffline(true);
	try {
		await page.reload();
		return {
			controlled: await page.evaluate(
				() => navigator.serviceWorker.controller !== null,
			),
			cached,
			uncached: await page.evaluate(() =>
				fetch(`/not-cached-${Date.now()}`).then(
					() => 'answered',
					() => 'failed',
				),
			),
		};
	} finally {
		await context.setOffline(false);
	}
}

const agentNote = `---\nchatId: live-ada\nchatTitle: Ada Test\nprofile: fake-test-installation\nstatus: draft\n---\nDrafted by an agent`;

test('1. replies open from the folder while Beeper is not connected, and saving them sends nothing', async () => {
	// WebKit keeps OPFS outside the profile directory: start from an empty origin.
	await page.goto(`${app}/`);
	await emptyOpfs(page);
	await mkdir(join(folder, 'replies'), { recursive: true });
	await writeFile(join(folder, 'replies', '2026-11-01T10-00-00-000Z-agent001.md'), agentNote);
	await page.goto(`${app}/`);
	await expect(page.getByText('Beeper not connected')).toBeVisible();
	await expect(replyCard('Drafted by an agent')).toBeVisible();

	// The only reply so far; a card being edited holds its text in a field.
	const card = repliesView().getByRole('article', { name: 'Reply to Ada Test' });
	await card.getByRole('button', { name: 'Edit' }).click();
	await card.getByLabel('Reply text').fill('Edited in Messages');
	await card.getByRole('button', { name: 'Save' }).click();
	await expect(card).toContainText('Edited in Messages');
	await card.getByRole('button', { name: 'Mark ready' }).click();
	await expect(card.getByText('Ready', { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await replyFiles())['2026-11-01T10-00-00-000Z-agent001.md'])
		.toBe(agentNote.replace('status: draft', 'status: ready').replace('Drafted by an agent', 'Edited in Messages'));
	// Ready waits for Send selected, which needs Beeper.
	await expect(sendSelected()).toBeDisabled();
	// The same stored conversation identity can start another draft offline.
	await card.getByRole('button', { name: 'New reply to this conversation' }).click();
	await card.getByLabel('Message').fill('Another offline reply');
	await card.getByRole('button', { name: 'Save draft' }).click();
	await expect(replyCard('Another offline reply')).toBeVisible();
	await expect.poll(async () => (await fileWith('Another offline reply'))?.[1]).toContain('status: draft');
});

test('2. drafts this browser kept stay visible, and one imports as a draft without changing them', async () => {
	const old = `---\nchatId: live-ada\nprofile: fake-test-installation\nmode: live\n---\nFrom the browser`;
	await page.evaluate(async (text) => {
		const root = await navigator.storage.getDirectory();
		const drafts = await root.getDirectoryHandle('drafts', { create: true });
		const writable = await (
			await drafts.getFileHandle('live-old.md', { create: true })
		).createWritable();
		await writable.write(text);
		await writable.close();
	}, old);
	await page.reload();
	const kept = page.getByRole('region', { name: 'Drafts kept in this browser' });
	await expect(kept).toContainText('From the browser');
	await kept.getByRole('button', { name: 'Import as draft' }).click();
	await expect(kept.getByText('Imported', { exact: true })).toBeVisible();
	expect((await replyFiles())['browser-draft-live-old.md']).toBe(
		'---\nchatId: live-ada\nprofile: fake-test-installation\nstatus: draft\n---\nFrom the browser',
	);
	expect(await opfsText(page, 'drafts/live-old.md')).toBe(old);
	await expect(replyCard('From the browser')).toBeVisible();
});

test('3. a ready reply waits, and Send selected sends it once', async () => {
	await page.getByRole('button', { name: 'Connect Beeper' }).click();
	await page.getByLabel('Beeper access token').fill('test-token');
	await page.getByRole('button', { name: 'Connect to live Beeper' }).click();
	await expect(page.getByText('Live Beeper', { exact: true })).toBeVisible();

	await conversation('Ada Test').click();
	const history = page.getByRole('list', { name: 'Messages' });
	await expect(history).toContainText('Are you there?');
	await composer().fill('Here now');
	await page.getByRole('button', { name: 'Save as ready' }).click();
	await expect(page.getByText('Saved as ready. Send it from Replies.')).toBeVisible();
	await expect.poll(async () => (await fileWith('Here now'))?.[1]).toContain('status: ready');
	await expect(history).not.toContainText('Here now');

	await page.getByRole('button', { name: /^Replies/ }).click();
	await replyCard('Here now').getByRole('checkbox').check();
	await sendSelected().click();
	await expect(repliesView().getByRole('status').first()).toContainText('1 sent to Beeper');
	// Beeper reports it sent, so its note leaves the folder.
	await expect.poll(async () => (await fileWith('Here now')) === undefined, { timeout: 20_000 }).toBe(true);
	await conversation('Ada Test').click();
	await expect(history).toContainText('Here now');
	await expect(history.getByText('Here now')).toHaveCount(1);
});

test('4. a send with no answer waits for a person, holds its chat, and a reload sends nothing', async () => {
	await composer().fill('Maybe [no answer]');
	await page.getByRole('button', { name: 'Save as ready' }).click();
	await expect(page.getByText('Saved as ready.')).toBeVisible();
	await composer().fill('Second thought');
	await page.getByRole('button', { name: 'Save as ready' }).click();
	await expect.poll(async () => (await fileWith('Second thought')) !== undefined).toBe(true);

	await page.getByRole('button', { name: /^Replies/ }).click();
	await replyCard('Maybe [no answer]').getByRole('checkbox').check();
	await replyCard('Second thought').getByRole('checkbox').check();
	await sendSelected().click();
	await expect(repliesView().getByRole('status').first()).toContainText('0 sent to Beeper, 2 not sent');
	await expect(replyCard('Maybe [no answer]').getByText('Check in Beeper')).toBeVisible();
	await expect(replyCard('Second thought')).toContainText('held back to keep their order');

	await page.reload();
	await expect(page.getByText('Live Beeper', { exact: true })).toBeVisible();
	await expect(replyCard('Maybe [no answer]').getByText('Check in Beeper')).toBeVisible();
	await expect(replyCard('Second thought').getByRole('checkbox')).toBeEnabled();
	await conversation('Ada Test').click();
	const history = page.getByRole('list', { name: 'Messages' });
	await expect(history).toContainText('Here now');
	await expect(history).not.toContainText('Maybe');
	await expect(history).not.toContainText('Second thought');

	await page.getByRole('button', { name: /^Replies/ }).click();
	await replyCard('Maybe [no answer]').getByRole('button', { name: 'I checked Beeper: not sent' }).click();
	await expect(replyCard('Maybe [no answer]').getByText('Not sent', { exact: true })).toBeVisible();
	expect(await fileWith('Maybe [no answer]')).toBeDefined();
});

test('5. the Messages folder fits the published contract', async () => {
	const checked = await run(
		['bun', '--no-install', cli, 'check', `${app}/contract.json`, folder],
		{ cwd: folder, env: { ...process.env } as Record<string, string> },
	);
	expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
});

test('6. the demo sends fictional replies through the same steps', async () => {
	await page.getByRole('button', { name: 'Try the demo' }).click();
	await expect(page.getByText('Demo · fictional conversations')).toBeVisible();
	await conversation('Maya Chen').click();
	await composer().fill('Ten works');
	await page.getByRole('button', { name: 'Save as ready' }).click();
	await page.getByRole('button', { name: /^Replies/ }).click();
	await replyCard('Ten works').getByRole('checkbox').check();
	await sendSelected().click();
	await expect(repliesView().getByRole('status').first()).toContainText('1 sent in the demo');
	await conversation('Maya Chen').click();
	await expect(page.getByRole('list', { name: 'Messages' })).toContainText('Ten works');
	// The demo never writes to the folder.
	expect(await fileWith('Ten works')).toBeUndefined();
	await page.getByRole('button', { name: 'Leave the demo' }).click();
	await expect(page.getByText('Live Beeper', { exact: true })).toBeVisible();
});

test('7. the page, loaded once, reopens offline from its service worker', async ({
	browserName,
}) => {
	await page.goto(`${app}/`);
	const reopened = await reloadOffline(browserName);
	expect(reopened).toMatchObject({
		controlled: true,
		cached: { home: true, scripts: 0 },
		uncached: browserName === 'chromium' ? 'failed' : null,
	});
	if (browserName !== 'chromium') return;
	await context.setOffline(true);
	try {
		await expect(
			page.getByText('Demo · fictional conversations'),
		).toBeVisible();
		await conversation('Maya Chen').click();
		await expect(composer()).toBeVisible();
	} finally {
		await context.setOffline(false);
	}
});
