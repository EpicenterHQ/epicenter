import { DurableObject } from 'cloudflare:workers';

import {
	appendPortableArtifactScratchRecords,
	initializePortableArtifactScratchIndex,
	type PortableArtifactIndexPage,
	type PortableArtifactRecord,
	readPortableArtifactIndexPage,
	scanPortableArtifactIndex,
} from '@epicenter/data/portable';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

import { createR2BackupBlobStore } from './backup-files-r2.js';
import { parseDataBackupName, r2DataBackupPrefix } from './backup-r2-paths.js';
import {
	decodePortableMaterializerRecordStream,
	encodePortableMaterializerRecordFrame,
} from './portable-record-stream-v1.js';

export {
	dataBackupV1Name,
	r2DataBackupPrefix,
} from './backup-r2-paths.js';

const MAX_PAGE = 16;

type BuildingState = {
	version: 1;
	state: 'building';
	expectedRecordCount: number;
};

type SealedState = {
	version: 1;
	state: 'sealed';
	recordCount: number;
};

type BackupState = BuildingState | SealedState;

export type CloudflareBackupV1Status =
	| { state: 'empty' }
	| { state: 'building'; expectedRecordCount: number }
	| { state: 'sealed'; recordCount: number };

export type DataBackupEnv = Cloudflare.Env & { DATA_BLOBS: R2Bucket };

function validateRecordCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError('Backup record count must be a non-negative integer');
	}
}

function isBackupState(value: unknown): value is BackupState {
	if (value === null || typeof value !== 'object') return false;
	const state = value as Partial<BackupState>;
	return (
		state.version === 1 &&
		((state.state === 'building' &&
			Number.isSafeInteger(state.expectedRecordCount) &&
			(state.expectedRecordCount ?? -1) >= 0) ||
			(state.state === 'sealed' &&
				Number.isSafeInteger(state.recordCount) &&
				(state.recordCount ?? -1) >= 0))
	);
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
	for (;;) {
		const page = await bucket.list({ prefix });
		if (page.objects.length === 0) return;
		await bucket.delete(page.objects.map((object) => object.key));
	}
}

/** Immutable logical record owner for one Cloudflare Backup. */
export class DataBackup extends DurableObject<DataBackupEnv> {
	private readonly database: ReturnType<
		typeof createDurableObjectSqliteAdapter
	>;
	private readonly blobs: ReturnType<typeof createR2BackupBlobStore>;
	private readonly backupPrefix: string;
	private readonly stateKey: string;
	private operationTail = Promise.resolve();

	constructor(ctx: DurableObjectState, env: DataBackupEnv) {
		super(ctx, env);
		this.database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		const identity = parseDataBackupName(ctx.id.name);
		this.blobs = createR2BackupBlobStore(
			env.DATA_BLOBS,
			identity.ownerStorageKey,
			identity.backupId,
		);
		this.backupPrefix = r2DataBackupPrefix(
			identity.ownerStorageKey,
			identity.backupId,
		);
		this.stateKey = `${this.backupPrefix}control/state-v1.json`;
	}

	/** Initialize unpublished scratch storage for a fresh Backup. */
	initialize(expectedRecordCount: number): Promise<void> {
		return this.exclusive(async () => {
			validateRecordCount(expectedRecordCount);
			const current = await this.readState();
			if (current !== undefined) {
				if (
					current.state === 'building' &&
					current.expectedRecordCount === expectedRecordCount
				) {
					return;
				}
				throw new Error('Backup storage is already initialized');
			}
			initializePortableArtifactScratchIndex(this.database);
			await this.writeState({
				version: 1,
				state: 'building',
				expectedRecordCount,
			});
		});
	}

	/** Append one atomic page. Any uncertain response abandons the whole Backup. */
	append(rawRecords: unknown): Promise<number> {
		return this.exclusive(async () => {
			await this.buildingState();
			if (
				!Array.isArray(rawRecords) ||
				rawRecords.length === 0 ||
				rawRecords.length > MAX_PAGE
			) {
				throw new TypeError(
					`Backup record page must contain 1..${MAX_PAGE} rows`,
				);
			}
			return appendPortableArtifactScratchRecords({
				database: this.database,
				records: rawRecords as PortableArtifactRecord[],
			});
		});
	}

	/** Import one backpressured sequence of bounded record pages. */
	importRecords(bytes: ReadableStream<Uint8Array>): Promise<number> {
		return this.exclusive(async () => {
			await this.buildingState();
			let imported = 0;
			for await (const records of decodePortableMaterializerRecordStream(
				bytes,
			)) {
				imported += appendPortableArtifactScratchRecords({
					database: this.database,
					records,
				});
			}
			return imported;
		});
	}

	/** Copy one referenced blob into this unpublished Backup. */
	putBlob(
		address: RecordAddress,
		digest: string,
		bytes: ReadableStream<Uint8Array>,
	): Promise<void> {
		return this.exclusive(async () => {
			await this.buildingState();
			await this.blobs.copy(address, digest, bytes);
		});
	}

	/** Validate the complete index and make this Backup immutable. */
	seal(): Promise<SealedState> {
		return this.exclusive(async () => {
			const building = await this.buildingState();
			const metadata = scanPortableArtifactIndex({
				database: this.database,
				onPage: () => undefined,
			});
			if (metadata.recordCount !== building.expectedRecordCount) {
				throw new Error('Backup record membership is incomplete');
			}
			const database = this.database;
			const records = async function* () {
				let after: RecordAddress | undefined;
				for (;;) {
					const page = readPortableArtifactIndexPage({ database, after });
					for (const record of page.records) {
						if (record.blobSha256 === null) continue;
						yield { address: record.address, digest: record.blobSha256 };
					}
					if (page.nextAfter === undefined) return;
					if (page.records.length === 0) {
						throw new Error('Backup record page did not advance');
					}
					after = page.nextAfter;
				}
			};
			await this.blobs.seal(records());
			const sealed = {
				version: 1,
				state: 'sealed',
				recordCount: metadata.recordCount,
			} satisfies SealedState;
			await this.writeState(sealed);
			return sealed;
		});
	}

	status(): Promise<CloudflareBackupV1Status> {
		return this.exclusive(async () => {
			const state = await this.readState();
			if (state === undefined) return { state: 'empty' };
			return state.state === 'building'
				? {
						state: 'building',
						expectedRecordCount: state.expectedRecordCount,
					}
				: { state: 'sealed', recordCount: state.recordCount };
		});
	}

	/** Read one bounded immutable record page for Restore or materialization. */
	readPage(rawAfter?: unknown): Promise<PortableArtifactIndexPage> {
		return this.exclusive(async () => {
			await this.sealedState();
			return readPortableArtifactIndexPage({
				database: this.database,
				after: rawAfter as RecordAddress | undefined,
			});
		});
	}

	/** Stream this sealed Backup's records without one RPC per private page. */
	openRecordStream(): Promise<ReadableStream<Uint8Array>> {
		return this.exclusive(async () => {
			await this.sealedState();
			const database = this.database;
			let after: RecordAddress | undefined;
			let done = false;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (done) return;
					try {
						const page = readPortableArtifactIndexPage({ database, after });
						if (page.records.length === 0) {
							done = true;
							controller.close();
							return;
						}
						controller.enqueue(
							encodePortableMaterializerRecordFrame(page.records),
						);
						if (page.nextAfter === undefined) {
							done = true;
							controller.close();
						} else {
							after = page.nextAfter;
						}
					} catch (cause) {
						done = true;
						controller.error(cause);
					}
				},
			});
		});
	}

	/** Open one verified blob from this sealed Backup. */
	openBlob(
		address: RecordAddress,
		digest: string,
	): Promise<ReadableStream<Uint8Array>> {
		return this.exclusive(async () => {
			await this.sealedState();
			return this.blobs.open(address, digest);
		});
	}

	/** Delete this incomplete or sealed Backup's logical and control storage. */
	destroy(): Promise<void> {
		return this.exclusive(async () => {
			// Delete publication state first. A crash may leave unpublished SQL
			// debris, but can never leave deleted SQL advertised as sealed.
			await deleteR2Prefix(this.env.DATA_BLOBS, this.backupPrefix);
			await this.ctx.storage.deleteAll();
		});
	}

	private async buildingState(): Promise<BuildingState> {
		const state = await this.readState();
		if (state?.state !== 'building') {
			throw new Error('Backup storage is not building');
		}
		return state;
	}

	private async sealedState(): Promise<SealedState> {
		const state = await this.readState();
		if (state?.state !== 'sealed') {
			throw new Error('Backup storage is not sealed');
		}
		return state;
	}

	private async readState(): Promise<BackupState | undefined> {
		const object = await this.env.DATA_BLOBS.get(this.stateKey);
		if (object === null) return undefined;
		let state: unknown;
		try {
			state = await object.json();
		} catch {
			throw new Error('Backup control state is not recognized');
		}
		if (!isBackupState(state)) {
			throw new Error('Backup control state is not recognized');
		}
		return state;
	}

	private async writeState(state: BackupState): Promise<void> {
		const stored = await this.env.DATA_BLOBS.put(
			this.stateKey,
			JSON.stringify(state),
			{ httpMetadata: { contentType: 'application/json' } },
		);
		if (stored === null) throw new Error('R2 refused Backup control state');
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
			return await operation();
		} finally {
			release();
		}
	}
}
