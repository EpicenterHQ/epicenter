/**
 * Browser Host Tests
 *
 * Real Chromium and WebKit with persistent profiles, so OPFS behaves as it
 * does for a person: the repository lives in SQLite through the
 * `opfs-sahpool` VFS in the leader tab's worker, and other tabs call it over
 * the BroadcastChannel. No server runs here; `sync.test.ts` adds one.
 *
 * Key behaviors:
 * - A reload keeps data and unsent edits
 * - Two tabs share one leader and see each other's edits, in reads and open notes
 * - Closing the leader mid-command hands over without losing or repeating the command
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { startSite } from './site.js';
import { launchProfile, openTab, reopen, TIMEOUT, uniqueName } from './support.js';

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
			"two tabs share one leader and see each other's edits",
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('shared');
					const a = await openTab(context, site.url, name, { page: context.pages()[0] });
					const b = await openTab(context, site.url, name);
					expect(await a.evaluate(() => harness.locks())).toEqual({ held: 1, pending: 1 });
					await b.evaluate(() => harness.hold('plan'));
					await a.evaluate(() => harness.write('plan', 'from a\n'));
					await b.evaluate(() => harness.untilHeld('plan', 'from a\n'));
					await b.evaluate(() => harness.append('plan', 'from b\n'));
					expect(await b.evaluate(() => harness.heldText('plan'))).toBe('from a\nfrom b\n');
					await a.evaluate(() => harness.untilText('plan', 'from a\nfrom b\n'));
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'closing the leader mid-command hands over without losing or repeating the command',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('handover');
					const leader = await openTab(context, site.url, name, { page: context.pages()[0] });
					const follower = await openTab(context, site.url, name);
					await follower.evaluate(() => harness.write('log', 'one\n'));
					// The leader applies the next write but never answers it, as a
					// leader whose tab closes between the two would.
					await follower.evaluate(() => harness.dropSubmitAnswers());
					const appended = await follower.evaluate(() => harness.append('log', 'two\n', { wait: false }));
					await leader.evaluate(() => harness.untilText('log', 'one\ntwo\n'));
					await leader.close();
					// Sent while no tab leads: the next leader receives it.
					await follower.evaluate(() => harness.append('log', 'three\n', { wait: false }));
					await follower.evaluate(() => harness.untilText('log', 'one\ntwo\nthree\n'));
					expect(await follower.evaluate(() => harness.locks())).toEqual({ held: 1, pending: 0 });
					expect(await follower.evaluate(() => harness.unsent())).toBe(3);
					// The retried command was found in the outbox, not applied again.
					await follower.evaluate(() => harness.flush());
					expect(await follower.evaluate(() => harness.text('log'))).toBe('one\ntwo\nthree\n');
					expect(appended).toBe(1);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
