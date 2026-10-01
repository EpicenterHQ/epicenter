/**
 * Browser download filename and source lifetime.
 * Exercises the real adapter and object URLs with an intercepted anchor click.
 * A complete filename reaches the anchor unchanged, and both successful and
 * failed clicks release their URL after the click has had a chance to consume it.
 */
import { expect, spyOn, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { DownloadServiceLive } from './index.browser.js';

for (const fails of [false, true]) {
	test(`${fails ? 'failed' : 'successful'} browser download preserves the filename and revokes its URL`, async () => {
		const previousDocument = Object.getOwnPropertyDescriptor(
			globalThis,
			'document',
		);
		const revoked = Promise.withResolvers<void>();
		const events: string[] = [];
		const urls: string[] = [];
		const originalRevoke = URL.revokeObjectURL;
		const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
			events.push('revoke');
			urls.push(url);
			originalRevoke(url);
			revoked.resolve();
		});
		let consumed: Promise<string> | undefined;
		const anchor = {
			href: '',
			download: '',
			click() {
				events.push('click');
				if (fails) throw new Error('Click refused.');
				consumed = fetch(anchor.href).then((response) => response.text());
			},
		};
		Reflect.set(globalThis, 'document', {
			createElement(tag: string) {
				expect(tag).toBe('a');
				return anchor;
			},
		});
		try {
			const result = await DownloadServiceLive.downloadBlob({
				name: 'recordings.zip',
				blob: new Blob(['archive bytes'], { type: 'application/zip' }),
			});
			if (fails) expect(expectErr(result).name).toBe('BrowserDownloadFailed');
			else expectOk(result);
			events.push('returned');
			expect(anchor.download).toBe('recordings.zip');
			await revoked.promise;
			expect(events).toEqual(['click', 'returned', 'revoke']);
			expect(urls).toEqual([anchor.href]);
			if (!fails) expect(await consumed).toBe('archive bytes');
		} finally {
			revoke.mockRestore();
			if (previousDocument)
				Object.defineProperty(globalThis, 'document', previousDocument);
			else Reflect.deleteProperty(globalThis, 'document');
		}
	});
}
