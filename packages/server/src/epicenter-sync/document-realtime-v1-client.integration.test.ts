/**
 * Document Realtime V1 Client Integration Proof
 *
 * Drives the runtime-owned realtime document channel in @epicenter/data
 * against the production realtime server and scalar authority: two Bun
 * replicas converge one open record document live, acceptance flows through
 * the one authority acceptance function, and a terminal record closes every
 * peer and permanently stops the channels.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import {
	parseSubmissionRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type {
	DocumentRealtimeSocket,
	EpicenterRuntime,
} from '@epicenter/data/runtime';
import { createEpicenterRuntime } from '@epicenter/data/runtime';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';
import { defineLens, defineTable } from '../../../data/src/lens/index.js';
import {
	createTestCarrier,
	MemoryBlobFiles,
} from '../../../data/src/runtime/epicenter.test-support.js';
import { createReplicaBlobStore } from '../../../data/src/store/replica/blob-store.js';
import {
	openReplicaStore,
	type ReplicaStore,
} from '../../../data/src/store/replica/index.js';
import { openScalarAuthorityV1 } from './authority-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';

const LIFETIME = 'runtime-life';
const lens = defineLens({
	namespace: 'so.epicenter.realtime',
	title: 'Realtime',
	description: 'Realtime client integration',
	collections: {
		notes: defineTable({ title: 'Notes', fields: { title: field.string() } }),
	},
});
const ADDRESS: RecordAddress = {
	namespace: lens.namespace,
	collection: 'notes',
	recordKey: 'cccccccccccccccccccccccc',
};

function openAuthority() {
	const raw = new Database(':memory:', { strict: true });
	const authority = openScalarAuthorityV1({
		database: createBunSqliteAdapter(raw),
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { authorityLifetime: LIFETIME },
	});
	expectOk(
		authority.submit(
			expectOk(
				parseSubmissionRequest(
					{
						authorityLifetime: LIFETIME,
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						submissionNumber: 1,
						intents: [
							{ address: ADDRESS, op: 'replace', value: { title: 'shared' } },
						],
					},
					SCALAR_SYNC_V1_LIMITS,
				),
			),
		),
	);
	return { raw, authority };
}

/** Pipe the runtime's socket contract straight into the production server. */
function createServerOpener(
	server: ReturnType<typeof createDocumentRealtimeV1Server>,
) {
	return {
		async open(address: RecordAddress): Promise<DocumentRealtimeSocket> {
			const client: DocumentRealtimeSocket = {
				readyState: 1,
				protocol: 'epicenter-document-v3',
				binaryType: 'arraybuffer',
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send(data: Uint8Array): void {
					server.receive(peer, address, LIFETIME, new Uint8Array(data));
				},
				close(): void {
					(client as { readyState: number }).readyState = 3;
					server.disconnect(peer);
				},
			};
			const peer: DocumentRealtimeV1Socket = {
				send(data: Uint8Array): void {
					if (client.readyState !== 1) return;
					client.onmessage?.({ data: new Uint8Array(data) });
				},
				close(code?: number, reason?: string): void {
					if (client.readyState !== 1) return;
					(client as { readyState: number }).readyState = 3;
					client.onclose?.({
						code: code ?? 1000,
						reason: reason ?? '',
						wasClean: true,
					});
				},
			};
			return client;
		},
	};
}

type Fixture = {
	raw: Database;
	store: ReplicaStore;
	epicenter: EpicenterRuntime<Uint8Array, Uint8Array>;
	bound: ReturnType<typeof bindLens>;
};

function bindLens(epicenter: EpicenterRuntime<Uint8Array, Uint8Array>) {
	return epicenter.bind(lens);
}

function openRuntime(
	opener: ReturnType<typeof createServerOpener>,
	replicaId: string,
): Fixture {
	const raw = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(raw);
	const store = openReplicaStore({
		database: adapter,
		limits: SCALAR_SYNC_V1_LIMITS,
		owner: null,
		initialize: { replicaId, authorityLifetime: LIFETIME },
	});
	store.installFacts({
		request: { authorityLifetime: LIFETIME, afterSequence: 0 },
		response: {
			authorityLifetime: LIFETIME,
			facts: [
				{
					address: ADDRESS,
					sequence: 1,
					state: 'live',
					payload: { title: 'shared' },
				},
			],
			hasMore: false,
		},
	});
	const epicenter = createEpicenterRuntime({
		store,
		blobs: createReplicaBlobStore(adapter, new MemoryBlobFiles()),
		carrier: { ...createTestCarrier(), documentRealtime: opener },
		intervalMs: 3_600_000,
	});
	return { raw, store, epicenter, bound: bindLens(epicenter) };
}

async function close(fixture: Fixture): Promise<void> {
	await fixture.epicenter[Symbol.asyncDispose]();
	fixture.raw.close();
}

async function flush(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

test('two runtimes converge one record document through the production realtime server', async () => {
	const { raw: authorityRaw, authority } = openAuthority();
	const server = createDocumentRealtimeV1Server({ authority });
	const opener = createServerOpener(server);
	const a = openRuntime(opener, 'aaaaaaaaaaaaaaaaaaaaaaaa');
	const b = openRuntime(opener, 'bbbbbbbbbbbbbbbbbbbbbbbb');
	try {
		const documentA = expectOk(
			await a.bound.notes.record(ADDRESS.recordKey).document.open(),
		);
		const documentB = expectOk(
			await b.bound.notes.record(ADDRESS.recordKey).document.open(),
		);
		await flush();
		expect(server.connectionCount).toBe(2);

		documentA.transact(() => {
			documentA.getText('content').insert(0, 'realtime');
		});
		await flush();

		expect(documentB.getText('content').toString()).toBe('realtime');
		// The authority holds the accepted state through its one acceptance path.
		const authorityState = authority.exportDocument(ADDRESS);
		expect(authorityState).toBeDefined();
		// The receiving replica installed durably without a local obligation.
		expect(b.store.inspectDocument(ADDRESS)?.owed).toBe(false);

		documentB.transact(() => {
			const content = documentB.getText('content');
			content.insert(content.length, ' both ways');
		});
		await flush();
		expect(documentA.getText('content').toString()).toBe('realtime both ways');

		// A terminal record closes every peer and stops the channels for good.
		expectOk(
			authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: LIFETIME,
							replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
							submissionNumber: 2,
							intents: [{ address: ADDRESS, op: 'tombstone' }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		server.closeAddress(ADDRESS);
		await flush();
		expect(server.connectionCount).toBe(0);

		await documentA[Symbol.asyncDispose]();
		await documentB[Symbol.asyncDispose]();
	} finally {
		await close(a);
		await close(b);
		authorityRaw.close();
	}
});
