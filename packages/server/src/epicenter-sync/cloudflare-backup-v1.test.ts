import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { beforeAll, expect, mock, test } from 'bun:test';

import type { PortableArtifactRecord } from '@epicenter/data/portable';
import { sha256Hex } from '@epicenter/data/protocol/v1';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { sha256 } from '@noble/hashes/sha2.js';

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

let DataBackup: typeof import('./cloudflare-backup-v1.js').DataBackup;
let dataBackupV1Name: typeof import('./cloudflare-backup-v1.js').dataBackupV1Name;

beforeAll(async () => {
	({ DataBackup, dataBackupV1Name } = await import(
		'./cloudflare-backup-v1.js'
	));
});

const BACKUP_ID = 'z'.repeat(24);
const STATE_KEY = `data-authorities/owner-one/backups/${BACKUP_ID}/control/state-v1.json`;

const FIRST: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	scalar: { state: 'live', payload: { title: 'First' } },
	documentUpdateV2: null,
	blobSha256: null,
};

const SECOND: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	},
	scalar: { state: 'unset' },
	documentUpdateV2: null,
	blobSha256: null,
};

function setupState() {
	const raw = new Database(':memory:', { strict: true });
	const objects = new Map<string, string | Uint8Array>();
	function r2Object(key: string, bytes: Uint8Array): R2Object {
		return {
			key,
			checksums: { sha256: Uint8Array.from(sha256(bytes)).buffer },
		} as R2Object;
	}
	const storage = {
		sql: {
			exec<TRow extends SqliteRow>(query: string, ...bindings: SqliteValue[]) {
				const statement = raw.query(query);
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
		kv: {
			get() {
				throw new Error('portable Backup storage must not use DO KV');
			},
			put() {
				throw new Error('portable Backup storage must not use DO KV');
			},
			delete() {
				throw new Error('portable Backup storage must not use DO KV');
			},
			list() {
				throw new Error('portable Backup storage must not use DO KV');
			},
		},
		transactionSync<TResult>(run: () => TResult): TResult {
			return raw.transaction(run).immediate();
		},
		async deleteAll() {
			for (const row of raw
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_schema
					WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
				)
				.all()) {
				raw.exec(`DROP TABLE "${row.name.replaceAll('"', '""')}"`);
			}
		},
	} as unknown as DurableObjectStorage;
	const state = {
		id: {
			name: dataBackupV1Name('owner-one', BACKUP_ID),
			toString: () => 'data-backup-test',
		},
		storage,
	} as unknown as DurableObjectState;
	const env = {
		DATA_BLOBS: {
			async head(key: string) {
				const value = objects.get(key);
				return value instanceof Uint8Array ? r2Object(key, value) : null;
			},
			async get(key: string) {
				const value = objects.get(key);
				return value === undefined
					? null
					: typeof value === 'string'
						? ({ json: async () => JSON.parse(value) } as R2ObjectBody)
						: ({
								...r2Object(key, value),
								body: new Blob([Uint8Array.from(value).buffer]).stream(),
							} as R2ObjectBody);
			},
			async put(key: string, value: string | ReadableStream<Uint8Array>) {
				if (typeof value === 'string') {
					objects.set(key, value);
					return {} as R2Object;
				}
				const bytes = new Uint8Array(await new Response(value).arrayBuffer());
				objects.set(key, bytes);
				return r2Object(key, bytes);
			},
			async list({ prefix }: R2ListOptions = {}) {
				return {
					objects: [...objects.keys()]
						.filter((key) => key.startsWith(prefix ?? ''))
						.map((key) => {
							const value = objects.get(key);
							return value instanceof Uint8Array
								? r2Object(key, value)
								: ({ key } as R2Object);
						}),
					truncated: false,
				};
			},
			async delete(target: string | string[]) {
				for (const key of Array.isArray(target) ? target : [target]) {
					objects.delete(key);
				}
			},
		},
	} as unknown as ConstructorParameters<typeof DataBackup>[1];
	return { raw, state, env, objects };
}

test('Cloudflare Backup publishes one sealed identity-free logical index', async () => {
	const owned = setupState();
	try {
		let backup = new DataBackup(owned.state, owned.env);
		await backup.initialize(2);
		expect(await backup.status()).toEqual({
			state: 'building',
			expectedRecordCount: 2,
		});
		expect(await backup.append([FIRST])).toBe(1);

		backup = new DataBackup(owned.state, owned.env);
		expect(await backup.append([SECOND])).toBe(1);
		expect(await backup.seal()).toEqual({
			version: 1,
			state: 'sealed',
			recordCount: 2,
		});
		expect(await backup.status()).toEqual({ state: 'sealed', recordCount: 2 });
		expect((await backup.readPage()).records).toEqual([FIRST, SECOND]);
		expect(owned.raw.query('SELECT * FROM _epicenter_artifact').get()).toEqual({
			singleton: 1,
			kind: 'portable',
			format_version: 1,
		});
		expect(owned.objects.has(STATE_KEY)).toBe(true);
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup never exposes an incomplete build', async () => {
	const owned = setupState();
	try {
		const backup = new DataBackup(owned.state, owned.env);
		await backup.initialize(2);
		await backup.append([FIRST]);
		await expect(backup.readPage()).rejects.toThrow('not sealed');
		await expect(backup.seal()).rejects.toThrow(
			'record membership is incomplete',
		);
		expect(await backup.status()).toEqual({
			state: 'building',
			expectedRecordCount: 2,
		});
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup seal proves referenced blob completeness', async () => {
	const owned = setupState();
	try {
		const backup = new DataBackup(owned.state, owned.env);
		await backup.initialize(1);
		await backup.append([{ ...SECOND, blobSha256: 'b'.repeat(64) }]);
		await expect(backup.seal()).rejects.toThrow(
			'blob membership is incomplete',
		);
		expect(await backup.status()).toEqual({
			state: 'building',
			expectedRecordCount: 1,
		});
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup owns verified blob writes and reads', async () => {
	const owned = setupState();
	try {
		const backup = new DataBackup(owned.state, owned.env);
		const bytes = 'byte-complete';
		const digest = sha256Hex(bytes);
		const record = { ...SECOND, blobSha256: digest };
		await backup.initialize(1);
		await backup.append([record]);
		await backup.putBlob(record.address, digest, new Blob([bytes]).stream());
		expect(await backup.seal()).toEqual({
			version: 1,
			state: 'sealed',
			recordCount: 1,
		});
		expect(
			await new Response(await backup.openBlob(record.address, digest)).text(),
		).toBe(bytes);
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup page failure is atomic and the build is disposable', async () => {
	const owned = setupState();
	try {
		const backup = new DataBackup(owned.state, owned.env);
		await backup.initialize(2);
		await expect(backup.append([FIRST, FIRST])).rejects.toThrow();
		await expect(backup.seal()).rejects.toThrow(
			'record membership is incomplete',
		);
		owned.objects.set(
			`data-authorities/owner-one/backups/${BACKUP_ID}/blobs/content/debris`,
			'debris',
		);
		owned.objects.set(
			'data-authorities/owner-one/backups/sibling/blobs/content/kept',
			'kept',
		);
		await backup.destroy();
		expect(await backup.status()).toEqual({ state: 'empty' });
		expect(
			owned.raw
				.query(
					`SELECT name FROM sqlite_schema
					WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
				)
				.all(),
		).toEqual([]);
		expect(owned.objects.has(STATE_KEY)).toBe(false);
		expect([...owned.objects.keys()]).toEqual([
			'data-authorities/owner-one/backups/sibling/blobs/content/kept',
		]);
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup refuses malformed control state and record pages', async () => {
	const owned = setupState();
	try {
		const backup = new DataBackup(owned.state, owned.env);
		await expect(backup.initialize(-1)).rejects.toThrow('non-negative integer');
		await backup.initialize(0);
		await expect(backup.append([])).rejects.toThrow('must contain 1..16');
		owned.objects.set(
			STATE_KEY,
			JSON.stringify({ version: 1, state: 'sealed', recordCount: -1 }),
		);
		await expect(backup.status()).rejects.toThrow(
			'control state is not recognized',
		);
	} finally {
		owned.raw.close();
	}
});

test('Cloudflare Backup identity keeps control state under the exact owner prefix', () => {
	expect(dataBackupV1Name('owner:one', BACKUP_ID)).toBe(
		`backup-v1:owner%3Aone:${BACKUP_ID}`,
	);
	expect(() => dataBackupV1Name('owner-one', 'short')).toThrow(
		'24 lowercase alphanumeric characters',
	);
});
