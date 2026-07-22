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

test('record connector uses the V3 address and stops after a document bound', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'record-document-sync-'));
	const epicenter = await openBunRecordEpicenter({ directory });
	try {
		const notes = epicenter.bind({ test: lens }).test.notes;
		const row = await notes.create({ title: 'Connected' });
		const document = await notes.openDocument(row.id);
		const socket = new FakeSocket();
		let openedUrl: URL | undefined;
		let openedProtocols: string[] | undefined;
		const connection = connectRecordDocument({
			document,
			baseUrl: 'https://example.com/base',
			authorityLifetime: 'authority-one',
			credentials: { get: () => 'secret-token' },
			openSocket(url, protocols) {
				openedUrl = url;
				openedProtocols = protocols;
				return socket;
			},
			schedule() {
				throw new Error('terminal refusal must not schedule a retry');
			},
		});
		await Promise.resolve();

		expect(openedUrl?.pathname).toBe(
			`/api/sync/v1/records/so.epicenter.documenttest/notes/${row.id}/document`,
		);
		expect(openedUrl?.searchParams.get('authorityLifetime')).toBe(
			'authority-one',
		);
		expect(openedProtocols).toEqual([
			DOCUMENT_SUBPROTOCOL,
			'bearer.secret-token',
		]);
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
					await epicenter.inspectRecord({
						namespace: lens.namespace,
						collection: 'notes',
						recordKey: row.id,
					})
				).document?.dirty,
			).toBe(false);

			document.transact(() => {
				const content = document.get('content', 'text') as unknown as {
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
		} finally {
			authority.destroy();
			connection.dispose();
			await document[Symbol.asyncDispose]();
		}
	} finally {
		await epicenter[Symbol.asyncDispose]();
		await rm(directory, { recursive: true });
	}
});
