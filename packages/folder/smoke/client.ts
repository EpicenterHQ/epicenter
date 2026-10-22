/** Production engine exercised from two real pages; no alternative state model. */

import { unwrap } from 'wellcrafted/result';
import { changeSnapshot, emptyTree } from '../src/browser/git/snapshot.js';
import { openRepository } from '../src/browser/repository.js';
import { writeRow } from '../src/browser/row-writes.test-support.js';
import { snapshotObject } from '../src/browser/storage.js';
import { prepareCommit } from '../src/browser/sync.js';
import {
	type GitObject,
	hashObject,
	readCommit,
	writeCommit,
} from '../src/git/raw-objects.js';
import type { Row } from '../src/shared/row.js';

const schema = {
	type: 'object',
	properties: { a: { type: 'number' }, b: { type: 'number' } },
	required: ['a', 'b'],
} as const;
let repository: Awaited<
	ReturnType<typeof openRepository<{ notes: typeof schema }>>
>;
let draft: Row<typeof schema> | null = null;
let failedChecks = 0;
const latencies: number[] = [];
const author = () => ({
	name: 'Browser test',
	email: 'browser@example.com',
	timestamp: Math.floor(Date.now() / 1000),
});

async function writeValue(field: 'a' | 'b', value: number) {
	const start = performance.now();
	draft = unwrap(
		await writeRow(
			repository,
			'notes',
			'one',
			{ fields: { [field]: value } },
			schema,
		),
	);
	latencies.push(performance.now() - start);
}

export const client = {
	async open(id: string) {
		repository = await openRepository(id, { notes: schema });
		const publish = repository.storage.publish;
		repository.storage.publish = async (input) => {
			const result = await publish(input);
			if (!result) failedChecks++;
			return result;
		};
		draft = unwrap(await repository.tables.notes.get('one')) ?? null;
	},
	async seed() {
		draft = unwrap(
			await writeRow(
				repository,
				'notes',
				'one',
				{ fields: { a: 0, b: 0 }, body: 'First\n\nLast\n' },
				schema,
			),
		);
	},
	async observeEmpty() {
		const { state } = await repository.storage.capture([]);
		if (state.remoteBase !== undefined || state.pendingCommit !== null)
			throw new Error('Not a new empty repository');
		if (
			!(await repository.storage.publish({
				expected: state,
				refs: { remoteBase: null, pendingCommit: null },
			}))
		)
			throw new Error('Empty observation raced a save');
	},
	async addSharedFile() {
		unwrap(await repository.files.write('shared.txt', 'shared snapshot'));
	},
	async sharedText() {
		const file = unwrap(await repository.files.read('shared.txt'));
		return file === undefined ? null : file.content.text();
	},
	async write(field: 'a' | 'b', count: number) {
		for (let value = 1; value <= count; value++) {
			await writeValue(field, value);
		}
	},
	set: writeValue,
	async paragraph(which: 'First' | 'Last', text: string) {
		if (draft === null) throw new Error('No draft to edit');
		draft = unwrap(
			await writeRow(
				repository,
				'notes',
				'one',
				{ body: draft.body!.replace(which, text) },
				schema,
			),
		);
	},
	async commitLoop(count: number) {
		for (let attempt = 0; attempt < count; attempt++) {
			const pending = await prepareCommit(repository.storage, author());
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (pending !== null)
				await repository.storage.acknowledge(pending.base, pending.head);
		}
	},
	async commit() {
		return await prepareCommit(repository.storage, author());
	},
	async accept(
		pending: NonNullable<Awaited<ReturnType<typeof prepareCommit>>>,
	) {
		return repository.storage.acknowledge(pending.base, pending.head);
	},
	async state() {
		const snapshot = await repository.storage.capture('sync');
		return {
			state: snapshot.state,
			unsent:
				snapshot.state.workingTree !==
				((snapshot.state.pendingCommit ?? snapshot.state.remoteBase)
					? readCommit(
							snapshot.objects.get(
								(snapshot.state.pendingCommit ?? snapshot.state.remoteBase)!,
							)!.bytes,
						).tree
					: emptyTree),
			row: unwrap(await repository.tables.notes.get('one')),
			failedChecks,
			latencies,
		};
	},
	/** Compute a candidate and abandon it before any persistent publication. */
	async abandonCandidate() {
		const snapshot = await repository.storage.capture([]);
		const current =
			snapshot.state.pendingCommit ?? snapshot.state.remoteBase ?? null;

		const object: GitObject = {
			type: 'commit',
			bytes: writeCommit({
				tree: snapshot.state.workingTree,
				parents: current === null ? [] : [current],
				author: author(),
				message: 'Unpublished\n',
			}),
		};
		return {
			candidate: await hashObject(object),
			persisted: current,
			files: snapshot.files.size,
		};
	},
	async nativeObjects() {
		const snapshot = await repository.storage.capture('sync');
		return {
			head: snapshot.state.pendingCommit ?? snapshot.state.remoteBase ?? null,
			objects: [...snapshot.objects].map(([oid, object]) => ({
				oid,
				type: object.type,
				bytes: [...object.bytes],
			})),
		};
	},
	async injectOrphan() {
		const orphan: GitObject = {
			type: 'blob',
			bytes: new TextEncoder().encode('unpublished browser candidate'),
		};
		const oid = await hashObject(orphan);
		const { state } = await repository.storage.capture([]);
		if (
			!(await repository.storage.publish({
				expected: state,
				objects: new Map([[oid, orphan]]),
			}))
		)
			throw new Error('Orphan fixture raced a publication');
		return oid;
	},
	collect: () => repository.storage.collect(),
	async hasStoredObject(oid: string) {
		const request = indexedDB.open(`epicenter.folder.${repository.id}`);
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const request = database
				.transaction('objects')
				.objectStore('objects')
				.getKey(oid);
			return await new Promise<boolean>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result !== undefined);
				request.onerror = () => reject(request.error);
			});
		} finally {
			database.close();
		}
	},
	/** A bounded metadata-scaling probe, not another storage implementation. */
	async archive(folders: number) {
		const edits = new Map(
			Array.from(
				{ length: folders },
				(_, index) => [`archive/${index}/file.txt`, `${index}\n`] as const,
			),
		);
		const candidate = await changeSnapshot({
			root: null,
			edits,
			read: async () => {
				throw new Error('Fresh fixture has no existing objects');
			},
		});
		const object: GitObject = {
			type: 'commit',
			bytes: writeCommit({
				tree: candidate.tree,
				parents: [],
				author: author(),
				message: 'Archive fixture\n',
			}),
		};
		const head = await hashObject(object);
		candidate.objects.set(head, object);
		if (
			!(await repository.storage.publish({
				expected: (await repository.storage.capture([])).state,
				workingTree: candidate.tree,
				objects: candidate.objects,
				refs: { remoteBase: head, pendingCommit: null },
			}))
		)
			throw new Error('Archive seed raced');
		const captures: number[] = [];
		let capturedTrees = 0;
		for (let attempt = 0; attempt < 5; attempt++) {
			const start = performance.now();
			const snapshot = await repository.storage.capture(['archive/0/file.txt']);
			captures.push(performance.now() - start);
			capturedTrees = [...snapshot.objects.values()].filter(
				(object) => object.type === 'tree',
			).length;
		}
		const start = performance.now();
		unwrap(await repository.files.write('archive/0/file.txt', 'edited\n'));
		const saveMs = performance.now() - start;
		// Compare scoped reads before and after a large offline save backlog.
		const backlog = new Map(
			Array.from(
				{ length: folders },
				(_, index) =>
					[
						`archive/${index}/file.txt`,
						`${index}: ${'x'.repeat(4096)}\n`,
					] as const,
			),
		);
		const backlogBase = await repository.storage.capture();
		const backlogTree = await changeSnapshot({
			root: backlogBase.state.workingTree,
			edits: backlog,
			read: async (oid) => snapshotObject(backlogBase, oid),
		});
		if (
			!(await repository.storage.publish({
				expected: backlogBase.state,
				workingTree: backlogTree.tree,
				objects: backlogTree.objects,
			}))
		)
			throw new Error('Backlog seed raced');
		const backlogStart = performance.now();
		const backlogSnapshot = await repository.storage.capture([
			'archive/0/file.txt',
		]);
		const backlogCaptureMs = performance.now() - backlogStart;
		return {
			folders,
			capturedTrees,
			captureMs: captures,
			saveMs,
			backlog: {
				savedFiles: backlog.size,
				utf8Bytes: [...backlog.values()].reduce(
					(size, text) => size + new TextEncoder().encode(text).length,
					0,
				),
				capturedTrees: [...backlogSnapshot.objects.values()].filter(
					(object) => object.type === 'tree',
				).length,
				captureMs: backlogCaptureMs,
			},
		};
	},
	close() {
		repository.close();
	},
};

declare global {
	var dataSmoke: typeof client;
}
globalThis.dataSmoke = client;
