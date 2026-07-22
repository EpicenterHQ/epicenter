import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { beforeAll, expect, mock, test } from 'bun:test';

import { BLOB_PUBLICATION_VERSION } from '@epicenter/data/blob-v1';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	sha256Hex,
} from '@epicenter/data/protocol/v1';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { encodeDocumentFrame } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

mock.module('cloudflare:workers', () => ({
	DurableObject: class<Env> {
		protected ctx: DurableObjectState;
		protected env: Env;

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

let DataAuthority: typeof import('./scalar-v1-cloudflare.js').DataAuthority;

beforeAll(async () => {
	({ DataAuthority } = await import('./scalar-v1-cloudflare.js'));
});

function setupEnv(): ConstructorParameters<typeof DataAuthority>[1] {
	return {
		DATA_BLOBS: {
			list: async () => ({ objects: [], truncated: false }),
		},
	} as unknown as ConstructorParameters<typeof DataAuthority>[1];
}

function setupTrackedEnv(initialKeys: readonly string[]) {
	const keys = new Set(initialKeys);
	const env = {
		DATA_BLOBS: {
			async list({ prefix }: R2ListOptions = {}) {
				return {
					objects: [...keys]
						.filter((key) => key.startsWith(prefix ?? ''))
						.map((key) => ({ key })),
					truncated: false,
				};
			},
			async delete(targets: string | string[]) {
				for (const key of Array.isArray(targets) ? targets : [targets]) {
					keys.delete(key);
				}
			},
		},
	} as unknown as ConstructorParameters<typeof DataAuthority>[1];
	return { env, keys };
}

function setupDeferredPutEnv() {
	const objects = new Map<string, Uint8Array>();
	const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
		Uint8Array.from(bytes).buffer;
	let releasePut = () => {};
	const putRelease = new Promise<void>((resolve) => {
		releasePut = resolve;
	});
	let announcePut = () => {};
	const putStarted = new Promise<void>((resolve) => {
		announcePut = resolve;
	});
	let deferNextPut = true;

	async function metadata(key: string): Promise<R2Object | null> {
		const bytes = objects.get(key);
		if (bytes === undefined) return null;
		return {
			key,
			checksums: {
				sha256: await crypto.subtle.digest('SHA-256', bufferOf(bytes)),
			},
		} as unknown as R2Object;
	}

	const env = {
		DATA_BLOBS: {
			async put(key: string, value: unknown) {
				if (deferNextPut) {
					deferNextPut = false;
					announcePut();
					await putRelease;
				}
				const bytes = new Uint8Array(
					await new Response(value as BodyInit).arrayBuffer(),
				);
				objects.set(key, bytes);
				return metadata(key);
			},
			head: metadata,
			async get(key: string) {
				const object = await metadata(key);
				const bytes = objects.get(key);
				if (object === null || bytes === undefined) return null;
				return {
					...object,
					body: new Blob([bufferOf(bytes)]).stream(),
				} as R2ObjectBody;
			},
			async delete(targets: string | string[]) {
				for (const key of Array.isArray(targets) ? targets : [targets]) {
					objects.delete(key);
				}
			},
			async list({ prefix }: R2ListOptions = {}) {
				return {
					objects: await Promise.all(
						[...objects.keys()]
							.filter((key) => key.startsWith(prefix ?? ''))
							.map(async (key) => {
								const object = await metadata(key);
								if (object === null) throw new Error('R2 object disappeared');
								return object;
							}),
					),
					truncated: false,
				};
			},
		},
	} as unknown as ConstructorParameters<typeof DataAuthority>[1];

	return { env, objects, putStarted, releasePut };
}

function setupState() {
	const database = new Database(':memory:', { strict: true });
	let ready = Promise.resolve();
	let storageDeleted = false;
	let alarm: number | null = null;
	const sockets: WebSocket[] = [];
	const storage = {
		sql: {
			exec<TRow extends SqliteRow>(query: string, ...bindings: SqliteValue[]) {
				const statement = database.query(query);
				if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
					return {
						toArray: () =>
							statement.all(...(bindings as SQLQueryBindings[])) as TRow[],
					};
				}
				statement.run(...(bindings as SQLQueryBindings[]));
				return { toArray: () => [] as TRow[] };
			},
		},
		transactionSync<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
		async deleteAll() {
			storageDeleted = true;
			database.exec(`
				DROP TABLE IF EXISTS capture_manifest_records;
				DROP TABLE IF EXISTS capture_manifests;
				DROP TABLE IF EXISTS replica_witness;
				DROP TABLE IF EXISTS record_documents;
				DROP TABLE IF EXISTS records;
				DROP TABLE IF EXISTS meta;
			`);
		},
		getAlarm: async () => alarm,
		setAlarm: async (value: number) => {
			alarm = value;
		},
		deleteAlarm: async () => {
			alarm = null;
		},
	};
	const state = {
		id: { toString: () => 'data-authority-test' },
		storage,
		getWebSockets: () => sockets,
		acceptWebSocket(socket: WebSocket) {
			sockets.push(socket);
		},
		blockConcurrencyWhile(run: () => Promise<void>) {
			ready = run();
			return ready;
		},
	} as unknown as DurableObjectState;
	return {
		database,
		state,
		sockets,
		ready: () => ready,
		storageDeleted: () => storageDeleted,
	};
}

function fakeSocket(attachment: unknown) {
	const sent: Uint8Array[] = [];
	const closes: { code?: number; reason?: string }[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		deserializeAttachment: () => attachment,
		serializeAttachment() {},
		send(data: ArrayBuffer | Uint8Array) {
			sent.push(new Uint8Array(data));
		},
		close(code?: number, reason?: string) {
			closes.push({ code, reason });
		},
	} as unknown as WebSocket;
	return { socket, sent, closes };
}

test('Durable Object authority persists acceptance and retry state across restart', async () => {
	const owned = setupState();
	try {
		let authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const request = expectOk(
			parseSubmissionRequest(
				{
					authorityLifetime: lifetime,
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					submissionNumber: 1,
					intents: [
						{
							address: {
								namespace: 'so.epicenter.notes',
								collection: 'recordings',
								recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
							},
							op: 'replace',
							value: 'persisted',
						},
					],
				},
				SCALAR_SYNC_V1_LIMITS,
			),
		);
		const accepted = expectOk(await authority.submit(request));
		expect(accepted.facts[0]).toMatchObject({
			sequence: 1,
			state: 'live',
			payload: 'persisted',
		});
		const document = new Y.Doc({ gc: true });
		document.get('content').insert(0, 'durable document');
		const payload = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		document.destroy();
		const publication = {
			authorityLifetime: lifetime,
			address:
				request.intents[0]?.address ??
				(() => {
					throw new Error('missing intent');
				})(),
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload,
			digest: documentPayloadDigest(payload),
		};
		expect((await authority.acceptDocument(publication)).kind).toBe('accepted');

		authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		expect(expectOk(await authority.submit(request))).toEqual(accepted);
		expect((await authority.acceptDocument(publication)).kind).toBe('accepted');
	} finally {
		owned.database.close();
	}
});

test('Durable Object hibernation restores document sessions from attachments', async () => {
	const owned = setupState();
	try {
		let authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const address = {
			namespace: 'so.epicenter.notes',
			collection: 'records',
			recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		};
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
							submissionNumber: 1,
							intents: [{ address, op: 'replace', value: {} }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		const attachment = {
			version: 1,
			protocol: DOCUMENT_PUBLICATION_VERSION,
			address,
			authorityLifetime: lifetime,
			authorizationExpiresAt: Date.now() + 60_000,
		};
		const first = fakeSocket(attachment);
		const second = fakeSocket(attachment);
		owned.sockets.push(first.socket, second.socket);

		authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		const document = new Y.Doc({ gc: true });
		document.get('content').insert(0, 'after wake');
		const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		document.destroy();
		const frame = encodeDocumentFrame({ kind: 'update', update });
		await authority.webSocketMessage(
			first.socket,
			frame.buffer.slice(
				frame.byteOffset,
				frame.byteOffset + frame.byteLength,
			) as ArrayBuffer,
		);
		expect(second.sent).toHaveLength(1);
		expect(first.sent).toHaveLength(0);
		expect(first.closes).toEqual([]);
	} finally {
		owned.database.close();
	}
});

test('Durable Object RPC boundary revalidates structured input', async () => {
	const owned = setupState();
	try {
		const authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		await expect(authority.readFacts({ afterSequence: '0' })).rejects.toThrow(
			'invalid scalar V1 facts RPC request',
		);
		await expect(authority.submit({})).rejects.toThrow(
			'invalid scalar V1 submission RPC request',
		);
		await expect(authority.acceptDocument({})).rejects.toThrow(
			'invalid document V1 publication RPC request',
		);
		await expect(authority.acceptBlob({}, undefined as never)).rejects.toThrow(
			'invalid blob V1 publication RPC request',
		);
	} finally {
		owned.database.close();
	}
});

test('account deletion reopens an empty successor lifetime', async () => {
	const owned = setupState();
	try {
		const authority = new DataAuthority(owned.state, setupEnv());
		await owned.ready();
		const before = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		await authority.deleteAccount();
		const after = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		);
		expect(after.authorityLifetime).not.toBe(before);
		expect(after.facts).toEqual([]);
	} finally {
		owned.database.close();
	}
});

test('account deletion drains an admitted blob upload before deleting every owner byte', async () => {
	const owned = setupState();
	try {
		const blobs = setupDeferredPutEnv();
		const authority = new DataAuthority(owned.state, blobs.env);
		await owned.ready();
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const address = {
			namespace: 'so.epicenter.notes',
			collection: 'assets',
			recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		};
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
							submissionNumber: 1,
							intents: [{ address, op: 'replace', value: {} }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);

		const value = 'upload racing account deletion';
		const acceptance = authority.acceptBlob(
			{
				authorityLifetime: lifetime,
				address,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: sha256Hex(value),
			},
			new Blob([value]).stream(),
		);
		await blobs.putStarted;
		let deleted = false;
		const deletion = authority.deleteAccount().then(() => {
			deleted = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(deleted).toBe(false);
		expect(owned.storageDeleted()).toBe(false);

		blobs.releasePut();
		expect((await acceptance).kind).toBe('accepted');
		await deletion;
		expect(owned.storageDeleted()).toBe(true);
		expect([...blobs.objects.keys()]).toEqual([]);
	} finally {
		owned.database.close();
	}
});

test('account deletion recovers an authority whose stored schema is malformed', async () => {
	const owned = setupState();
	try {
		const blobs = setupTrackedEnv([
			'data-authorities/data-authority-test/authorities/lifetime-one/blobs/staging/orphan',
			'data-authorities/data-authority-test/authorities/lifetime-one/blobs/content/owner/digest',
			'data-authorities/data-authority-test/authorities/lifetime-two/blobs/content/owner/digest',
			'data-authorities/data-authority-test-sibling/authorities/lifetime-one/blobs/content/owner/digest',
		]);
		owned.database.exec('CREATE TABLE records (wrong TEXT) STRICT');
		const authority = new DataAuthority(owned.state, blobs.env);
		await owned.ready();
		await expect(
			authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).rejects.toThrow('schema does not match');

		await authority.deleteAccount();
		expect([...blobs.keys]).toEqual([
			'data-authorities/data-authority-test-sibling/authorities/lifetime-one/blobs/content/owner/digest',
		]);
		expect(
			expectOk(
				await authority.readFacts(
					expectOk(
						parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
					),
				),
			).facts,
		).toEqual([]);
	} finally {
		owned.database.close();
	}
});
