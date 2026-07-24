import { describe, expect, test } from 'bun:test';
import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

import type {
	DocumentBoundRefusal,
	DocumentPublicationReceipt,
} from '../../document-v1/index.js';
import type { Intent, RecordAddress } from '../../protocol/v1/index.js';
import type {
	CapturedDocumentPublication,
	DocumentInspection,
	DocumentPublicationState,
} from '../replica/index.js';
import type { MaybePromise } from './replica-cases.test-support.js';

export type DocumentAction =
	| { kind: 'append-local'; address: RecordAddress; update: Uint8Array }
	| { kind: 'install-accepted'; address: RecordAddress; update: Uint8Array }
	| { kind: 'publication'; address: RecordAddress }
	| {
			kind: 'settle-publication';
			address: RecordAddress;
			proof: DocumentPublicationReceipt | DocumentBoundRefusal;
			captured: { revision: number; digest: string };
	  }
	| { kind: 'local-write'; intent: Intent };

export type DocumentActionResult = DocumentPublicationState | undefined;

export type DocumentTransition = {
	readonly boundaries: MaybePromise<number>;
	crash(boundary: number): MaybePromise<DocumentCrashedReplica>;
	commit(): MaybePromise<DocumentActionResult>;
};

export type DocumentObservations = {
	inspectDocument(
		address: RecordAddress,
	): MaybePromise<DocumentInspection | null>;
	exportDocument(address: RecordAddress): MaybePromise<Uint8Array | undefined>;
	owedDocuments(limit: number): MaybePromise<RecordAddress[]>;
	snapshot(): MaybePromise<string>;
};

export type DocumentCrashedReplica = DocumentObservations & {
	close(): MaybePromise<void>;
};

export type DocumentConformanceReplica = DocumentObservations & {
	prepare(action: DocumentAction): MaybePromise<DocumentTransition>;
	reopen(): MaybePromise<DocumentConformanceReplica>;
	dispose(): MaybePromise<void>;
};

export type DocumentConformanceBinding = {
	name: string;
	create(): MaybePromise<DocumentConformanceReplica>;
};

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function sourceUpdates(...values: string[]): Uint8Array[] {
	const document = new Y.Doc({ gc: true });
	const updates: Uint8Array[] = [];
	document.on('updateV2', (update: Uint8Array) => {
		updates.push(new Uint8Array(update));
	});
	for (const value of values) document.get('content').insert(0, value);
	document.destroy();
	return updates;
}

function documentText(update: Uint8Array | undefined): string | undefined {
	if (update === undefined) return undefined;
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		return document.get('content').toString();
	} finally {
		document.destroy();
	}
}

function receipt(
	publication: CapturedDocumentPublication,
): DocumentPublicationReceipt {
	return {
		authorityLifetime: publication.authorityLifetime,
		address: publication.address,
		protocolVersion: publication.protocolVersion,
		digest: publication.digest,
	};
}

function capturedOf(publication: CapturedDocumentPublication): {
	revision: number;
	digest: string;
} {
	return { revision: publication.capturedRevision, digest: publication.digest };
}

/** Run document durability and lifecycle cases against one physical replica owner. */
export function runDocumentConformanceCases(
	binding: DocumentConformanceBinding,
): void {
	async function apply(
		replica: DocumentConformanceReplica,
		action: DocumentAction,
	): Promise<DocumentActionResult> {
		return (await replica.prepare(action)).commit();
	}

	async function readyPublication(
		replica: DocumentConformanceReplica,
		action?: Partial<Extract<DocumentAction, { kind: 'publication' }>>,
	): Promise<CapturedDocumentPublication> {
		const state = await apply(replica, {
			kind: 'publication',
			address: ADDRESS,
			...action,
		});
		if (state?.kind !== 'ready') {
			throw new Error('document publication was not ready');
		}
		return state.publication;
	}

	/**
	 * The crash matrix (interrupted transitions leave durable state exactly as
	 * it was). Read-only transitions report zero boundaries and are committed
	 * without a crash pass.
	 */
	async function applyWithCrashes(
		replica: DocumentConformanceReplica,
		action: DocumentAction,
	): Promise<DocumentActionResult> {
		const transition = await replica.prepare(action);
		const before = await replica.snapshot();
		const boundaries = await transition.boundaries;
		for (let boundary = 1; boundary <= boundaries; boundary += 1) {
			const crashed = await transition.crash(boundary);
			expect(await crashed.snapshot()).toBe(before);
			await crashed.close();
		}
		return transition.commit();
	}

	describe(`document foundation: ${binding.name}`, () => {
		test('local append and revision increment commit atomically and survive reopen', async () => {
			let replica = await binding.create();
			try {
				const [update] = sourceUpdates('first');
				if (update === undefined) throw new Error('missing source update');
				const transition = await replica.prepare({
					kind: 'append-local',
					address: ADDRESS,
					update,
				});
				expect(await transition.boundaries).toBeGreaterThanOrEqual(1);
				const before = await replica.snapshot();
				const boundaries = await transition.boundaries;
				for (let boundary = 1; boundary <= boundaries; boundary += 1) {
					const crashed = await transition.crash(boundary);
					// An interrupted append never leaves a chain entry without its
					// revision increment or the reverse.
					expect(await crashed.snapshot()).toBe(before);
					expect(await crashed.inspectDocument(ADDRESS)).toBeNull();
					await crashed.close();
				}
				await transition.commit();
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 1,
					acceptedRevision: 0,
					owed: true,
					refused: false,
				});
				expect(await replica.owedDocuments(16)).toEqual([ADDRESS]);
				replica = await replica.reopen();
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 1,
					acceptedRevision: 0,
					owed: true,
				});
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					'first',
				);
				expect(await replica.owedDocuments(16)).toEqual([ADDRESS]);
			} finally {
				await replica.dispose();
			}
		});

		test('an interrupted publication leaves the document owed and a lost receipt regenerates', async () => {
			let replica = await binding.create();
			try {
				const [update] = sourceUpdates('retry');
				if (update === undefined) throw new Error('missing source update');
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update,
				});
				// Publication holds its captured revision and digest only in memory:
				// it writes nothing durable, so losing the process (or the reply)
				// simply leaves the document owed.
				const attempt = await readyPublication(replica);
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					owed: true,
				});
				expect(await replica.owedDocuments(16)).toEqual([ADDRESS]);
				replica = await replica.reopen();
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					owed: true,
				});
				const regenerated = await readyPublication(replica);
				expect(regenerated.digest).toBe(attempt.digest);
				expect(regenerated.capturedRevision).toBe(attempt.capturedRevision);
				await applyWithCrashes(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(regenerated),
					captured: capturedOf(regenerated),
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 1,
					acceptedRevision: 1,
					owed: false,
				});
				expect(await replica.owedDocuments(16)).toEqual([]);
			} finally {
				await replica.dispose();
			}
		});

		test('tail compaction is atomic and preserves the complete document', async () => {
			let replica = await binding.create();
			try {
				const values = Array.from({ length: 65 }, (_, index) =>
					String.fromCharCode(65 + (index % 26)),
				);
				const updates = sourceUpdates(...values);
				for (const update of updates.slice(0, -1)) {
					await apply(replica, {
						kind: 'append-local',
						address: ADDRESS,
						update,
					});
				}
				const last = updates.at(-1);
				if (last === undefined) throw new Error('missing compaction update');
				await applyWithCrashes(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: last,
				});
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					values.toReversed().join(''),
				);
				replica = await replica.reopen();
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					values.toReversed().join(''),
				);
			} finally {
				await replica.dispose();
			}
		});

		test('a delayed receipt advances only its captured revision; racing work stays owed', async () => {
			const replica = await binding.create();
			try {
				const [first, second] = sourceUpdates('a', 'b');
				if (first === undefined || second === undefined) {
					throw new Error('missing source updates');
				}
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: first,
				});
				const attempt = await readyPublication(replica);
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: second,
				});
				await applyWithCrashes(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(attempt),
					captured: capturedOf(attempt),
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 2,
					acceptedRevision: 1,
					owed: true,
				});
				// A duplicate of the same receipt is a no-op, never a regression.
				await apply(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(attempt),
					captured: capturedOf(attempt),
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					acceptedRevision: 1,
					owed: true,
				});
			} finally {
				await replica.dispose();
			}
		});

		test('a delete-only update publishes as complete state', async () => {
			const replica = await binding.create();
			try {
				const source = new Y.Doc({ gc: true });
				const updates: Uint8Array[] = [];
				source.on('updateV2', (update: Uint8Array) => {
					updates.push(new Uint8Array(update));
				});
				source.get('content').insert(0, 'ab');
				source.get('content').delete(0, 1);
				source.destroy();
				const [insert, deletion] = updates;
				if (insert === undefined || deletion === undefined) {
					throw new Error('missing source updates');
				}
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: insert,
				});
				const first = await readyPublication(replica);
				await apply(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(first),
					captured: capturedOf(first),
				});
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: deletion,
				});
				// Complete compact state makes the publication self-sufficient even
				// when deletion semantics are not represented by a state-vector clock.
				const deleteOnly = await readyPublication(replica);
				expect(deleteOnly.capturedRevision).toBe(2);
				expect(deleteOnly.payload.byteLength).toBeGreaterThan(0);
				await apply(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(deleteOnly),
					captured: capturedOf(deleteOnly),
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					owed: false,
				});
			} finally {
				await replica.dispose();
			}
		});

		test('a remote accepted install never creates a local obligation', async () => {
			const replica = await binding.create();
			try {
				const [update] = sourceUpdates('remote');
				if (update === undefined) throw new Error('missing source update');
				await applyWithCrashes(replica, {
					kind: 'install-accepted',
					address: ADDRESS,
					update,
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 0,
					acceptedRevision: 0,
					owed: false,
				});
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					'remote',
				);
			} finally {
				await replica.dispose();
			}
		});

		test('an over-bound document blocks durably with measurements until a later edit', async () => {
			let replica = await binding.create();
			try {
				const [oversized] = sourceUpdates(
					'x'.repeat(DOCUMENT_BOUND.stateBytes + 1),
				);
				if (oversized === undefined) throw new Error('missing source update');
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: oversized,
				});
				// Recording the refusal evidence is itself a crash-safe transition.
				const refused = await applyWithCrashes(replica, {
					kind: 'publication',
					address: ADDRESS,
				});
				if (refused?.kind !== 'refused') {
					throw new Error('over-bound document was not refused');
				}
				expect(refused.refusal.measured.stateBytes).toBeGreaterThan(
					DOCUMENT_BOUND.stateBytes,
				);
				replica = await replica.reopen();
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					owed: true,
					refused: true,
				});
				const still = await apply(replica, {
					kind: 'publication',
					address: ADDRESS,
				});
				expect(still?.kind).toBe('refused');

				// A later edit supersedes the refusal evidence in the same
				// transaction that increments the revision.
				const [edit] = sourceUpdates('y');
				if (edit === undefined) throw new Error('missing source update');
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update: edit,
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					refused: false,
					owed: true,
				});
			} finally {
				await replica.dispose();
			}
		});

		test('unset retains document bytes while terminal tombstone reaps them atomically', async () => {
			const replica = await binding.create();
			try {
				const [update] = sourceUpdates('retained');
				if (update === undefined) throw new Error('missing source update');
				await apply(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update,
				});
				await apply(replica, {
					kind: 'local-write',
					intent: { address: ADDRESS, op: 'unset' },
				});
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					'retained',
				);

				await apply(replica, {
					kind: 'local-write',
					intent: { address: ADDRESS, op: 'replace', value: {} },
				});
				await applyWithCrashes(replica, {
					kind: 'local-write',
					intent: { address: ADDRESS, op: 'tombstone' },
				});
				expect(await replica.inspectDocument(ADDRESS)).toBeNull();
				expect(await replica.exportDocument(ADDRESS)).toBeUndefined();
			} finally {
				await replica.dispose();
			}
		});
	});
}
