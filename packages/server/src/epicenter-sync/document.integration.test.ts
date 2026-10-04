/**
 * Epicenter Row-Document Synchronization Tests
 *
 * Drives the public Document Sync client against the runtime-agnostic server
 * handler over real Bun SQLite authority and local replica stores.
 *
 * Key behaviors:
 * - Two clients converge live and after an offline edit
 * - Scalar deletion closes authority sockets and local revocation stops retry
 * - Compound-bound refusal appends nothing and closes retryably
 * - Presence and upgrade authentication obey the document-v1 wire
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import {
	createEpicenter,
	defineTable,
	openReplica,
	type Replica,
	type RowDocument,
} from '@epicenter/data';
import { batchDigest } from '@epicenter/data/protocol';
import {
	connectRowDocument,
	DOCUMENT_SUBPROTOCOL,
	type DocumentAddress,
	type DocumentClientSocket,
	type DocumentPeer,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/document-sync';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openEpicenterSyncAuthority } from './authority.js';
import {
	createEpicenterDocumentServer,
	type EpicenterDocumentServer,
	type EpicenterDocumentSocket,
	verifyDocumentUpgrade,
} from './document-server.js';

const ADDRESS: DocumentAddress = {
	namespace: 'so.epicenter.test',
	table: 'documents',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const definition = defineTable({
	namespace: ADDRESS.namespace,
	table: ADDRESS.table,
	fields: { title: field.string() },
});

type Local = {
	raw: Database;
	replica: Replica;
	epicenter: ReturnType<typeof createEpicenter>;
	document: RowDocument;
};

async function openLocal(): Promise<Local> {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplica({ database }));
	expectOk(
		replica.write({
			kind: 'create',
			...ADDRESS,
			fields: { title: 'document' },
		}),
	);
	const epicenter = createEpicenter({ replica, database });
	const document = await epicenter
		.bind({ tables: { documents: definition }, values: {} })
		.tables.documents.openDocument(ADDRESS.rowId);
	return { raw, replica, epicenter, document };
}

function openAuthority() {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const scalar = openEpicenterSyncAuthority({ database });
	const changes = [
		{
			kind: 'create' as const,
			...ADDRESS,
			fields: { title: 'document' },
		},
	];
	scalar.exchange({
		replicaId: 'serverseed00000000000000',
		lifetimeId: null,
		after: 0,
		batch: { seq: 1, digest: batchDigest(changes), changes },
	});
	return {
		raw,
		database,
		scalar,
		documents: createEpicenterDocumentServer({ database, clock: () => 123 }),
	};
}

class InProcessClientSocket implements DocumentClientSocket {
	readyState = 1;
	protocol = DOCUMENT_SUBPROTOCOL;
	binaryType = 'arraybuffer';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;

	constructor(
		private readonly server: EpicenterDocumentServer,
		private readonly address: DocumentAddress,
		readonly serverSocket: EpicenterDocumentSocket,
	) {}

	send(data: Uint8Array): void {
		this.server.receive(this.serverSocket, this.address, data);
	}

	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.server.disconnect(this.serverSocket);
		this.onclose?.({ code: 1000, reason: '', wasClean: true });
	}

	serverSend(data: Uint8Array): void {
		this.onmessage?.({ data: new Uint8Array(data) });
	}

	serverClose(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code: 1000, reason: '', wasClean: true });
	}
}

function inProcessOpener(
	server: EpicenterDocumentServer,
	opened: InProcessClientSocket[],
) {
	return async (url: URL, protocols: string[]) => {
		const request = new Request(url, {
			headers: {
				upgrade: 'websocket',
				'sec-websocket-protocol': protocols.join(', '),
			},
		});
		const verified = expectOk(
			await verifyDocumentUpgrade({
				request,
				resolveBearer: (token) =>
					token === 'token' ? 'principal-a' : undefined,
			}),
		);
		expect(server.admit(verified.address)).toBe(true);
		let client: InProcessClientSocket;
		const serverSocket: EpicenterDocumentSocket = {
			send(data) {
				client.serverSend(data);
			},
			close() {
				client.serverClose();
			},
		};
		client = new InProcessClientSocket(server, verified.address, serverSocket);
		opened.push(client);
		return client;
	};
}

function credentials() {
	return { get: () => 'token' };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for document convergence');
}

test('two clients on one row document converge', async () => {
	const authority = openAuthority();
	const first = await openLocal();
	const second = await openLocal();
	const opened: InProcessClientSocket[] = [];
	const openSocket = inProcessOpener(authority.documents, opened);
	const firstConnection = connectRowDocument({
		document: first.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'first',
		openSocket,
	});
	const secondConnection = connectRowDocument({
		document: second.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'second',
		openSocket,
	});
	await Promise.all([
		firstConnection.whenConnected,
		secondConnection.whenConnected,
	]);
	first.document.get('content').insert(0, 'hello');
	await waitFor(() => second.document.get('content').toString() === 'hello');
	expect(first.document.get('content').toString()).toBe('hello');
	firstConnection.dispose();
	secondConnection.dispose();
	await first.document[Symbol.asyncDispose]();
	await second.document[Symbol.asyncDispose]();
	await first.epicenter[Symbol.asyncDispose]();
	await second.epicenter[Symbol.asyncDispose]();
	first.raw.close();
	second.raw.close();
	authority.raw.close();
});

test('offline edit converges through reconnect state-vector exchange', async () => {
	const authority = openAuthority();
	const first = await openLocal();
	const second = await openLocal();
	const opened: InProcessClientSocket[] = [];
	const tasks: Array<() => void> = [];
	const openSocket = inProcessOpener(authority.documents, opened);
	const firstConnection = connectRowDocument({
		document: first.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'first',
		openSocket,
	});
	const secondConnection = connectRowDocument({
		document: second.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'second',
		openSocket,
		schedule(task) {
			tasks.push(task);
			return () => undefined;
		},
	});
	await Promise.all([
		firstConnection.whenConnected,
		secondConnection.whenConnected,
	]);
	opened[1]?.serverClose();
	second.document.get('content').insert(0, 'offline');
	expect(first.document.get('content').toString()).toBe('');
	expect(tasks).toHaveLength(1);
	tasks.shift()?.();
	await waitFor(() => first.document.get('content').toString() === 'offline');
	firstConnection.dispose();
	secondConnection.dispose();
	await first.document[Symbol.asyncDispose]();
	await second.document[Symbol.asyncDispose]();
	await first.epicenter[Symbol.asyncDispose]();
	await second.epicenter[Symbol.asyncDispose]();
	first.raw.close();
	second.raw.close();
	authority.raw.close();
});

test('row deletion closes sockets and local deletion revokes the connector', async () => {
	const authority = openAuthority();
	const local = await openLocal();
	const opened: InProcessClientSocket[] = [];
	const tasks: Array<() => void> = [];
	const connection = connectRowDocument({
		document: local.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'first',
		openSocket: inProcessOpener(authority.documents, opened),
		schedule(task) {
			tasks.push(task);
			return () => undefined;
		},
	});
	await connection.whenConnected;
	const deletion = {
		kind: 'delete' as const,
		...ADDRESS,
	};
	const changes = [deletion];
	authority.scalar.exchange({
		replicaId: 'serverseed00000000000000',
		lifetimeId: null,
		after: 1,
		batch: { seq: 2, digest: batchDigest(changes), changes },
	});
	authority.documents.closeRow(ADDRESS);
	expect(opened[0]?.readyState).toBe(3);
	expect(tasks).toHaveLength(1);
	expectOk(local.replica.write(deletion));
	expect(connection.status).toBe('revoked');
	expect(() => local.document.get('content')).toThrow('no longer live');
	await local.document[Symbol.asyncDispose]();
	await local.epicenter[Symbol.asyncDispose]();
	local.raw.close();
	authority.raw.close();
});

test('over-bound update closes retryably without mutating the update log', () => {
	const authority = openAuthority();
	let closed = false;
	const frames: Uint8Array[] = [];
	const socket: EpicenterDocumentSocket = {
		send: (data) => frames.push(data),
		close: () => {
			closed = true;
		},
	};
	authority.documents.receive(
		socket,
		ADDRESS,
		encodeDocumentFrame({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(new Y.Doc()),
		}),
	);
	expect(frames.map((frame) => decodeDocumentFrame(frame).kind)).toContain(
		'sync-response',
	);
	const before = authority.database.all<{ count: number }>(
		'SELECT COUNT(*) AS count FROM document_updates',
	)[0]?.count;
	const oversized = new Y.Doc();
	oversized.get('content').insert(0, 'x'.repeat(1_048_577));
	authority.documents.receive(
		socket,
		ADDRESS,
		encodeDocumentFrame({
			kind: 'update',
			update: Y.encodeStateAsUpdateV2(oversized),
		}),
	);
	expect(closed).toBe(true);
	expect(
		authority.database.all<{ count: number }>(
			'SELECT COUNT(*) AS count FROM document_updates',
		)[0]?.count,
	).toBe(before);
	oversized.destroy();
	authority.raw.close();
});

test('presence publishes the other peer for the same row address', async () => {
	const authority = openAuthority();
	const first = await openLocal();
	const second = await openLocal();
	const opened: InProcessClientSocket[] = [];
	const openSocket = inProcessOpener(authority.documents, opened);
	const firstConnection = connectRowDocument({
		document: first.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'first',
		openSocket,
	});
	const seen: DocumentPeer[][] = [];
	firstConnection.subscribePresence((peers) => seen.push([...peers]));
	const secondConnection = connectRowDocument({
		document: second.document,
		baseUrl: 'https://example.com/',
		credentials: credentials(),
		nodeId: 'second',
		agentId: 'resident',
		openSocket,
	});
	await Promise.all([
		firstConnection.whenConnected,
		secondConnection.whenConnected,
	]);
	await waitFor(() =>
		seen.some((peers) => peers.some((peer) => peer.nodeId === 'second')),
	);
	expect(seen.at(-1)).toContainEqual({
		nodeId: 'second',
		connectedAt: 123,
		agentId: 'resident',
	});
	firstConnection.dispose();
	secondConnection.dispose();
	await first.document[Symbol.asyncDispose]();
	await second.document[Symbol.asyncDispose]();
	await first.epicenter[Symbol.asyncDispose]();
	await second.epicenter[Symbol.asyncDispose]();
	first.raw.close();
	second.raw.close();
	authority.raw.close();
});

test('wrong document subprotocol or missing bearer is refused at upgrade', async () => {
	const wrong = await verifyDocumentUpgrade({
		request: new Request(
			`https://example.com/api/sync/v1/documents/${ADDRESS.namespace}/${ADDRESS.table}/${ADDRESS.rowId}`,
			{
				headers: {
					upgrade: 'websocket',
					'sec-websocket-protocol': 'epicenter-document-v2, bearer.token',
				},
			},
		),
		resolveBearer: () => 'principal-a',
	});
	expect(expectErr(wrong).name).toBe('InvalidSubprotocol');
	const missing = await verifyDocumentUpgrade({
		request: new Request(
			`https://example.com/api/sync/v1/documents/${ADDRESS.namespace}/${ADDRESS.table}/${ADDRESS.rowId}`,
			{
				headers: {
					upgrade: 'websocket',
					'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL,
				},
			},
		),
		resolveBearer: () => 'principal-a',
	});
	expect(expectErr(missing).name).toBe('InvalidSubprotocol');
});
