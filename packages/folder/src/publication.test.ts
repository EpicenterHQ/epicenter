/**
 * Publication accounting over partially completed file operations.
 *
 * Local observers hear confirmed paths and uncertain failed-step paths,
 * never unattempted paths. Accounting preserves the storage receipt and
 * notes one edit for any outcome that may have changed a path; it asks for
 * no commit (ADR-0529).
 */
import { expect, test } from 'bun:test';
import { expectErr } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { ApplyError, FileError, type FileStep } from './errors.js';
import { withPublication } from './storage.js';

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
