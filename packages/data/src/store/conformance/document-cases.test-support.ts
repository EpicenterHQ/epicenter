import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import type {
	DocumentBoundRefusal,
	DocumentPublicationReceipt,
} from '../../document-v1/index.js';
import type { Intent, RecordAddress } from '../../protocol/v1/index.js';
import type {
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
	publication: Extract<
		DocumentPublicationState,
		{ kind: 'ready' }
	>['publication'],
): DocumentPublicationReceipt {
	return {
		authorityLifetime: publication.authorityLifetime,
		address: publication.address,
		protocolVersion: publication.protocolVersion,
		digest: publication.digest,
	};
}

/** Run document durability and lifecycle cases against one physical replica owner. */
export function runDocumentConformanceCases(
	binding: DocumentConformanceBinding,
): void {
	async function applyWithCrashes(
		replica: DocumentConformanceReplica,
		action: DocumentAction,
	): Promise<DocumentActionResult> {
		const transition = await replica.prepare(action);
		const before = await replica.snapshot();
		const boundaries = await transition.boundaries;
		expect(boundaries).toBeGreaterThanOrEqual(1);
		for (let boundary = 1; boundary <= boundaries; boundary += 1) {
			const crashed = await transition.crash(boundary);
			expect(await crashed.snapshot()).toBe(before);
			await crashed.close();
		}
		return transition.commit();
	}

	describe(`document foundation: ${binding.name}`, () => {
		test('local append, revision, and dirty state commit atomically and survive reopen', async () => {
			let replica = await binding.create();
			try {
				const [update] = sourceUpdates('first');
				if (update === undefined) throw new Error('missing source update');
				await applyWithCrashes(replica, {
					kind: 'append-local',
					address: ADDRESS,
					update,
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 1,
					dirty: true,
					inflight: 'none',
				});
				replica = await replica.reopen();
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					'first',
				);
			} finally {
				await replica.dispose();
			}
		});

		test('a frozen publication is exact across crashes and clean reopen', async () => {
			let replica = await binding.create();
			try {
				const [update] = sourceUpdates('retry');
				if (update === undefined) throw new Error('missing source update');
				await (
					await replica.prepare({
						kind: 'append-local',
						address: ADDRESS,
						update,
					})
				).commit();
				const frozen = await applyWithCrashes(replica, {
					kind: 'publication',
					address: ADDRESS,
				});
				if (frozen?.kind !== 'ready') {
					throw new Error('document publication was not ready');
				}
				replica = await replica.reopen();
				const retry = await (
					await replica.prepare({ kind: 'publication', address: ADDRESS })
				).commit();
				expect(retry).toEqual(frozen);
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
					await (
						await replica.prepare({
							kind: 'append-local',
							address: ADDRESS,
							update,
						})
					).commit();
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

		test('an older receipt cannot clear a newer local revision', async () => {
			const replica = await binding.create();
			try {
				const [first, second] = sourceUpdates('a', 'b');
				if (first === undefined || second === undefined) {
					throw new Error('missing source updates');
				}
				await (
					await replica.prepare({
						kind: 'append-local',
						address: ADDRESS,
						update: first,
					})
				).commit();
				const frozen = await (
					await replica.prepare({ kind: 'publication', address: ADDRESS })
				).commit();
				if (frozen?.kind !== 'ready') {
					throw new Error('document publication was not ready');
				}
				await (
					await replica.prepare({
						kind: 'append-local',
						address: ADDRESS,
						update: second,
					})
				).commit();
				await applyWithCrashes(replica, {
					kind: 'settle-publication',
					address: ADDRESS,
					proof: receipt(frozen.publication),
				});
				expect(await replica.inspectDocument(ADDRESS)).toMatchObject({
					revision: 2,
					dirty: true,
					inflight: 'none',
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
				await (
					await replica.prepare({
						kind: 'append-local',
						address: ADDRESS,
						update,
					})
				).commit();
				await (
					await replica.prepare({
						kind: 'local-write',
						intent: { address: ADDRESS, op: 'unset' },
					})
				).commit();
				expect(documentText(await replica.exportDocument(ADDRESS))).toBe(
					'retained',
				);

				await (
					await replica.prepare({
						kind: 'local-write',
						intent: { address: ADDRESS, op: 'replace', value: {} },
					})
				).commit();
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
