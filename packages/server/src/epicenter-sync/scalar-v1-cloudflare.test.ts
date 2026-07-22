import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { beforeAll, expect, mock, test } from 'bun:test';

import { BLOB_PUBLICATION_VERSION } from '@epicenter/data/blob-v1';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import type { PortableArtifactRecord } from '@epicenter/data/portable';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	sha256Hex,
} from '@epicenter/data/protocol/v1';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { encodeDocumentFrame } from '@epicenter/sync/document-v3';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
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

function setupBackupEnv({
	deferAppend = false,
	loseSealResponse = false,
}: {
	deferAppend?: boolean;
	loseSealResponse?: boolean;
} = {}) {
	const objects = new Map<string, Uint8Array>();
	const records: PortableArtifactRecord[] = [];
	const backupNames: string[] = [];
	let expectedRecordCount: number | undefined;
	let backupState: 'empty' | 'building' | 'sealed' = 'empty';
	let destroyed = false;
	let releaseAppend = () => {};
	const appendRelease = new Promise<void>((resolve) => {
		releaseAppend = resolve;
	});
	let announceAppend = () => {};
	const appendStarted = new Promise<void>((resolve) => {
		announceAppend = resolve;
	});
	let appendDeferred = deferAppend;
	let currentBackupPrefix: string | undefined;

	async function metadata(key: string): Promise<R2Object | null> {
		const bytes = objects.get(key);
		if (bytes === undefined) return null;
		return {
			key,
			checksums: {
				sha256: await crypto.subtle.digest(
					'SHA-256',
					Uint8Array.from(bytes).buffer,
				),
			},
		} as unknown as R2Object;
	}

	const bucket = {
		async put(key: string, value: unknown, options?: R2PutOptions) {
			const bytes = new Uint8Array(
				await new Response(value as BodyInit).arrayBuffer(),
			);
			if (typeof options?.sha256 === 'string') {
				const actual = bytesToHex(sha256(bytes));
				if (actual !== options.sha256) return null;
			}
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
				body: new Blob([Uint8Array.from(bytes).buffer]).stream(),
			} as R2ObjectBody;
		},
		async delete(targets: string | string[]) {
			for (const key of Array.isArray(targets) ? targets : [targets]) {
				objects.delete(key);
			}
		},
		async list({ prefix, cursor }: R2ListOptions = {}) {
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(prefix ?? ''))
				.sort();
			const start = cursor === undefined ? 0 : Number(cursor);
			const page = keys.slice(start, start + 2);
			return {
				objects: await Promise.all(
					page.map(async (key) => {
						const object = await metadata(key);
						if (object === null) throw new Error('R2 object disappeared');
						return object;
					}),
				),
				truncated: start + page.length < keys.length,
				cursor: String(start + page.length),
			};
		},
	};

	const backup = {
		async initialize(expected: number) {
			expectedRecordCount = expected;
			backupState = 'building';
			if (currentBackupPrefix === undefined) {
				throw new Error('Backup stub identity is missing');
			}
			objects.set(
				`${currentBackupPrefix}control/state-v1.json`,
				new TextEncoder().encode('building'),
			);
		},
		async append(rawRecords: unknown) {
			if (appendDeferred) {
				appendDeferred = false;
				announceAppend();
				await appendRelease;
			}
			const page = structuredClone(rawRecords) as PortableArtifactRecord[];
			records.push(...page);
			return page.length;
		},
		async seal() {
			if (records.length !== expectedRecordCount) {
				throw new Error('Backup record membership is incomplete');
			}
			backupState = 'sealed';
			if (currentBackupPrefix !== undefined) {
				objects.set(
					`${currentBackupPrefix}control/state-v1.json`,
					new TextEncoder().encode('sealed'),
				);
			}
			if (loseSealResponse) throw new Error('lost sealed RPC response');
			return {
				version: 1 as const,
				state: 'sealed' as const,
				recordCount: records.length,
			};
		},
		async status() {
			if (backupState === 'empty') return { state: 'empty' as const };
			if (backupState === 'building') {
				return {
					state: 'building' as const,
					expectedRecordCount: expectedRecordCount ?? 0,
				};
			}
			return { state: 'sealed' as const, recordCount: records.length };
		},
		async destroy() {
			destroyed = true;
			backupState = 'empty';
			records.length = 0;
			if (currentBackupPrefix !== undefined) {
				for (const key of [...objects.keys()]) {
					if (key.startsWith(currentBackupPrefix)) objects.delete(key);
				}
			}
		},
	};

	const env = {
		DATA_BLOBS: bucket,
		DATA_BACKUP: {
			getByName(name: string) {
				backupNames.push(name);
				const backupId = name.slice(name.lastIndexOf(':') + 1);
				currentBackupPrefix = `data-authorities/data-authority-test/backups/${backupId}/`;
				return backup;
			},
		},
	} as unknown as ConstructorParameters<typeof DataAuthority>[1];

	return {
		env,
		objects,
		records,
		backupNames,
		appendStarted,
		releaseAppend,
		backupState: () => backupState,
		destroyed: () => destroyed,
	};
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

// ============================================================================
// Cloudflare Backup capture
// ============================================================================

test('Backup capture copies the complete logical record and pinned blob cut', async () => {
	const owned = setupState();
	try {
		const backups = setupBackupEnv();
		const authority = new DataAuthority(owned.state, backups.env);
		await owned.ready();
		const lifetime = expectOk(
			await authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const documented = {
			namespace: 'so.epicenter.notes',
			collection: 'records',
			recordKey: 'a'.repeat(24),
		};
		const blobbed = { ...documented, recordKey: 'b'.repeat(24) };
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'r'.repeat(24),
							submissionNumber: 1,
							intents: [
								{ address: documented, op: 'replace', value: { title: 'one' } },
								{ address: blobbed, op: 'replace', value: { title: 'two' } },
							],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		const document = new Y.Doc({ gc: true });
		document.get('content').insert(0, 'captured document');
		const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		document.destroy();
		expect(
			(
				await authority.acceptDocument({
					authorityLifetime: lifetime,
					address: documented,
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					payload: update,
					digest: documentPayloadDigest(update),
				})
			).kind,
		).toBe('accepted');
		const blob = 'captured blob bytes';
		const blobDigest = sha256Hex(blob);
		expect(
			(
				await authority.acceptBlob(
					{
						authorityLifetime: lifetime,
						address: blobbed,
						protocolVersion: BLOB_PUBLICATION_VERSION,
						digest: blobDigest,
					},
					new Blob([blob]).stream(),
				)
			).kind,
		).toBe('accepted');

		const backupId = 'c'.repeat(24);
		expect(await authority.captureBackup(backupId)).toEqual({ recordCount: 2 });
		expect(backups.backupState()).toBe('sealed');
		expect(backups.records).toHaveLength(2);
		expect(backups.records[0]).toMatchObject({
			address: documented,
			scalar: { state: 'live', payload: { title: 'one' } },
			blobSha256: null,
		});
		expect(backups.records[0]?.documentUpdateV2).toEqual(update);
		expect(backups.records[1]).toMatchObject({
			address: blobbed,
			scalar: { state: 'live', payload: { title: 'two' } },
			documentUpdateV2: null,
			blobSha256: blobDigest,
		});
		const backupBlobKey = [...backups.objects.keys()].find((key) =>
			key.includes(`/backups/${backupId}/blobs/content/`),
		);
		expect(backupBlobKey).toBeDefined();
		expect(
			new TextDecoder().decode(backups.objects.get(backupBlobKey ?? '')),
		).toBe(blob);
		expect(
			owned.database
				.query(`SELECT state FROM capture_manifests WHERE capture_id = ?`)
				.get(backupId),
		).toEqual({ state: 'succeeded' });
	} finally {
		owned.database.close();
	}
});

test('Backup capture refuses corrupt pinned blob bytes and publishes nothing', async () => {
	const owned = setupState();
	try {
		const backups = setupBackupEnv();
		const authority = new DataAuthority(owned.state, backups.env);
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
			recordKey: 'a'.repeat(24),
		};
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'r'.repeat(24),
							submissionNumber: 1,
							intents: [{ address, op: 'replace', value: {} }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		const digest = sha256Hex('original');
		expect(
			(
				await authority.acceptBlob(
					{
						authorityLifetime: lifetime,
						address,
						protocolVersion: BLOB_PUBLICATION_VERSION,
						digest,
					},
					new Blob(['original']).stream(),
				)
			).kind,
		).toBe('accepted');
		const liveBlobKey = [...backups.objects.keys()].find(
			(key) => key.includes('/authorities/') && key.includes('/blobs/content/'),
		);
		if (liveBlobKey === undefined) throw new Error('live blob was not stored');
		backups.objects.set(liveBlobKey, new TextEncoder().encode('corrupt'));

		const backupId = 'd'.repeat(24);
		await expect(authority.captureBackup(backupId)).rejects.toThrow(
			'failed digest verification',
		);
		expect(backups.backupState()).toBe('empty');
		expect(backups.destroyed()).toBe(true);
		expect(
			[...backups.objects.keys()].some((key) =>
				key.includes(`/backups/${backupId}/`),
			),
		).toBe(false);
		expect(
			owned.database
				.query(`SELECT state FROM capture_manifests WHERE capture_id = ?`)
				.get(backupId),
		).toEqual({ state: 'cancelled' });
	} finally {
		owned.database.close();
	}
});

test('account deletion fences new Backups and drains an admitted capture', async () => {
	const owned = setupState();
	try {
		const backups = setupBackupEnv({ deferAppend: true });
		const authority = new DataAuthority(owned.state, backups.env);
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
			recordKey: 'a'.repeat(24),
		};
		expectOk(
			await authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'r'.repeat(24),
							submissionNumber: 1,
							intents: [{ address, op: 'replace', value: 'captured' }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);

		const firstBackupId = 'e'.repeat(24);
		const capture = authority.captureBackup(firstBackupId);
		await backups.appendStarted;
		let deleted = false;
		const deletion = authority.deleteAccount().then(() => {
			deleted = true;
		});
		await expect(authority.captureBackup('f'.repeat(24))).rejects.toThrow(
			'Backups are being deleted',
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(deleted).toBe(false);
		expect(owned.storageDeleted()).toBe(false);
		expect(backups.backupNames).toHaveLength(1);

		backups.releaseAppend();
		expect(await capture).toEqual({ recordCount: 1 });
		await deletion;
		expect(owned.storageDeleted()).toBe(true);
		expect([...backups.objects.keys()]).toEqual([]);
	} finally {
		owned.database.close();
	}
});

test('Backup capture reconciles a sealed result whose RPC response was lost', async () => {
	const owned = setupState();
	try {
		const backups = setupBackupEnv({ loseSealResponse: true });
		const authority = new DataAuthority(owned.state, backups.env);
		await owned.ready();
		const backupId = 'g'.repeat(24);
		expect(await authority.captureBackup(backupId)).toEqual({ recordCount: 0 });
		expect(backups.backupState()).toBe('sealed');
		expect(backups.destroyed()).toBe(false);
		expect(
			owned.database
				.query(`SELECT state FROM capture_manifests WHERE capture_id = ?`)
				.get(backupId),
		).toEqual({ state: 'succeeded' });
	} finally {
		owned.database.close();
	}
});

test('Backup capture refuses every non-canonical Backup ID before allocating storage', async () => {
	const owned = setupState();
	try {
		const backups = setupBackupEnv();
		const authority = new DataAuthority(owned.state, backups.env);
		await owned.ready();
		await expect(authority.captureBackup('short')).rejects.toThrow(
			'24 lowercase alphanumeric characters',
		);
		await expect(authority.captureBackup('A'.repeat(24))).rejects.toThrow(
			'24 lowercase alphanumeric characters',
		);
		await expect(authority.captureBackup(7)).rejects.toThrow(
			'backup ID must be a string',
		);
		expect(backups.backupNames).toEqual([]);
	} finally {
		owned.database.close();
	}
});
