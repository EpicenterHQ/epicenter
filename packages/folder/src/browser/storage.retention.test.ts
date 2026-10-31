/**
 * Browser object retention tests.
 *
 * Collection keeps the working tree's objects, including a new working tree
 * another handle publishes meanwhile, and removes every other object. An
 * incomplete working tree aborts the sweep without deleting anything.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { type GitObject, hashObject, writeTree } from '../git/raw-objects.js';
import { emptyTree } from './git/snapshot.js';
import { openStorage } from './storage.js';

async function stored(type: GitObject['type'], bytes: Uint8Array) {
	const object: GitObject = { type, bytes };
	return { oid: await hashObject(object), object };
}

async function blob(text: string) {
	return stored('blob', new TextEncoder().encode(text));
}

async function tree(files: Record<string, string>) {
	return stored(
		'tree',
		writeTree(
			Object.entries(files).map(([name, oid]) => ({
				mode: '100644',
				name: new TextEncoder().encode(name),
				oid,
			})),
		),
	);
}

async function keys(id: string) {
	const request = indexedDB.open(`epicenter.folder.${id}`);
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const request = database
			.transaction('objects')
			.objectStore('objects')
			.getAllKeys();
		return await new Promise<string[]>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result.map(String));
			request.onerror = () => reject(request.error);
		});
	} finally {
		database.close();
	}
}

test('collection keeps the working tree and its files and drops every other object', async () => {
	const id = crypto.randomUUID();
	const storage = await openStorage(id);
	try {
		const shared = await blob('shared');
		const draft = await blob('saved');
		const replaced = await blob('replaced');
		const oldTree = await tree({
			'shared.md': shared.oid,
			'old.md': replaced.oid,
		});
		const orphan = await blob('unpublished candidate');
		const working = await tree({
			'shared.md': shared.oid,
			'draft.md': draft.oid,
		});
		const entries = [shared, draft, replaced, oldTree, orphan, working];
		expect(
			await storage.publish({
				expected: (await storage.capture([])).state.workingTree,
				objects: new Map(entries.map(({ oid, object }) => [oid, object])),
				workingTree: working.oid,
			}),
		).toBe(true);
		// Three of the published objects, and the empty tree it replaced.
		expect(await storage.collect()).toBe(4);
		expect(new Set(await keys(id))).toEqual(
			new Set([shared.oid, draft.oid, working.oid]),
		);
		const snapshot = await storage.capture();
		expect(snapshot.state).toEqual({
			workingTree: working.oid,
			retiredBytes: 0,
		});
		expect(snapshot.objects.has(draft.oid)).toBe(true);
	} finally {
		storage.close();
	}
});

test('collection and another handle publishing a new working tree leave its files', async () => {
	for (const collectFirst of [true, false]) {
		const id = crypto.randomUUID();
		const first = await openStorage(id);
		const second = await openStorage(id);
		try {
			const oldFile = await blob('old');
			const oldTree = await tree({ 'work.md': oldFile.oid });
			expect(
				await first.publish({
					expected: (await first.capture([])).state.workingTree,
					workingTree: oldTree.oid,
					objects: new Map(
						[oldFile, oldTree].map(({ oid, object }) => [oid, object]),
					),
				}),
			).toBe(true);
			const newFile = await blob('new');
			const newTree = await tree({ 'work.md': newFile.oid });
			const expected = (await first.capture()).state.workingTree;
			const publish = () =>
				second.publish({
					expected,
					workingTree: newTree.oid,
					objects: new Map(
						[newFile, newTree].map(({ oid, object }) => [oid, object]),
					),
				});
			const [collected, published] = collectFirst
				? await Promise.all([first.collect(), publish()])
				: await Promise.all([publish(), first.collect()]).then(([p, c]) => [
						c,
						p,
					]);
			expect(collected).toBeGreaterThanOrEqual(0);
			expect(published).toBe(true);
			const snapshot = await first.capture();
			expect(snapshot.state.workingTree).toBe(newTree.oid);
			expect([...snapshot.objects.keys()]).toContain(newFile.oid);
		} finally {
			first.close();
			second.close();
		}
	}
});

test('an incomplete working tree leaves every stored object untouched', async () => {
	const id = crypto.randomUUID();
	const storage = await openStorage(id);
	try {
		const orphan = await blob('keep while repair is needed');
		const broken = await tree({ 'gone.md': 'a'.repeat(40) });
		expect(
			await storage.publish({
				expected: (await storage.capture([])).state.workingTree,
				workingTree: broken.oid,
				objects: new Map([
					[orphan.oid, orphan.object],
					[broken.oid, broken.object],
				]),
			}),
		).toBe(true);
		await expect(storage.collect()).rejects.toThrow(/missing/);
		expect(new Set(await keys(id))).toEqual(
			new Set([emptyTree, orphan.oid, broken.oid]),
		);
	} finally {
		storage.close();
	}
});
