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

import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';

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

let DataBackupRegistry: typeof import('./cloudflare-backup-registry-v1.js').DataBackupRegistry;

beforeAll(async () => {
	({ DataBackupRegistry } = await import('./cloudflare-backup-registry-v1.js'));
});

const PRINCIPAL_NAME = 'principal%40example.com';
const OWNER_STORAGE_KEY = 'authority-storage-key';

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
	destroy,
	raw = new Database(':memory:', { strict: true }),
	statuses = new Map<string, BackupStatus>(),
}: {
	capture?: (backupId: string) => Promise<{ recordCount: number }>;
	destroy?: (backupId: string) => Promise<void>;
	raw?: Database;
	statuses?: Map<string, BackupStatus>;
} = {}) {
	const destroyed: string[] = [];
	const r2Keys = new Set<string>();
	const deletedR2Keys: string[] = [];
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
				return { captureBackup: capture };
			},
		},
		DATA_BACKUP: {
			getByName(name: string) {
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
					deletedR2Keys.push(key);
				}
			},
		},
	} as unknown as ConstructorParameters<typeof DataBackupRegistry>[1];
	return {
		raw,
		state,
		env,
		statuses,
		destroyed,
		r2Keys,
		deletedR2Keys,
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
