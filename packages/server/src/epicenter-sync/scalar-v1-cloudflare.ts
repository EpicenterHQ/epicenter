import { DurableObject } from 'cloudflare:workers';

import {
	type BlobAcceptance,
	parseBlobPublicationRequest,
} from '@epicenter/data/blob-v1';
import {
	type DocumentAcceptance,
	type DocumentPull,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
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
import type { Hono, MiddlewareHandler } from 'hono';
import type { Result } from 'wellcrafted/result';

import type { Env } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import {
	type AuthorityBlobV1,
	createAuthorityBlobV1,
} from './blob-authority-v1.js';
import { createR2BlobFileStore } from './blob-files-r2.js';
import {
	type BlobAuthorityV1Endpoint,
	mountBlobV1App,
} from './blob-v1-route.js';
import {
	type DocumentAuthorityV1Endpoint,
	mountDocumentV1App,
} from './document-v1-route.js';
import {
	mountScalarV1App,
	type ScalarAuthorityV1Endpoint,
} from './scalar-v1-route.js';

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

export type DataAuthorityEnv = Cloudflare.Env & { DATA_BLOBS: R2Bucket };

/** One principal-owned scalar V1 authority on Durable Object SQLite. */
export class DataAuthority extends DurableObject<DataAuthorityEnv> {
	private readonly database: ReturnType<
		typeof createDurableObjectSqliteAdapter
	>;
	private authority: DataAuthorityV1 | undefined;
	private blobAuthority:
		| AuthorityBlobV1<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>>
		| undefined;
	private readonly blobFiles: ReturnType<typeof createR2BlobFileStore>;
	private initializationError: unknown;
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: DataAuthorityEnv) {
		super(ctx, env);
		this.database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.blobFiles = createR2BlobFileStore(env.DATA_BLOBS, ctx.id.toString());
		this.ready = ctx.blockConcurrencyWhile(async () => {
			try {
				this.authority = this.openFreshOwner();
				this.blobAuthority = createAuthorityBlobV1(
					this.database,
					this.blobFiles,
				);
				await this.blobAuthority.reopenSweep();
			} catch (cause) {
				// Keep the actor reachable for account deletion. A rejected constructor
				// block prevents later RPC events from reaching deleteAccount at all.
				this.initializationError = cause;
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
		return (await this.owner()).readFacts(parsed.data);
	}

	async submit(
		rawRequest: unknown,
	): Promise<Result<SubmissionResponse, AuthorityError>> {
		const parsed = parseSubmissionRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 submission RPC request');
		}
		const result = (await this.owner()).submit(parsed.data);
		if (result.error === null) {
			let reapedBlob = false;
			for (const fact of result.data.facts) {
				if (fact.state === 'tombstone') reapedBlob = true;
			}
			if (reapedBlob && this.blobAuthority !== undefined) {
				this.ctx.waitUntil(this.blobAuthority.sweepDebris());
			}
		}
		return result;
	}

	async acceptDocument(rawRequest: unknown): Promise<DocumentAcceptance> {
		const parsed = parseDocumentPublicationRequest(
			rawRequest,
			SCALAR_SYNC_V1_LIMITS,
		);
		if (parsed === undefined) {
			throw new TypeError('invalid document V1 publication RPC request');
		}
		return (await this.owner()).acceptDocument(parsed);
	}

	async pullDocument(rawRequest: unknown): Promise<DocumentPull> {
		const request = rawRequest as {
			authorityLifetime?: unknown;
			address?: unknown;
			knownDocumentVersion?: unknown;
		};
		const address = parseAddress(request.address, SCALAR_SYNC_V1_LIMITS);
		if (
			typeof request.authorityLifetime !== 'string' ||
			address.error !== null ||
			(request.knownDocumentVersion !== null &&
				typeof request.knownDocumentVersion !== 'string')
		) {
			throw new TypeError('invalid document V1 pull RPC request');
		}
		return (await this.owner()).pullDocument({
			authorityLifetime: request.authorityLifetime,
			address: address.data,
			knownDocumentVersion: request.knownDocumentVersion,
		});
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
		return (await this.blobs()).accept(parsed, bytes);
	}

	async readBlob(
		rawAddress: unknown,
	): Promise<ReadableStream<Uint8Array> | undefined> {
		const parsed = parseAddress(rawAddress, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid blob V1 read RPC request');
		}
		return (await this.blobs()).read(parsed.data);
	}

	/** Delete every scalar V1 byte owned by this principal. */
	async deleteAccount(): Promise<void> {
		await this.ready;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.blobAuthority === undefined) {
				await this.blobFiles.sweepStaging();
				await this.blobFiles.sweepContent([]);
			} else {
				await this.blobAuthority.deleteAll();
			}
			this.authority = undefined;
			this.blobAuthority = undefined;
			await this.ctx.storage.deleteAll();
			// Authentication survives until the hosted deletion coordinator's last
			// step. Reopen an empty successor lifetime so a partial downstream
			// failure does not strand this actor in an unusable in-memory state.
			this.authority = this.openFreshOwner();
			this.blobAuthority = createAuthorityBlobV1(this.database, this.blobFiles);
			this.initializationError = undefined;
		});
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
		pullDocument: (request) => stub.pullDocument(request),
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
		resolveNamespace,
	}: {
		auth: MiddlewareHandler<E>;
		resolveNamespace(env: E['Bindings']): DataAuthorityNamespace;
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
