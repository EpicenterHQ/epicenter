import { DurableObject } from 'cloudflare:workers';

import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

import { deleteR2BlobOwner } from './blob-files-r2.js';
import {
	type CloudflareBackupV1Status,
	type DataBackup,
	dataBackupV1Name,
} from './cloudflare-backup-v1.js';

const FORMAT_VERSION = 1;
const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;

const SCHEMA_STATEMENTS = [
	`CREATE TABLE backup_registry_control (
		singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL CHECK (format_version = 1),
		deleting       INTEGER NOT NULL CHECK (deleting IN (0, 1))
	) STRICT`,
	`CREATE TABLE backup_registry_entries (
		backup_id   TEXT PRIMARY KEY
			CHECK (length(backup_id) = 24 AND backup_id NOT GLOB '*[^a-z0-9]*'),
		state       TEXT NOT NULL CHECK (state IN ('building', 'sealed', 'deleting')),
		record_count INTEGER
			CHECK (record_count IS NULL OR
				(record_count BETWEEN 0 AND 9007199254740991)),
		CHECK ((state = 'building' AND record_count IS NULL) OR
			(state IN ('sealed', 'deleting') AND record_count IS NOT NULL))
	) STRICT`,
] as const;

type DataAuthorityCaptureStub = {
	captureBackup(backupId: string): Promise<{ recordCount: number }>;
};

type DataBackupStub = Pick<DataBackup, 'destroy' | 'status'>;

type DataAuthorityNamespace = {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DataAuthorityCaptureStub;
};

type DataBackupNamespace = {
	getByName(name: string): DataBackupStub;
};

export type CloudflareBackupRegistryV1Env = Omit<
	Cloudflare.Env,
	'DATA_AUTHORITY' | 'DATA_BACKUP' | 'DATA_BLOBS'
> & {
	DATA_AUTHORITY: DataAuthorityNamespace;
	DATA_BACKUP: DataBackupNamespace;
	DATA_BLOBS: R2Bucket;
};

export type CloudflareBackupRegistryV1Entry = {
	backupId: string;
	recordCount: number;
};

export type DataBackupRegistryNamespace = {
	getByName(
		name: string,
	): Pick<DataBackupRegistry, 'create' | 'list' | 'delete'>;
};

export type DeletableDataBackupRegistryNamespace = {
	getByName(name: string): Pick<DataBackupRegistry, 'deleteAccount'>;
};

type EntryRow = {
	backup_id: string;
	state: 'building' | 'sealed' | 'deleting';
	record_count: number | null;
};

function validateBackupId(backupId: string): void {
	if (backupId.length !== 24 || !BACKUP_ID_CHARACTERS.test(backupId)) {
		throw new TypeError(
			'backup ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validateRecordCount(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError('Backup record count must be a non-negative integer');
	}
	return value as number;
}

function mintBackupId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

export function locateDataBackupRegistryV1(
	namespace: DataBackupRegistryNamespace,
	principalId: PrincipalId,
) {
	return namespace.getByName(principalName(principalId));
}

function normalizeSchema(sql: string): string {
	return sql.replaceAll(/\s+/gu, ' ').trim().toLowerCase();
}

/** Principal-owned publication registry for immutable Cloudflare Backups. */
export class DataBackupRegistry extends DurableObject<CloudflareBackupRegistryV1Env> {
	private readonly database: ReturnType<
		typeof createDurableObjectSqliteAdapter
	>;
	private readonly ownerStorageKey: string;
	private readonly authority: DataAuthorityCaptureStub;
	private readonly ready: Promise<void>;
	private operationTail = Promise.resolve();
	private deletionRequested = false;
	private controlReady = false;
	private initializationError: unknown;

	constructor(ctx: DurableObjectState, env: CloudflareBackupRegistryV1Env) {
		super(ctx, env);
		if (ctx.id.name === undefined) {
			throw new Error('DataBackupRegistry must use a named identity');
		}
		this.database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		const authorityId = env.DATA_AUTHORITY.idFromName(ctx.id.name);
		this.ownerStorageKey = authorityId.toString();
		this.authority = env.DATA_AUTHORITY.get(authorityId);
		const loaded = ctx.blockConcurrencyWhile(async () => {
			try {
				this.openSchema();
				const deleting = this.readDeleting();
				this.controlReady = true;
				this.deletionRequested = deleting;
			} catch (cause) {
				this.initializationError = cause;
			}
		});
		this.ready = loaded.then(async () => {
			if (this.initializationError !== undefined) return;
			try {
				if (this.deletionRequested) await this.finishAccountDeletion();
				else await this.recoverInterruptedEntries();
			} catch (cause) {
				// Keep a deletion-fenced registry reachable so callers can retry a
				// transient cross-DO cleanup failure without waiting for eviction.
				this.initializationError = cause;
			}
		});
	}

	/** Capture and publish one immutable Backup. */
	create(): Promise<CloudflareBackupRegistryV1Entry> {
		this.refuseDeleting();
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const backupId = mintBackupId();
			this.database.run(
				`INSERT INTO backup_registry_entries (backup_id, state, record_count)
				VALUES (?, 'building', NULL)`,
				[backupId],
			);
			try {
				const captured = await this.authority.captureBackup(backupId);
				return this.publish(backupId, captured.recordCount);
			} catch (cause) {
				const reconciled = await this.recoverBuildingEntry(backupId);
				if (reconciled !== undefined) return reconciled;
				throw cause;
			}
		});
	}

	/** List only complete, published Backups. */
	list(): Promise<CloudflareBackupRegistryV1Entry[]> {
		this.refuseDeleting();
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			return this.database
				.all<EntryRow>(
					`SELECT backup_id, state, record_count
					FROM backup_registry_entries
					WHERE state = 'sealed'
					ORDER BY backup_id`,
				)
				.map((row) => ({
					backupId: row.backup_id,
					recordCount: validateRecordCount(row.record_count),
				}));
		});
	}

	/** Delete one selected published Backup without affecting its siblings. */
	delete(rawBackupId: string): Promise<boolean> {
		this.refuseDeleting();
		validateBackupId(rawBackupId);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const row = this.readEntry(rawBackupId);
			if (row?.state !== 'sealed') return false;
			this.database.run(
				`UPDATE backup_registry_entries SET state = 'deleting'
				WHERE backup_id = ? AND state = 'sealed'`,
				[rawBackupId],
			);
			await this.backup(rawBackupId).destroy();
			this.database.run(
				'DELETE FROM backup_registry_entries WHERE backup_id = ?',
				[rawBackupId],
			);
			return true;
		});
	}

	/** Permanently fence this registry and erase every principal-owned Backup. */
	deleteAccount(): Promise<void> {
		this.deletionRequested = true;
		return this.exclusive(async () => {
			if (!this.controlReady) throw this.initializationError;
			this.database.run(
				'UPDATE backup_registry_control SET deleting = 1 WHERE singleton = 1',
			);
			await this.finishAccountDeletion();
			this.initializationError = undefined;
		});
	}

	private openSchema(): void {
		const objects = this.database.all<{
			type: string;
			name: string;
			sql: string | null;
		}>(
			`SELECT type, name, sql FROM sqlite_schema
			WHERE name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		);
		if (objects.length === 0) {
			this.database.transaction(() => {
				for (const statement of SCHEMA_STATEMENTS) this.database.run(statement);
				this.database.run(
					`INSERT INTO backup_registry_control
					(singleton, format_version, deleting) VALUES (1, ?, 0)`,
					[FORMAT_VERSION],
				);
			});
			return;
		}
		const expected = [...SCHEMA_STATEMENTS]
			.map((sql) => normalizeSchema(sql))
			.sort();
		const actual = objects
			.map((object) =>
				object.type === 'table' && object.sql !== null
					? normalizeSchema(object.sql)
					: `${object.type}:${object.name}`,
			)
			.sort();
		if (
			actual.length !== expected.length ||
			actual.some((entry, index) => entry !== expected[index])
		) {
			throw new Error('Cloudflare Backup registry schema is not recognized');
		}
		const control = this.database.all<{
			format_version: number;
			deleting: number;
		}>(
			`SELECT format_version, deleting FROM backup_registry_control
			WHERE singleton = 1`,
		);
		if (
			control.length !== 1 ||
			control[0]?.format_version !== FORMAT_VERSION ||
			(control[0]?.deleting !== 0 && control[0]?.deleting !== 1)
		) {
			throw new Error('Cloudflare Backup registry control is not recognized');
		}
	}

	private readDeleting(): boolean {
		const control = this.database.all<{ deleting: number }>(
			'SELECT deleting FROM backup_registry_control WHERE singleton = 1',
		)[0];
		if (control?.deleting === 0) return false;
		if (control?.deleting === 1) return true;
		throw new Error('Cloudflare Backup registry control is not recognized');
	}

	private readEntry(backupId: string): EntryRow | undefined {
		return this.database.all<EntryRow>(
			`SELECT backup_id, state, record_count
			FROM backup_registry_entries WHERE backup_id = ?`,
			[backupId],
		)[0];
	}

	private publish(
		backupId: string,
		rawRecordCount: unknown,
	): CloudflareBackupRegistryV1Entry {
		const recordCount = validateRecordCount(rawRecordCount);
		this.database.run(
			`UPDATE backup_registry_entries
			SET state = 'sealed', record_count = ?
			WHERE backup_id = ? AND state = 'building'`,
			[recordCount, backupId],
		);
		return { backupId, recordCount };
	}

	private backup(backupId: string): DataBackupStub {
		return this.env.DATA_BACKUP.getByName(
			dataBackupV1Name(this.ownerStorageKey, backupId),
		);
	}

	private async recoverBuildingEntry(
		backupId: string,
	): Promise<CloudflareBackupRegistryV1Entry | undefined> {
		const backup = this.backup(backupId);
		const status: CloudflareBackupV1Status = await backup.status();
		if (status.state === 'sealed') {
			return this.publish(backupId, status.recordCount);
		}
		await backup.destroy();
		this.database.run(
			`DELETE FROM backup_registry_entries
			WHERE backup_id = ? AND state = 'building'`,
			[backupId],
		);
		return undefined;
	}

	private async recoverInterruptedEntries(): Promise<void> {
		const building = this.database.all<{ backup_id: string }>(
			`SELECT backup_id FROM backup_registry_entries
			WHERE state = 'building' ORDER BY backup_id`,
		);
		for (const row of building) await this.recoverBuildingEntry(row.backup_id);
		const deleting = this.database.all<{ backup_id: string }>(
			`SELECT backup_id FROM backup_registry_entries
			WHERE state = 'deleting' ORDER BY backup_id`,
		);
		for (const row of deleting) {
			await this.backup(row.backup_id).destroy();
			this.database.run(
				'DELETE FROM backup_registry_entries WHERE backup_id = ?',
				[row.backup_id],
			);
		}
	}

	private async finishAccountDeletion(): Promise<void> {
		const rows = this.database.all<{ backup_id: string }>(
			'SELECT backup_id FROM backup_registry_entries ORDER BY backup_id',
		);
		for (const row of rows) {
			await this.backup(row.backup_id).destroy();
			this.database.run(
				'DELETE FROM backup_registry_entries WHERE backup_id = ?',
				[row.backup_id],
			);
		}
		await deleteR2BlobOwner(this.env.DATA_BLOBS, this.ownerStorageKey);
	}

	private refuseDeleting(): void {
		if (this.deletionRequested) {
			throw new Error('Cloudflare Backup registry is being deleted');
		}
	}

	private async recoverAvailability(): Promise<void> {
		if (this.initializationError === undefined) return;
		if (!this.controlReady) throw this.initializationError;
		try {
			await this.recoverInterruptedEntries();
			this.initializationError = undefined;
		} catch (cause) {
			this.initializationError = cause;
			throw cause;
		}
	}

	private async exclusive<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const preceding = this.operationTail;
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.operationTail = preceding.then(() => turn);
		await preceding;
		try {
			await this.ready;
			return await operation();
		} finally {
			release();
		}
	}
}

/** Bind hosted account deletion to the principal-owned Backup registry. */
export function createDataBackupRegistryAccountAuthorities(
	namespace: DeletableDataBackupRegistryNamespace,
) {
	return {
		authority(principalId: PrincipalId) {
			return {
				deleteAccount: () =>
					namespace.getByName(principalName(principalId)).deleteAccount(),
			};
		},
	};
}
