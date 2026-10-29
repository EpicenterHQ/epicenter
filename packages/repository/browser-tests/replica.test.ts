/**
 * Replica Host Tests
 *
 * Design B's client in real Chromium and WebKit with persistent profiles,
 * so OPFS behaves as it does for a person: each replica is a directory in
 * the replica layout, its database SQLite over `opfs-sahpool` in `sqlite/`,
 * its blobs in `objects/`, owned by one tab's worker at a time. No server
 * runs here; `replica-sync.test.ts` adds one.
 *
 * Playwright's WebKit shares one origin's OPFS across persistent profiles,
 * so every check of what is listed looks only at its own replica ids.
 *
 * Key behaviors:
 * - A replica survives a reload, is listed from its manifest, and keeps the layout: manifest.json, sqlite/, objects/
 * - A second tab offers Use here, which takes the replica; the first shows moved and never takes it back by itself
 * - Freezing the page saves the last keystroke and lets the database go
 * - Only another worker holding the database is waiting; a database that cannot open for another reason is unavailable at once
 * - A removal refuses unsent text unless told; a removal cut short is finished by the next listing, and the replica never opens again
 * - A blob survives a reload, and a File read from it still reads after the worker that read it ends
 * - The blob store's conformance checks hold against OPFS
 * - The first save from a click asks for persistent storage and shows the grant; the estimate is the origin's
 * - (Chromium) A save the device has no room for fails before it is acknowledged, and stores nothing
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, webkit } from 'playwright';
import { BLOB_STORE_CHECKS } from '../src/client/blobs.checks.js';
import { startSite } from './site.js';
import { launchProfile, loadReplicaPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

/** A repository id no other test uses (WebKit's profiles share OPFS, and an origin holds one replica per repository and account). */
const uniqueRepository = (base: string) => `${base}-${crypto.randomUUID().slice(0, 8)}`;
const note = (body: string) => `---\ntitle: A\n---\n${body}`;
const stored = { data: undefined, error: null };

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a replica survives a reload, is listed from its manifest, and keeps the replica layout',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const repository = uniqueRepository('reload');
					const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica } = await page.evaluate((repository) => replicas.create(repository, { account: 'alice' }), repository);
					if (replica === null) throw new Error('the replica was not created');
					expect(await page.evaluate(() => replicas.write('notes/a.md', `---\ntitle: A\n---\none\n`))).toEqual(stored);
					// One replica per repository and account in an origin.
					expect(await page.evaluate((repository) => replicas.create(repository, { account: 'alice' }), repository)).toMatchObject({ error: 'AlreadyHere' });

					await page.reload();
					await page.waitForFunction(() => globalThis.replicas !== undefined);
					expect(await page.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'open' });
					expect(await page.evaluate(() => replicas.read('notes/a.md'))).toBe(note('one\n'));
					// No server, so the save waits to be sent.
					expect(await page.evaluate(() => replicas.unsent())).toEqual(['notes/a.md']);
					expect(await page.evaluate(() => replicas.query('SELECT path FROM notes'))).toEqual([{ path: 'notes/a.md' }]);

					const listed = (await page.evaluate(() => replicas.list())).filter((manifest) => manifest.replica === replica);
					expect(listed).toEqual([{ replica, repository, name: repository, account: 'alice', url: null }]);
					const layout = await page.evaluate((replica) => replicas.layout(replica), replica);
					expect(layout?.root).toEqual(['manifest.json', 'objects/', 'sqlite/']);
					// The VFS's own files only: no blob, no manifest, in its directory.
					expect(layout?.sqlite?.every((name) => name.startsWith('.'))).toBe(true);
					expect(layout?.objects).toEqual([]);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a second tab offers Use here, which takes the replica; the first shows moved and never takes it back by itself',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const first = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica } = await first.evaluate((repository) => replicas.create(repository), uniqueRepository('takeover'));
					if (replica === null) throw new Error('the replica was not created');
					await first.evaluate(() => replicas.write('notes/plan.md', `---\ntitle: A\n---\nfirst\n`));

					const second = await loadReplicaPage(context, site.url);
					expect(await second.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'elsewhere' });
					await second.evaluate(() => replicas.useHere());
					await second.evaluate(() => replicas.untilStatus('open'));
					await first.evaluate(() => replicas.untilStatus('moved'));
					expect(await second.evaluate(() => replicas.read('notes/plan.md'))).toBe(note('first\n'));
					expect(await second.evaluate(() => replicas.write('notes/plan.md', `---\ntitle: A\n---\nsecond\n`))).toEqual(stored);

					// The owner goes away and the lock is free; the first tab stays moved until asked.
					await second.close();
					await first.evaluate((replica) => replicas.untilReleased(replica), replica);
					await Bun.sleep(500);
					expect(await first.evaluate(() => replicas.status())).toBe('moved');
					await first.evaluate(() => replicas.useHere());
					await first.evaluate(() => replicas.untilStatus('open'));
					expect(await first.evaluate(() => replicas.read('notes/plan.md'))).toBe(note('second\n'));
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
					const first = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica } = await first.evaluate((repository) => replicas.create(repository), uniqueRepository('freeze'));
					if (replica === null) throw new Error('the replica was not created');
					await first.evaluate(() => replicas.write('notes/log.md', `---\ntitle: A\n---\nab\n`));
					// The keystroke and the freeze in one task: the write is only posted to the worker.
					const index = await first.evaluate(() => replicas.writeThenFreeze('notes/log.md', `---\ntitle: A\n---\nabc\n`));
					expect(await first.evaluate((index) => replicas.settled(index), index)).toEqual(stored);
					await first.evaluate((replica) => replicas.untilReleased(replica), replica);

					// With no owner, another tab opens the replica without asking.
					const second = await loadReplicaPage(context, site.url);
					expect(await second.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'open' });
					expect(await second.evaluate(() => replicas.read('notes/log.md'))).toBe(note('abc\n'));
					// Back from the freeze, the first tab finds it taken.
					await first.evaluate(() => replicas.resume());
					await first.evaluate(() => replicas.untilStatus('elsewhere'));
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'only another worker holding the database is waiting; a database that cannot open for another reason is unavailable at once',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const first = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica } = await first.evaluate((repository) => replicas.create(repository), uniqueRepository('waiting'));
					if (replica === null) throw new Error('the replica was not created');
					await first.evaluate(() => replicas.write('notes/log.md', `---\ntitle: A\n---\nkept\n`));
					await first.close();

					// An old owner that keeps the lock and the database, as a frozen tab would.
					const stale = await loadReplicaPage(context, site.url);
					await stale.evaluate((replica) => replicas.holdAsStaleOwner(replica), replica);
					const next = await loadReplicaPage(context, site.url);
					expect(await next.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'elsewhere' });
					await next.evaluate(() => replicas.useHere());
					await next.evaluate(() => replicas.untilStatus('waiting'));
					await Bun.sleep(3_000);
					expect(await next.evaluate(() => replicas.status())).toBe('waiting');
					await stale.evaluate(() => replicas.releaseStorage());
					await next.evaluate(() => replicas.untilStatus('open'));
					expect(await next.evaluate(() => replicas.read('notes/log.md'))).toBe(note('kept\n'));
					await next.evaluate(() => replicas.close());
					await next.evaluate((replica) => replicas.untilReleased(replica), replica);

					// A database that cannot open for any other reason is not waited for.
					await next.evaluate((replica) => replicas.breakDatabase(replica), replica);
					const started = Date.now();
					expect(await next.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'unavailable', error: 'Unavailable' });
					expect(Date.now() - started).toBeLessThan(5_000);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a removal refuses unsent text unless told; one cut short is finished by the next listing, and the replica never opens again',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica: removed } = await page.evaluate((repository) => replicas.create(repository), uniqueRepository('remove'));
					if (removed === null) throw new Error('the replica was not created');
					await page.evaluate(() => replicas.write('notes/a.md', `---\ntitle: A\n---\nunsent\n`));
					expect(await page.evaluate(() => replicas.remove())).toMatchObject({ error: { name: 'UnsentWork', paths: ['notes/a.md'] } });
					expect(await page.evaluate(() => replicas.status())).toBe('open');
					expect(await page.evaluate(() => replicas.remove(true))).toEqual(stored);
					expect(await page.evaluate(() => replicas.status())).toBe('closed');
					expect(await page.evaluate((replica) => replicas.layout(replica), removed)).toBeNull();

					// A removal cut short: marked, its database gone, its manifest and objects still there.
					const { replica: cut } = await page.evaluate((repository) => replicas.create(repository), uniqueRepository('cut'));
					if (cut === null) throw new Error('the replica was not created');
					await page.evaluate(() => replicas.seal(1_000, 1));
					await page.evaluate(() => replicas.close());
					await page.evaluate((replica) => replicas.untilReleased(replica), cut);
					await page.evaluate((replica) => replicas.interruptRemoval(replica), cut);
					await page.reload();
					await page.waitForFunction(() => globalThis.replicas !== undefined);
					// It never opens while marked, and the next listing finishes it.
					expect(await page.evaluate((replica) => replicas.open(replica), cut)).toEqual({ status: 'unavailable', error: 'NotFound' });
					await page.evaluate(() => replicas.close());
					await page.evaluate((replica) => replicas.untilReleased(replica), cut);
					expect((await page.evaluate(() => replicas.list())).map((manifest) => manifest.replica)).not.toContain(cut);
					expect(await page.evaluate(() => replicas.replicaDirectories())).not.toContain(cut);
					expect(await page.evaluate((replica) => replicas.open(replica), cut)).toEqual({ status: 'unavailable', error: 'NotFound' });
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a blob survives a reload, and a File read from it still reads after the worker that read it ends',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const { replica } = await page.evaluate((repository) => replicas.create(repository), uniqueRepository('blob'));
					if (replica === null) throw new Error('the replica was not created');
					const { result, expected } = await page.evaluate(() => replicas.seal(300_000, 2));
					expect(result as unknown).toEqual({ data: expected, error: null });
					const oid = expected?.oid ?? '';

					await page.reload();
					await page.waitForFunction(() => globalThis.replicas !== undefined);
					expect(await page.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'open' });
					expect(await page.evaluate((oid) => replicas.blob(oid), oid)).toEqual(expected);
					expect((await page.evaluate((replica) => replicas.layout(replica), replica))?.objects).toEqual([oid]);

					// The page keeps the File; the worker that read it ends.
					expect(await page.evaluate((oid) => replicas.keep(oid), oid)).toBe(true);
					await page.evaluate(() => replicas.close());
					await page.evaluate((replica) => replicas.untilReleased(replica), replica);
					expect(await page.evaluate((oid) => replicas.readKept(oid), oid)).toEqual({ direct: expected, viaUrl: expected });
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			"the blob store's conformance checks hold against OPFS",
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					const results = await page.evaluate(() => replicas.checkObjects());
					expect(results).toEqual(Object.fromEntries(Object.keys(BLOB_STORE_CHECKS).map((name) => [name, 'ok'])));
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			"the first save from a click asks for persistent storage and shows the grant; the estimate is the origin's",
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
					await page.evaluate((repository) => replicas.create(repository), uniqueRepository('persist'));
					await page.waitForFunction(() => replicas.persistence() !== 'checking');
					expect(['not-asked', 'granted']).toContain(await page.evaluate(() => replicas.persistence()));
					await page.evaluate(() => replicas.arm('notes/a.md', `---\ntitle: A\n---\nclicked\n`));
					await page.click('#save');
					expect(await page.evaluate(() => replicas.settled(0))).toEqual(stored);
					// Headless browsers answer without a prompt; the answer is what is shown.
					await page.waitForFunction(() => ['granted', 'denied'].includes(replicas.persistence()));
					const estimate = await page.evaluate(() => replicas.estimate());
					expect(estimate.scope).toBe('origin');
					expect(estimate.quota).toBeGreaterThan(0);
					expect(estimate.usage).toBeGreaterThanOrEqual(0);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		if (engine === 'chromium')
			test(
				'a save the device has no room for fails before it is acknowledged, and stores nothing',
				async () => {
					const { context, cleanup } = await launchProfile(browser);
					try {
						const page = await loadReplicaPage(context, site.url, { page: context.pages()[0] });
						const { replica } = await page.evaluate((repository) => replicas.create(repository), uniqueRepository('quota'));
						if (replica === null) throw new Error('the replica was not created');
						expect(await page.evaluate(() => replicas.write('notes/a.md', `---\ntitle: A\n---\nsmall\n`))).toEqual(stored);
						// Chromium's DevTools protocol caps this origin's quota near what it already uses.
						const cdp = await context.newCDPSession(page);
						const origin = new URL(site.url).origin;
						const { usage } = await page.evaluate(() => replicas.estimate());
						await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage + 200_000 });

						const large = `---\ntitle: A\n---\n${'x'.repeat(2_000_000)}\n`;
						expect(await page.evaluate((large) => replicas.write('notes/a.md', large), large)).toMatchObject({ error: { name: 'QuotaExceeded' } });
						expect(await page.evaluate(() => replicas.read('notes/a.md'))).toBe(note('small\n'));
						expect(await page.evaluate(() => replicas.seal(2_000_000, 3))).toMatchObject({ result: { error: { name: 'QuotaExceeded' } } });

						// With room again, saves store, and nothing of the refused ones was kept.
						await cdp.send('Storage.overrideQuotaForOrigin', { origin });
						expect(await page.evaluate(() => replicas.write('notes/b.md', `---\ntitle: A\n---\nroom\n`))).toEqual(stored);
						await page.reload();
						await page.waitForFunction(() => globalThis.replicas !== undefined);
						expect(await page.evaluate((replica) => replicas.open(replica), replica)).toEqual({ status: 'open' });
						expect(await page.evaluate(() => replicas.read('notes/a.md'))).toBe(note('small\n'));
						expect(await page.evaluate(() => replicas.read('notes/b.md'))).toBe(note('room\n'));
						expect((await page.evaluate((replica) => replicas.layout(replica), replica))?.objects).toEqual([]);
					} finally {
						await cleanup();
					}
				},
				TIMEOUT,
			);
	});
}
