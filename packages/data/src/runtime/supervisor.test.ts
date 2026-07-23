/**
 * Runtime Supervisor Tests
 *
 * Exercises the one lifecycle owner over the production replica store and an
 * in-memory carrier backed by the pure scalar reference authority.
 *
 * Key behaviors:
 * - Obligations recorded without a carrier drain under a later carrier-bearing
 *   supervisor over the same store (ADR-0178)
 * - Exact scalar retries, racing publications, and delayed proofs are monotonic
 * - Plane failures, refusals, replacement, and disposal obey their lifecycle
 *   laws without a socket or loopback server
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobAcceptance,
	type BlobFileStore,
	type BlobPublicationRequest,
	type OwnedBlobFile,
	type StagedBlob,
} from '../blob-v1/index.js';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationRequest,
} from '../document-v1/index.js';
import { sha256HexBytes } from '../protocol/v1/canonical.js';
import {
	type AuthorityState,
	addressKey,
	createAuthority,
	type Fact,
	type FactsRequest,
	type JsonValue,
	parseFactsRequest,
	parseSubmissionRequest,
	type RecordAddress,
	readFacts,
	type SubmissionRequest,
	type SubmissionResponse,
	submit,
} from '../protocol/v1/index.js';
import { makeLimits } from '../protocol/v1/kernel.test-support.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
	type ReplicaStore,
} from '../store/replica/index.js';
import {
	type AuthorityCarrier,
	createRuntimeSupervisor,
	type RuntimeBackoff,
	type RuntimeSchedule,
} from './supervisor.js';

const LIMITS = makeLimits();
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const OTHER_REPLICA_ID = 'ssssssssssssssssssssssss';
const ADDRESS_A = address('aaaaaaaaaaaaaaaaaaaaaaaa');
const ADDRESS_B = address('bbbbbbbbbbbbbbbbbbbbbbbb');
const ADDRESS_C = address('cccccccccccccccccccccccc');

function address(recordKey: string): RecordAddress {
	return {
		namespace: 'so.epicenter.tests',
		collection: 'notes',
		recordKey,
	};
}

class MemoryBlobFiles implements BlobFileStore<Uint8Array, Uint8Array> {
	readonly staging = new Map<string, Uint8Array>();
	readonly content = new Map<string, Uint8Array>();
	#nextId = 1;

	async stage(source: Uint8Array): Promise<StagedBlob> {
		const bytes = new Uint8Array(source);
		const staged = { id: String(this.#nextId), digest: sha256HexBytes(bytes) };
		this.#nextId += 1;
		this.staging.set(staged.id, bytes);
		return staged;
	}

	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staging.get(staged.id);
		if (bytes === undefined) throw new Error('missing staged blob');
		this.content.set(`${owner.ownerKey}:${owner.digest}`, bytes);
		this.staging.delete(staged.id);
	}

	async open(owner: OwnedBlobFile): Promise<Uint8Array> {
		const bytes = this.content.get(`${owner.ownerKey}:${owner.digest}`);
		if (bytes === undefined) throw new Error('missing blob content');
		return new Uint8Array(bytes);
	}

	async sweepStaging(): Promise<void> {
		this.staging.clear();
	}

	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(
			owned.map((owner) => `${owner.ownerKey}:${owner.digest}`),
		);
		for (const key of this.content.keys()) {
			if (!retained.has(key)) this.content.delete(key);
		}
	}
}

type Scheduled = {
	task: () => void;
	delayMs: number;
	cancelled: boolean;
};

function createManualBackoff() {
	let now = 0;
	const scheduled: Scheduled[] = [];
	const schedule: RuntimeSchedule = (task, delayMs) => {
		const entry = { task, delayMs, cancelled: false };
		scheduled.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	const backoff: RuntimeBackoff = {
		now: () => now,
		delay: () => 10,
		schedule,
	};
	return {
		backoff,
		scheduled,
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

type TestCarrier = AuthorityCarrier<Uint8Array> & {
	get state(): AuthorityState;
	setState(state: AuthorityState): void;
	submittedBytes: string[];
	documents: Map<string, Uint8Array>;
	blobs: Map<string, Uint8Array>;
	fail: Set<'scalar' | 'facts' | 'documents' | 'blobs'>;
	dropNextSubmissionReply: boolean;
	forceDocumentNotLive: Set<string>;
	beforeDocumentAcceptance?(
		address: RecordAddress,
		publication: DocumentPublicationRequest,
	): void;
	beforeBlobAcceptance?(
		address: RecordAddress,
		publication: BlobPublicationRequest,
	): void;
};

function createCarrier(initialState = authority('lifetime-one')): TestCarrier {
	let state = initialState;
	const submittedBytes: string[] = [];
	const documents = new Map<string, Uint8Array>();
	const blobs = new Map<string, Uint8Array>();
	const fail = new Set<'scalar' | 'facts' | 'documents' | 'blobs'>();
	const forceDocumentNotLive = new Set<string>();
	const carrier: TestCarrier = {
		get state() {
			return state;
		},
		setState(next) {
			state = next;
		},
		submittedBytes,
		documents,
		blobs,
		fail,
		dropNextSubmissionReply: false,
		forceDocumentNotLive,
		async fetchFacts(request: FactsRequest) {
			if (fail.has('facts')) throw new Error('facts transport unavailable');
			const admitted = expectOk(parseFactsRequest(request, LIMITS));
			const result = readFacts(state, admitted, LIMITS);
			if (result.error !== null) throw result.error;
			return result.data;
		},
		async submit(bytes: string): Promise<SubmissionResponse> {
			if (fail.has('scalar')) throw new Error('scalar transport unavailable');
			submittedBytes.push(bytes);
			const admitted = expectOk(
				parseSubmissionRequest(JSON.parse(bytes), LIMITS),
			);
			const result = submit(state, admitted, LIMITS);
			if (result.error !== null) throw result.error;
			state = result.data.state;
			if (carrier.dropNextSubmissionReply) {
				carrier.dropNextSubmissionReply = false;
				throw new Error('submission reply dropped');
			}
			return result.data.response;
		},
		async publishDocument(
			target: RecordAddress,
			publication,
		): Promise<DocumentAcceptance> {
			if (fail.has('documents')) {
				throw new Error('document transport unavailable');
			}
			if (publication.authorityLifetime !== state.lifetime) {
				return {
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: state.lifetime,
				};
			}
			carrier.beforeDocumentAcceptance?.(target, publication);
			if (
				forceDocumentNotLive.has(addressKey(target)) ||
				state.facts.get(addressKey(target))?.state !== 'live'
			) {
				return {
					kind: 'record-not-live',
					activeAuthorityLifetime: state.lifetime,
					address: target,
					state: 'absent',
				};
			}
			documents.set(addressKey(target), new Uint8Array(publication.payload));
			return {
				kind: 'accepted',
				receipt: {
					authorityLifetime: state.lifetime,
					address: target,
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					digest: publication.digest,
				},
			};
		},
		async publishBlob(
			target: RecordAddress,
			publication: BlobPublicationRequest,
			bytes: Uint8Array,
		): Promise<BlobAcceptance> {
			if (fail.has('blobs')) throw new Error('blob transport unavailable');
			if (publication.authorityLifetime !== state.lifetime) {
				return {
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: state.lifetime,
				};
			}
			carrier.beforeBlobAcceptance?.(target, publication);
			if (state.facts.get(addressKey(target))?.state !== 'live') {
				return {
					kind: 'record-not-live',
					activeAuthorityLifetime: state.lifetime,
					address: target,
					state: 'absent',
				};
			}
			blobs.set(addressKey(target), new Uint8Array(bytes));
			return {
				kind: 'accepted',
				receipt: {
					authorityLifetime: state.lifetime,
					address: target,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: publication.digest,
				},
			};
		},
	};
	return carrier;
}

function authority(lifetime: string): AuthorityState {
	return expectOk(createAuthority(lifetime, LIMITS));
}

function applyAuthority(
	state: AuthorityState,
	intents: SubmissionRequest['intents'],
	replicaId = OTHER_REPLICA_ID,
): AuthorityState {
	const request: SubmissionRequest = {
		authorityLifetime: state.lifetime,
		replicaId,
		submissionNumber:
			(state.replicas.get(replicaId)?.lastSubmissionNumber ?? 0) + 1,
		intents,
	};
	const result = submit(
		state,
		expectOk(parseSubmissionRequest(request, LIMITS)),
		LIMITS,
	);
	if (result.error !== null) throw result.error;
	return result.data.state;
}

function documentUpdate(text: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function setup(
	options: {
		authorityLifetime?: string;
		carrier?: TestCarrier | null;
		onAuthorityReplacement?: () => void;
	} = {},
) {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const store = openReplicaStore({
		owner: null,
		database: adapter,
		limits: LIMITS,
		initialize: {
			replicaId: REPLICA_ID,
			...(options.authorityLifetime === undefined
				? {}
				: { authorityLifetime: options.authorityLifetime }),
		},
	});
	const files = new MemoryBlobFiles();
	const blobs = createReplicaBlobStore(adapter, files);
	const timing = createManualBackoff();
	const invalidations: RecordAddress[][] = [];
	const statuses: string[] = [];
	const supervisor = createRuntimeSupervisor({
		store,
		blobs,
		carrier: options.carrier ?? null,
		onInvalidate: (addresses) => invalidations.push(addresses),
		onAuthorityReplacement: options.onAuthorityReplacement ?? (() => undefined),
		onStatus: (status) => statuses.push(status.state),
		intervalMs: 1_000,
		backoff: timing.backoff,
	});
	return {
		database,
		store,
		files,
		blobs,
		timing,
		invalidations,
		statuses,
		supervisor,
	};
}

function makeLive(
	store: ReplicaStore,
	target: RecordAddress,
	value: JsonValue,
) {
	store.localWrite({ address: target, op: 'replace', value });
}

test('obligations recorded without a carrier drain under a later carrier-bearing supervisor', async () => {
	const carrier = createCarrier();
	const context = setup();
	const invalidations: RecordAddress[][] = [];
	let resumed: ReturnType<typeof createRuntimeSupervisor> | undefined;
	try {
		makeLive(context.store, ADDRESS_A, { title: 'offline' });
		context.store.appendLocalDocumentUpdate(
			ADDRESS_A,
			documentUpdate('offline document'),
		);
		await context.blobs.capture(
			ADDRESS_A,
			new TextEncoder().encode('offline blob'),
		);

		// The local-only lifetime never contacts an authority.
		await context.supervisor.drainOnce();
		expect(context.supervisor.status().state).toBe('local-only');
		expect(carrier.submittedBytes).toEqual([]);
		await context.supervisor.dispose();

		// A later lifetime over the same store, opened with a carrier, drains
		// everything that stayed durable.
		resumed = createRuntimeSupervisor({
			store: context.store,
			blobs: context.blobs,
			carrier,
			onInvalidate: (addresses) => invalidations.push(addresses),
			onAuthorityReplacement: () => undefined,
			onStatus: () => undefined,
			intervalMs: 1_000,
			backoff: context.timing.backoff,
		});
		await resumed.drainOnce();

		expect(carrier.state.facts.get(addressKey(ADDRESS_A))).toMatchObject({
			state: 'live',
			payload: { title: 'offline' },
		});
		expect(carrier.documents.has(addressKey(ADDRESS_A))).toBe(true);
		expect(carrier.blobs.has(addressKey(ADDRESS_A))).toBe(true);
		expect(context.store.sealedRequest()).toBeNull();
		expect(context.store.inspectDocument(ADDRESS_A)).toMatchObject({
			owed: false,
			revision: 1,
			acceptedRevision: 1,
		});
		expect(context.blobs.inspect(ADDRESS_A).kind).toBe('accepted');
		expect(context.store.sync().afterSequence).toBe(1);
		expect(resumed.status().state).toBe('idle');
		expect(invalidations.flat()).toContainEqual(ADDRESS_A);
	} finally {
		await resumed?.dispose();
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('lost scalar reply retries exact persisted bytes without duplicate application', async () => {
	const carrier = createCarrier();
	carrier.dropNextSubmissionReply = true;
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		makeLive(context.store, ADDRESS_A, 'once');
		await context.supervisor.drainOnce();
		expect(context.supervisor.status().state).toBe('offline');
		expect(context.store.sealedRequest()).not.toBeNull();
		expect(carrier.state.nextSequence).toBe(2);

		context.timing.advance(10);
		await context.supervisor.drainOnce();

		expect(carrier.submittedBytes).toHaveLength(2);
		expect(carrier.submittedBytes[1]).toBe(carrier.submittedBytes[0]);
		expect(carrier.state.nextSequence).toBe(2);
		expect(context.store.sealedRequest()).toBeNull();
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('an empty scalar seal outcome leaves the plane healthy', async () => {
	const carrier = createCarrier();
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {

		await context.supervisor.drainOnce();

		expect(carrier.submittedBytes).toEqual([]);
		expect(context.supervisor.status().state).toBe('idle');
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('delayed duplicate proofs are monotonic and a racing edit stays owed', async () => {
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		context.store.appendLocalDocumentUpdate(ADDRESS_A, documentUpdate('N'));
		let capturedReceipt:
			| Extract<DocumentAcceptance, { kind: 'accepted' }>['receipt']
			| undefined;
		carrier.beforeDocumentAcceptance = (target, publication) => {
			capturedReceipt = {
				authorityLifetime: 'lifetime-one',
				address: target,
				protocolVersion: DOCUMENT_PUBLICATION_VERSION,
				digest: publication.digest,
			};
			context.store.appendLocalDocumentUpdate(ADDRESS_A, documentUpdate('N+1'));
			carrier.beforeDocumentAcceptance = undefined;
		};
		await context.supervisor.drainOnce();
		expect(context.store.inspectDocument(ADDRESS_A)).toMatchObject({
			revision: 2,
			acceptedRevision: 1,
			owed: true,
		});
		const captured = context.store.documentPublication(ADDRESS_A);
		expect(captured.kind).toBe('ready');
		if (captured.kind !== 'ready' || capturedReceipt === undefined) return;
		context.store.settleDocumentPublication(ADDRESS_A, capturedReceipt, {
			revision: 1,
			digest: capturedReceipt.digest,
		});
		expect(context.store.inspectDocument(ADDRESS_A)?.acceptedRevision).toBe(1);

		context.store.localWrite({
			address: ADDRESS_A,
			op: 'replace',
			value: { version: 'delayed-submission' },
		});
		const sealed = context.store.seal();
		if (sealed.kind !== 'sealed') throw new Error('submission was not sealed');
		const delayedResponse = await carrier.submit(sealed.request.bytes);
		const newer = applyAuthority(carrier.state, [
			{ address: ADDRESS_A, op: 'replace', value: { version: 2 } },
		]);
		carrier.setState(newer);
		context.store.installFacts({
			request: {
				authorityLifetime: 'lifetime-one',
				afterSequence: context.store.sync().afterSequence,
			},
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [newer.facts.get(addressKey(ADDRESS_A)) as Fact],
				hasMore: false,
			},
		});
		context.store.settle(delayedResponse);
		expect(context.store.visibleRecord(ADDRESS_A)).toEqual({
			state: 'live',
			payload: { version: 2 },
		});
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('refused work does not block later ready scalar and document obligations', async () => {
	let seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: 'primitive' },
		{ address: ADDRESS_B, op: 'replace', value: {} },
		{ address: ADDRESS_C, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	carrier.forceDocumentNotLive.add(addressKey(ADDRESS_B));
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()].sort(
					(left, right) => left.sequence - right.sequence,
				),
				hasMore: false,
			},
		});
		context.store.localWrite({
			address: ADDRESS_A,
			op: 'patch',
			set: { parked: true },
			unset: [],
		});
		context.store.localWrite({
			address: ADDRESS_C,
			op: 'replace',
			value: { drained: true },
		});
		context.store.appendLocalDocumentUpdate(
			ADDRESS_B,
			documentUpdate('blocked'),
		);
		context.store.appendLocalDocumentUpdate(ADDRESS_C, documentUpdate('ready'));

		await context.supervisor.drainOnce();
		seeded = carrier.state;

		expect(context.store.record(ADDRESS_A)?.parked?.code).toBe(
			'patch-base-not-object',
		);
		expect(seeded.facts.get(addressKey(ADDRESS_C))).toMatchObject({
			payload: { drained: true },
		});
		expect(context.store.inspectDocument(ADDRESS_B)?.refusal?.kind).toBe(
			'record-not-live',
		);
		expect(carrier.documents.has(addressKey(ADDRESS_C))).toBe(true);
		expect(context.store.owedDocuments(64)).toEqual([]);
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('plane failure retains work and reconnect drains it', async () => {
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_B, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	carrier.fail.add('scalar');
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		makeLive(context.store, ADDRESS_A, 'retained');
		context.store.appendLocalDocumentUpdate(
			ADDRESS_B,
			documentUpdate('independent'),
		);
		await context.supervisor.drainOnce();
		expect(context.supervisor.status().state).toBe('offline');
		expect(context.store.sealedRequest()).not.toBeNull();
		expect(carrier.documents.has(addressKey(ADDRESS_B))).toBe(true);
		expect(context.store.inspectDocument(ADDRESS_B)?.owed).toBe(false);

		carrier.fail.clear();
		context.timing.advance(10);
		await context.supervisor.drainOnce();
		expect(context.supervisor.status().state).toBe('idle');
		expect(context.store.sealedRequest()).toBeNull();
		expect(carrier.state.facts.has(addressKey(ADDRESS_A))).toBe(true);
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('authority replacement erases and reacquires while old document proof is fenced', async () => {
	const oldState = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(oldState);
	let replacements = 0;
	let documentExistedAtReplacement = false;
	let context: ReturnType<typeof setup>;
	context = setup({
		authorityLifetime: 'lifetime-one',
		carrier,
		onAuthorityReplacement() {
			replacements += 1;
			documentExistedAtReplacement =
				context.store.inspectDocument(ADDRESS_A) !== null;
		},
	});
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...oldState.facts.values()],
				hasMore: false,
			},
		});
		context.store.appendLocalDocumentUpdate(ADDRESS_A, documentUpdate('old'));
		const attempt = context.store.documentPublication(ADDRESS_A);
		expect(attempt.kind).toBe('ready');
		if (attempt.kind !== 'ready') return;

		const successor = applyAuthority(authority('lifetime-two'), [
			{ address: ADDRESS_B, op: 'replace', value: 'restored' },
		]);
		carrier.setState(successor);
		await context.supervisor.drainOnce();
		expect(replacements).toBe(1);
		expect(documentExistedAtReplacement).toBe(true);
		expect(context.store.sync()).toMatchObject({
			authorityLifetime: null,
			afterSequence: 0,
		});
		await context.supervisor.drainOnce();
		expect(context.store.sync().authorityLifetime).toBe('lifetime-two');
		expect(context.store.visibleRecord(ADDRESS_B)).toEqual({
			state: 'live',
			payload: 'restored',
		});
		expect(() =>
			context.store.settleDocumentPublication(
				ADDRESS_A,
				{
					authorityLifetime: 'lifetime-one',
					address: ADDRESS_A,
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					digest: attempt.publication.digest,
				},
				{
					revision: attempt.publication.capturedRevision,
					digest: attempt.publication.digest,
				},
			),
		).toThrow();
		expect(context.store.visibleRecord(ADDRESS_B).state).toBe('live');
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('document tombstone race is swallowed and the pass continues', async () => {
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
		{ address: ADDRESS_B, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		context.store.appendLocalDocumentUpdate(
			ADDRESS_A,
			documentUpdate('reaped'),
		);
		context.store.appendLocalDocumentUpdate(ADDRESS_B, documentUpdate('kept'));
		carrier.beforeDocumentAcceptance = (target) => {
			if (addressKey(target) !== addressKey(ADDRESS_A)) return;
			context.store.localWrite({ address: ADDRESS_A, op: 'tombstone' });
			carrier.beforeDocumentAcceptance = undefined;
		};

		await expect(context.supervisor.drainOnce()).resolves.toBeUndefined();
		expect(context.store.inspectDocument(ADDRESS_A)).toBeNull();
		expect(context.store.inspectDocument(ADDRESS_B)?.owed).toBe(false);
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('blob tombstone race is isolated and later blobs still settle', async () => {
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
		{ address: ADDRESS_B, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		await context.blobs.capture(
			ADDRESS_A,
			new TextEncoder().encode('reaped'),
		);
		await context.blobs.capture(
			ADDRESS_B,
			new TextEncoder().encode('settled'),
		);
		carrier.beforeBlobAcceptance = (target) => {
			if (addressKey(target) !== addressKey(ADDRESS_A)) return;
			context.store.localWrite({ address: ADDRESS_A, op: 'tombstone' });
			carrier.beforeBlobAcceptance = undefined;
		};

		await context.supervisor.drainOnce();

		expect(context.blobs.inspect(ADDRESS_A)).toEqual({ kind: 'absent' });
		expect(context.blobs.inspect(ADDRESS_B).kind).toBe('accepted');
		expect(context.supervisor.status().state).toBe('idle');
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('unexpected store failure enters ordinary plane backoff and later recovers', async () => {
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		context.store.appendLocalDocumentUpdate(
			ADDRESS_A,
			documentUpdate('owed'),
		);
		const publication = context.store.documentPublication;
		context.store.documentPublication = () => {
			throw new TypeError('unexpected store failure');
		};

		await context.supervisor.drainOnce();

		expect(context.supervisor.status().state).toBe('offline');
		expect(context.store.inspectDocument(ADDRESS_A)?.owed).toBe(true);

		context.store.documentPublication = publication;
		context.timing.advance(10);
		await context.supervisor.drainOnce();
		expect(context.supervisor.status().state).toBe('idle');
		expect(context.store.inspectDocument(ADDRESS_A)?.owed).toBe(false);
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('an unset record with an owed document does not starve later documents', async () => {
	// Reversible unset preserves document state (ADR-0160) but the record is
	// not visibly live, so capture throws the liveness race. The address must
	// be skipped per-address, never fail the plane or abort the page.
	const seeded = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_A, op: 'replace', value: {} },
		{ address: ADDRESS_B, op: 'replace', value: {} },
	]);
	const carrier = createCarrier(seeded);
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	try {
		context.store.installFacts({
			request: { authorityLifetime: 'lifetime-one', afterSequence: 0 },
			response: {
				authorityLifetime: 'lifetime-one',
				facts: [...seeded.facts.values()],
				hasMore: false,
			},
		});
		context.store.appendLocalDocumentUpdate(ADDRESS_A, documentUpdate('held'));
		context.store.appendLocalDocumentUpdate(ADDRESS_B, documentUpdate('sent'));
		context.store.localWrite({ address: ADDRESS_A, op: 'unset' });

		await expect(context.supervisor.drainOnce()).resolves.toBeUndefined();

		// The unset record's document remains owed and untouched; the later
		// record's document settled in the same pass; the plane is healthy.
		expect(context.store.inspectDocument(ADDRESS_A)?.owed).toBe(true);
		expect(context.store.inspectDocument(ADDRESS_B)?.owed).toBe(false);
		expect(context.supervisor.status().state).toBe('idle');
	} finally {
		await context.supervisor.dispose();
		context.database.close();
	}
});

test('a local-only lifetime never contacts an authority and a carrier-bearing one hydrates it', async () => {
	// A supervisor opened without a carrier is permanently local-only: no
	// authority contact, no status churn, durable writes retained.
	const local = setup();
	try {
		makeLive(local.store, ADDRESS_A, 'kept');
		await local.supervisor.drainOnce();
		expect(local.supervisor.status().state).toBe('local-only');
		expect(local.store.visibleRecord(ADDRESS_A)).toEqual({
			state: 'live',
			payload: 'kept',
		});
		expect(local.statuses).toEqual([]);
	} finally {
		await local.supervisor.dispose();
		local.database.close();
	}

	// A supervisor opened with a carrier over a fresh account replica
	// bootstraps the authority's existing Epicenter.
	const remote = applyAuthority(authority('lifetime-one'), [
		{ address: ADDRESS_B, op: 'replace', value: 'remote' },
	]);
	const hydrate = setup({ carrier: createCarrier(remote) });
	try {
		await hydrate.supervisor.drainOnce();
		expect(hydrate.store.visibleRecord(ADDRESS_B)).toEqual({
			state: 'live',
			payload: 'remote',
		});
		expect(hydrate.supervisor.status().state).toBe('idle');
	} finally {
		await hydrate.supervisor.dispose();
		hydrate.database.close();
	}
});

test('dispose cancels scheduled work and makes mutating entry points terminal', async () => {
	const carrier = createCarrier();
	const context = setup({ authorityLifetime: 'lifetime-one', carrier });
	makeLive(context.store, ADDRESS_A, 'never sent');
	context.supervisor.nudge();
	await context.supervisor.dispose();

	expect(context.timing.scheduled.some((entry) => entry.cancelled)).toBe(true);
	for (const entry of context.timing.scheduled) {
		if (!entry.cancelled) entry.task();
	}
	expect(carrier.submittedBytes).toEqual([]);
	expect(() => context.supervisor.nudge()).toThrow(/disposed/);
	expect(() => context.supervisor.drainOnce()).toThrow(/disposed/);
	expect(context.supervisor.status().state).toBe('idle');
	context.database.close();
});
