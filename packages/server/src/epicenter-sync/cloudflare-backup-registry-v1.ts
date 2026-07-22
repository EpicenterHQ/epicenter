import { DurableObject } from 'cloudflare:workers';

import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { bytesToHex } from '@noble/hashes/utils.js';

import { deleteR2BlobOwner } from './blob-files-r2.js';
import {
	type CloudflareBackupV1Status,
	type DataBackup,
	dataBackupV1Name,
} from './cloudflare-backup-v1.js';
import { portableMaterializerJobName } from './portable-materializer-contract-v1.js';

const FORMAT_VERSION = 3;
const BACKUP_ID_CHARACTERS = /^[a-z0-9]+$/u;
const SHA256_CHARACTERS = /^[a-f0-9]{64}$/u;
const MAX_UPLOAD_PART_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_PARTS = 512;

const SCHEMA_STATEMENTS = [
	`CREATE TABLE backup_registry_control (
		singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL CHECK (format_version = 3),
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
	`CREATE TABLE backup_registry_restores (
		request_id TEXT PRIMARY KEY
			CHECK (length(request_id) = 24 AND request_id NOT GLOB '*[^a-z0-9]*'),
		backup_id TEXT NOT NULL
			CHECK (length(backup_id) = 24 AND backup_id NOT GLOB '*[^a-z0-9]*'),
		successor_lifetime TEXT NOT NULL UNIQUE CHECK (length(successor_lifetime) = 36),
		record_count INTEGER NOT NULL
			CHECK (record_count BETWEEN 0 AND 9007199254740991),
		state TEXT NOT NULL CHECK (state IN ('building', 'succeeded'))
	) STRICT`,
	`CREATE UNIQUE INDEX backup_registry_one_active_restore
		ON backup_registry_restores ((1)) WHERE state = 'building'`,
	`CREATE TABLE backup_registry_uploads (
		request_id TEXT PRIMARY KEY
			CHECK (length(request_id) = 24 AND request_id NOT GLOB '*[^a-z0-9]*'),
		backup_id TEXT NOT NULL UNIQUE
			CHECK (length(backup_id) = 24 AND backup_id NOT GLOB '*[^a-z0-9]*'),
		state TEXT NOT NULL
			CHECK (state IN ('uploading', 'uploaded', 'materializing', 'sealed')),
		part_count INTEGER CHECK (part_count IS NULL OR part_count BETWEEN 1 AND 512),
		record_count INTEGER
			CHECK (record_count IS NULL OR
				(record_count BETWEEN 0 AND 9007199254740991)),
		CHECK ((state = 'uploading' AND part_count IS NULL) OR
			(state != 'uploading' AND part_count IS NOT NULL)),
		CHECK ((state = 'sealed' AND record_count IS NOT NULL) OR
			(state != 'sealed' AND record_count IS NULL))
	) STRICT`,
	`CREATE TABLE backup_registry_upload_parts (
		request_id TEXT NOT NULL
			CHECK (length(request_id) = 24 AND request_id NOT GLOB '*[^a-z0-9]*'),
		part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 512),
		byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 67108864),
		sha256 TEXT NOT NULL
			CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
		PRIMARY KEY (request_id, part_number)
	) STRICT`,
] as const;

type DataAuthorityStub = {
	captureBackup(backupId: string): Promise<{ recordCount: number }>;
	currentAuthorityLifetime(): Promise<string>;
	restoreBackup(
		backupId: string,
		successorLifetime: string,
	): Promise<{ authorityLifetime: string; recordCount: number }>;
};

type DataBackupStub = Pick<DataBackup, 'destroy' | 'status'>;

type PortableMaterializerStub = {
	materializeUpload(input: {
		ownerStorageKey: string;
		backupId: string;
		bytes: ReadableStream<Uint8Array>;
	}): Promise<{ recordCount: number } | { invalidPortableBackup: true }>;
	downloadBackup(input: {
		ownerStorageKey: string;
		backupId: string;
	}): Promise<Response>;
};

type PortableMaterializerNamespace = {
	getByName(name: string): PortableMaterializerStub;
};

type DataAuthorityNamespace = {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): DataAuthorityStub;
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
	PORTABLE_MATERIALIZER: PortableMaterializerNamespace;
};

export type CloudflareBackupRegistryV1Entry = {
	backupId: string;
	recordCount: number;
};

export type CloudflarePortableUploadV1 = {
	requestId: string;
	backupId: string;
	state: 'uploading' | 'uploaded' | 'materializing' | 'sealed';
};

export type CloudflarePortableUploadPartV1Result =
	| { kind: 'stored' }
	| { kind: 'upload-not-found' }
	| { kind: 'upload-conflict' }
	| { kind: 'invalid-upload-part' };

export type CloudflarePortableUploadCompletionV1Result =
	| { kind: 'completed'; backup: CloudflareBackupRegistryV1Entry }
	| { kind: 'upload-not-found' }
	| { kind: 'upload-conflict' }
	| { kind: 'invalid-upload-completion' }
	| { kind: 'invalid-portable-backup' };

export type CloudflareRestoreBackupV1Result =
	| {
			kind: 'restored';
			authorityLifetime: string;
			recordCount: number;
	  }
	| { kind: 'backup-not-found' }
	| { kind: 'restore-in-progress' }
	| { kind: 'idempotency-conflict' };

export type DataBackupRegistryNamespace = {
	getByName(
		name: string,
	): Pick<
		DataBackupRegistry,
		| 'create'
		| 'list'
		| 'delete'
		| 'download'
		| 'restore'
		| 'createUpload'
		| 'putUploadPart'
		| 'completeUpload'
		| 'deleteUpload'
	>;
};

export type DeletableDataBackupRegistryNamespace = {
	getByName(name: string): Pick<DataBackupRegistry, 'deleteAccount'>;
};

type EntryRow = {
	backup_id: string;
	state: 'building' | 'sealed' | 'deleting';
	record_count: number | null;
};

type RestoreRow = {
	request_id: string;
	backup_id: string;
	successor_lifetime: string;
	record_count: number;
	state: 'building' | 'succeeded';
};

type UploadRow = {
	request_id: string;
	backup_id: string;
	state: 'uploading' | 'uploaded' | 'materializing' | 'sealed';
	part_count: number | null;
	record_count: number | null;
};

type UploadPartRow = {
	request_id: string;
	part_number: number;
	byte_length: number;
	sha256: string;
};

function validateBackupId(backupId: string): void {
	if (backupId.length !== 24 || !BACKUP_ID_CHARACTERS.test(backupId)) {
		throw new TypeError(
			'backup ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validateRestoreRequestId(requestId: string): void {
	if (requestId.length !== 24 || !BACKUP_ID_CHARACTERS.test(requestId)) {
		throw new TypeError(
			'Restore request ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validateUploadRequestId(requestId: string): void {
	if (requestId.length !== 24 || !BACKUP_ID_CHARACTERS.test(requestId)) {
		throw new TypeError(
			'portable upload request ID must be 24 lowercase alphanumeric characters',
		);
	}
}

function validateUploadPartNumber(partNumber: number): void {
	if (
		!Number.isSafeInteger(partNumber) ||
		partNumber < 1 ||
		partNumber > MAX_UPLOAD_PARTS
	) {
		throw new RangeError(
			`portable upload part number must be between 1 and ${MAX_UPLOAD_PARTS}`,
		);
	}
}

function validateUploadPartMetadata(byteLength: number, sha256: string): void {
	if (
		!Number.isSafeInteger(byteLength) ||
		byteLength < 1 ||
		byteLength > MAX_UPLOAD_PART_BYTES
	) {
		throw new RangeError(
			`portable upload part must contain 1..${MAX_UPLOAD_PART_BYTES} bytes`,
		);
	}
	if (!SHA256_CHARACTERS.test(sha256)) {
		throw new TypeError('portable upload part SHA-256 is not recognized');
	}
}

function checksumHex(object: R2Object): string | undefined {
	const checksum = object.checksums.sha256;
	return checksum === undefined
		? undefined
		: bytesToHex(new Uint8Array(checksum));
}

function isR2BadDigest(cause: unknown): boolean {
	return cause instanceof Error && /\(10037\)$/u.test(cause.message);
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
	private readonly authority: DataAuthorityStub;
	private readonly ready: Promise<void>;
	private readonly activeDownloads = new Map<
		string,
		Set<(reason: unknown) => Promise<void>>
	>();
	private operationTail = Promise.resolve();
	private deletionRequested = false;
	private restoreRequested = false;
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

	/** Start or resume one idempotent portable Backup upload. */
	createUpload(rawRequestId: string): Promise<CloudflarePortableUploadV1> {
		this.refuseDeleting();
		validateUploadRequestId(rawRequestId);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const prior = this.readUpload(rawRequestId);
			if (prior !== undefined) return this.uploadResult(prior);
			const upload: UploadRow = {
				request_id: rawRequestId,
				backup_id: mintBackupId(),
				state: 'uploading',
				part_count: null,
				record_count: null,
			};
			this.database.run(
				`INSERT INTO backup_registry_uploads
				(request_id, backup_id, state, part_count, record_count)
				VALUES (?, ?, 'uploading', NULL, NULL)`,
				[upload.request_id, upload.backup_id],
			);
			return this.uploadResult(upload);
		});
	}

	/** Store one immutable, bounded portable upload part. */
	putUploadPart(
		rawRequestId: string,
		partNumber: number,
		byteLength: number,
		sha256: string,
		bytes: ReadableStream<Uint8Array>,
	): Promise<CloudflarePortableUploadPartV1Result> {
		this.refuseDeleting();
		validateUploadRequestId(rawRequestId);
		validateUploadPartNumber(partNumber);
		validateUploadPartMetadata(byteLength, sha256);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const upload = this.readUpload(rawRequestId);
			if (upload === undefined) {
				return { kind: 'upload-not-found' };
			}
			if (upload.state === 'materializing' || upload.state === 'sealed') {
				return { kind: 'upload-conflict' };
			}
			const prior = this.readUploadPart(rawRequestId, partNumber);
			if (
				prior !== undefined &&
				(prior.byte_length !== byteLength || prior.sha256 !== sha256)
			) {
				return { kind: 'upload-conflict' };
			}
			if (prior === undefined && upload.state !== 'uploading') {
				return { kind: 'upload-conflict' };
			}
			const key = this.uploadPartKey(rawRequestId, partNumber);
			if (prior !== undefined) {
				const stored = await this.env.DATA_BLOBS.head(key);
				if (
					stored !== null &&
					stored.size === byteLength &&
					checksumHex(stored) === sha256
				) {
					return { kind: 'stored' };
				}
			}
			let stored: R2Object | null;
			try {
				stored = await this.env.DATA_BLOBS.put(key, bytes, { sha256 });
			} catch (cause) {
				if (!isR2BadDigest(cause)) throw cause;
				await this.env.DATA_BLOBS.delete(key);
				return { kind: 'invalid-upload-part' };
			}
			if (
				stored === null ||
				stored.size !== byteLength ||
				checksumHex(stored) !== sha256
			) {
				await this.env.DATA_BLOBS.delete(key);
				return { kind: 'invalid-upload-part' };
			}
			if (prior === undefined) {
				this.database.run(
					`INSERT INTO backup_registry_upload_parts
					(request_id, part_number, byte_length, sha256)
					VALUES (?, ?, ?, ?)`,
					[rawRequestId, partNumber, byteLength, sha256],
				);
			}
			return { kind: 'stored' };
		});
	}

	/** Materialize, seal, and publish one complete portable upload. */
	completeUpload(
		rawRequestId: string,
		rawOrderedParts: unknown,
	): Promise<CloudflarePortableUploadCompletionV1Result> {
		this.refuseDeleting();
		validateUploadRequestId(rawRequestId);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			let upload = this.readUpload(rawRequestId);
			if (upload === undefined) {
				return { kind: 'upload-not-found' };
			}
			if (upload.state === 'sealed') {
				await this.deleteUploadParts(upload.request_id);
				return {
					kind: 'completed',
					backup: {
						backupId: upload.backup_id,
						recordCount: validateRecordCount(upload.record_count),
					},
				};
			}
			if (upload.state === 'materializing') {
				const reconciled = await this.recoverMaterializingUpload(upload);
				if (reconciled !== undefined) {
					return { kind: 'completed', backup: reconciled };
				}
				upload = { ...upload, state: 'uploaded' };
			}
			const parts = this.validateOrderedUploadParts(
				upload.request_id,
				rawOrderedParts,
			);
			if (!Array.isArray(parts)) return parts;
			if (!(await this.validateStoredUploadParts(parts))) {
				return { kind: 'upload-conflict' };
			}
			if (upload.state === 'uploading') {
				this.database.run(
					`UPDATE backup_registry_uploads
					SET state = 'uploaded', part_count = ?
					WHERE request_id = ? AND state = 'uploading'`,
					[parts.length, upload.request_id],
				);
			} else if (upload.part_count !== parts.length) {
				return { kind: 'upload-conflict' };
			}
			this.database.run(
				`UPDATE backup_registry_uploads SET state = 'materializing'
				WHERE request_id = ? AND state = 'uploaded'`,
				[upload.request_id],
			);
			return this.executeUploadMaterialization(
				{
					...upload,
					state: 'materializing',
					part_count: parts.length,
				},
				parts,
			);
		});
	}

	/** Abandon one unpublished portable upload and its staged bytes. */
	deleteUpload(rawRequestId: string): Promise<boolean> {
		this.refuseDeleting();
		validateUploadRequestId(rawRequestId);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const upload = this.readUpload(rawRequestId);
			if (upload === undefined || upload.state === 'sealed') return false;
			await this.backup(upload.backup_id).destroy();
			await this.deleteUploadParts(upload.request_id);
			this.database.run(
				'DELETE FROM backup_registry_uploads WHERE request_id = ?',
				[upload.request_id],
			);
			return true;
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

	/** Materialize one published Backup as a streamed portable TAR. */
	download(rawBackupId: string): Promise<Response | undefined> {
		this.refuseDeleting();
		validateBackupId(rawBackupId);
		return this.exclusive(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			if (this.readEntry(rawBackupId)?.state !== 'sealed') return undefined;
			const response = await this.env.PORTABLE_MATERIALIZER.getByName(
				portableMaterializerJobName(this.ownerStorageKey, crypto.randomUUID()),
			).downloadBackup({
				ownerStorageKey: this.ownerStorageKey,
				backupId: rawBackupId,
			});
			return this.leaseDownload(rawBackupId, response);
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
			if (this.readActiveRestore()?.backup_id === rawBackupId) {
				throw new Error('Cloudflare Backup Restore is incomplete');
			}
			this.database.run(
				`UPDATE backup_registry_entries SET state = 'deleting'
				WHERE backup_id = ? AND state = 'sealed'`,
				[rawBackupId],
			);
			await this.cancelDownloads(rawBackupId);
			await this.backup(rawBackupId).destroy();
			this.database.run(
				'DELETE FROM backup_registry_entries WHERE backup_id = ?',
				[rawBackupId],
			);
			return true;
		});
	}

	/** Atomically replace the live authority once for one durable request ID. */
	restore(
		rawBackupId: string,
		rawRequestId: string,
	): Promise<CloudflareRestoreBackupV1Result> {
		this.refuseDeleting();
		validateBackupId(rawBackupId);
		validateRestoreRequestId(rawRequestId);
		if (this.restoreRequested) {
			return Promise.resolve({ kind: 'restore-in-progress' });
		}
		this.restoreRequested = true;
		return this.exclusive<CloudflareRestoreBackupV1Result>(async () => {
			await this.recoverAvailability();
			this.refuseDeleting();
			const prior = this.readRestore(rawRequestId);
			if (prior !== undefined) {
				if (prior.backup_id !== rawBackupId) {
					return { kind: 'idempotency-conflict' };
				}
				return prior.state === 'succeeded'
					? this.restoredResult(prior)
					: this.executeRestore(prior);
			}
			if (this.readActiveRestore() !== undefined) {
				return { kind: 'restore-in-progress' };
			}
			const entry = this.readEntry(rawBackupId);
			if (entry?.state !== 'sealed') return { kind: 'backup-not-found' };
			const restore: RestoreRow = {
				request_id: rawRequestId,
				backup_id: rawBackupId,
				successor_lifetime: crypto.randomUUID(),
				record_count: validateRecordCount(entry.record_count),
				state: 'building',
			};
			this.database.run(
				`INSERT INTO backup_registry_restores
				(request_id, backup_id, successor_lifetime, record_count, state)
				VALUES (?, ?, ?, ?, 'building')`,
				[
					restore.request_id,
					restore.backup_id,
					restore.successor_lifetime,
					restore.record_count,
				],
			);
			return this.executeRestore(restore);
		}).finally(() => {
			this.restoreRequested = false;
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
			await this.cancelAllDownloads();
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
				(object.type === 'table' || object.type === 'index') &&
				object.sql !== null
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

	private readRestore(requestId: string): RestoreRow | undefined {
		return this.database.all<RestoreRow>(
			`SELECT request_id, backup_id, successor_lifetime, record_count, state
			FROM backup_registry_restores WHERE request_id = ?`,
			[requestId],
		)[0];
	}

	private readActiveRestore(): RestoreRow | undefined {
		return this.database.all<RestoreRow>(
			`SELECT request_id, backup_id, successor_lifetime, record_count, state
			FROM backup_registry_restores WHERE state = 'building'`,
		)[0];
	}

	private readUpload(requestId: string): UploadRow | undefined {
		return this.database.all<UploadRow>(
			`SELECT request_id, backup_id, state, part_count, record_count
			FROM backup_registry_uploads WHERE request_id = ?`,
			[requestId],
		)[0];
	}

	private readUploadPart(
		requestId: string,
		partNumber: number,
	): UploadPartRow | undefined {
		return this.database.all<UploadPartRow>(
			`SELECT request_id, part_number, byte_length, sha256
			FROM backup_registry_upload_parts
			WHERE request_id = ? AND part_number = ?`,
			[requestId, partNumber],
		)[0];
	}

	private uploadResult(row: UploadRow): CloudflarePortableUploadV1 {
		return {
			requestId: row.request_id,
			backupId: row.backup_id,
			state: row.state,
		};
	}

	private uploadPartKey(requestId: string, partNumber: number): string {
		return `${this.uploadPrefix(requestId)}${partNumber.toString().padStart(3, '0')}`;
	}

	private uploadPrefix(requestId: string): string {
		return `data-authorities/${this.ownerStorageKey}/portable-uploads/${requestId}/parts/`;
	}

	private validateOrderedUploadParts(
		requestId: string,
		rawOrderedParts: unknown,
	):
		| UploadPartRow[]
		| { kind: 'invalid-upload-completion' }
		| { kind: 'upload-conflict' } {
		if (
			!Array.isArray(rawOrderedParts) ||
			rawOrderedParts.length === 0 ||
			rawOrderedParts.length > MAX_UPLOAD_PARTS
		) {
			return { kind: 'invalid-upload-completion' };
		}
		for (const [index, partNumber] of rawOrderedParts.entries()) {
			if (partNumber !== index + 1) {
				return { kind: 'invalid-upload-completion' };
			}
		}
		const stored = this.database.all<UploadPartRow>(
			`SELECT request_id, part_number, byte_length, sha256
			FROM backup_registry_upload_parts WHERE request_id = ?
			ORDER BY part_number`,
			[requestId],
		);
		if (
			stored.length !== rawOrderedParts.length ||
			stored.some((part, index) => part.part_number !== rawOrderedParts[index])
		) {
			return { kind: 'upload-conflict' };
		}
		return stored;
	}

	private async validateStoredUploadParts(
		parts: readonly UploadPartRow[],
	): Promise<boolean> {
		for (const part of parts) {
			const object = await this.env.DATA_BLOBS.head(
				this.uploadPartKey(part.request_id, part.part_number),
			);
			if (
				object === null ||
				object.size !== part.byte_length ||
				checksumHex(object) !== part.sha256
			) {
				return false;
			}
		}
		return true;
	}

	private uploadBytes(
		parts: readonly UploadPartRow[],
	): ReadableStream<Uint8Array> {
		const bucket = this.env.DATA_BLOBS;
		const ownerStorageKey = this.ownerStorageKey;
		let partIndex = 0;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				for (;;) {
					if (reader === undefined) {
						const part = parts[partIndex];
						if (part === undefined) {
							controller.close();
							return;
						}
						const key = `data-authorities/${ownerStorageKey}/portable-uploads/${part.request_id}/parts/${part.part_number.toString().padStart(3, '0')}`;
						const object = await bucket.get(key);
						if (
							object === null ||
							!('body' in object) ||
							object.size !== part.byte_length ||
							checksumHex(object) !== part.sha256
						) {
							throw new Error('portable upload part membership is incomplete');
						}
						reader = object.body.getReader();
						partIndex += 1;
					}
					const chunk = await reader.read();
					if (chunk.done) {
						reader.releaseLock();
						reader = undefined;
						continue;
					}
					controller.enqueue(chunk.value);
					return;
				}
			},
			async cancel(reason) {
				await reader?.cancel(reason);
			},
		});
	}

	private async executeUploadMaterialization(
		upload: UploadRow,
		parts: readonly UploadPartRow[],
	): Promise<CloudflarePortableUploadCompletionV1Result> {
		try {
			const result = await this.env.PORTABLE_MATERIALIZER.getByName(
				portableMaterializerJobName(this.ownerStorageKey, upload.request_id),
			).materializeUpload({
				ownerStorageKey: this.ownerStorageKey,
				backupId: upload.backup_id,
				bytes: this.uploadBytes(parts),
			});
			if ('invalidPortableBackup' in result) {
				await this.backup(upload.backup_id).destroy();
				this.resetUploadToUploaded(upload.request_id);
				return { kind: 'invalid-portable-backup' };
			}
			const published = await this.recoverMaterializingUpload(
				upload,
				validateRecordCount(result.recordCount),
			);
			if (published !== undefined) {
				return { kind: 'completed', backup: published };
			}
			throw new Error('portable materializer did not seal its DataBackup');
		} catch (cause) {
			if (this.deletionRequested) throw cause;
			try {
				const published = await this.recoverMaterializingUpload(upload);
				if (published !== undefined) {
					return { kind: 'completed', backup: published };
				}
			} catch (reconciliationCause) {
				throw new AggregateError(
					[cause, reconciliationCause],
					'portable upload materialization outcome is indeterminate',
				);
			}
			throw cause;
		}
	}

	private async recoverMaterializingUpload(
		upload: UploadRow,
		expectedRecordCount?: number,
	): Promise<CloudflareBackupRegistryV1Entry | undefined> {
		const backup = this.backup(upload.backup_id);
		const status = await backup.status();
		if (status.state === 'sealed') {
			const recordCount = validateRecordCount(status.recordCount);
			if (
				expectedRecordCount !== undefined &&
				recordCount !== expectedRecordCount
			) {
				await backup.destroy();
				this.resetUploadToUploaded(upload.request_id);
				throw new Error('portable materializer record count is inconsistent');
			}
			this.refuseDeleting();
			return this.publishUpload(upload, recordCount);
		}
		await backup.destroy();
		this.resetUploadToUploaded(upload.request_id);
		return undefined;
	}

	private resetUploadToUploaded(requestId: string): void {
		this.database.run(
			`UPDATE backup_registry_uploads SET state = 'uploaded', record_count = NULL
			WHERE request_id = ? AND state = 'materializing'`,
			[requestId],
		);
	}

	private async publishUpload(
		upload: UploadRow,
		recordCount: number,
	): Promise<CloudflareBackupRegistryV1Entry> {
		this.refuseDeleting();
		this.database.transaction(() => {
			const entry = this.readEntry(upload.backup_id);
			if (entry === undefined) {
				this.database.run(
					`INSERT INTO backup_registry_entries
					(backup_id, state, record_count) VALUES (?, 'sealed', ?)`,
					[upload.backup_id, recordCount],
				);
			} else if (
				entry.state !== 'sealed' ||
				validateRecordCount(entry.record_count) !== recordCount
			) {
				throw new Error(
					'portable upload publication conflicts with its Backup',
				);
			}
			this.database.run(
				`UPDATE backup_registry_uploads
				SET state = 'sealed', record_count = ? WHERE request_id = ?`,
				[recordCount, upload.request_id],
			);
		});
		await this.deleteUploadParts(upload.request_id);
		return { backupId: upload.backup_id, recordCount };
	}

	private async deleteUploadParts(requestId: string): Promise<void> {
		for (;;) {
			const page = await this.env.DATA_BLOBS.list({
				prefix: this.uploadPrefix(requestId),
			});
			if (page.objects.length === 0) break;
			await this.env.DATA_BLOBS.delete(
				page.objects.map((object) => object.key),
			);
		}
		this.database.run(
			'DELETE FROM backup_registry_upload_parts WHERE request_id = ?',
			[requestId],
		);
	}

	private restoredResult(row: RestoreRow): CloudflareRestoreBackupV1Result {
		return {
			kind: 'restored',
			authorityLifetime: row.successor_lifetime,
			recordCount: validateRecordCount(row.record_count),
		};
	}

	private publishRestore(row: RestoreRow): CloudflareRestoreBackupV1Result {
		this.database.run(
			`UPDATE backup_registry_restores SET state = 'succeeded'
			WHERE request_id = ? AND state = 'building'`,
			[row.request_id],
		);
		return this.restoredResult({ ...row, state: 'succeeded' });
	}

	private async executeRestore(
		restore: RestoreRow,
	): Promise<CloudflareRestoreBackupV1Result> {
		try {
			const restored = await this.authority.restoreBackup(
				restore.backup_id,
				restore.successor_lifetime,
			);
			if (
				restored.authorityLifetime !== restore.successor_lifetime ||
				validateRecordCount(restored.recordCount) !== restore.record_count
			) {
				throw new Error('Data authority Restore result is not recognized');
			}
			return this.publishRestore(restore);
		} catch (cause) {
			try {
				const activeLifetime = await this.authority.currentAuthorityLifetime();
				if (activeLifetime === restore.successor_lifetime) {
					return this.publishRestore(restore);
				}
				// The authority has proven that this attempt did not activate. Release
				// the one-active slot so a corrupt Backup cannot brick all Restore work.
				this.database.run(
					`DELETE FROM backup_registry_restores
					WHERE request_id = ? AND state = 'building'`,
					[restore.request_id],
				);
			} catch (reconciliationCause) {
				throw new AggregateError(
					[cause, reconciliationCause],
					'Cloudflare Restore outcome is indeterminate',
				);
			}
			throw cause;
		}
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

	private leaseDownload(backupId: string, response: Response): Response {
		if (response.body === null) return response;
		const active =
			this.activeDownloads.get(backupId) ??
			new Set<(reason: unknown) => Promise<void>>();
		this.activeDownloads.set(backupId, active);
		const reader = response.body.getReader();
		let released = false;
		let cancel!: (reason: unknown) => Promise<void>;
		const release = () => {
			if (released) return;
			released = true;
			reader.releaseLock();
			active.delete(cancel);
			if (active.size === 0) this.activeDownloads.delete(backupId);
		};
		cancel = async (reason) => {
			if (released) return;
			try {
				await reader.cancel(reason);
			} finally {
				release();
			}
		};
		active.add(cancel);
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (chunk.done) {
						controller.close();
						release();
						return;
					}
					controller.enqueue(chunk.value);
				} catch (cause) {
					release();
					controller.error(cause);
				}
			},
			cancel(reason) {
				return cancel(reason);
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	private async cancelDownloads(backupId: string): Promise<void> {
		const active = this.activeDownloads.get(backupId);
		if (active === undefined) return;
		await Promise.all(
			[...active].map((cancel) =>
				cancel(new Error('Backup download was cancelled by deletion')),
			),
		);
	}

	private async cancelAllDownloads(): Promise<void> {
		await Promise.all(
			[...this.activeDownloads.keys()].map((backupId) =>
				this.cancelDownloads(backupId),
			),
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
		const restore = this.readActiveRestore();
		if (
			restore !== undefined &&
			(await this.authority.currentAuthorityLifetime()) ===
				restore.successor_lifetime
		) {
			this.publishRestore(restore);
		}
		const materializing = this.database.all<UploadRow>(
			`SELECT request_id, backup_id, state, part_count, record_count
			FROM backup_registry_uploads WHERE state = 'materializing'
			ORDER BY request_id`,
		);
		for (const upload of materializing) {
			await this.recoverMaterializingUpload(upload);
		}
		const sealedUploads = this.database.all<{ request_id: string }>(
			`SELECT request_id FROM backup_registry_uploads WHERE state = 'sealed'
			ORDER BY request_id`,
		);
		for (const upload of sealedUploads) {
			await this.deleteUploadParts(upload.request_id);
		}
	}

	private async finishAccountDeletion(): Promise<void> {
		const backupIds = new Set(
			this.database
				.all<{ backup_id: string }>(
					`SELECT backup_id FROM backup_registry_entries
					UNION SELECT backup_id FROM backup_registry_uploads
					ORDER BY backup_id`,
				)
				.map((row) => row.backup_id),
		);
		for (const backupId of backupIds) {
			await this.backup(backupId).destroy();
			this.database.run(
				'DELETE FROM backup_registry_entries WHERE backup_id = ?',
				[backupId],
			);
			this.database.run(
				'DELETE FROM backup_registry_uploads WHERE backup_id = ?',
				[backupId],
			);
		}
		this.database.run('DELETE FROM backup_registry_restores');
		this.database.run('DELETE FROM backup_registry_upload_parts');
		this.database.run('DELETE FROM backup_registry_uploads');
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
