/**
 * IndexedDB publication regressions using the in-memory implementation.
 * Stale writers publish nothing, aborted batches leave no partial objects or
 * edits, and exact commit acknowledgements preserve saves from another tab.
 * Real browser transaction and reopening coverage lives in smoke/local.ts.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import {
	type GitObject,
	hashObject,
	writeCommit,
	writeTree,
} from '../git/raw-objects.js';
import { openStorage } from './storage.js';

async function fixture() {
	const id = crypto.randomUUID();
	const first = await openStorage(id);
	const second = await openStorage(id);
	return {
		id,
		first,
		second,
		close: () => {
			first.close();
			second.close();
		},
	};
}

test('a stale publication installs neither objects, refs, nor edit cleanup', async () => {
	const { first, second, close } = await fixture();
	try {
		const stale = await first.capture([]);
		expect(
			await second.publish({
				revision: 0,
				edits: new Map([['new.md', 'other tab']]),
			}),
		).toBe(true);
		const candidate: GitObject = { type: 'commit', bytes: new Uint8Array() };
		expect(
			await first.publish({
				revision: stale.state.revision,
				objects: new Map([['unpublished', candidate]]),
				refs: { remoteBase: null, pendingCommit: 'unpublished' },
				edits: new Map([['new.md', undefined]]),
			}),
		).toBe(false);
		const after = await first.capture();
		expect(after.state).toEqual({
			remoteBase: undefined,
			pendingCommit: null,
			revision: 1,
		});
		expect([...after.edits]).toEqual([['new.md', 'other tab']]);
	} finally {
		close();
	}
});

test('a failed object batch aborts writes queued before it and leaves the revision unchanged', async () => {
	const { id, first, second, close } = await fixture();
	try {
		const good: GitObject = { type: 'blob', bytes: new Uint8Array([1]) };
		// A structured-clone refusal occurs after one put has been queued. No
		// production crash hook or alternate transaction implementation is needed.
		const unclonable = {
			type: 'blob',
			bytes: () => {},
		} as unknown as GitObject;
		await expect(
			first.publish({
				revision: 0,
				objects: new Map([
					['good', good],
					['bad', unclonable],
				]),
			}),
		).rejects.toThrow();
		expect((await second.capture()).state.revision).toBe(0);
		const opening = indexedDB.open(`epicenter.data.${id}`);
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		try {
			const request = database
				.transaction('objects')
				.objectStore('objects')
				.count();
			const count = await new Promise<number>((resolve) => {
				request.onsuccess = () => resolve(request.result);
			});
			expect(count).toBe(0);
		} finally {
			database.close();
		}
	} finally {
		close();
	}
});

test('acknowledgement uses exact B/C and retains edits saved after the request began', async () => {
	const { first, second, close } = await fixture();
	try {
		const tree: GitObject = { type: 'tree', bytes: writeTree([]) };
		const treeId = await hashObject(tree);
		const commit: GitObject = {
			type: 'commit',
			bytes: writeCommit({
				tree: treeId,
				parents: [],
				author: { name: 'Test', email: 'test@example.com', timestamp: 1 },
				message: '',
			}),
		};
		const head = await hashObject(commit);
		expect(
			await first.publish({
				revision: 0,
				objects: new Map([
					[treeId, tree],
					[head, commit],
				]),
				refs: { remoteBase: null, pendingCommit: head },
			}),
		).toBe(true);
		expect(
			await second.publish({
				revision: 1,
				edits: new Map([['late.md', 'newer input']]),
			}),
		).toBe(true);
		expect(await first.acknowledge(null, head)).toBe(true);
		const snapshot = await second.capture();
		expect(snapshot.state).toEqual({
			remoteBase: head,
			pendingCommit: null,
			revision: 3,
		});
		expect([...snapshot.edits]).toEqual([['late.md', 'newer input']]);
		expect(await first.acknowledge(null, head)).toBe(false);
	} finally {
		close();
	}
});
