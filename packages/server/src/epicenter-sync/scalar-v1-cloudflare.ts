import { DurableObject } from 'cloudflare:workers';

import {
	type BlobAcceptance,
	blobFileOwner,
	parseBlobPublicationRequest,
} from '@epicenter/data/blob-v1';
import {
	type DocumentAcceptance,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import type { PortableArtifactIndexPage } from '@epicenter/data/portable';
import {
	type AuthorityError,
	type FactsResponse,
	parseAddress,
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
	type SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { DOCUMENT_SUBPROTOCOL } from '@epicenter/sync/document-v3';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Result } from 'wellcrafted/result';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import { mountBackupV1App } from './backup-v1-route.js';
import {
	type AuthorityBlobV1,
	createAuthorityBlobV1,
} from './blob-authority-v1.js';
import {
	copyR2AuthorityBlob,
	createR2BlobFileStore,
	deleteR2AuthorityLifetime,
	deleteR2BlobOwner,
	sealR2AuthorityBlobs,
	sweepR2AuthorityLifetimes,
} from './blob-files-r2.js';
import {
	type BlobAuthorityV1Endpoint,
	mountBlobV1App,
} from './blob-v1-route.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';
import {
	type DataBackupRegistryNamespace,
	locateDataBackupRegistryV1,
} from './cloudflare-backup-registry-v1.js';
import {
	type CloudflareBackupV1Status,
	dataBackupV1Name,
} from './cloudflare-backup-v1.js';
import {
	abandonCloudflareRestoreV1,
	activateCloudflareRestoreV1,
	appendCloudflareRestoreV1Page,
	initializeCloudflareRestoreV1,
	recoverCloudflareRestoreV1,
	sealCloudflareRestoreV1,
} from './cloudflare-restore-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';
import {
	DOCUMENT_V1_REALTIME_PATH,
	resolveDocumentRealtimeV1Upgrade,
} from './document-realtime-v1-route.js';
import {
	type DocumentAuthorityV1Endpoint,
	mountDocumentV1App,
} from './document-v1-route.js';
import {
	mountScalarV1App,
	type ScalarAuthorityV1Endpoint,
} from './scalar-v1-route.js';

const INTERNAL_DOCUMENT_REALTIME_PATH = '/document-v1';
const ADDRESS_NAMESPACE_HEADER = 'x-epicenter-document-namespace';
const ADDRESS_COLLECTION_HEADER = 'x-epicenter-document-collection';
const ADDRESS_RECORD_HEADER = 'x-epicenter-document-record';
const AUTHORITY_LIFETIME_HEADER = 'x-epicenter-authority-lifetime';
const AUTHORIZATION_EXPIRES_HEADER = 'x-epicenter-authorization-expires-at';
const MAX_CAPTURE_MILLISECONDS = 30 * 60 * 1_000;

type DataDocumentAttachment = {
	version: 1;
	protocol: typeof DOCUMENT_SUBPROTOCOL;
	address: {
		namespace: string;
		collection: string;
		recordKey: string;
	};
	authorityLifetime: string;
	authorizationExpiresAt: number;
};

function isDataDocumentAttachment(
	value: unknown,
): value is DataDocumentAttachment {
	if (value === null || typeof value !== 'object') return false;
	const attachment = value as Partial<DataDocumentAttachment>;
	return (
		attachment.version === 1 &&
		attachment.protocol === DOCUMENT_SUBPROTOCOL &&
		typeof attachment.address?.namespace === 'string' &&
		typeof attachment.address.collection === 'string' &&
		typeof attachment.address.recordKey === 'string' &&
		typeof attachment.authorityLifetime === 'string' &&
		typeof attachment.authorizationExpiresAt === 'number'
	);
}

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

type DataBackupStub = {
	initialize(expectedRecordCount: number): Promise<void>;
	append(rawRecords: unknown): Promise<number>;
	putBlob(
		address: Parameters<typeof blobFileOwner>[0],
		digest: string,
		bytes: ReadableStream<Uint8Array>,
	): Promise<void>;
	seal(): Promise<{ version: 1; state: 'sealed'; recordCount: number }>;
	status(): Promise<CloudflareBackupV1Status>;
	readPage(rawAfter?: unknown): Promise<PortableArtifactIndexPage>;
	openBlob(
		address: Parameters<typeof blobFileOwner>[0],
		digest: string,
	): Promise<ReadableStream<Uint8Array>>;
	destroy(): Promise<void>;
};

export type DataAuthorityEnv = {
	DATA_BACKUP: { getByName(name: string): DataBackupStub };
	DATA_BLOBS: R2Bucket;
};

/** One principal-owned scalar V1 authority on Durable Object SQLite. */
export class DataAuthority extends DurableObject<DataAuthorityEnv> {
	private readonly database: ReturnType<
		typeof createDurableObjectSqliteAdapter
	>;
	private authority: DataAuthorityV1 | undefined;
	private blobAuthority:
		| AuthorityBlobV1<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>>
		| undefined;
	private readonly blobOwnerStorageKey: string;
	private realtime: DocumentRealtimeV1Server | undefined;
	private readonly sockets = new WeakMap<WebSocket, DocumentRealtimeV1Socket>();
	private initializationError: unknown;
	private readonly ready: Promise<void>;
	private readonly operations = new Set<Promise<unknown>>();
	private readonly resourceCancels = new Set<() => Promise<void>>();
	private operationBarrier: Promise<void> | undefined;
	private releaseOperationBarrier: (() => void) | undefined;
	private maintenance: 'restore' | 'account-delete' | undefined;
	private accountDeletion: Promise<void> | undefined;
	private restoreOperation: Promise<unknown> | undefined;
	private backupCaptureFenced = false;

	constructor(ctx: DurableObjectState, env: DataAuthorityEnv) {
		super(ctx, env);
		this.database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.blobOwnerStorageKey = ctx.id.toString();
		const loaded = ctx.blockConcurrencyWhile(async () => {
			try {
				recoverCloudflareRestoreV1(this.database);
				this.authority = this.openFreshOwner();
				this.blobAuthority = this.openBlobOwner(this.authority);
			} catch (cause) {
				// Keep the actor reachable for account deletion. A rejected constructor
				// block prevents later RPC events from reaching deleteAccount at all.
				this.initializationError = cause;
			}
		});
		this.ready = loaded.then(async () => {
			if (this.initializationError !== undefined) return;
			const authority = this.authority;
			const blobAuthority = this.blobAuthority;
			if (authority === undefined || blobAuthority === undefined) return;
			try {
				// R2 work is deliberately outside blockConcurrencyWhile. Events still
				// await ready, without exposing startup to the constructor gate timeout.
				await sweepR2AuthorityLifetimes(
					this.env.DATA_BLOBS,
					this.blobOwnerStorageKey,
					authority.authorityLifetime(),
				);
				await blobAuthority.reopenSweep();
				this.realtime = createDocumentRealtimeV1Server({ authority });
				for (const socket of ctx.getWebSockets()) {
					const attachment = socket.deserializeAttachment();
					if (!isDataDocumentAttachment(attachment)) {
						socket.close(1011, 'invalid-document-attachment');
						continue;
					}
					if (attachment.authorityLifetime !== authority.authorityLifetime()) {
						socket.close(1012, 'authority-replaced');
						continue;
					}
					this.realtime.restore(
						this.socket(socket),
						attachment.address,
						attachment.authorityLifetime,
					);
				}
			} catch (cause) {
				this.initializationError = cause;
				for (const socket of ctx.getWebSockets()) {
					socket.close(1011, 'authority-initialization-failed');
				}
			}
		});
	}

	async readFacts(
		rawRequest: unknown,
	): Promise<Result<FactsResponse, AuthorityError>> {
		const parsed = parseFactsRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 facts RPC request');
		}
		return this.runOperation(async () =>
			(await this.owner()).readFacts(parsed.data),
		);
	}

	async submit(
		rawRequest: unknown,
	): Promise<Result<SubmissionResponse, AuthorityError>> {
		const parsed = parseSubmissionRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 submission RPC request');
		}
		return this.runOperation(async () => {
			const result = (await this.owner()).submit(parsed.data);
			if (result.error === null) {
				let reapedBlob = false;
				for (const fact of result.data.facts) {
					if (fact.state === 'tombstone') {
						this.realtime?.closeAddress(fact.address);
						reapedBlob = true;
					}
				}
				if (reapedBlob && this.blobAuthority !== undefined) {
					this.ctx.waitUntil(
						this.trackOperation(this.blobAuthority.sweepDebris()),
					);
				}
			}
			return result;
		});
	}

	async acceptDocument(rawRequest: unknown): Promise<DocumentAcceptance> {
		const parsed = parseDocumentPublicationRequest(
			rawRequest,
			SCALAR_SYNC_V1_LIMITS,
		);
		if (parsed === undefined) {
			throw new TypeError('invalid document V1 publication RPC request');
		}
		return this.runOperation(async () =>
			(await this.owner()).acceptDocument(parsed),
		);
	}

	async acceptBlob(
		rawRequest: unknown,
		bytes: ReadableStream<Uint8Array>,
	): Promise<BlobAcceptance> {
		const parsed = parseBlobPublicationRequest(
			rawRequest,
			SCALAR_SYNC_V1_LIMITS,
		);
		if (
			parsed === undefined ||
			typeof bytes !== 'object' ||
			bytes === null ||
			typeof bytes.getReader !== 'function'
		) {
			throw new TypeError('invalid blob V1 publication RPC request');
		}
		return this.runOperation(async () =>
			(await this.blobs()).accept(parsed, bytes),
		);
	}

	async readBlob(
		rawAddress: unknown,
	): Promise<ReadableStream<Uint8Array> | undefined> {
		const parsed = parseAddress(rawAddress, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid blob V1 read RPC request');
		}
		return this.runOperation(async () =>
			(await this.blobs())
				.read(parsed.data)
				.then((stream) =>
					stream === undefined ? undefined : this.leaseBlobRead(stream),
				),
		);
	}

	/** Capture one immutable logical Backup under the supplied registry identity. */
	captureBackup(rawBackupId: unknown): Promise<{ recordCount: number }> {
		if (typeof rawBackupId !== 'string') {
			return Promise.reject(new TypeError('backup ID must be a string'));
		}
		let backupName: string;
		try {
			backupName = dataBackupV1Name(this.blobOwnerStorageKey, rawBackupId);
		} catch (cause) {
			return Promise.reject(cause);
		}
		if (this.backupCaptureFenced) {
			return Promise.reject(
				new Error('Data authority Backups are being deleted'),
			);
		}
		return this.runOperation(async () => {
			if (this.backupCaptureFenced) {
				throw new Error('Data authority Backups are being deleted');
			}
			return this.captureBackupOperation(rawBackupId, backupName);
		});
	}

	/** Read the canonical activation selector for lost Restore response recovery. */
	currentAuthorityLifetime(): Promise<string> {
		return this.runOperation(() => this.readCanonicalAuthorityLifetime());
	}

	/** Construct and atomically activate one sealed Backup as a fresh authority. */
	restoreBackup(
		rawBackupId: unknown,
		rawSuccessorLifetime: unknown,
	): Promise<{ authorityLifetime: string; recordCount: number }> {
		if (typeof rawBackupId !== 'string') {
			return Promise.reject(new TypeError('backup ID must be a string'));
		}
		let backupName: string;
		try {
			backupName = dataBackupV1Name(this.blobOwnerStorageKey, rawBackupId);
		} catch (cause) {
			return Promise.reject(cause);
		}
		const parsedLifetime = parseFactsRequest(
			{ authorityLifetime: rawSuccessorLifetime, afterSequence: 0 },
			SCALAR_SYNC_V1_LIMITS,
		);
		if (
			parsedLifetime.error !== null ||
			typeof rawSuccessorLifetime !== 'string'
		) {
			return Promise.reject(
				new TypeError('invalid Restore successor authority lifetime'),
			);
		}
		if (this.backupCaptureFenced) {
			return Promise.reject(new Error('Data authority is being deleted'));
		}
		if (this.restoreOperation !== undefined) {
			return Promise.reject(
				new Error('Data authority Restore is already active'),
			);
		}
		let restoring!: Promise<{
			authorityLifetime: string;
			recordCount: number;
		}>;
		restoring = this.runOperation((currentOperation) =>
			this.restoreBackupOperation({
				backupName,
				successorAuthorityLifetime: rawSuccessorLifetime,
				currentOperation,
			}),
		);
		this.restoreOperation = restoring;
		return restoring.finally(() => {
			if (this.restoreOperation === restoring)
				this.restoreOperation = undefined;
		});
	}

	override async fetch(request: Request): Promise<Response> {
		return this.runOperation(async () => {
			const url = new URL(request.url);
			if (
				request.method === 'GET' &&
				url.pathname === INTERNAL_DOCUMENT_REALTIME_PATH
			) {
				return this.acceptDocumentUpgrade(request);
			}
			return new Response(null, { status: 404 });
		});
	}

	override async webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		await this.runOperation(() => {
			const attachment = socket.deserializeAttachment();
			if (!isDataDocumentAttachment(attachment)) {
				socket.close(1011, 'invalid-document-attachment');
				return;
			}
			const currentLifetime = this.authority?.authorityLifetime();
			if (currentLifetime === undefined) {
				socket.close(1011, 'authority-unavailable');
				return;
			}
			if (attachment.authorityLifetime !== currentLifetime) {
				this.realtime?.disconnect(this.socket(socket));
				socket.close(1012, 'authority-replaced');
				return;
			}
			if (Date.now() >= attachment.authorizationExpiresAt) {
				this.realtime?.disconnect(this.socket(socket));
				socket.close(1000, 'credential-expired');
				return;
			}
			if (typeof message === 'string') {
				socket.close(1002, 'invalid-document-frame');
				return;
			}
			this.realtime?.receive(
				this.socket(socket),
				attachment.address,
				attachment.authorityLifetime,
				new Uint8Array(message),
			);
		});
	}

	override webSocketClose(socket: WebSocket): void {
		this.realtime?.disconnect(this.socket(socket));
	}

	override webSocketError(socket: WebSocket): void {
		this.webSocketClose(socket);
	}

	override async alarm(): Promise<void> {
		await this.runOperation(async () => {
			const now = Date.now();
			let nextExpiry: number | undefined;
			for (const socket of this.ctx.getWebSockets()) {
				if (socket.readyState !== WebSocket.OPEN) continue;
				const attachment = socket.deserializeAttachment();
				if (!isDataDocumentAttachment(attachment)) continue;
				if (attachment.authorizationExpiresAt <= now) {
					this.realtime?.disconnect(this.socket(socket));
					socket.close(1000, 'credential-expired');
				} else {
					nextExpiry = Math.min(
						nextExpiry ?? attachment.authorizationExpiresAt,
						attachment.authorizationExpiresAt,
					);
				}
			}
			if (nextExpiry === undefined) await this.ctx.storage.deleteAlarm();
			else await this.ctx.storage.setAlarm(nextExpiry);
		});
	}

	/** Delete every scalar V1 byte owned by this principal. */
	deleteAccount(): Promise<void> {
		this.backupCaptureFenced = true;
		if (this.accountDeletion !== undefined) return this.accountDeletion;
		if (this.maintenance === 'restore') {
			// Keep the Restore barrier installed and transfer it to deletion. The
			// Restore observes the synchronous fence and abandons before activation.
			this.maintenance = 'account-delete';
		} else if (this.maintenance === undefined) {
			this.beginMaintenance('account-delete');
		}
		const deletion = this.deleteAccountOperation().finally(() => {
			this.accountDeletion = undefined;
			this.finishMaintenance('account-delete');
		});
		this.accountDeletion = deletion;
		return deletion;
	}

	private async deleteAccountOperation(): Promise<void> {
		await this.ready;
		await this.cancelResourcesAndDrain();
		await this.ctx.blockConcurrencyWhile(async () => {
			this.closeDocumentSockets(1001, 'server-shutdown');
			await this.blobAuthority?.deleteAll();
			await deleteR2BlobOwner(this.env.DATA_BLOBS, this.blobOwnerStorageKey);
			this.realtime = undefined;
			this.authority = undefined;
			this.blobAuthority = undefined;
			await this.ctx.storage.deleteAll();
			// Authentication survives until the hosted deletion coordinator's last
			// step. Reopen an empty successor lifetime so a partial downstream
			// failure does not strand this actor in an unusable in-memory state.
			this.authority = this.openFreshOwner();
			this.blobAuthority = this.openBlobOwner(this.authority);
			await this.blobAuthority.reopenSweep();
			this.realtime = createDocumentRealtimeV1Server({
				authority: this.authority,
			});
			this.initializationError = undefined;
		});
	}

	private readCanonicalAuthorityLifetime(): string {
		const rows = this.database.all<{ authority_lifetime: string }>(
			'SELECT authority_lifetime FROM meta WHERE singleton = 1',
		);
		if (rows.length !== 1 || typeof rows[0]?.authority_lifetime !== 'string') {
			throw new Error('canonical authority lifetime is missing');
		}
		return rows[0].authority_lifetime;
	}

	private canonicalRecordCount(): number {
		const count = this.database.all<{ record_count: number }>(
			'SELECT count(*) AS record_count FROM records',
		)[0]?.record_count;
		if (!Number.isSafeInteger(count) || (count ?? -1) < 0) {
			throw new Error('canonical authority record count is invalid');
		}
		return count as number;
	}

	private async restoreBackupOperation({
		backupName,
		successorAuthorityLifetime,
		currentOperation,
	}: {
		backupName: string;
		successorAuthorityLifetime: string;
		currentOperation: Promise<unknown>;
	}): Promise<{ authorityLifetime: string; recordCount: number }> {
		await this.ready;
		if (this.readCanonicalAuthorityLifetime() === successorAuthorityLifetime) {
			return {
				authorityLifetime: successorAuthorityLifetime,
				recordCount: this.canonicalRecordCount(),
			};
		}
		if (this.backupCaptureFenced) {
			throw new Error('Data authority is being deleted');
		}

		const backup = this.env.DATA_BACKUP.getByName(backupName);
		const status = await backup.status();
		if (
			status.state !== 'sealed' ||
			!Number.isSafeInteger(status.recordCount) ||
			status.recordCount < 0
		) {
			throw new Error('Data authority Restore Backup is not sealed');
		}
		const expectedRecordCount = status.recordCount;
		let initialized = false;
		let activated = false;
		let restoreBarrier = false;
		let outgoingAuthorityLifetime: string | undefined;
		try {
			const construction = initializeCloudflareRestoreV1({
				database: this.database,
				successorAuthorityLifetime,
			});
			initialized = true;
			outgoingAuthorityLifetime = construction.outgoingAuthorityLifetime;

			let after: Parameters<DataBackupStub['readPage']>[0];
			let recordCount = 0;
			let blobCount = 0;
			for (;;) {
				if (this.backupCaptureFenced) {
					throw new Error('Data authority is being deleted');
				}
				const page = await backup.readPage(after);
				if (page.records.length > 0) {
					appendCloudflareRestoreV1Page({
						database: this.database,
						records: page.records,
					});
				}
				for (const record of page.records) {
					if (record.blobSha256 === null) continue;
					const source = await backup.openBlob(
						record.address,
						record.blobSha256,
					);
					await copyR2AuthorityBlob(
						this.env.DATA_BLOBS,
						this.blobOwnerStorageKey,
						successorAuthorityLifetime,
						blobFileOwner(record.address, record.blobSha256),
						source,
					);
					blobCount += 1;
				}
				recordCount += page.records.length;
				if (recordCount > expectedRecordCount) {
					throw new Error('Data authority Restore contains extra records');
				}
				if (page.nextAfter === undefined) break;
				if (page.records.length === 0) {
					throw new Error('Data authority Restore page did not advance');
				}
				after = page.nextAfter;
			}
			const sealed = sealCloudflareRestoreV1({
				database: this.database,
				expectedRecordCount,
			});
			if (
				sealed.authorityLifetime !== successorAuthorityLifetime ||
				sealed.recordCount !== expectedRecordCount ||
				recordCount !== expectedRecordCount
			) {
				throw new Error(
					'Data authority Restore staging result is not recognized',
				);
			}
			await sealR2AuthorityBlobs(
				this.env.DATA_BLOBS,
				this.blobOwnerStorageKey,
				successorAuthorityLifetime,
				blobCount,
			);
			if (this.backupCaptureFenced || this.maintenance !== undefined) {
				throw new Error(
					'Data authority cannot activate Restore while quiescing',
				);
			}

			this.beginMaintenance('restore');
			restoreBarrier = true;
			await this.cancelResourcesAndDrain(currentOperation);
			if (this.backupCaptureFenced || this.maintenance !== 'restore') {
				throw new Error('Data authority Restore was superseded by deletion');
			}
			this.closeDocumentSockets(1012, 'authority-replaced');
			const activation = activateCloudflareRestoreV1({
				database: this.database,
				outgoingAuthorityLifetime,
			});
			activated = true;
			this.authority = openScalarAuthorityV1({
				database: this.database,
				limits: SCALAR_SYNC_V1_LIMITS,
			});
			this.blobAuthority = this.openBlobOwner(this.authority);
			this.realtime = createDocumentRealtimeV1Server({
				authority: this.authority,
			});
			this.initializationError = undefined;
			this.finishMaintenance('restore');
			restoreBarrier = false;
			this.ctx.waitUntil(
				deleteR2AuthorityLifetime(
					this.env.DATA_BLOBS,
					this.blobOwnerStorageKey,
					outgoingAuthorityLifetime,
				),
			);
			return {
				authorityLifetime: activation.authorityLifetime,
				recordCount: activation.recordCount,
			};
		} catch (cause) {
			const cleanupFailures: unknown[] = [];
			if (!activated && initialized) {
				try {
					abandonCloudflareRestoreV1(this.database);
				} catch (failure) {
					cleanupFailures.push(failure);
				}
				await deleteR2AuthorityLifetime(
					this.env.DATA_BLOBS,
					this.blobOwnerStorageKey,
					successorAuthorityLifetime,
				).catch((failure) => cleanupFailures.push(failure));
			}
			if (restoreBarrier && this.maintenance === 'restore') {
				this.finishMaintenance('restore');
			}
			if (activated) this.initializationError = cause;
			if (cleanupFailures.length > 0) {
				throw new AggregateError(
					[cause, ...cleanupFailures],
					'Data authority Restore failed and cleanup was incomplete',
				);
			}
			throw cause;
		}
	}

	private beginMaintenance(kind: 'restore' | 'account-delete'): void {
		if (this.operationBarrier !== undefined || this.maintenance !== undefined) {
			throw new Error('Data authority is already quiescing');
		}
		this.maintenance = kind;
		this.operationBarrier = new Promise<void>((resolve) => {
			this.releaseOperationBarrier = resolve;
		});
	}

	private finishMaintenance(kind: 'restore' | 'account-delete'): void {
		if (this.maintenance !== kind) return;
		const release = this.releaseOperationBarrier;
		this.maintenance = undefined;
		this.operationBarrier = undefined;
		this.releaseOperationBarrier = undefined;
		release?.();
	}

	private async cancelResourcesAndDrain(
		excluded?: Promise<unknown>,
	): Promise<void> {
		while ([...this.operations].some((operation) => operation !== excluded)) {
			await Promise.allSettled(
				[...this.resourceCancels].map((cancel) => cancel()),
			);
			await Promise.allSettled(
				[...this.operations].filter((operation) => operation !== excluded),
			);
		}
	}

	private leaseBlobRead(
		source: ReadableStream<Uint8Array>,
	): ReadableStream<Uint8Array> {
		const reader = source.getReader();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let completed = false;
		let releaseHold!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});
		this.operations.add(hold);

		const finish = async (cancel: boolean): Promise<void> => {
			if (completed) return;
			completed = true;
			this.resourceCancels.delete(cancelResource);
			try {
				if (cancel) await reader.cancel('authority-replaced');
			} finally {
				reader.releaseLock();
				this.operations.delete(hold);
				releaseHold();
			}
		};
		const cancelResource = async (): Promise<void> => {
			if (completed) return;
			controller?.error(
				new Error('Blob read interrupted by authority replacement'),
			);
			await finish(true);
		};
		this.resourceCancels.add(cancelResource);

		return new ReadableStream<Uint8Array>({
			start(outward) {
				controller = outward;
			},
			async pull(outward) {
				if (completed) {
					outward.close();
					return;
				}
				try {
					const result = await reader.read();
					if (result.done) {
						await finish(false);
						outward.close();
					} else {
						outward.enqueue(result.value);
					}
				} catch (cause) {
					const interrupted = completed;
					await finish(false);
					if (!interrupted) outward.error(cause);
				}
			},
			cancel: () => finish(true),
		});
	}

	private async captureBackupOperation(
		backupId: string,
		backupName: string,
	): Promise<{ recordCount: number }> {
		const captures = createAuthorityCaptureManifestV1(this.database);
		const backup = this.env.DATA_BACKUP.getByName(backupName);
		let started = false;
		let sealedRecordCount: number | undefined;
		try {
			captures.start(backupId);
			started = true;
			const captureDeadline = Date.now() + MAX_CAPTURE_MILLISECONDS;
			while (Date.now() < captureDeadline) {
				const progress = captures.advance(backupId);
				if (progress.kind === 'document-not-settled') {
					throw new Error('portable capture document is not settled');
				}
				if (progress.caughtUp) {
					const outcome = captures.seal(backupId);
					if (outcome.kind === 'document-not-settled') {
						throw new Error('portable capture document is not settled');
					}
					if (outcome.kind === 'sealed') {
						sealedRecordCount = outcome.recordCount;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			if (sealedRecordCount === undefined) {
				throw new Error('portable capture could not reach a bounded final cut');
			}

			await backup.initialize(sealedRecordCount);
			let afterRecordId = 0;
			for (;;) {
				const page = captures.readPage(backupId, afterRecordId);
				if (page.entries.length > 0) await backup.append(page.entries);
				for (const record of page.entries) {
					if (record.blobSha256 === null) continue;
					const read = await (await this.blobs()).readCapture(
						backupId,
						record.address,
						record.blobSha256,
					);
					if (read === undefined) {
						throw new Error('portable capture blob pin is missing');
					}
					await backup.putBlob(record.address, record.blobSha256, read);
				}
				if (page.nextAfterRecordId === undefined) break;
				afterRecordId = page.nextAfterRecordId;
			}
			const sealed = await backup.seal();
			if (sealed.recordCount !== sealedRecordCount) {
				throw new Error('Backup sealed with an unexpected record count');
			}
			captures.finish(backupId, 'succeeded');
			return { recordCount: sealed.recordCount };
		} catch (cause) {
			let status: CloudflareBackupV1Status | undefined;
			try {
				status = await backup.status();
			} catch {
				// Destructive cleanup below owns unrecognized partial state.
			}
			if (
				status?.state === 'sealed' &&
				status.recordCount === sealedRecordCount
			) {
				captures.finish(backupId, 'succeeded');
				return { recordCount: status.recordCount };
			}
			if (started) {
				try {
					captures.finish(backupId, 'cancelled');
				} catch {
					// Reopen recovery marks an interrupted manifest crashed.
				}
			}
			try {
				await backup.destroy();
			} catch {
				// The registry retries destruction before publishing or deleting.
			}
			throw cause;
		}
	}

	private async runOperation<TResult>(
		operation: (
			currentOperation: Promise<unknown>,
		) => TResult | Promise<TResult>,
	): Promise<TResult> {
		await this.ready;
		const barrier = this.operationBarrier;
		if (barrier !== undefined) {
			await barrier;
			return this.runOperation(operation);
		}
		let result!: Promise<TResult>;
		result = Promise.resolve().then(() => operation(result));
		return this.trackOperation(result);
	}

	private trackOperation<TResult>(
		operation: Promise<TResult>,
	): Promise<TResult> {
		this.operations.add(operation);
		void operation
			.finally(() => this.operations.delete(operation))
			.catch(() => undefined);
		return operation;
	}

	private async owner(): Promise<DataAuthorityV1> {
		await this.ready;
		if (this.initializationError !== undefined) {
			throw this.initializationError;
		}
		if (this.authority === undefined) {
			throw new Error('scalar V1 authority is unavailable');
		}
		return this.authority;
	}

	private async blobs(): Promise<
		AuthorityBlobV1<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>>
	> {
		await this.ready;
		if (this.initializationError !== undefined) throw this.initializationError;
		if (this.blobAuthority === undefined) {
			throw new Error('blob V1 authority is unavailable');
		}
		return this.blobAuthority;
	}

	private openFreshOwner(): DataAuthorityV1 {
		return openScalarAuthorityV1({
			database: this.database,
			limits: SCALAR_SYNC_V1_LIMITS,
			initialize: { authorityLifetime: crypto.randomUUID() },
		});
	}

	private openBlobOwner(
		authority: DataAuthorityV1,
	): AuthorityBlobV1<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>> {
		return createAuthorityBlobV1(
			this.database,
			createR2BlobFileStore(
				this.env.DATA_BLOBS,
				this.blobOwnerStorageKey,
				authority.authorityLifetime(),
			),
		);
	}

	private closeDocumentSockets(code: number, reason: string): void {
		for (const socket of this.ctx.getWebSockets()) socket.close(code, reason);
	}

	private async acceptDocumentUpgrade(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 426 });
		}
		if (
			request.headers.get('sec-websocket-protocol') !== DOCUMENT_SUBPROTOCOL
		) {
			return new Response(null, { status: 400 });
		}
		const address = {
			namespace: request.headers.get(ADDRESS_NAMESPACE_HEADER),
			collection: request.headers.get(ADDRESS_COLLECTION_HEADER),
			recordKey: request.headers.get(ADDRESS_RECORD_HEADER),
		};
		const authorityLifetime = request.headers.get(AUTHORITY_LIFETIME_HEADER);
		const authorizationExpiresAt = Number(
			request.headers.get(AUTHORIZATION_EXPIRES_HEADER),
		);
		const parsedAddress = parseAddress(address, SCALAR_SYNC_V1_LIMITS);
		const parsedLifetime = parseFactsRequest(
			{ authorityLifetime, afterSequence: 0 },
			SCALAR_SYNC_V1_LIMITS,
		);
		if (
			parsedAddress.error !== null ||
			parsedLifetime.error !== null ||
			authorityLifetime === null ||
			!Number.isSafeInteger(authorizationExpiresAt) ||
			authorizationExpiresAt <= Date.now()
		) {
			return new Response(null, { status: 400 });
		}
		const authority = await this.owner();
		if (authority.authorityLifetime() !== authorityLifetime) {
			return new Response(null, { status: 409 });
		}
		if (!this.realtime?.admit(parsedAddress.data)) {
			return new Response(null, { status: 404 });
		}
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm === null || authorizationExpiresAt < currentAlarm) {
			await this.ctx.storage.setAlarm(authorizationExpiresAt);
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		const attachment: DataDocumentAttachment = {
			version: 1,
			protocol: DOCUMENT_SUBPROTOCOL,
			address: parsedAddress.data,
			authorityLifetime,
			authorizationExpiresAt,
		};
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { 'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL },
		});
	}

	private socket(socket: WebSocket): DocumentRealtimeV1Socket {
		let adapter = this.sockets.get(socket);
		if (adapter === undefined) {
			adapter = {
				send: (data) => socket.send(data),
				close: (code, reason) => socket.close(code, reason),
			};
			this.sockets.set(socket, adapter);
		}
		return adapter;
	}
}

/** Narrow RPC namespace shape consumed by the shared mount. */
export type DataAuthorityNamespace = {
	getByName(name: string): ScalarAuthorityV1Endpoint &
		DocumentAuthorityV1Endpoint & {
			acceptBlob(
				request: Parameters<BlobAuthorityV1Endpoint['accept']>[0],
				bytes: ReadableStream<Uint8Array>,
			): Promise<BlobAcceptance>;
			readBlob(
				address: Parameters<BlobAuthorityV1Endpoint['read']>[0],
			): Promise<ReadableStream<Uint8Array> | undefined>;
			fetch(request: Request): Promise<Response>;
		};
};

export type DeletableDataAuthorityNamespace = {
	getByName(name: string): { deleteAccount(): Promise<void> };
};

function stubFor(
	namespace: DataAuthorityNamespace,
	principalId: PrincipalId,
): ScalarAuthorityV1Endpoint & DocumentAuthorityV1Endpoint {
	const stub = namespace.getByName(principalName(principalId));
	return {
		readFacts: (request) => stub.readFacts(request),
		submit: (request) => stub.submit(request),
		acceptDocument: (request) => stub.acceptDocument(request),
	};
}

function blobStubFor(
	namespace: DataAuthorityNamespace,
	principalId: PrincipalId,
): BlobAuthorityV1Endpoint {
	const stub = namespace.getByName(principalName(principalId));
	return {
		accept: (request, bytes) => stub.acceptBlob(request, bytes),
		read: (address) => stub.readBlob(address),
	};
}

/** Mount the authenticated Data V1 surfaces on a Cloudflare deployment. */
export function mountCloudflareScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveDocumentPrincipal,
		resolveNamespace,
		resolveBackupRegistry,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
		resolveNamespace(env: E['Bindings']): DataAuthorityNamespace;
		resolveBackupRegistry(env: E['Bindings']): DataBackupRegistryNamespace;
	},
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: (principalId, env) =>
			stubFor(resolveNamespace(env), principalId),
	});
	mountDocumentV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: (principalId, env) =>
			stubFor(resolveNamespace(env), principalId),
	});
	mountBlobV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: (principalId, env) =>
			blobStubFor(resolveNamespace(env), principalId),
	});
	mountBackupV1App(app, {
		auth,
		locateRegistry: (principalId, env) =>
			locateDataBackupRegistryV1(resolveBackupRegistry(env), principalId),
		restoreBackup: (principalId, backupId, restoreRequestId, env) =>
			locateDataBackupRegistryV1(
				resolveBackupRegistry(env),
				principalId,
			).restore(backupId, restoreRequestId),
	});
	app.get(DOCUMENT_V1_REALTIME_PATH, async (c) => {
		const verified = await resolveDocumentRealtimeV1Upgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (verified === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		const headers = new Headers({
			upgrade: 'websocket',
			'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL,
			[ADDRESS_NAMESPACE_HEADER]: verified.address.namespace,
			[ADDRESS_COLLECTION_HEADER]: verified.address.collection,
			[ADDRESS_RECORD_HEADER]: verified.address.recordKey,
			[AUTHORITY_LIFETIME_HEADER]: verified.authorityLifetime,
			[AUTHORIZATION_EXPIRES_HEADER]: String(verified.authorizationExpiresAt),
		});
		return resolveNamespace(c.env)
			.getByName(principalName(verified.principalId))
			.fetch(
				new Request(
					`https://data-authority.internal${INTERNAL_DOCUMENT_REALTIME_PATH}`,
					{ headers },
				),
			);
	});
}

/** Bind hosted account deletion to the new principal-owned authority. */
export function createDataAuthorityAccountAuthorities(
	namespace: DeletableDataAuthorityNamespace,
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
