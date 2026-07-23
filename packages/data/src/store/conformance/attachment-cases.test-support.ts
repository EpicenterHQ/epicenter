/**
 * First-Attachment Crash and Reopen Conformance Cases
 *
 * States the ADR-0171 first-attachment evidence once for every SQLite replica
 * adapter. The cases seed one unattached record with scalar, document, and
 * blob publication obligations, then kill the owner after every attachment
 * statement and immediately after commit.
 *
 * Key behaviors:
 * - Bring recovery exposes either the complete unattached state or the complete
 *   attached state, never a partial attachment
 * - Bring preserves every obligation through lifetime discovery and the first
 *   scalar submission
 * - Discard recovery exposes either all local state or none of it, with the
 *   permanent attachment committed in the empty outcome
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

import { documentPayloadDigest } from '../../document-v1/index.js';
import {
	createAuthority,
	type FactsResponse,
	type JsonValue,
	parseSubmissionRequest,
	type RecordAddress,
	type SubmissionResponse,
	submit,
} from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import type {
	DocumentInspection,
	FirstAttachmentChoice,
	ReplicaAttachment,
	ReplicaAttachmentState,
	ReplicaRecordLanes,
	ReplicaStoreSync,
	ReplicaWorkSummary,
	SealedRequest,
} from '../replica/index.js';
import type { MaybePromise } from './replica-cases.test-support.js';

const LIMITS = makeLimits();
const LIFETIME = 'lifetime-one';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const DIGEST = 'a'.repeat(64);

const ATTACHMENT: ReplicaAttachment = {
	deploymentId: 'https://api.epicenter.so/',
	principalId: 'principal-one',
};

const record: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

const payload = { title: 'local' } satisfies Record<string, JsonValue>;

export type AttachmentConformanceAction =
	| {
			kind: 'admit-record-with-blob';
			address: RecordAddress;
			payload: Record<string, JsonValue>;
			digest: string;
	  }
	| {
			kind: 'append-local-document';
			address: RecordAddress;
			update: Uint8Array;
	  }
	| {
			kind: 'attach';
			attachment: ReplicaAttachment;
			choice: FirstAttachmentChoice;
	  }
	| {
			kind: 'install-facts';
			page: {
				request: { afterSequence: number };
				response: FactsResponse;
			};
	  }
	| { kind: 'seal' }
	| { kind: 'settle'; response: SubmissionResponse };

export type AttachmentConformanceResult =
	| undefined
	| SealedRequest
	| { attached: boolean; discarded: boolean };

export type AttachmentObservations = {
	attachment(): MaybePromise<ReplicaAttachmentState>;
	record(address: RecordAddress): MaybePromise<ReplicaRecordLanes | null>;
	sync(): MaybePromise<ReplicaStoreSync>;
	workSummary(): MaybePromise<ReplicaWorkSummary>;
	owedDocuments(limit: number): MaybePromise<RecordAddress[]>;
	owedBlobs(limit: number): MaybePromise<RecordAddress[]>;
	blobDigest(address: RecordAddress): MaybePromise<string | null>;
	inspectDocument(
		address: RecordAddress,
	): MaybePromise<DocumentInspection | null>;
	exportDocument(address: RecordAddress): MaybePromise<Uint8Array | undefined>;
	snapshot(): MaybePromise<string>;
};

export type CrashedAttachmentReplica = AttachmentObservations & {
	close(): MaybePromise<void>;
};

export type PreparedAttachmentTransition = {
	/** Includes every SQLite write boundary plus the durable commit boundary. */
	readonly boundaries: MaybePromise<number>;
	crash(boundary: number): MaybePromise<CrashedAttachmentReplica>;
	commit(): MaybePromise<AttachmentConformanceResult>;
};

export type AttachmentConformanceReplica = AttachmentObservations & {
	prepare(
		action: AttachmentConformanceAction,
	): MaybePromise<PreparedAttachmentTransition>;
	reopen(): MaybePromise<AttachmentConformanceReplica>;
	dispose(): MaybePromise<void>;
};

export type AttachmentConformanceBinding = {
	name: string;
	create(fixture: {
		replicaId: string;
	}): MaybePromise<AttachmentConformanceReplica>;
};

function documentUpdate(): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('body').insert(0, 'local document');
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function documentText(update: Uint8Array | undefined): string | undefined {
	if (update === undefined) return undefined;
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		return document.get('body').toString();
	} finally {
		document.destroy();
	}
}

async function seedLocalReplica(
	replica: AttachmentConformanceReplica,
): Promise<string> {
	await (
		await replica.prepare({
			kind: 'admit-record-with-blob',
			address: record,
			payload,
			digest: DIGEST,
		})
	).commit();
	const update = documentUpdate();
	await (
		await replica.prepare({
			kind: 'append-local-document',
			address: record,
			update,
		})
	).commit();
	return documentPayloadDigest(update);
}

async function expectLocalObligations(
	replica: AttachmentObservations,
	scalar: 'pending' | 'sealed' | 'settled',
	expectedDocumentDigest: string,
): Promise<void> {
	const lanes = await replica.record(record);
	expect(lanes?.pending).toEqual(
		scalar === 'pending' ? { op: 'patch', set: payload, unset: [] } : null,
	);
	expect(lanes?.sealed).toEqual(
		scalar === 'sealed' ? { op: 'patch', set: payload, unset: [] } : null,
	);
	expect(lanes?.confirmed).toEqual(
		scalar === 'settled' ? { state: 'live', payload, sequence: 1 } : null,
	);
	expect(await replica.workSummary()).toEqual({
		scalar: {
			pending: scalar === 'pending' ? 1 : 0,
			sealed: scalar === 'sealed' ? 1 : 0,
			parked: 0,
		},
		document: { owed: 1, parked: 0 },
		blob: { owed: 1, parked: 0 },
	});
	expect(await replica.owedDocuments(16)).toEqual([record]);
	expect(await replica.owedBlobs(16)).toEqual([record]);
	expect(await replica.blobDigest(record)).toBe(DIGEST);
	const document = await replica.inspectDocument(record);
	expect(document).toEqual({
		revision: 1,
		acceptedRevision: 0,
		owed: true,
		chainBytes: expect.any(Number),
		refused: false,
	});
	expect(document?.chainBytes).toBeGreaterThan(0);
	const exported = await replica.exportDocument(record);
	expect(documentText(exported)).toBe('local document');
	expect(exported).toBeDefined();
	if (exported !== undefined) {
		expect(documentPayloadDigest(exported)).toBe(expectedDocumentDigest);
	}
}

async function expectDiscarded(replica: AttachmentObservations): Promise<void> {
	expect(await replica.record(record)).toBeNull();
	expect(await replica.workSummary()).toEqual({
		scalar: { pending: 0, sealed: 0, parked: 0 },
		document: { owed: 0, parked: 0 },
		blob: { owed: 0, parked: 0 },
	});
	expect(await replica.owedDocuments(16)).toEqual([]);
	expect(await replica.owedBlobs(16)).toEqual([]);
	expect(await replica.blobDigest(record)).toBeNull();
	expect(await replica.inspectDocument(record)).toBeNull();
	expect(await replica.exportDocument(record)).toBeUndefined();
}

async function applyAttachmentWithCrashes(
	replica: AttachmentConformanceReplica,
	choice: FirstAttachmentChoice,
	expectedDocumentDigest: string,
): Promise<void> {
	const before = await replica.snapshot();
	const transition = await replica.prepare({
		kind: 'attach',
		attachment: ATTACHMENT,
		choice,
	});
	const boundaries = await transition.boundaries;
	expect(boundaries).toBeGreaterThanOrEqual(2);

	for (let boundary = 1; boundary <= boundaries; boundary += 1) {
		const crashed = await transition.crash(boundary);
		try {
			const attachment = await crashed.attachment();
			if (attachment.kind === 'unattached') {
				expect(await crashed.snapshot()).toBe(before);
				expect(attachment.requiresChoice).toBe(true);
				await expectLocalObligations(
					crashed,
					'pending',
					expectedDocumentDigest,
				);
			} else {
				expect(attachment.attachment).toEqual(ATTACHMENT);
				if (choice === 'bring')
					await expectLocalObligations(
						crashed,
						'pending',
						expectedDocumentDigest,
					);
				else await expectDiscarded(crashed);
			}
		} finally {
			await crashed.close();
		}
	}

	expect(await transition.commit()).toEqual({
		attached: true,
		discarded: choice === 'discard',
	});
}

function acceptFirstSubmission(witness: SealedRequest): SubmissionResponse {
	const parsed = parseSubmissionRequest(JSON.parse(witness.bytes), LIMITS);
	if (parsed.error !== null) throw new Error(parsed.error.message);
	const created = createAuthority(LIFETIME, LIMITS);
	if (created.error !== null) throw new Error(created.error.message);
	const accepted = submit(created.data, parsed.data, LIMITS);
	if (accepted.error !== null) throw new Error(accepted.error.message);
	return accepted.data.response;
}

export function runAttachmentConformanceCases(
	binding: AttachmentConformanceBinding,
): void {
	describe(`first attachment: ${binding.name}`, () => {
		test('Bring crash recovery keeps the whole replica and publishes its first scalar submission', async () => {
			let replica = await binding.create({ replicaId: REPLICA_ID });
			try {
				const expectedDocumentDigest = await seedLocalReplica(replica);
				expect(await replica.attachment()).toEqual({
					kind: 'unattached',
					requiresChoice: true,
				});
				await expectLocalObligations(
					replica,
					'pending',
					expectedDocumentDigest,
				);

				await applyAttachmentWithCrashes(
					replica,
					'bring',
					expectedDocumentDigest,
				);
				replica = await replica.reopen();
				expect(await replica.attachment()).toEqual({
					kind: 'attached',
					attachment: ATTACHMENT,
				});
				await expectLocalObligations(
					replica,
					'pending',
					expectedDocumentDigest,
				);

				await (
					await replica.prepare({
						kind: 'install-facts',
						page: {
							request: { afterSequence: 0 },
							response: {
								authorityLifetime: LIFETIME,
								facts: [],
								hasMore: false,
							},
						},
					})
				).commit();
				expect((await replica.sync()).authorityLifetime).toBe(LIFETIME);
				await expectLocalObligations(
					replica,
					'pending',
					expectedDocumentDigest,
				);

				const sealed = await (await replica.prepare({ kind: 'seal' })).commit();
				if (sealed === undefined || !('bytes' in sealed)) {
					throw new Error('first attachment seal returned no witness');
				}
				await expectLocalObligations(replica, 'sealed', expectedDocumentDigest);
				await (
					await replica.prepare({
						kind: 'settle',
						response: acceptFirstSubmission(sealed),
					})
				).commit();

				replica = await replica.reopen();
				await expectLocalObligations(
					replica,
					'settled',
					expectedDocumentDigest,
				);
				expect(await replica.attachment()).toEqual({
					kind: 'attached',
					attachment: ATTACHMENT,
				});
			} finally {
				await replica.dispose();
			}
		});

		test('Discard crash recovery keeps all local data or commits an attached empty replica', async () => {
			let replica = await binding.create({ replicaId: REPLICA_ID });
			try {
				const expectedDocumentDigest = await seedLocalReplica(replica);
				await applyAttachmentWithCrashes(
					replica,
					'discard',
					expectedDocumentDigest,
				);

				replica = await replica.reopen();
				expect(await replica.attachment()).toEqual({
					kind: 'attached',
					attachment: ATTACHMENT,
				});
				expect(await replica.sync()).toEqual({
					replicaId: REPLICA_ID,
					authorityLifetime: null,
					afterSequence: 0,
					sealedSubmission: null,
					nextSubmission: 1,
				});
				await expectDiscarded(replica);
			} finally {
				await replica.dispose();
			}
		});
	});
}
