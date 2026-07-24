/**
 * Runtime Document Realtime Tests
 *
 * Exercises the runtime-owned realtime channel over two production replica
 * stores against an in-memory hub speaking the document V1 realtime frame
 * contract (sync-request handshake, acceptance, peer broadcast, no sender
 * echo).
 *
 * Key behaviors:
 * - an open record document converges live between two replicas
 * - remote installs persist durably and create no local publication obligation
 * - reconnect resynchronizes both directions without duplicate application
 * - a record-not-live close stops the channel permanently
 * - disposal closes every channel
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
	encodeDocumentAcceptance,
} from '../document-v1/index.js';
import { defineLens, defineTable } from '../lens/index.js';
import type { Fact, RecordAddress } from '../protocol/v1/index.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
	type ReplicaStore,
} from '../store/replica/index.js';
import type { DocumentRealtimeSocket } from './document-realtime.js';
import { createEpicenterRuntime, type EpicenterRuntime } from './epicenter.js';
import {
	createTestCarrier,
	MemoryBlobFiles,
	TEST_LIMITS,
} from './epicenter.test-support.js';
import type { RowDocument } from './row-document.js';

const LIFETIME = 'runtime-life';

const lens = defineLens({
	namespace: 'so.epicenter.realtime',
	title: 'Realtime',
	description: 'Realtime tests',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
		}),
	},
});

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

type HubSocket = DocumentRealtimeSocket & {
	serverClose(code: number, reason: string): void;
};

/** In-memory stand-in for the document V1 realtime server frame contract. */
function createHub() {
	const documents = new Map<string, Y.Doc>();
	const sessions = new Map<string, Set<HubSocket>>();
	let openCount = 0;

	function documentAt(key: string): Y.Doc {
		const existing = documents.get(key);
		if (existing !== undefined) return existing;
		const created = new Y.Doc({ gc: true });
		documents.set(key, created);
		return created;
	}

	function sessionsAt(key: string): Set<HubSocket> {
		const existing = sessions.get(key);
		if (existing !== undefined) return existing;
		const created = new Set<HubSocket>();
		sessions.set(key, created);
		return created;
	}

	function deliver(
		socket: HubSocket,
		frame: Parameters<typeof encodeDocumentFrame>[0],
	): void {
		if (socket.readyState !== 1) return;
		socket.onmessage?.({ data: new Uint8Array(encodeDocumentFrame(frame)) });
	}

	function open(address: RecordAddress): HubSocket {
		openCount += 1;
		const key = addressKey(address);
		let handshaken = false;
		const socket: HubSocket = {
			readyState: 1,
			protocol: DOCUMENT_SUBPROTOCOL,
			binaryType: 'arraybuffer',
			onopen: null,
			onmessage: null,
			onerror: null,
			onclose: null,
			send(data: Uint8Array): void {
				const frame = decodeDocumentFrame(new Uint8Array(data));
				const hubDocument = documentAt(key);
				if (!handshaken) {
					if (frame.kind !== 'sync-request') {
						throw new TypeError('expected initial sync request');
					}
					handshaken = true;
					deliver(socket, {
						kind: 'sync-request',
						stateVector: new Uint8Array(Y.encodeStateVector(hubDocument)),
					});
					deliver(socket, {
						kind: 'sync-response',
						update: new Uint8Array(
							Y.encodeStateAsUpdateV2(hubDocument, frame.stateVector),
						),
					});
					return;
				}
				switch (frame.kind) {
					case 'sync-request':
						deliver(socket, {
							kind: 'sync-response',
							update: new Uint8Array(
								Y.encodeStateAsUpdateV2(hubDocument, frame.stateVector),
							),
						});
						return;
					case 'sync-response':
					case 'update': {
						Y.applyUpdateV2(hubDocument, frame.update);
						deliver(socket, {
							kind: 'publication-response',
							acceptance: encodeDocumentAcceptance({
								kind: 'accepted',
								receipt: {
									authorityLifetime: LIFETIME,
									address: structuredClone(address),
									protocolVersion: DOCUMENT_PUBLICATION_VERSION,
									digest: documentPayloadDigest(frame.update),
								},
							}),
						});
						for (const peer of sessionsAt(key)) {
							if (peer !== socket) {
								deliver(peer, { kind: 'update', update: frame.update });
							}
						}
						return;
					}
					case 'publication-response':
						throw new TypeError('unexpected client acceptance frame');
				}
			},
			close(): void {
				(socket as { readyState: number }).readyState = 3;
				sessionsAt(key).delete(socket);
			},
			serverClose(code: number, reason: string): void {
				(socket as { readyState: number }).readyState = 3;
				sessionsAt(key).delete(socket);
				socket.onclose?.({ code, reason, wasClean: true });
			},
		};
		sessionsAt(key).add(socket);
		return socket;
	}

	return {
		opener: {
			async open(address: RecordAddress): Promise<DocumentRealtimeSocket> {
				return open(address);
			},
		},
		text(address: RecordAddress): string {
			return documentAt(addressKey(address)).get('content').toString();
		},
		liveSessions(address: RecordAddress): number {
			return sessionsAt(addressKey(address)).size;
		},
		closeAddress(address: RecordAddress, reason: string): void {
			for (const socket of [...sessionsAt(addressKey(address))]) {
				socket.serverClose(1000, reason);
			}
		},
		dropAddress(address: RecordAddress): void {
			for (const socket of [...sessionsAt(addressKey(address))]) {
				socket.serverClose(1006, '');
			}
		},
		get openCount(): number {
			return openCount;
		},
	};
}

function createManualSchedule() {
	const tasks: (() => void)[] = [];
	return {
		schedule(task: () => void): () => void {
			tasks.push(task);
			return () => {
				const index = tasks.indexOf(task);
				if (index !== -1) tasks.splice(index, 1);
			};
		},
		runPending(): number {
			const pending = tasks.splice(0, tasks.length);
			for (const task of pending) task();
			return pending.length;
		},
		get pendingCount(): number {
			return tasks.length;
		},
	};
}

function bindLens(epicenter: EpicenterRuntime<Uint8Array, Uint8Array>) {
	return epicenter.bind(lens);
}

type Fixture = {
	database: Database;
	store: ReplicaStore;
	epicenter: EpicenterRuntime<Uint8Array, Uint8Array>;
	bound: ReturnType<typeof bindLens>;
	schedule: ReturnType<typeof createManualSchedule>;
};

function setup(hub: ReturnType<typeof createHub>): Fixture {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const store = openReplicaStore({
		owner: null,
		database: adapter,
		limits: TEST_LIMITS,
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: LIFETIME,
		},
	});
	const schedule = createManualSchedule();
	const epicenter = createEpicenterRuntime({
		store,
		blobs: createReplicaBlobStore(adapter, new MemoryBlobFiles()),
		carrier: { ...createTestCarrier(), documentRealtime: hub.opener },
		intervalMs: 3_600_000,
		realtimeSchedule: schedule.schedule,
	});
	return { database, store, epicenter, bound: bindLens(epicenter), schedule };
}

async function close(fixture: Fixture): Promise<void> {
	await fixture.epicenter[Symbol.asyncDispose]();
	fixture.database.close();
}

function installLive(
	store: ReplicaStore,
	address: RecordAddress,
	payload: Extract<Fact, { state: 'live' }>['payload'],
): void {
	const afterSequence = store.sync().afterSequence;
	store.installFacts({
		request: { authorityLifetime: LIFETIME, afterSequence },
		response: {
			authorityLifetime: LIFETIME,
			facts: [{ address, sequence: afterSequence + 1, state: 'live', payload }],
			hasMore: false,
		},
	});
}

async function flush(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function appendText(document: RowDocument, value: string): void {
	document.transact(() => {
		const content = document.getText('content');
		content.insert(content.length, value);
	});
}

async function createSharedRecord(a: Fixture, b: Fixture | null) {
	const created = await a.bound.notes.create({ title: 'shared' });
	const address: RecordAddress = {
		namespace: lens.namespace,
		collection: 'notes',
		recordKey: created.id,
	};
	if (b !== null) installLive(b.store, address, { title: 'shared' });
	return { id: created.id, address };
}

test('an open record document converges live between two replicas', async () => {
	const hub = createHub();
	const a = setup(hub);
	const b = setup(hub);
	try {
		const { id, address } = await createSharedRecord(a, b);
		const documentA = expectOk(await a.bound.notes.record(id).document.open());
		const documentB = expectOk(await b.bound.notes.record(id).document.open());
		await flush();
		appendText(documentA, 'hello');
		await flush();

		expect(documentB.getText('content').toString()).toBe('hello');
		expect(hub.text(address)).toBe('hello');
		// The remote install is durable in B's store, not only in B's live doc.
		expect(b.store.exportDocument(address)).toBeDefined();
		// Remote acceptance created no local publication obligation on B.
		expect(b.store.inspectDocument(address)?.owed).toBe(false);

		appendText(documentB, ' world');
		await flush();
		expect(documentA.getText('content').toString()).toBe('hello world');
		expect(hub.text(address)).toBe('hello world');

		await documentA[Symbol.asyncDispose]();
		await documentB[Symbol.asyncDispose]();
	} finally {
		await close(a);
		await close(b);
	}
});

test('reconnect resynchronizes both directions without duplicate application', async () => {
	const hub = createHub();
	const a = setup(hub);
	const b = setup(hub);
	try {
		const { id, address } = await createSharedRecord(a, b);
		const documentA = expectOk(await a.bound.notes.record(id).document.open());
		const documentB = expectOk(await b.bound.notes.record(id).document.open());
		await flush();
		appendText(documentA, 'first.');
		await flush();
		expect(documentB.getText('content').toString()).toBe('first.');

		// Drop every transport, then let both sides write while offline.
		const socketsBefore = hub.openCount;
		hub.dropAddress(address);
		await flush();
		appendText(documentA, 'offline-a.');
		appendText(documentB, 'offline-b.');
		await flush();

		// Both channels reconnect through their backoff schedules.
		a.schedule.runPending();
		b.schedule.runPending();
		await flush();
		a.schedule.runPending();
		b.schedule.runPending();
		await flush();
		expect(hub.openCount).toBeGreaterThan(socketsBefore);

		const textA = documentA.getText('content').toString();
		const textB = documentB.getText('content').toString();
		expect(textA).toBe(textB);
		expect(textA).toContain('first.');
		// Exactly one copy of each offline edit survives reconnection.
		expect(textA.split('offline-a.').length).toBe(2);
		expect(textA.split('offline-b.').length).toBe(2);

		await documentA[Symbol.asyncDispose]();
		await documentB[Symbol.asyncDispose]();
	} finally {
		await close(a);
		await close(b);
	}
});

test('a record-not-live close stops the channel permanently', async () => {
	const hub = createHub();
	const a = setup(hub);
	try {
		const { id, address } = await createSharedRecord(a, null);
		const document = expectOk(await a.bound.notes.record(id).document.open());
		await flush();
		expect(hub.liveSessions(address)).toBe(1);

		hub.closeAddress(address, 'record-not-live');
		await flush();
		expect(a.schedule.pendingCount).toBe(0);
		a.schedule.runPending();
		await flush();
		expect(hub.liveSessions(address)).toBe(0);

		await document[Symbol.asyncDispose]();
	} finally {
		await close(a);
	}
});

test('disposing a document handle closes its channel', async () => {
	const hub = createHub();
	const a = setup(hub);
	try {
		const { id, address } = await createSharedRecord(a, null);
		const document = expectOk(await a.bound.notes.record(id).document.open());
		await flush();
		expect(hub.liveSessions(address)).toBe(1);
		await document[Symbol.asyncDispose]();
		expect(hub.liveSessions(address)).toBe(0);
	} finally {
		await close(a);
	}
});
