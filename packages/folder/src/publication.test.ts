/**
 * Publication accounting over a folder's storage.
 *
 * A change that landed, or may have, notes one edit, so the history's
 * observations go stale, and the storage's answer passes through unchanged;
 * so do changes made holding the save lock. A change that changed nothing
 * notes none. Accounting asks for no commit (ADR-0529) and tells no change
 * listener: a handle's own saves are not reported to it (ADR-0548).
 */
import { expect, test } from 'bun:test';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { FileError } from './errors.js';
import { withPublication } from './storage.js';

const bytes = new TextEncoder().encode('x');

async function counted(id: string) {
	const { boundary } = await rawBrowserFolder({ id });
	let edits = 0;
	return {
		boundary,
		edits: () => edits,
		wrap: (storage = boundary) =>
			withPublication({
				storage,
				history: {
					noteEdit: () => {
						edits++;
					},
				},
			}),
	};
}

test('a change that landed, or whose reply was lost, notes one edit, under the lock too', async () => {
	const { boundary, edits, wrap } = await counted('publication-landed');
	const storage = wrap();
	expect((await storage.put('a.md', bytes, null)).data).toBe('landed');
	expect(edits()).toBe(1);
	await storage.lock(async (held) => {
		expect((await held.put('b.md', bytes, null)).data).toBe('landed');
	});
	expect(edits()).toBe(2);
	const lost = FileError.Unconfirmed({
		path: 'c.md',
		operation: 'write',
		cause: new Error('lost reply'),
	});
	const unconfirmed = wrap({ ...boundary, put: async () => lost });
	expect(await unconfirmed.put('c.md', bytes, null)).toBe(lost);
	expect(edits()).toBe(3);
});

test('a change that changed nothing notes no edit', async () => {
	const { boundary, edits, wrap } = await counted('publication-refusal');
	const storage = wrap();
	expect((await storage.put('a.md', bytes, null)).data).toBe('landed');
	expect((await storage.put('a.md', bytes, null)).data).toBe('stale');
	expect(edits()).toBe(1);
	const refusal = FileError.Io({
		path: 'b.md',
		operation: 'write',
		cause: new Error('disk full'),
	});
	const refusing = wrap({ ...boundary, put: async () => refusal });
	expect(await refusing.put('b.md', bytes, null)).toBe(refusal);
	expect(edits()).toBe(1);
});
