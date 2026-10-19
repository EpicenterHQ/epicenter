/** Production engine exercised from two real pages; no alternative state model. */

import { unwrap } from 'wellcrafted/result';
import { type GitObject, hashObject, writeCommit } from '../src/git/objects.js';
import { changeSnapshot } from '../src/git/snapshot.js';
import { openRepository, type PendingCommit } from '../src/repository.js';
import type { Row } from '../src/row.js';
import { snapshotObject } from '../src/storage.js';

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
		await repository.tables.notes.set('one', draft, {
			fields: { [field]: value },
		}),
	).sent;
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
			await repository.tables.notes.set('one', null, {
				fields: { a: 0, b: 0 },
				body: 'First\n\nLast\n',
			}),
		).sent;
	},
	async observeEmpty() {
		const { state } = await repository.storage.capture([]);
		if (state.base !== null || state.head !== null)
			throw new Error('Not a new empty repository');
		if (
			!(await repository.storage.publish({
				revision: state.revision,
				remoteKnown: true,
			}))
		)
			throw new Error('Empty observation raced a save');
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
			await repository.tables.notes.set('one', draft, {
				body: draft.body.replace(which, text),
			}),
		).sent;
	},
	async commitLoop(count: number) {
		for (let attempt = 0; attempt < count; attempt++) {
			const pending = unwrap(await repository.prepareCommit(author()));
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (pending !== null)
				await repository.storage.acknowledge(pending.base, pending.head);
		}
	},
	async commit() {
		return unwrap(await repository.prepareCommit(author()));
	},
	async accept(pending: PendingCommit) {
		return repository.storage.acknowledge(pending.base, pending.head);
	},
	async state() {
		const snapshot = await repository.storage.capture();
		return {
			state: snapshot.state,
			edits: [...snapshot.edits],
			row: unwrap(await repository.tables.notes.get('one')),
			failedChecks,
			latencies,
		};
	},
	/** Compute a candidate and abandon it before any persistent publication. */
	async abandonCandidate() {
		const snapshot = await repository.storage.capture([]);
		const candidate = await changeSnapshot({
			root: snapshot.head.root,
			edits: snapshot.edits,
			read: async (oid) => snapshotObject(snapshot, oid),
		});
		const object: GitObject = {
			type: 'commit',
			bytes: writeCommit({
				tree: candidate.tree,
				parents: snapshot.state.head === null ? [] : [snapshot.state.head],
				author: author(),
				message: 'Unpublished\n',
			}),
		};
		return {
			candidate: await hashObject(object),
			persisted: snapshot.state.head,
			edits: snapshot.edits.size,
		};
	},
	async nativeObjects() {
		const snapshot = await repository.storage.capture();
		return {
			head: snapshot.state.head,
			objects: [...snapshot.objects].map(([oid, object]) => ({
				oid,
				type: object.type,
				bytes: [...object.bytes],
			})),
		};
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
				revision: 0,
				objects: candidate.objects,
				refs: { base: head, head, shallow: [head] },
				remoteKnown: true,
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
		unwrap(
			await repository.files.write('archive/0/file.txt', '0\n', 'edited\n'),
		);
		return {
			folders,
			capturedTrees,
			captureMs: captures,
			saveMs: performance.now() - start,
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
