/**
 * Publication accounting over partially completed file operations.
 *
 * Any outcome that may have changed a path notes one edit, so the history's
 * observations go stale, and the storage receipt passes through unchanged.
 * A refusal that changed nothing notes none. Accounting asks for no commit
 * (ADR-0529) and tells no change listener: a handle's own saves are not
 * reported to it (ADR-0548).
 */
import { expect, test } from 'bun:test';
import { expectErr } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { ApplyError, FileError, type FileStep } from './errors.js';
import { withPublication } from './storage.js';

const overwrite = (path: string) =>
	({
		kind: 'overwrite',
		path,
		bytes: new Uint8Array(),
		sha256: path,
	}) as const;

for (const failed of [
	{ kind: 'move', from: 'source/b.md', to: 'destination/b.md' },
	{ kind: 'remove', path: 'source/b.md' },
] satisfies FileStep[])
	for (const unknown of [true, false])
		test(`a partial ${failed.kind} ${unknown ? 'with an uncertain step' : 'with a refused step'} notes one edit without changing its receipt`, async () => {
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
			let edits = 0;
			const storage = withPublication({
				storage: { ...boundary, apply: async () => receipt },
				history: {
					noteEdit: () => {
						edits++;
					},
				},
			});
			expect(
				await storage.apply([
					overwrite('confirmed.md'),
					failed,
					overwrite('unattempted.md'),
				]),
			).toBe(receipt);
			expect(edits).toBe(1);
		});

test('a refusal that changed nothing notes no edit', async () => {
	const { boundary } = await rawBrowserFolder({ id: 'publication-refusal' });
	const refusal = FileError.Conflict({
		path: 'a.md',
		expectedSha256: 'a'.repeat(64),
		actualSha256: undefined,
	});
	let edits = 0;
	const storage = withPublication({
		storage: { ...boundary, apply: async () => refusal },
		history: {
			noteEdit: () => {
				edits++;
			},
		},
	});
	expect(await storage.apply([overwrite('a.md')])).toBe(refusal);
	expect(edits).toBe(0);
});
