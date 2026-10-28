/**
 * Browser Host Tests
 *
 * Real Chromium and WebKit with persistent profiles, so OPFS behaves as it
 * does for a person: the repository lives in SQLite through the
 * `opfs-sahpool` VFS in the owning tab's worker. No server runs here;
 * `sync.test.ts` adds one.
 *
 * Key behaviors:
 * - A reload keeps data and unsent edits
 * - A second tab offers Use here; taking over moves the repository, and the old tab never takes it back by itself
 * - Freezing the page saves the last keystroke and releases the database
 * - Use here waits for an old worker to release the database, however long it takes
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { startSite } from './site.js';
import { launchProfile, loadTab, openTab, reopen, TIMEOUT, uniqueName } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a reload keeps data and unsent edits',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('reload');
					const page = await openTab(context, site.url, name, { page: context.pages()[0] });
					await page.evaluate(() => harness.write('trip', 'Pack.\n'));
					await page.evaluate(() => harness.append('trip', 'Passport.\n'));
					await page.reload();
					await reopen(page, name);
					expect(await page.evaluate(() => harness.text('trip'))).toBe('Pack.\nPassport.\n');
					// Never sent, since there is no server: both writes wait in the outbox.
					expect(await page.evaluate(() => harness.unsent())).toBe(2);
					// SQLite computes the fields column with the registered parser.
					await page.evaluate(() => harness.setTitle('trip', 'Trip'));
					expect(await page.evaluate(() => harness.query('SELECT stem, title FROM notes'))).toEqual([{ stem: 'trip', title: 'Trip' }]);
					const [table] = await page.evaluate(() => harness.query(`SELECT sql FROM sqlite_master WHERE name = 'epicenter/files'`));
					expect(String(table?.sql)).toContain('GENERATED ALWAYS AS (epicenter_fields(text)) STORED');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a second tab offers Use here, which takes the repository; the first tab shows it moved',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('takeover');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					await first.evaluate(() => harness.write('plan', 'from the first tab\n'));
					const second = await loadTab(context, site.url);
					expect(await reopen(second, name)).toBe('elsewhere');

					await second.evaluate(() => harness.useHere());
					await second.evaluate(() => harness.untilStatus('open'));
					expect(await second.evaluate(() => harness.text('plan'))).toBe('from the first tab\n');
					await first.evaluate(() => harness.untilStatus('moved'));
					await second.evaluate(() => harness.append('plan', 'from the second tab\n'));
					expect(await second.evaluate(() => harness.text('plan'))).toBe('from the first tab\nfrom the second tab\n');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a tab that lost the repository never takes it back by itself',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('retake');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					const second = await openTab(context, site.url, name);
					await second.evaluate(() => harness.useHere());
					await second.evaluate(() => harness.untilStatus('open'));
					await second.evaluate(() => harness.write('plan', 'second\n'));
					await first.evaluate(() => harness.untilStatus('moved'));
					// The owner goes away and the lock is free; the first tab stays moved.
					await second.close();
					await first.evaluate(() => harness.untilReleased());
					await Bun.sleep(500);
					expect(await first.evaluate(() => harness.status())).toBe('moved');
					await first.evaluate(() => harness.useHere());
					await first.evaluate(() => harness.untilStatus('open'));
					expect(await first.evaluate(() => harness.text('plan'))).toBe('second\n');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'freezing the page saves the last keystroke and lets the database go',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('freeze');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					await first.evaluate(() => harness.write('log', 'ab'));
					// The keystroke and the freeze in one task: the write is only posted to the worker.
					await first.evaluate(() => harness.writeThenFreeze('log', 'abc'));
					// The write was saved before the worker let the database go.
					expect(await first.evaluate(() => harness.settled(1))).toEqual({ data: undefined, error: null });
					await first.evaluate(() => harness.untilReleased());

					// With no owner, another tab opens the repository without asking.
					const second = await loadTab(context, site.url);
					expect(await reopen(second, name)).toBe('open');
					expect(await second.evaluate(() => harness.text('log'))).toBe('abc');
					// Back from the freeze, the first tab finds the repository taken.
					await first.evaluate(() => harness.resume());
					await first.evaluate(() => harness.untilStatus('elsewhere'));
					expect(await second.evaluate(() => harness.status())).toBe('open');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'Use here waits, past five seconds, until the old worker lets the database go',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('waiting');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					await first.evaluate(() => harness.write('log', 'kept\n'));
					await first.close();
					// An old owner that keeps the lock and the storage, as a frozen tab would.
					const stale = await loadTab(context, site.url);
					await stale.evaluate((name) => harness.holdAsStaleOwner(name), name);
					const next = await loadTab(context, site.url);
					expect(await reopen(next, name)).toBe('elsewhere');

					await next.evaluate(() => harness.useHere());
					await next.evaluate(() => harness.untilStatus('waiting'));
					await Bun.sleep(6_000);
					expect(await next.evaluate(() => harness.status())).toBe('waiting');
					await stale.evaluate(() => harness.releaseStorage());
					await next.evaluate(() => harness.untilStatus('open'));
					expect(await next.evaluate(() => harness.text('log'))).toBe('kept\n');
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
