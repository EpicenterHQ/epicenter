/**
 * Browser Blob Tests
 *
 * Blob bytes in the owning tab's worker, stored in OPFS beside the
 * repository's SQLite pool, in real Chromium and WebKit with persistent
 * profiles: Playwright's WebKit has no OPFS in its default ephemeral context.
 *
 * Key behaviors:
 * - A blob survives a reload, read as bytes and through a URL with its type
 * - A tab that takes the repository over reads the blob; the old tab's URLs end with its worker
 * - Freezing the page mid-put stores the whole blob before the worker lets go
 * - Blob files live beside the SQLite pool's directory, never in it, since the VFS deletes that directory whole
 * - A put whose oid does not match its bytes stores nothing
 * - A temporary file left by a worker that died mid-put is never read as the object
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

const saved = { data: undefined, error: null };

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a blob survives a reload, read as bytes and through a URL with its type',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('blob-reload');
					const page = await openTab(context, site.url, name, { page: context.pages()[0] });
					const photo = await page.evaluate(() => harness.putBlob('cat', 10_000, 1));
					const note = await page.evaluate(() => harness.putBlob('readme', 300, 2, 'text/plain'));
					expect(photo.result).toEqual(saved);
					expect(note.result).toEqual(saved);
					await page.reload();
					await reopen(page, name);

					expect(await page.evaluate(() => harness.blob('cat'))).toEqual(photo.blob);
					const url = await page.evaluate(() => harness.blobUrl('cat'));
					expect(url).toStartWith('blob:');
					expect(await page.evaluate((url) => harness.fetchUrl(url as string), url)).toEqual({ fetched: true, type: 'image/png', blob: photo.blob });
					// One URL per object: a caller never has one to revoke.
					expect(await page.evaluate(() => harness.blobUrl('cat'))).toBe(url);
					const noteUrl = await page.evaluate(() => harness.blobUrl('readme'));
					expect(await page.evaluate((url) => harness.fetchUrl(url as string), noteUrl)).toEqual({ fetched: true, type: 'text/plain', blob: note.blob });
					expect(await page.evaluate(() => harness.blob('missing'))).toBeNull();
					expect(await page.evaluate(() => harness.blobUrl('missing'))).toBeNull();
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			"a tab that takes the repository over reads the blob, and the old tab's URL ends with its worker",
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('blob-takeover');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					const { blob } = await first.evaluate(() => harness.putBlob('cat', 50_000, 3));
					const oldUrl = await first.evaluate(() => harness.blobUrl('cat'));
					expect((await first.evaluate((url) => harness.fetchUrl(url as string), oldUrl)).fetched).toBe(true);

					const second = await loadTab(context, site.url);
					expect(await reopen(second, name)).toBe('elsewhere');
					await second.evaluate(() => harness.useHere());
					await second.evaluate(() => harness.untilStatus('open'));
					await first.evaluate(() => harness.untilStatus('moved'));

					expect(await second.evaluate(() => harness.blob('cat'))).toEqual(blob);
					const url = await second.evaluate(() => harness.blobUrl('cat'));
					expect(await second.evaluate((url) => harness.fetchUrl(url as string), url)).toEqual({ fetched: true, type: 'image/png', blob });
					// The old worker revoked its URLs as it closed.
					expect(await first.evaluate((url) => harness.fetchUrl(url as string), oldUrl)).toEqual({ fetched: false });
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'freezing the page mid-put stores the whole blob before the worker lets go',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('blob-freeze');
					const first = await openTab(context, site.url, name, { page: context.pages()[0] });
					const size = 8_000_000;
					const index = await first.evaluate((size) => harness.putBlobThenFreeze('big', size, 4), size);
					expect(await first.evaluate((index) => harness.settled(index), index)).toEqual(saved);
					await first.evaluate(() => harness.untilReleased());

					const second = await loadTab(context, site.url);
					expect(await reopen(second, name)).toBe('open');
					expect(await second.evaluate(() => harness.blob('big'))).toEqual(await second.evaluate((size) => harness.blobSummary(size, 4), size));
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			"blob files live beside the SQLite pool's directory, never in it",
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('blob-layout');
					const page = await openTab(context, site.url, name, { page: context.pages()[0] });
					const { blob } = await page.evaluate(() => harness.putBlob('cat', 1_000, 5));
					const oid = (blob as { oid: string }).oid;
					const layout = await page.evaluate((name) => harness.checkStore(name, 'layout'), name);
					expect(layout.epicenter).toEqual(expect.arrayContaining([name, `${name}.blobs`]));
					expect(layout.blobs).toEqual([oid, `${oid}.type`]);
					// The pool's directory holds only what the VFS put there.
					expect((layout.pool as string[]).some((file) => file.startsWith(oid) || file === 'blobs')).toBe(false);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a wrong oid stores nothing, and a temporary file left mid-put is never read as the object',
			async () => {
				const { context, cleanup } = await launchProfile(browser);
				try {
					const name = uniqueName('blob-store');
					const page = await openTab(context, site.url, name, { page: context.pages()[0] });

					const wrong = await page.evaluate((name) => harness.checkStore(name, 'wrong-oid'), name);
					expect(wrong.refused).toContain('do not hash to');
					expect(wrong.stored).toBeNull();
					expect(wrong.files).toEqual([]);

					const partial = await page.evaluate((name) => harness.checkStore(name, 'partial-temp'), name);
					expect(partial.before).toEqual({ bytes: null, url: null });
					expect(partial.after).toEqual(partial.expected);
					expect(partial.type).toBe('image/png');
					const { oid } = partial.expected as { oid: string };
					// The stray temporary file stays, unread, beside the object and its type.
					const files = partial.files as string[];
					expect(files.filter((file) => !file.endsWith('.tmp'))).toEqual([oid, `${oid}.type`]);
					expect(files.filter((file) => file.endsWith('.tmp'))).toHaveLength(1);
				} finally {
					await cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
