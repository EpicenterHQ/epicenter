/**
 * Publication accounting over partially completed file operations.
 *
 * Local observers hear confirmed paths and uncertain failed-step paths,
 * never unattempted paths. Accounting preserves the storage receipt and
 * notes one edit for any outcome that may have changed a path; it asks for
 * no commit (ADR-0529).
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	rawBrowserFolder,
} from './browser-storage.test-support.js';
import { defineFolder } from './contract.js';
import { ApplyError, FileError, type FileStep } from './errors.js';
import { withPublication } from './storage.js';

test('a directory move hints its uncertain destination after a completed prefix', async () => {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: 'partial-publication',
			definition: defineFolder({ kv: {}, tables: {} }),
			browser: { ...browserStorage(storage) },
		}),
	);
	try {
		for (const name of ['a', 'b', 'c'])
			expectOk(await folder.files.create(`source/${name}.md`, name));
		const heard: string[] = [];
		folder.onFilesChanged((paths) => heard.push(...paths));
		storage.opfs.faults.close = (path) =>
			path.endsWith('/destination/b.md') ? 'lost' : undefined;
		const result = await folder.terminal().exec('mv source destination');
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('did not confirm');
		expect([...new Set(heard)].sort()).toEqual([
			'destination/a.md',
			'destination/b.md',
			'source/a.md',
			'source/b.md',
		]);
		expect(expectOk(await folder.files.read('destination/b.md')).bytes).toEqual(
			new TextEncoder().encode('b'),
		);
		expect(expectOk(await folder.files.read('source/b.md')).bytes).toEqual(
			new TextEncoder().encode('b'),
		);
		expect(expectErr(await folder.files.read('destination/c.md')).name).toBe(
			'NotFound',
		);
	} finally {
		storage.opfs.faults.close = undefined;
		await folder.close();
	}
});

for (const failed of [
	{ kind: 'move', from: 'source/b.md', to: 'destination/b.md' },
	{ kind: 'remove', path: 'source/b.md' },
] satisfies FileStep[])
	for (const unknown of [true, false])
		test(`a partial ${failed.kind} ${unknown ? 'hints uncertain paths' : 'hints only its confirmed prefix'} without changing its receipt`, async () => {
			const { boundary } = await rawBrowserFolder({
				id: 'publication-receipt',
			});
			const path = failed.kind === 'move' ? failed.to : failed.path;
			const cause = {
				path,
				operation: 'publication',
				cause: new Error('lost reply'),
			};
			const receipt = ApplyError.Partial({
				applied: [{ kind: 'write', path: 'confirmed.md' }],
				failed,
				error: unknown
					? expectErr(FileError.Unconfirmed(cause))
					: expectErr(FileError.Io(cause)),
				notAttempted: [{ kind: 'write', path: 'unattempted.md' }],
			});
			const heard: string[] = [];
			let edits = 0;
			const storage = withPublication({
				storage: { ...boundary, apply: async () => receipt },
				history: {
					noteEdit: () => {
						edits++;
					},
				},
				landed: (paths) => heard.push(...paths),
			});
			expect(
				await storage.apply([
					{
						kind: 'overwrite',
						path: 'confirmed.md',
						bytes: new Uint8Array(),
						sha256: 'confirmed',
					},
					failed,
					{
						kind: 'overwrite',
						path: 'unattempted.md',
						bytes: new Uint8Array(),
						sha256: 'unattempted',
					},
				]),
			).toBe(receipt);
			expect(edits).toBe(1);
			expect(heard).toEqual([
				'confirmed.md',
				...(unknown
					? failed.kind === 'move'
						? [failed.from, failed.to]
						: [failed.path]
					: []),
			]);
		});
