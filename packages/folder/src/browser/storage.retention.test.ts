/**
 * Browser object retention tests.
 *
 * Collection preserves both published snapshots, pending edits, and a new
 * publication from another handle while removing unreachable Git objects.
 * An incomplete live snapshot aborts the sweep without deleting anything.
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

async function commit(root: string, parents: string[] = []) {
	return stored(
		'commit',
		writeCommit({
			tree: root,
			parents,
			author: { name: 'Test', email: 'test@example.invalid', timestamp: 1 },
			message: 'Retention fixture',
		}),
	);
}

async function keys(id: string) {
	const request = indexedDB.open(`epicenter.data.${id}`);
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

test('collection keeps shared snapshots, an uncertain commit, and unsent edits but drops old history', async () => {
	const id = crypto.randomUUID();
	const storage = await openStorage(id);
	try {
		const ancestorFile = await blob('older history');
		const ancestorTree = await tree({ 'ancestor.md': ancestorFile.oid });
		const ancestor = await commit(ancestorTree.oid);
		const shared = await blob('shared');
		const baseFile = await blob('confirmed');
		const baseTree = await tree({
			'shared.md': shared.oid,
			'base.md': baseFile.oid,
		});
		const base = await commit(baseTree.oid, [ancestor.oid]);
		const headFile = await blob('pending');
		const headTree = await tree({
			'shared.md': shared.oid,
			'head.md': headFile.oid,
		});
		const head = await commit(headTree.oid, [base.oid]);
		const orphan = await blob('unpublished candidate');
		const entries = [
			ancestorFile,
			ancestorTree,
			ancestor,
			shared,
			baseFile,
			baseTree,
			base,
			headFile,
			headTree,
			head,
			orphan,
		];
		expect(
			await storage.publish({
				revision: 0,
				objects: new Map(entries.map(({ oid, object }) => [oid, object])),
				refs: { base: base.oid, head: head.oid, shallow: [base.oid] },
				edits: new Map([['draft.md', 'saved but unsent']]),
			}),
		).toBe(true);
		expect(await storage.collect()).toBe(4);
		expect(new Set(await keys(id))).toEqual(
			new Set([
				shared.oid,
				baseFile.oid,
				baseTree.oid,
				base.oid,
				headFile.oid,
				headTree.oid,
				head.oid,
			]),
		);
		const snapshot = await storage.capture('sync');
		expect(snapshot.state).toEqual({
			base: base.oid,
			head: head.oid,
			shallow: [base.oid],
			revision: 1,
			remoteKnown: false,
		});
		expect(snapshot.edits.get('draft.md')).toBe('saved but unsent');
	} finally {
		storage.close();
	}
});

test('collection and another handle publishing a new head leave its complete snapshot', async () => {
	for (const collectFirst of [true, false]) {
		const id = crypto.randomUUID();
		const first = await openStorage(id);
		const second = await openStorage(id);
		try {
			const oldFile = await blob('old');
			const oldTree = await tree({ 'work.md': oldFile.oid });
			const oldHead = await commit(oldTree.oid);
			const oldObjects = [oldFile, oldTree, oldHead];
			expect(
				await first.publish({
					revision: 0,
					objects: new Map(oldObjects.map(({ oid, object }) => [oid, object])),
					refs: {
						base: oldHead.oid,
						head: oldHead.oid,
						shallow: [oldHead.oid],
					},
				}),
			).toBe(true);
			const newFile = await blob('new');
			const newTree = await tree({ 'work.md': newFile.oid });
			const newHead = await commit(newTree.oid, [oldHead.oid]);
			const publish = () =>
				second.publish({
					revision: 1,
					objects: new Map(
						[newFile, newTree, newHead].map(({ oid, object }) => [oid, object]),
					),
					refs: {
						base: oldHead.oid,
						head: newHead.oid,
						shallow: [oldHead.oid],
					},
				});
			const [collected, published] = collectFirst
				? await Promise.all([first.collect(), publish()])
				: await Promise.all([publish(), first.collect()]).then(([p, c]) => [
						c,
						p,
					]);
			expect(collected).toBeGreaterThanOrEqual(0);
			expect(published).toBe(true);
			const snapshot = await first.capture('sync');
			expect(snapshot.state.head).toBe(newHead.oid);
			expect([...snapshot.objects.keys()]).toContain(newFile.oid);
		} finally {
			first.close();
			second.close();
		}
	}
});

test('an incomplete live snapshot leaves every stored object untouched', async () => {
	const id = crypto.randomUUID();
	const storage = await openStorage(id);
	try {
		const orphan = await blob('keep while repair is needed');
		const missingTree = 'a'.repeat(40);
		const broken = await commit(missingTree);
		expect(
			await storage.publish({
				revision: 0,
				objects: new Map([
					[orphan.oid, orphan.object],
					[broken.oid, broken.object],
				]),
				refs: { base: broken.oid, head: broken.oid, shallow: [broken.oid] },
			}),
		).toBe(true);
		await expect(storage.collect()).rejects.toThrow(/is missing/);
		expect(new Set(await keys(id))).toEqual(new Set([orphan.oid, broken.oid]));
	} finally {
		storage.close();
	}
});
