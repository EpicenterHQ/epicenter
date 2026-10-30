/**
 * Leaving Mid-Write Tests
 *
 * An editor sends one write at a time; what is typed while it is in flight
 * waits in the page, in the draft. These tests hold the worker's answer to
 * that write, type more, and then leave the page the way a person does
 * (a reload) or the way a browser does (a freeze), so the draft above the
 * write in flight is still only in the page when the worker session ends.
 *
 * Key behaviors:
 * - A reload with typing above a write in flight keeps all of it, and the server gets it
 * - A freeze does too, and typing carries on after it
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, webkit } from 'playwright';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';
import { startSite } from './site.js';
import { launchProfile, loadApiPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

/** Open `stem`'s editor and type `held` as one write whose answer the page holds, then `more`, which waits in the draft. */
async function typeAboveAHeldWrite(
	page: Page,
	stem: string,
	held: string,
	more: string,
) {
	const row = page.locator(`[data-testid="todo"][data-stem="${stem}"]`);
	await row.getByRole('button', { name: stem }).click();
	const content = page.locator('.cm-content');
	await content.waitFor();
	await content.click();
	await page.evaluate(() => api.hold());
	await page.keyboard.type(held);
	await page.waitForFunction(
		(held) => api.editorState() === 'saving' && api.editorDraft() === held,
		held,
	);
	await page.keyboard.type(more);
	await page.waitForFunction(
		(typed) => api.editorDraft() === typed,
		`${held}${more}`,
	);
}

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a reload with typing above a write in flight keeps all of it, and the server gets it',
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'leaving-'));
				const server = await openDiskRepository(join(dir, 'repo.git'));
				const repository = `leaving-${crypto.randomUUID().slice(0, 8)}`;
				const served = serveRepository({
					repository,
					serverId: 'leaving',
					server,
					authenticate: authenticateBearer((token) => ({
						user: token,
						role: 'writer',
					})),
					origins: [new URL(site.url).origin],
				});
				const profile = await launchProfile(browser);
				try {
					const page = await loadApiPage(profile.context, site.url, {
						page: profile.context.pages()[0],
					});
					const replica = await page.evaluate(
						([repository, url]) =>
							api.create(repository, { account: 'alice', url, token: 'alice' }),
						[repository, served.url] as const,
					);
					await page.evaluate(() => api.untilOpen());
					expect(
						await page.evaluate(() => api.add('milk', 'milk', '')),
					).toBeNull();
					await typeAboveAHeldWrite(page, 'milk', 'M', 'ilk');

					await page.reload();
					await page.waitForFunction(() => globalThis.api !== undefined);
					await page.evaluate((replica) => api.open(replica, 'alice'), replica);
					await page.evaluate(() => api.untilOpen());
					expect(await page.evaluate(() => api.todos())).toMatchObject([
						{ stem: 'milk', body: 'Milk' },
					]);
					const deadline = Date.now() + 10_000;
					while (
						!(server.read('todos/milk.md') ?? '').endsWith('---\nMilk') &&
						Date.now() < deadline
					)
						await Bun.sleep(50);
					expect(server.read('todos/milk.md')).toEndWith('---\nMilk');
				} finally {
					await profile.cleanup();
					await served.stop();
					await server.flush();
					await server.idle();
					await rm(dir, { recursive: true, force: true });
				}
			},
			TIMEOUT,
		);

		test(
			'a freeze with typing above a write in flight keeps all of it, and typing carries on after',
			async () => {
				const profile = await launchProfile(browser);
				try {
					const page = await loadApiPage(profile.context, site.url, {
						page: profile.context.pages()[0],
					});
					await page.evaluate(
						(repository) =>
							api.create(repository, {
								account: null,
								url: null,
								token: 'alice',
							}),
						`frozen-${crypto.randomUUID().slice(0, 8)}`,
					);
					await page.evaluate(() => api.untilOpen());
					expect(
						await page.evaluate(() => api.add('milk', 'milk', '')),
					).toBeNull();
					await typeAboveAHeldWrite(page, 'milk', 'M', 'ilk');

					// The browser freezes the page: the worker ends with the write in flight and the draft above it.
					await page.evaluate(() => api.freeze());
					await page.evaluate(() => api.untilStatus('opening'));
					await page.evaluate(() => api.release());
					await page.evaluate(() => api.resume());
					await page.evaluate(() => api.untilOpen());
					await page.evaluate(() => api.untilStored('milk', 'Milk'));
					await page.keyboard.type(' and bread');
					await page.evaluate(() => api.untilEditorSaved());
					expect(await page.evaluate(() => api.stored('milk'))).toEndWith(
						'---\nMilk and bread',
					);
				} finally {
					await profile.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
