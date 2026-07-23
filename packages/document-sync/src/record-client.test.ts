/**
 * Record Document Connector Tests
 *
 * Verifies record-scoped Document V3 connection ownership across authority
 * lifetime discovery, replacement, authentication boundaries, and refusal.
 *
 * Key behaviors:
 * - A document remains local until an authority lifetime is known
 * - Lifetime replacement reconnects without reviving terminal connections
 * - Auth-owned and direct raw-bearer socket paths keep credentials isolated
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBunRecordEpicenter } from '@epicenter/data/bun';
import { defineLens, defineTable } from '@epicenter/data/record';
import { field } from '@epicenter/field';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

import {
	connectRecordDocument,
	type RecordAuthorityLifetimeProvider,
	type RecordDocumentClientSocket,
} from './record-client.js';

const lens = defineLens({
	namespace: 'so.epicenter.documenttest',
	title: 'Document test',
	description: 'Record document connector test.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

class FakeSocket implements RecordDocumentClientSocket {
	readyState = 1;
	protocol = DOCUMENT_SUBPROTOCOL;
	binaryType = '';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;
	readonly sent: Uint8Array[] = [];

	send(data: Uint8Array): void {
		this.sent.push(new Uint8Array(data));
	}

	close(code = 1000, reason = ''): void {
		this.readyState = 3;
		this.onclose?.({ code, reason, wasClean: true });
	}

	receive(data: Uint8Array): void {
		this.onmessage?.({ data });
	}
}

function createLifetimeProvider(initial?: string) {
	let lifetime = initial;
	const listeners = new Set<() => void>();
	const provider: RecordAuthorityLifetimeProvider = {
		get: () => lifetime,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		provider,
		set(next: string | undefined) {
			lifetime = next;
			for (const listener of listeners) listener();
		},
	};
}

async function openTestDocument() {
	const directory = await mkdtemp(join(tmpdir(), 'record-document-sync-'));
	const epicenter = await openBunRecordEpicenter({ directory });
	const notes = epicenter.bind({ test: lens }).test.notes;
	const row = await notes.create({ title: 'Connected' });
	const document = await notes.openDocument(row.id);
	return {
		document,
		epicenter,
		row,
		async dispose() {
			await document[Symbol.asyncDispose]();
			await epicenter[Symbol.asyncDispose]();
			await rm(directory, { recursive: true });
		},
	};
}

test('record connector uses the V3 address and stops after a document bound', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider('authority-one');
	let connection: ReturnType<typeof connectRecordDocument> | undefined;
	try {
		const socket = new FakeSocket();
		let openedUrl: URL | undefined;
		let socketOpenCount = 0;
		connection = connectRecordDocument({
			document: opened.document,
			baseUrl: 'https://example.com/base',
			authorityLifetime: lifetime.provider,
			openSocket(url) {
				socketOpenCount += 1;
				openedUrl = url;
				return socket;
			},
			schedule() {
				throw new Error('terminal refusal must not schedule a retry');
			},
		});
		await Promise.resolve();

		expect(openedUrl?.pathname).toBe(
			`/api/sync/v1/records/so.epicenter.documenttest/notes/${opened.row.id}/document`,
		);
		expect(openedUrl?.searchParams.get('authorityLifetime')).toBe(
			'authority-one',
		);
		expect(decodeDocumentFrame(socket.sent[0] ?? new Uint8Array()).kind).toBe(
			'sync-request',
		);

		const authority = new Y.Doc();
		try {
			(
				authority.get('content', 'text') as unknown as {
					insert(index: number, text: string): void;
				}
			).insert(0, 'remote');
			socket.receive(
				encodeDocumentFrame({
					kind: 'sync-request',
					stateVector: Y.encodeStateVector(authority),
				}),
			);
			socket.receive(
				encodeDocumentFrame({
					kind: 'sync-response',
					update: Y.encodeStateAsUpdateV2(authority),
				}),
			);
			await connection.whenConnected;
			expect(connection.status).toBe('connected');
			expect(
				(
					await opened.epicenter.inspectRecord({
						namespace: lens.namespace,
						collection: 'notes',
						recordKey: opened.row.id,
					})
				).document?.owed,
			).toBe(false);

			opened.document.transact(() => {
				const content = opened.document.get('content', 'text') as unknown as {
					insert(index: number, text: string): void;
				};
				content.insert(0, 'local');
			});
			expect(
				socket.sent.some(
					(encoded) => decodeDocumentFrame(encoded).kind === 'update',
				),
			).toBe(true);

			socket.close(DOCUMENT_BACKSTOP_CLOSE_CODE, 'document-bound');
			expect(connection.status).toBe('refused');
			lifetime.set('authority-two');
			await Promise.resolve();
			expect(socketOpenCount).toBe(1);
			expect(connection.status).toBe('refused');
		} finally {
			authority.destroy();
		}
	} finally {
		connection?.dispose();
		await opened.dispose();
	}
});

test('record connector opens no socket before learning an authority lifetime', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider();
	let socketOpenCount = 0;
	const connection = connectRecordDocument({
		document: opened.document,
		baseUrl: 'https://example.com',
		authorityLifetime: lifetime.provider,
		openSocket() {
			socketOpenCount += 1;
			return new FakeSocket();
		},
	});
	try {
		await Promise.resolve();
		expect(socketOpenCount).toBe(0);
		expect(connection.status).toBe('offline');
	} finally {
		connection.dispose();
		await opened.dispose();
	}
});

test('record connector connects when the authority lifetime appears', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider();
	let openedUrl: URL | undefined;
	const connection = connectRecordDocument({
		document: opened.document,
		baseUrl: 'https://example.com',
		authorityLifetime: lifetime.provider,
		openSocket(url) {
			openedUrl = url;
			return new FakeSocket();
		},
	});
	try {
		lifetime.set('authority-one');
		await Promise.resolve();
		expect(openedUrl?.searchParams.get('authorityLifetime')).toBe(
			'authority-one',
		);
	} finally {
		connection.dispose();
		await opened.dispose();
	}
});

test('record connector replaces the socket when the authority lifetime changes', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider('authority-one');
	const sockets: FakeSocket[] = [];
	const openedLifetimes: string[] = [];
	const connection = connectRecordDocument({
		document: opened.document,
		baseUrl: 'https://example.com',
		authorityLifetime: lifetime.provider,
		openSocket(url) {
			openedLifetimes.push(
				url.searchParams.get('authorityLifetime') ?? 'missing',
			);
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	try {
		await Promise.resolve();
		lifetime.set('authority-one');
		await Promise.resolve();
		expect(openedLifetimes).toEqual(['authority-one']);
		lifetime.set('authority-two');
		await Promise.resolve();
		expect(openedLifetimes).toEqual(['authority-one', 'authority-two']);
		expect(sockets[0]?.readyState).toBe(3);
		expect(sockets[1]?.readyState).toBe(1);
	} finally {
		connection.dispose();
		await opened.dispose();
	}
});

test('revoked record connection remains terminal after a lifetime change', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider('authority-one');
	const sockets: FakeSocket[] = [];
	const connection = connectRecordDocument({
		document: opened.document,
		baseUrl: 'https://example.com',
		authorityLifetime: lifetime.provider,
		openSocket() {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	});
	try {
		await Promise.resolve();
		sockets[0]?.close(4404, 'record-not-live');
		expect(connection.status).toBe('revoked');
		lifetime.set('authority-two');
		await Promise.resolve();
		expect(sockets).toHaveLength(1);
		expect(connection.status).toBe('revoked');
	} finally {
		connection.dispose();
		await opened.dispose();
	}
});

test('auth-owned socket opener receives only the document protocol', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider('authority-one');
	let openedProtocols: string[] | undefined;
	const connection = connectRecordDocument({
		document: opened.document,
		baseUrl: 'https://example.com',
		authorityLifetime: lifetime.provider,
		credentials: { get: () => 'availability-only' },
		openSocket(_url, protocols) {
			openedProtocols = protocols;
			return new FakeSocket();
		},
	});
	try {
		await Promise.resolve();
		expect(openedProtocols).toEqual([DOCUMENT_SUBPROTOCOL]);
	} finally {
		connection.dispose();
		await opened.dispose();
	}
});

test('default socket opener carries the direct caller raw bearer', async () => {
	const opened = await openTestDocument();
	const lifetime = createLifetimeProvider('authority-one');
	const originalWebSocket = Object.getOwnPropertyDescriptor(
		globalThis,
		'WebSocket',
	);
	let openedProtocols: string | string[] | undefined;
	class CapturingWebSocket extends FakeSocket {
		constructor(_url: string | URL, protocols?: string | string[]) {
			super();
			openedProtocols = protocols;
		}
	}
	Object.defineProperty(globalThis, 'WebSocket', {
		configurable: true,
		writable: true,
		value: CapturingWebSocket,
	});
	let connection: ReturnType<typeof connectRecordDocument> | undefined;
	try {
		connection = connectRecordDocument({
			document: opened.document,
			baseUrl: 'https://example.com',
			authorityLifetime: lifetime.provider,
			credentials: { get: () => 'secret-token' },
		});
		await Promise.resolve();
		expect(openedProtocols).toEqual([
			DOCUMENT_SUBPROTOCOL,
			'bearer.secret-token',
		]);
	} finally {
		connection?.dispose();
		if (originalWebSocket === undefined) {
			Reflect.deleteProperty(globalThis, 'WebSocket');
		} else {
			Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
		}
		await opened.dispose();
	}
});
