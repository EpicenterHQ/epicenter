/**
 * Cloudflare Backup Registry V1 Tests
 *
 * Verifies publication, uncertain capture recovery, independent deletion, and
 * the durable account-deletion fence owned by the per-principal registry DO.
 *
 * Key behaviors:
 * - Only sealed DataBackup objects become visible
 * - Startup reconciles durable building entries after hibernation
 * - Account deletion destroys every Backup before sweeping the exact R2 owner
 * - Unrecognized registry schema and control state fail closed
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { beforeAll, expect, mock, test } from 'bun:test';

import { asPrincipalId } from '@epicenter/identity';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

mock.module('cloudflare:workers', () => ({
	DurableObject: class<Env> {
		protected ctx: DurableObjectState;
		protected env: Env;

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx;
			this.env = env;
		}
	},
	WorkerEntrypoint: class {},
}));

let DataBackupRegistry: typeof import('./cloudflare-backup-registry-v1.js').DataBackupRegistry;
let createDataBackupRegistryAccountAuthorities: typeof import('./cloudflare-backup-registry-v1.js').createDataBackupRegistryAccountAuthorities;
let locateDataBackupRegistryV1: typeof import('./cloudflare-backup-registry-v1.js').locateDataBackupRegistryV1;

beforeAll(async () => {
	({
		DataBackupRegistry,
		createDataBackupRegistryAccountAuthorities,
		locateDataBackupRegistryV1,
	} = await import('./cloudflare-backup-registry-v1.js'));
});

const PRINCIPAL_NAME = 'principal%40example.com';
const OWNER_STORAGE_KEY = 'authority-storage-key';
const RESTORE_REQUEST_ID = 'r'.repeat(24);
const UPLOAD_REQUEST_ID = 'u'.repeat(24);

async function streamBytes(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const reader = stream.getReader();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		chunks.push(chunk.value);
		byteLength += chunk.value.byteLength;
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function byteStream(value: string): ReadableStream<Uint8Array> {
	return new Blob([value]).stream();
}

function digestOf(value: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(value)));
}

type BackupStatus =
	| { state: 'empty' }
	| { state: 'building'; expectedRecordCount: number }
	| { state: 'sealed'; recordCount: number };

function backupIdFromName(name: string): string {
	const backupId = name.split(':').at(-1);
	if (backupId === undefined) throw new Error('missing test Backup identity');
	return backupId;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function setupState({
	capture = async (backupId: string) => {
		statuses.set(backupId, { state: 'sealed', recordCount: 0 });
		return { recordCount: 0 };
	},
	currentAuthorityLifetime = async () => 'outgoing-lifetime',
	destroy,
	downloadBackup = async (input: {
		ownerStorageKey: string;
		backupId: string;
	}) => new Response(`${input.ownerStorageKey}:${input.backupId}`),
	materialize,
	raw = new Database(':memory:', { strict: true }),
	r2PutFailure,
	restoreBackup = async (_backupId: string, successorLifetime: string) => ({
		authorityLifetime: successorLifetime,
		recordCount: 0,
	}),
	statuses = new Map<string, BackupStatus>(),
}: {
	capture?: (backupId: string) => Promise<{ recordCount: number }>;
	currentAuthorityLifetime?: () => Promise<string>;
	destroy?: (backupId: string) => Promise<void>;
	downloadBackup?: (input: {
		ownerStorageKey: string;
		backupId: string;
	}) => Promise<Response>;
	materialize?: (input: {
		ownerStorageKey: string;
		backupId: string;
		bytes: ReadableStream<Uint8Array>;
	}) => Promise<{ recordCount: number } | { invalidPortableBackup: true }>;
	raw?: Database;
	r2PutFailure?: Error;
	restoreBackup?: (
		backupId: string,
		successorLifetime: string,
	) => Promise<{ authorityLifetime: string; recordCount: number }>;
	statuses?: Map<string, BackupStatus>;
} = {}) {
	const destroyed: string[] = [];
	const backupNames: string[] = [];
	const r2Keys = new Set<string>();
	const r2Objects = new Map<string, { bytes: Uint8Array; sha256: string }>();
	const deletedR2Keys: string[] = [];
	const materializations: Array<{ backupId: string; bytes: Uint8Array }> = [];
	let insideConcurrencyBlock = false;
	const storage = {
		sql: {
			exec<TRow extends SqliteRow>(query: string, ...bindings: SqliteValue[]) {
				const statement = raw.query(query);
				if (/^\s*(SELECT|WITH|PRAGMA)\b/iu.test(query)) {
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
			return raw.transaction(run).immediate();
		},
	} as unknown as DurableObjectStorage;
	const state = {
		id: {
			name: PRINCIPAL_NAME,
			toString: () => 'registry-storage-key',
		},
		storage,
		async blockConcurrencyWhile<TResult>(run: () => Promise<TResult>) {
			insideConcurrencyBlock = true;
			try {
				return await run();
			} finally {
				insideConcurrencyBlock = false;
			}
		},
	} as unknown as DurableObjectState;
	const env = {
		DATA_AUTHORITY: {
			idFromName(name: string) {
				expect(name).toBe(PRINCIPAL_NAME);
				return {
					name,
					toString: () => OWNER_STORAGE_KEY,
				} as unknown as DurableObjectId;
			},
			get() {
				return {
					captureBackup: capture,
					currentAuthorityLifetime,
					restoreBackup,
				};
			},
		},
		DATA_BACKUP: {
			getByName(name: string) {
				backupNames.push(name);
				const backupId = backupIdFromName(name);
				return {
					async status() {
						return statuses.get(backupId) ?? { state: 'empty' as const };
					},
					async destroy() {
						await destroy?.(backupId);
						destroyed.push(backupId);
						statuses.set(backupId, { state: 'empty' });
					},
				};
			},
		},
		DATA_BLOBS: {
			async list({ prefix }: { prefix?: string }) {
				return {
					objects: [...r2Keys]
						.filter((key) => key.startsWith(prefix ?? ''))
						.map((key) => ({ key })),
					truncated: false,
				};
			},
			async delete(keys: string | string[]) {
				for (const key of typeof keys === 'string' ? [keys] : keys) {
					r2Keys.delete(key);
					r2Objects.delete(key);
					deletedR2Keys.push(key);
				}
			},
			async put(
				key: string,
				body: ReadableStream<Uint8Array>,
				options?: { sha256?: string },
			) {
				if (r2PutFailure !== undefined) throw r2PutFailure;
				const bytes = await streamBytes(body);
				const digest = bytesToHex(sha256(bytes));
				if (options?.sha256 !== undefined && options.sha256 !== digest) {
					return null;
				}
				r2Keys.add(key);
				r2Objects.set(key, { bytes, sha256: digest });
				return {
					key,
					size: bytes.byteLength,
					checksums: { sha256: Uint8Array.from(sha256(bytes)).buffer },
				} as R2Object;
			},
			async head(key: string) {
				const object = r2Objects.get(key);
				return object === undefined
					? null
					: ({
							key,
							size: object.bytes.byteLength,
							checksums: {
								sha256: Uint8Array.from(sha256(object.bytes)).buffer,
							},
						} as R2Object);
			},
			async get(key: string) {
				const object = r2Objects.get(key);
				return object === undefined
					? null
					: ({
							key,
							size: object.bytes.byteLength,
							checksums: {
								sha256: Uint8Array.from(sha256(object.bytes)).buffer,
							},
							body: new Blob([new Uint8Array(object.bytes)]).stream(),
						} as R2ObjectBody);
			},
		},
		PORTABLE_MATERIALIZER: {
			getByName() {
				return {
					downloadBackup,
					async materializeUpload(input: {
						ownerStorageKey: string;
						backupId: string;
						bytes: ReadableStream<Uint8Array>;
					}) {
						if (materialize !== undefined) return materialize(input);
						const bytes = await streamBytes(input.bytes);
						materializations.push({ backupId: input.backupId, bytes });
						statuses.set(input.backupId, {
							state: 'sealed',
							recordCount: 0,
						});
						return { recordCount: 0 };
					},
				};
			},
		},
	} as unknown as ConstructorParameters<typeof DataBackupRegistry>[1];
	return {
		raw,
		state,
		env,
		statuses,
		destroyed,
		backupNames,
		r2Keys,
		r2Objects,
		deletedR2Keys,
		materializations,
		get insideConcurrencyBlock() {
			return insideConcurrencyBlock;
		},
	};
}

test('uncertain capture publishes the already sealed DataBackup', async () => {
	const statuses = new Map<string, BackupStatus>();
	const owned = setupState({
		statuses,
		async capture(backupId) {
			statuses.set(backupId, { state: 'sealed', recordCount: 7 });
			throw new Error('RPC response was lost');
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const created = await registry.create();
		expect(created.recordCount).toBe(7);
		expect(created.backupId).toHaveLength(24);
		expect(await registry.list()).toEqual([created]);
		expect(owned.destroyed).toEqual([]);
	} finally {
		owned.raw.close();
	}
});

test('failed incomplete capture destroys unpublished storage', async () => {
	const statuses = new Map<string, BackupStatus>();
	let attemptedId = '';
	const owned = setupState({
		statuses,
		async capture(backupId) {
			attemptedId = backupId;
			statuses.set(backupId, {
				state: 'building',
				expectedRecordCount: 2,
			});
			throw new Error('capture failed');
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		await expect(registry.create()).rejects.toThrow('capture failed');
		expect(owned.destroyed).toEqual([attemptedId]);
		expect(await registry.list()).toEqual([]);
		expect(
			owned.raw.query('SELECT * FROM backup_registry_entries').all(),
		).toEqual([]);
	} finally {
		owned.raw.close();
	}
});

test('deleting one sealed Backup leaves its sibling published', async () => {
	const statuses = new Map<string, BackupStatus>();
	let count = 0;
	const owned = setupState({
		statuses,
		async capture(backupId) {
			count += 1;
			statuses.set(backupId, { state: 'sealed', recordCount: count });
			return { recordCount: count };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const first = await registry.create();
		const second = await registry.create();
		expect(await registry.delete(first.backupId)).toBe(true);
		expect(await registry.delete(first.backupId)).toBe(false);
		expect(await registry.list()).toEqual([second]);
		expect(owned.destroyed).toEqual([first.backupId]);
	} finally {
		owned.raw.close();
	}
});

test('download materializes only a published sealed Backup', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const downloaded = await registry.download(backup.backupId);
		expect(downloaded).toBeDefined();
		expect(await downloaded?.text()).toBe(
			`authority-storage-key:${backup.backupId}`,
		);
		expect(await registry.download('m'.repeat(24))).toBeUndefined();
	} finally {
		owned.raw.close();
	}
});

test('deletion cancels an admitted portable download before erasing its Backup', async () => {
	const admitted = deferred<void>();
	const release = deferred<void>();
	const owned = setupState({
		async downloadBackup() {
			return new Response(
				new ReadableStream<Uint8Array>({
					start() {
						admitted.resolve();
					},
					async pull(controller) {
						await release.promise;
						controller.enqueue(new TextEncoder().encode('complete'));
						controller.close();
					},
				}),
			);
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const response = await registry.download(backup.backupId);
		const downloaded = response?.text();
		await admitted.promise;
		expect(await registry.delete(backup.backupId)).toBe(true);
		expect(await downloaded).not.toBe('complete');
		expect(owned.destroyed).toEqual([backup.backupId]);
	} finally {
		owned.raw.close();
	}
});

test('account deletion cancels every admitted portable download', async () => {
	const admitted = deferred<void>();
	const owned = setupState({
		async downloadBackup() {
			return new Response(
				new ReadableStream<Uint8Array>({
					start() {
						admitted.resolve();
					},
					pull() {
						return new Promise(() => undefined);
					},
				}),
			);
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const response = await registry.download(backup.backupId);
		const downloaded = response?.text();
		await admitted.promise;

		await registry.deleteAccount();
		expect(await downloaded).not.toBe('complete');
		expect(owned.destroyed).toContain(backup.backupId);
	} finally {
		owned.raw.close();
	}
});

test('Restore selects one sealed Backup without consuming it', async () => {
	let restoredId = '';
	const owned = setupState({
		async restoreBackup(backupId, successorLifetime) {
			restoredId = backupId;
			return { authorityLifetime: successorLifetime, recordCount: 0 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const restored = await registry.restore(
			backup.backupId,
			RESTORE_REQUEST_ID,
		);

		expect(restored).toMatchObject({
			kind: 'restored',
			recordCount: 0,
		});
		expect(
			restored.kind === 'restored' ? restored.authorityLifetime : undefined,
		).toMatch(/^[0-9a-f-]{36}$/u);
		expect(restoredId).toBe(backup.backupId);
		expect(await registry.list()).toEqual([backup]);
		expect(await registry.restore('c'.repeat(24), 's'.repeat(24))).toEqual({
			kind: 'backup-not-found',
		});
	} finally {
		owned.raw.close();
	}
});

test('concurrent Restore reports in progress while retaining its Backup lease', async () => {
	const started = deferred<{ backupId: string; successorLifetime: string }>();
	const release = deferred<void>();
	const owned = setupState({
		async restoreBackup(backupId, successorLifetime) {
			started.resolve({ backupId, successorLifetime });
			await release.promise;
			return { authorityLifetime: successorLifetime, recordCount: 0 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const first = registry.restore(backup.backupId, RESTORE_REQUEST_ID);
		const active = await started.promise;

		expect(await registry.restore(backup.backupId, RESTORE_REQUEST_ID)).toEqual(
			{
				kind: 'restore-in-progress',
			},
		);
		expect(active.backupId).toBe(backup.backupId);
		release.resolve();
		expect(await first).toEqual({
			kind: 'restored',
			authorityLifetime: active.successorLifetime,
			recordCount: 0,
		});
	} finally {
		owned.raw.close();
	}
});

test('Restore reconciles an activated authority whose RPC response was lost', async () => {
	let activeLifetime = 'outgoing-lifetime';
	const owned = setupState({
		currentAuthorityLifetime: async () => activeLifetime,
		async restoreBackup(_backupId, successorLifetime) {
			activeLifetime = successorLifetime;
			throw new Error('lost Restore RPC response');
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();

		expect(await registry.restore(backup.backupId, RESTORE_REQUEST_ID)).toEqual(
			{
				kind: 'restored',
				authorityLifetime: activeLifetime,
				recordCount: 0,
			},
		);
	} finally {
		owned.raw.close();
	}
});

test('Restore retry survives registry restart without minting another lifetime', async () => {
	let activeLifetime = 'outgoing-lifetime';
	let restoreCalls = 0;
	const owned = setupState({
		currentAuthorityLifetime: async () => activeLifetime,
		async restoreBackup(_backupId, successorLifetime) {
			restoreCalls += 1;
			activeLifetime = successorLifetime;
			return { authorityLifetime: successorLifetime, recordCount: 0 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		const first = await registry.restore(backup.backupId, RESTORE_REQUEST_ID);
		if (first.kind !== 'restored')
			throw new Error('test Restore did not finish');

		expect(await registry.restore(backup.backupId, RESTORE_REQUEST_ID)).toEqual(
			first,
		);
		expect(restoreCalls).toBe(1);

		// Model eviction after authority activation but before registry publication.
		owned.raw.exec(
			`UPDATE backup_registry_restores SET state = 'building'
			WHERE request_id = '${RESTORE_REQUEST_ID}'`,
		);
		const reopened = new DataBackupRegistry(owned.state, owned.env);
		expect(await reopened.restore(backup.backupId, RESTORE_REQUEST_ID)).toEqual(
			first,
		);
		expect(restoreCalls).toBe(1);
		expect(activeLifetime).toBe(first.authorityLifetime);
	} finally {
		owned.raw.close();
	}
});

test('Restore request ID cannot be reused for another Backup', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const first = await registry.create();
		const second = await registry.create();
		expect(
			(await registry.restore(first.backupId, RESTORE_REQUEST_ID)).kind,
		).toBe('restored');
		expect(await registry.restore(second.backupId, RESTORE_REQUEST_ID)).toEqual(
			{
				kind: 'idempotency-conflict',
			},
		);
	} finally {
		owned.raw.close();
	}
});

test('definitive Restore failure releases the durable active slot', async () => {
	let attempts = 0;
	const owned = setupState({
		async restoreBackup(_backupId, successorLifetime) {
			attempts += 1;
			if (attempts === 1) throw new Error('portable Backup is corrupt');
			return { authorityLifetime: successorLifetime, recordCount: 0 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		await expect(
			registry.restore(backup.backupId, RESTORE_REQUEST_ID),
		).rejects.toThrow('portable Backup is corrupt');
		expect(
			owned.raw
				.query(
					`SELECT * FROM backup_registry_restores WHERE state = 'building'`,
				)
				.all(),
		).toEqual([]);
		expect(
			(await registry.restore(backup.backupId, RESTORE_REQUEST_ID)).kind,
		).toBe('restored');
	} finally {
		owned.raw.close();
	}
});

test('portable upload creation is durable and validates its request ID', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const first = await registry.createUpload(UPLOAD_REQUEST_ID);
		expect(first).toMatchObject({
			requestId: UPLOAD_REQUEST_ID,
			state: 'uploading',
		});
		expect(first.backupId).toHaveLength(24);
		expect(await registry.createUpload(UPLOAD_REQUEST_ID)).toEqual(first);
		expect(() => registry.createUpload('short')).toThrow(
			'24 lowercase alphanumeric',
		);
	} finally {
		owned.raw.close();
	}
});

test('portable upload parts are immutable and verify R2 size and checksum', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			5,
			digestOf('first'),
			byteStream('first'),
		);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			5,
			digestOf('first'),
			byteStream('unused retry'),
		);
		expect(
			await registry.putUploadPart(
				UPLOAD_REQUEST_ID,
				1,
				6,
				digestOf('second'),
				byteStream('second'),
			),
		).toEqual({ kind: 'upload-conflict' });
		expect(
			await registry.putUploadPart(
				UPLOAD_REQUEST_ID,
				2,
				4,
				digestOf('wrong'),
				byteStream('bytes'),
			),
		).toEqual({ kind: 'invalid-upload-part' });
		expect(
			owned.raw
				.query('SELECT part_number FROM backup_registry_upload_parts')
				.all(),
		).toEqual([{ part_number: 1 }]);
		expect(() =>
			registry.putUploadPart(
				UPLOAD_REQUEST_ID,
				513,
				1,
				digestOf('x'),
				byteStream('x'),
			),
		).toThrow('between 1 and 512');
	} finally {
		owned.raw.close();
	}
});

test('portable upload classifies only R2 BadDigest as invalid client bytes', async () => {
	for (const [message, expected] of [
		[
			'put: Provided checksum does not match the uploaded content. (10037)',
			'invalid',
		],
		['put: Service is temporarily unavailable. (10043)', 'throw'],
	] as const) {
		const owned = setupState({ r2PutFailure: new Error(message) });
		try {
			const registry = new DataBackupRegistry(owned.state, owned.env);
			await registry.createUpload(UPLOAD_REQUEST_ID);
			const stored = registry.putUploadPart(
				UPLOAD_REQUEST_ID,
				1,
				5,
				digestOf('first'),
				byteStream('first'),
			);
			if (expected === 'invalid') {
				expect(await stored).toEqual({ kind: 'invalid-upload-part' });
			} else {
				await expect(stored).rejects.toThrow('(10043)');
			}
		} finally {
			owned.raw.close();
		}
	}
});

test('portable upload cleanup sweeps a part written before its SQL ledger row', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		await registry.createUpload(UPLOAD_REQUEST_ID);
		const orphan = `data-authorities/${OWNER_STORAGE_KEY}/portable-uploads/${UPLOAD_REQUEST_ID}/parts/001`;
		owned.r2Keys.add(orphan);

		expect(await registry.deleteUpload(UPLOAD_REQUEST_ID)).toBe(true);
		expect(owned.r2Keys.has(orphan)).toBe(false);
		expect(owned.deletedR2Keys).toContain(orphan);
	} finally {
		owned.raw.close();
	}
});

test('portable upload concatenates contiguous parts and publishes once', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const upload = await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			3,
			digestOf('one'),
			byteStream('one'),
		);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			2,
			3,
			digestOf('two'),
			byteStream('two'),
		);
		expect(await registry.completeUpload(UPLOAD_REQUEST_ID, [1, 3])).toEqual({
			kind: 'invalid-upload-completion',
		});

		const completed = await registry.completeUpload(UPLOAD_REQUEST_ID, [1, 2]);
		expect(completed).toEqual({
			kind: 'completed',
			backup: { backupId: upload.backupId, recordCount: 0 },
		});
		expect(new TextDecoder().decode(owned.materializations[0]?.bytes)).toBe(
			'onetwo',
		);
		expect(await registry.list()).toEqual([
			{ backupId: upload.backupId, recordCount: 0 },
		]);
		expect(
			owned.raw.query('SELECT * FROM backup_registry_upload_parts').all(),
		).toEqual([]);
		expect(await registry.completeUpload(UPLOAD_REQUEST_ID, [1, 2])).toEqual(
			completed,
		);
		expect(owned.materializations).toHaveLength(1);
	} finally {
		owned.raw.close();
	}
});

test('partial portable materialization resets to uploaded and retries without re-upload', async () => {
	const statuses = new Map<string, BackupStatus>();
	let attempts = 0;
	const owned = setupState({
		statuses,
		async materialize(input) {
			await streamBytes(input.bytes);
			attempts += 1;
			if (attempts === 1) {
				statuses.set(input.backupId, {
					state: 'building',
					expectedRecordCount: 2,
				});
				throw new Error('materializer crashed');
			}
			statuses.set(input.backupId, { state: 'sealed', recordCount: 2 });
			return { recordCount: 2 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const upload = await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			5,
			digestOf('bytes'),
			byteStream('bytes'),
		);
		await expect(
			registry.completeUpload(UPLOAD_REQUEST_ID, [1]),
		).rejects.toThrow('materializer crashed');
		expect(await registry.createUpload(UPLOAD_REQUEST_ID)).toEqual({
			...upload,
			state: 'uploaded',
		});
		expect(owned.destroyed).toEqual([upload.backupId]);
		expect(
			await registry.putUploadPart(
				UPLOAD_REQUEST_ID,
				2,
				1,
				digestOf('x'),
				byteStream('x'),
			),
		).toEqual({ kind: 'upload-conflict' });

		expect(await registry.completeUpload(UPLOAD_REQUEST_ID, [1])).toEqual({
			kind: 'completed',
			backup: { backupId: upload.backupId, recordCount: 2 },
		});
		expect(attempts).toBe(2);
	} finally {
		owned.raw.close();
	}
});

test('invalid portable bytes return a stable result and remain resettable', async () => {
	const owned = setupState({
		async materialize(input) {
			await streamBytes(input.bytes);
			return { invalidPortableBackup: true };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const upload = await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			7,
			digestOf('invalid'),
			byteStream('invalid'),
		);

		expect(await registry.completeUpload(UPLOAD_REQUEST_ID, [1])).toEqual({
			kind: 'invalid-portable-backup',
		});
		expect(await registry.createUpload(UPLOAD_REQUEST_ID)).toEqual({
			...upload,
			state: 'uploaded',
		});
		expect(await registry.deleteUpload(UPLOAD_REQUEST_ID)).toBe(true);
	} finally {
		owned.raw.close();
	}
});

test('sealed portable materialization publishes after a lost response and restart', async () => {
	const statuses = new Map<string, BackupStatus>();
	let calls = 0;
	const owned = setupState({
		statuses,
		async materialize(input) {
			await streamBytes(input.bytes);
			calls += 1;
			statuses.set(input.backupId, { state: 'sealed', recordCount: 4 });
			throw new Error('materializer response was lost');
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const upload = await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			4,
			digestOf('data'),
			byteStream('data'),
		);
		const completed = await registry.completeUpload(UPLOAD_REQUEST_ID, [1]);
		expect(completed).toEqual({
			kind: 'completed',
			backup: { backupId: upload.backupId, recordCount: 4 },
		});
		expect(calls).toBe(1);

		owned.raw
			.query(
				`UPDATE backup_registry_uploads
				SET state = 'materializing', record_count = NULL WHERE request_id = ?`,
			)
			.run(UPLOAD_REQUEST_ID);
		const reopened = new DataBackupRegistry(owned.state, owned.env);
		expect(await reopened.list()).toEqual([
			{ backupId: upload.backupId, recordCount: 4 },
		]);
		expect(await reopened.completeUpload(UPLOAD_REQUEST_ID, [1])).toEqual(
			completed,
		);
		expect(calls).toBe(1);
	} finally {
		owned.raw.close();
	}
});

test('startup destroys a partial portable materialization but keeps its upload parts', async () => {
	const statuses = new Map<string, BackupStatus>();
	const owned = setupState({ statuses });
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const upload = await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			5,
			digestOf('bytes'),
			byteStream('bytes'),
		);
		owned.raw
			.query(
				`UPDATE backup_registry_uploads
				SET state = 'materializing', part_count = 1
				WHERE request_id = ?`,
			)
			.run(UPLOAD_REQUEST_ID);
		statuses.set(upload.backupId, {
			state: 'building',
			expectedRecordCount: 1,
		});

		const reopened = new DataBackupRegistry(owned.state, owned.env);
		expect(await reopened.createUpload(UPLOAD_REQUEST_ID)).toEqual({
			...upload,
			state: 'uploaded',
		});
		expect(owned.destroyed).toEqual([upload.backupId]);
		expect(
			owned.raw
				.query('SELECT part_number FROM backup_registry_upload_parts')
				.all(),
		).toEqual([{ part_number: 1 }]);
	} finally {
		owned.raw.close();
	}
});

test('account deletion fences portable upload publication and erases staged owners', async () => {
	const started = deferred<{ backupId: string }>();
	const release = deferred<void>();
	const statuses = new Map<string, BackupStatus>();
	const owned = setupState({
		statuses,
		async materialize(input) {
			await streamBytes(input.bytes);
			started.resolve({ backupId: input.backupId });
			await release.promise;
			statuses.set(input.backupId, { state: 'sealed', recordCount: 1 });
			return { recordCount: 1 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		await registry.createUpload(UPLOAD_REQUEST_ID);
		await registry.putUploadPart(
			UPLOAD_REQUEST_ID,
			1,
			1,
			digestOf('x'),
			byteStream('x'),
		);
		const completion = registry.completeUpload(UPLOAD_REQUEST_ID, [1]);
		const active = await started.promise;
		const deletion = registry.deleteAccount();
		release.resolve();
		await expect(completion).rejects.toThrow('being deleted');
		await deletion;
		expect(owned.destroyed).toContain(active.backupId);
		expect(
			owned.raw.query('SELECT * FROM backup_registry_uploads').all(),
		).toEqual([]);
		expect(
			[...owned.r2Keys].filter((key) => key.includes(UPLOAD_REQUEST_ID)),
		).toEqual([]);
	} finally {
		owned.raw.close();
	}
});

test('account deletion destroys all SQL owners then sweeps the exact R2 owner', async () => {
	const owned = setupState();
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const first = await registry.create();
		const second = await registry.create();
		const ownerPrefix = `data-authorities/${OWNER_STORAGE_KEY}/`;
		owned.r2Keys.add(`${ownerPrefix}backups/${first.backupId}/state`);
		owned.r2Keys.add(`${ownerPrefix}backups/${second.backupId}/blob`);
		owned.r2Keys.add('data-authorities/another-owner/keep');

		await registry.deleteAccount();

		expect(
			owned.backupNames.every((name) =>
				name.startsWith(`backup-v1:${OWNER_STORAGE_KEY}:`),
			),
		).toBe(true);
		expect(owned.destroyed.sort()).toEqual(
			[first.backupId, second.backupId].sort(),
		);
		expect(owned.deletedR2Keys.sort()).toEqual(
			[
				`${ownerPrefix}backups/${first.backupId}/state`,
				`${ownerPrefix}backups/${second.backupId}/blob`,
			].sort(),
		);
		expect(owned.r2Keys).toEqual(
			new Set(['data-authorities/another-owner/keep']),
		);
		expect(() => registry.create()).toThrow('being deleted');

		const reopened = new DataBackupRegistry(owned.state, owned.env);
		await reopened.deleteAccount();
		expect(() => reopened.list()).toThrow('being deleted');
	} finally {
		owned.raw.close();
	}
});

test('account deletion immediately fences work queued behind an active create', async () => {
	const captureStarted = deferred<string>();
	const captureFinished = deferred<void>();
	const statuses = new Map<string, BackupStatus>();
	const owned = setupState({
		statuses,
		async capture(backupId) {
			captureStarted.resolve(backupId);
			await captureFinished.promise;
			statuses.set(backupId, { state: 'sealed', recordCount: 1 });
			return { recordCount: 1 };
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const creation = registry.create();
		const backupId = await captureStarted.promise;
		const deletion = registry.deleteAccount();
		expect(() => registry.create()).toThrow('being deleted');
		captureFinished.resolve();
		expect(await creation).toEqual({ backupId, recordCount: 1 });
		await deletion;
		expect(owned.destroyed).toEqual([backupId]);
	} finally {
		owned.raw.close();
	}
});

test('startup publishes sealed builds and destroys incomplete builds', async () => {
	const statuses = new Map<string, BackupStatus>();
	const owned = setupState({ statuses });
	try {
		const first = new DataBackupRegistry(owned.state, owned.env);
		expect(await first.list()).toEqual([]);
		const sealedId = 'a'.repeat(24);
		const incompleteId = 'b'.repeat(24);
		owned.raw
			.query(
				`INSERT INTO backup_registry_entries
				(backup_id, state, record_count) VALUES (?, 'building', NULL)`,
			)
			.run(sealedId);
		owned.raw
			.query(
				`INSERT INTO backup_registry_entries
				(backup_id, state, record_count) VALUES (?, 'building', NULL)`,
			)
			.run(incompleteId);
		statuses.set(sealedId, { state: 'sealed', recordCount: 9 });
		statuses.set(incompleteId, {
			state: 'building',
			expectedRecordCount: 10,
		});

		const reopened = new DataBackupRegistry(owned.state, owned.env);
		expect(await reopened.list()).toEqual([
			{ backupId: sealedId, recordCount: 9 },
		]);
		expect(owned.destroyed).toEqual([incompleteId]);
	} finally {
		owned.raw.close();
	}
});

test('uncertain selected deletion stays hidden and resumes on startup', async () => {
	let destroyAttempts = 0;
	const owned = setupState({
		async destroy() {
			destroyAttempts += 1;
			if (destroyAttempts <= 2) {
				throw new Error('uncertain DataBackup deletion');
			}
		},
	});
	try {
		const registry = new DataBackupRegistry(owned.state, owned.env);
		const backup = await registry.create();
		await expect(registry.delete(backup.backupId)).rejects.toThrow(
			'uncertain DataBackup deletion',
		);
		expect(await registry.list()).toEqual([]);

		const reopened = new DataBackupRegistry(owned.state, owned.env);
		expect(await reopened.list()).toEqual([]);
		expect(destroyAttempts).toBe(3);
		expect(owned.destroyed).toEqual([backup.backupId]);
	} finally {
		owned.raw.close();
	}
});

test('account deletion retries a transient startup cleanup failure', async () => {
	let failDestroy = true;
	let owned: ReturnType<typeof setupState>;
	owned = setupState({
		async destroy() {
			expect(owned.insideConcurrencyBlock).toBe(false);
			if (failDestroy) {
				failDestroy = false;
				throw new Error('transient DataBackup failure');
			}
		},
	});
	try {
		const first = new DataBackupRegistry(owned.state, owned.env);
		const backup = await first.create();
		owned.raw.exec(
			'UPDATE backup_registry_control SET deleting = 1 WHERE singleton = 1',
		);

		const reopened = new DataBackupRegistry(owned.state, owned.env);
		await reopened.deleteAccount();

		expect(owned.destroyed).toEqual([backup.backupId]);
		expect(
			owned.raw.query('SELECT * FROM backup_registry_entries').all(),
		).toEqual([]);
		expect(() => reopened.create()).toThrow('being deleted');
	} finally {
		owned.raw.close();
	}
});

test('account deletion resolves the same principal-owned registry', async () => {
	const names: string[] = [];
	let deleted = false;
	const authorities = createDataBackupRegistryAccountAuthorities({
		getByName(name) {
			names.push(name);
			return {
				deleteAccount: async () => {
					deleted = true;
				},
			};
		},
	});

	await authorities
		.authority(asPrincipalId('alice@example.com'))
		.deleteAccount();

	expect(names).toEqual(['alice%40example%2Ecom']);
	expect(deleted).toBe(true);
});

test('registry lookup keeps percent-sensitive principal names distinct', () => {
	const names: string[] = [];
	const namespace = {
		getByName(name: string) {
			names.push(name);
			return {
				create: async () => ({ backupId: 'a'.repeat(24), recordCount: 0 }),
				list: async () => [],
				download: async () => undefined,
				delete: async () => false,
				restore: async () => ({ kind: 'backup-not-found' as const }),
				createUpload: async () => ({
					requestId: UPLOAD_REQUEST_ID,
					backupId: 'a'.repeat(24),
					state: 'uploading' as const,
				}),
				putUploadPart: async () => ({ kind: 'stored' as const }),
				completeUpload: async () => ({
					kind: 'completed' as const,
					backup: { backupId: 'a'.repeat(24), recordCount: 0 },
				}),
				deleteUpload: async () => false,
			};
		},
	};

	locateDataBackupRegistryV1(namespace, asPrincipalId('alice@example.com'));
	locateDataBackupRegistryV1(namespace, asPrincipalId('alice@example%2Ecom'));

	expect(names).toEqual(['alice%40example%2Ecom', 'alice%40example%252Ecom']);
});

test('unrecognized schema and control state fail closed', async () => {
	const malformedSchema = setupState();
	try {
		malformedSchema.raw.exec('CREATE TABLE unexpected (value TEXT) STRICT');
		const registry = new DataBackupRegistry(
			malformedSchema.state,
			malformedSchema.env,
		);
		await expect(registry.list()).rejects.toThrow('schema is not recognized');
	} finally {
		malformedSchema.raw.close();
	}

	const malformedControl = setupState();
	try {
		const first = new DataBackupRegistry(
			malformedControl.state,
			malformedControl.env,
		);
		expect(await first.list()).toEqual([]);
		malformedControl.raw.exec(
			'DELETE FROM backup_registry_control WHERE singleton = 1',
		);
		const reopened = new DataBackupRegistry(
			malformedControl.state,
			malformedControl.env,
		);
		await expect(reopened.list()).rejects.toThrow('control is not recognized');
	} finally {
		malformedControl.raw.close();
	}
});
