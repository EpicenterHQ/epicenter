/**
 * Atomic working-tree publication across IndexedDB connections.
 * Root guards reject stale candidates, and failed batches or maintenance
 * cannot misreport durable work.
 */
import { captureFile } from './repository.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { GitObject } from '../git/raw-objects.js';
import { changeSnapshot, emptyTree } from './git/snapshot.js';
import { openRepository } from './repository.js';
import { openStorage, snapshotObject } from './storage.js';

async function fixture() {
	const id = crypto.randomUUID();
	const first = await openStorage(id);
	const second = await openStorage(id);
	return {
		id,
		first,
		second,
		close() {
			first.close();
			second.close();
		},
	};
}
async function candidate(
	storage: Awaited<ReturnType<typeof openStorage>>,
	files: [string, string][],
) {
	const snapshot = await storage.capture();
	const next = await changeSnapshot({
		root: snapshot.state.workingTree,
		edits: new Map(files),
		read: async (oid) => snapshotObject(snapshot, oid),
	});
	return {
		expected: snapshot.state.workingTree,
		workingTree: next.tree,
		objects: next.objects,
	};
}

test('a stale publication installs no candidate objects', async () => {
	const f = await fixture();
	try {
		const stale = await candidate(f.first, [['stale.md', 'stale']]);
		expect(
			await f.second.publish(
				await candidate(f.second, [['new.md', 'other tab']]),
			),
		).toBe(true);
		expect(await f.first.publish(stale)).toBe(false);
		const after = await f.first.capture();
		expect([...after.files.keys()]).toEqual(['new.md']);
		expect(await f.first.collect()).toBe(1); // Only the former empty root, no stale candidate.
	} finally {
		f.close();
	}
});

test('returning to the same root makes an earlier content candidate valid again', async () => {
	const f = await fixture();
	try {
		const initial = (await f.first.capture()).state;
		const next = await candidate(f.first, [['next.md', 'next']]);
		expect(
			await f.second.publish(
				await candidate(f.second, [['temporary.md', 'temporary']]),
			),
		).toBe(true);
		expect(
			await f.second.publish({
				expected: (await f.second.capture()).state.workingTree,
				workingTree: initial.workingTree,
			}),
		).toBe(true);
		expect(await f.first.publish(next)).toBe(true);
		expect([...(await f.first.capture()).files.keys()]).toEqual(['next.md']);
	} finally {
		f.close();
	}
});

test('a failed object batch rolls back earlier puts and leaves the working root unchanged', async () => {
	const f = await fixture();
	try {
		const good: GitObject = { type: 'blob', bytes: new Uint8Array([1]) };
		const unclonable: GitObject = {
			type: 'blob',
			// @ts-expect-error Deliberately give IndexedDB a value it cannot clone.
			bytes: () => {},
		};
		await expect(
			f.first.publish({
				expected: emptyTree,
				objects: new Map([
					['good', good],
					['bad', unclonable],
				]),
			}),
		).rejects.toThrow();
		expect((await f.second.capture()).state.workingTree).toBe(emptyTree);
		expect(await f.first.collect()).toBe(0);
	} finally {
		f.close();
	}
});

test('a publication that changes no file, and collection, do not notify file subscribers', async () => {
	const repository = await openRepository(crypto.randomUUID());
	try {
		let changes = 0;
		repository.onChange(() => changes++);
		expectOk(await repository.put('one.md', 'one'));
		const snapshot = await repository.storage.capture();
		await repository.storage.publish({
			expected: snapshot.state.workingTree,
		});
		await repository.storage.collect();
		expect(changes).toBe(1);
	} finally {
		repository.close();
	}
});

test('failed collection after publication leaves the save successful and its budget persistent', async () => {
	const id = crypto.randomUUID();
	let repository = await openRepository(id);
	try {
		const original = 'x'.repeat(8 * 1024 * 1024);
		expectOk(await repository.put('large.txt', original));
		let collections = 0;
		repository.storage.collect = async () => {
			collections++;
			throw new Error('maintenance unavailable');
		};
		expectOk(await repository.put('large.txt', 'small'));
		expect(collections).toBe(1);
		repository.close();
		repository = await openRepository(id);
		expect(
			(await repository.storage.capture()).state.retiredBytes,
		).toBeGreaterThanOrEqual(original.length);
		expect(
			await expectOk(
				await captureFile(repository, 'large.txt'),
			)!.content.text(),
		).toBe('small');
		expectOk(await repository.put('other.txt', 'next'));
		expect((await repository.storage.capture()).state.retiredBytes).toBe(0);
	} finally {
		repository.close();
	}
});

test('quota failure collects once and retries without replacing a root on a second failure', async () => {
	const repository = await openRepository(crypto.randomUUID());
	const put = IDBObjectStore.prototype.put;
	try {
		expectOk(await repository.put('one.md', 'saved'));
		const before = (await repository.storage.capture()).state.workingTree;
		let failures = 0;
		IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
			if (this.name === 'objects') {
				failures++;
				throw new DOMException('full', 'QuotaExceededError');
			}
			return put.apply(this, args);
		};
		expect(expectErr(await repository.put('one.md', 'unsaved')).name).toBe(
			'StorageFailed',
		);
		expect(failures).toBe(2);
		expect((await repository.storage.capture()).state.workingTree).toBe(before);
		IDBObjectStore.prototype.put = put;
		expectOk(await repository.put('one.md', 'retried'));
	} finally {
		IDBObjectStore.prototype.put = put;
		repository.close();
	}
});

test('collection reads no blob payloads', async () => {
	const repository = await openRepository(crypto.randomUUID());
	const get = IDBObjectStore.prototype.get;
	try {
		expectOk(await repository.put('notes/one.md', 'base'));
		expectOk(await repository.put('audio/take.wav', Uint8Array.of(0, 255)));
		expectOk(await repository.put('notes/one.md', 'newer'));
		const saved = await repository.storage.capture();
		const blobs = new Set(
			[...saved.objects]
				.filter(([, object]) => object.type === 'blob')
				.map(([oid]) => oid),
		);
		const reads: IDBValidKey[] = [];
		IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
			if (this.name === 'objects' && typeof key === 'string') reads.push(key);
			return get.call(this, key);
		};
		await repository.storage.collect();
		expect(reads.some((key) => blobs.has(String(key)))).toBe(false);
	} finally {
		IDBObjectStore.prototype.get = get;
		repository.close();
	}
});
