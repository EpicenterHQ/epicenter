import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from './blob-v1/index.js';
import { sha256HexBytes } from './protocol/v1/canonical.js';
import { foldIntent, type SubmissionRequest } from './protocol/v1/index.js';
import { makeLimits } from './protocol/v1/kernel.test-support.js';
import {
	createRecordSyncSupervisor,
	RecordAuthorityLifetimeMismatchError,
	type RecordSyncTransport,
	RecordSyncTransportCancelledError,
} from './record-sync-supervisor.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from './store/replica/index.js';

class MemoryBlobFiles implements BlobFileStore<Uint8Array, Uint8Array> {
	readonly staging = new Map<string, Uint8Array>();
	readonly content = new Map<string, Uint8Array>();

	async stage(source: Uint8Array): Promise<StagedBlob> {
		const bytes = new Uint8Array(source);
		const digest = sha256HexBytes(bytes);
		const id = `${digest}.stage`;
		this.staging.set(id, bytes);
		return { id, digest };
	}

	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staging.get(staged.id);
		if (bytes === undefined) throw new Error('staged blob missing');
		this.content.set(`${owner.ownerKey}/${owner.digest}`, bytes);
		this.staging.delete(staged.id);
	}

	async open(owner: OwnedBlobFile): Promise<Uint8Array> {
		const bytes = this.content.get(`${owner.ownerKey}/${owner.digest}`);
		if (bytes === undefined) throw new Error('owned blob missing');
		return new Uint8Array(bytes);
	}

	async sweepStaging(): Promise<void> {
		this.staging.clear();
	}

	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(
			owned.map((owner) => `${owner.ownerKey}/${owner.digest}`),
		);
		for (const key of this.content.keys()) {
			if (!retained.has(key)) this.content.delete(key);
		}
	}
}

const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const ATTACHMENT = {
	deploymentId: 'https://api.example.com/',
	principalId: 'principal-one',
} as const;

function setup(authorityLifetime?: string) {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const replica = openReplicaStore({
		database: adapter,
		limits: makeLimits(),
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			...(authorityLifetime === undefined ? {} : { authorityLifetime }),
		},
	});
	const blobs = createReplicaBlobStore(adapter, new MemoryBlobFiles());
	const scheduled: (() => void)[] = [];
	const supervisor = createRecordSyncSupervisor({
		replica,
		blobs,
		schedule(task) {
			scheduled.push(task);
			return () => undefined;
		},
	});
	return { database, replica, blobs, supervisor, scheduled };
}

function acceptingTransport({
	failFacts = false,
}: {
	failFacts?: boolean;
} = {}): RecordSyncTransport<Uint8Array> & {
	calls: string[];
} {
	const calls: string[] = [];
	let sequence = 0;
	return {
		calls,
		async readFacts() {
			calls.push('facts');
			if (failFacts) throw new Error('facts unavailable');
			return {
				authorityLifetime: 'lifetime-one',
				facts: [],
				hasMore: false,
			};
		},
		async submit(sealed) {
			calls.push('scalar');
			const request = JSON.parse(sealed.bytes) as SubmissionRequest;
			const facts = request.intents.map((intent) => {
				const outcome = foldIntent(undefined, intent, ++sequence);
				if (outcome.kind !== 'changed') {
					throw new Error('test authority expected a changed fact');
				}
				return outcome.fact;
			});
			return {
				authorityLifetime: request.authorityLifetime,
				facts,
				parked: [],
			};
		},
		async publishDocument(request) {
			calls.push('document');
			return {
				kind: 'accepted',
				receipt: {
					authorityLifetime: request.authorityLifetime,
					address: request.address,
					protocolVersion: request.protocolVersion,
					digest: request.digest,
				},
			};
		},
		async publishBlob(publication) {
			calls.push('blob');
			return { kind: 'accepted', receipt: publication.request };
		},
	};
}

describe('record sync supervisor', () => {
	test('attaches before draining every durable plane to proof', async () => {
		const context = setup();
		try {
			context.replica.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { title: 'Local' },
			});
			const document = new Y.Doc({ gc: true });
			let update: Uint8Array | undefined;
			document.on(
				'updateV2',
				(next: Uint8Array) => (update = new Uint8Array(next)),
			);
			document.get('content').insert(0, 'hello');
			document.destroy();
			if (update === undefined) throw new Error('document update missing');
			context.replica.appendLocalDocumentUpdate(ADDRESS, update);
			await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('blob bytes'),
			);

			const transport = acceptingTransport();
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				firstAttachmentChoice: 'bring',
				transport,
			});
			expect(transport.calls).toEqual([
				'facts',
				'scalar',
				'document',
				'blob',
				'facts',
			]);
			expect(context.replica.workSummary()).toEqual({
				scalar: { pending: 0, sealed: 0, parked: 0 },
				document: { pending: 0, parked: 0 },
				blob: { pending: 0, parked: 0 },
			});
			expect(context.replica.inspectDocument(ADDRESS)?.dirty).toBe(false);
			expect(context.blobs.inspect(ADDRESS).kind).toBe('accepted');
		} finally {
			context.supervisor.dispose();
			context.database.close();
		}
	});

	test('requires Bring for nonempty data and drains scalar work automatically', async () => {
		const context = setup();
		try {
			context.replica.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { title: 'Local' },
			});
			const transport = acceptingTransport();
			await expect(
				context.supervisor.attach({ attachment: ATTACHMENT, transport }),
			).rejects.toThrow(/bring or discard/);
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				firstAttachmentChoice: 'bring',
				transport,
			});
			expect(transport.calls).toEqual(['facts', 'scalar', 'facts']);
			expect(context.replica.workSummary().scalar).toEqual({
				pending: 0,
				sealed: 0,
				parked: 0,
			});
			expect(context.supervisor.status.state).toBe('idle');
			expect(context.supervisor.status.authorityLifetime).toBe('lifetime-one');
			expect(context.replica.attachment()).toMatchObject({
				kind: 'attached',
				attachment: ATTACHMENT,
			});
		} finally {
			context.supervisor.dispose();
			context.database.close();
		}
	});

	test('a facts failure does not block the independent submission drain', async () => {
		const context = setup('lifetime-one');
		try {
			context.replica.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { title: 'Local' },
			});
			const transport = acceptingTransport({ failFacts: true });
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				firstAttachmentChoice: 'bring',
				transport,
			});
			expect(transport.calls).toEqual(['facts', 'scalar']);
			expect(context.replica.workSummary().scalar).toEqual({
				pending: 0,
				sealed: 0,
				parked: 0,
			});
			expect(context.supervisor.status).toMatchObject({
				state: 'offline',
				lastError: { message: 'facts unavailable' },
			});
		} finally {
			context.supervisor.dispose();
			context.database.close();
		}
	});

	test('an ambiguous mutation stops later planes until explicit reattachment', async () => {
		const context = setup('lifetime-one');
		try {
			context.replica.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { title: 'Local' },
			});
			const document = new Y.Doc({ gc: true });
			let update: Uint8Array | undefined;
			document.on(
				'updateV2',
				(next: Uint8Array) => (update = new Uint8Array(next)),
			);
			document.get('content').insert(0, 'hello');
			document.destroy();
			if (update === undefined) throw new Error('document update missing');
			context.replica.appendLocalDocumentUpdate(ADDRESS, update);
			await context.blobs.capture(
				ADDRESS,
				new TextEncoder().encode('blob bytes'),
			);

			const ambiguous = acceptingTransport();
			ambiguous.submit = async () => {
				ambiguous.calls.push('scalar');
				throw new RecordSyncTransportCancelledError('response is ambiguous');
			};
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				firstAttachmentChoice: 'bring',
				transport: ambiguous,
			});
			expect(ambiguous.calls).toEqual(['facts', 'scalar']);
			expect(context.supervisor.status).toMatchObject({
				state: 'offline',
				lastError: { name: 'RecordSyncTransportCancelled' },
			});
			expect(context.scheduled).toHaveLength(0);
			await context.supervisor.requestDrain();
			expect(ambiguous.calls).toEqual(['facts', 'scalar']);

			const reattached = acceptingTransport();
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				transport: reattached,
			});
			expect(reattached.calls).toEqual([
				'facts',
				'scalar',
				'document',
				'blob',
				'facts',
			]);
		} finally {
			context.supervisor.dispose();
			context.database.close();
		}
	});

	test('a lifetime mismatch erases once and reacquires from zero', async () => {
		const context = setup('lifetime-old');
		try {
			context.replica.localWrite({
				address: ADDRESS,
				op: 'replace',
				value: { title: 'Abandoned' },
			});
			const transport = acceptingTransport();
			let reads = 0;
			transport.readFacts = async () => {
				transport.calls.push('facts');
				reads += 1;
				if (reads === 1) {
					throw new RecordAuthorityLifetimeMismatchError('lifetime-two');
				}
				return {
					authorityLifetime: 'lifetime-two',
					facts: [],
					hasMore: false,
				};
			};
			await context.supervisor.attach({
				attachment: ATTACHMENT,
				firstAttachmentChoice: 'bring',
				transport,
			});
			expect(reads).toBe(2);
			expect(context.replica.sync().authorityLifetime).toBe('lifetime-two');
			expect(context.replica.visible(ADDRESS)).toBeNull();
			expect(context.supervisor.status.state).toBe('idle');
		} finally {
			context.supervisor.dispose();
			context.database.close();
		}
	});
});
