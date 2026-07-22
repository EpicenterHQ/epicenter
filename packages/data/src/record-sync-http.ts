import type { BlobAcceptance } from './blob-v1/index.js';
import type { DocumentAcceptance } from './document-v1/index.js';
import {
	type FactsRequest,
	type FactsResponse,
	SCALAR_SYNC_V1_LIMITS,
	type SubmissionResponse,
	type ValidatedLimits,
} from './protocol/v1/index.js';
import {
	RecordAuthorityLifetimeMismatchError,
	type RecordSyncSession,
	type RecordSyncTransport,
} from './record-sync-supervisor.js';
import type { FirstAttachmentChoice } from './store/replica/index.js';
import type { SyncCredentialProvider } from './sync-supervisor.js';

const FACTS_PATH = 'api/sync/v1/facts';
const SUBMISSIONS_PATH = 'api/sync/v1/submissions';
const MAX_PLANE_RESPONSE_BYTES = 64 * 1024;

type Fetch = (request: Request) => Promise<Response>;
export type RecordBlobHttpBody = Blob | ReadableStream<Uint8Array>;

function bearer(credentials: SyncCredentialProvider): string {
	const token = credentials.get();
	if (token === undefined) throw new Error('Sync credentials are unavailable');
	if (token.length === 0 || /[\r\n]/u.test(token)) {
		throw new Error('Sync bearer is invalid');
	}
	return `Bearer ${token}`;
}

function endpoint(deploymentId: string, path: string): URL {
	return new URL(path, deploymentId);
}

async function readJson(
	response: Response,
	maximumBytes: number,
): Promise<unknown> {
	if (response.body === null) throw new Error('Sync response body is missing');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		total += part.value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel();
			throw new Error('Sync response exceeds its byte ceiling');
		}
		chunks.push(part.value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new Error('Sync response is not valid UTF-8 JSON', { cause });
	}
}

function lifetimeMismatch(value: unknown): string | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!Object.hasOwn(value, 'error') ||
		!Object.hasOwn(value, 'activeAuthorityLifetime')
	) {
		return undefined;
	}
	const candidate = value as {
		error: unknown;
		activeAuthorityLifetime: unknown;
	};
	return candidate.error === 'lifetime-mismatch' &&
		typeof candidate.activeAuthorityLifetime === 'string'
		? candidate.activeAuthorityLifetime
		: undefined;
}

async function scalarResponse<T>(
	response: Response,
	maximumBytes: number,
): Promise<T> {
	const value = await readJson(response, maximumBytes);
	if (response.ok) return value as T;
	const active = lifetimeMismatch(value);
	if (response.status === 409 && active !== undefined) {
		throw new RecordAuthorityLifetimeMismatchError(active);
	}
	throw new Error(`Sync request failed with HTTP ${response.status}`);
}

async function planeResponse<T>(
	response: Response,
	kinds: readonly string[],
): Promise<T> {
	const value = await readJson(response, MAX_PLANE_RESPONSE_BYTES);
	if (response.status !== 200 && response.status !== 409) {
		throw new Error(`Sync request failed with HTTP ${response.status}`);
	}
	if (
		typeof value !== 'object' ||
		value === null ||
		!Object.hasOwn(value, 'kind') ||
		typeof (value as { kind: unknown }).kind !== 'string' ||
		!kinds.includes((value as { kind: string }).kind)
	) {
		throw new Error('Sync response has an unknown acceptance shape');
	}
	return value as T;
}

function planePath(
	address: { namespace: string; collection: string; recordKey: string },
	suffix: string,
): string {
	return `api/sync/v1/records/${encodeURIComponent(address.namespace)}/${encodeURIComponent(address.collection)}/${encodeURIComponent(address.recordKey)}/${suffix}`;
}

/** Create the strict bearer-authenticated HTTP realization of Sync V1. */
export function createHttpRecordSyncTransport<
	TBlobRead extends RecordBlobHttpBody,
>({
	deploymentId,
	credentials,
	limits = SCALAR_SYNC_V1_LIMITS,
	fetch: runFetch = globalThis.fetch,
}: {
	deploymentId: string;
	credentials: SyncCredentialProvider;
	limits?: ValidatedLimits;
	fetch?: Fetch;
}): RecordSyncTransport<TBlobRead> {
	function headers(extra: Record<string, string> = {}): Headers {
		return new Headers({ ...extra, authorization: bearer(credentials) });
	}

	return {
		async readFacts(request: FactsRequest): Promise<FactsResponse> {
			const url = endpoint(deploymentId, FACTS_PATH);
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			return scalarResponse<FactsResponse>(
				await runFetch(new Request(url.href, { headers: headers() })),
				limits.maxFactsResponseBytes,
			);
		},
		async submit(request): Promise<SubmissionResponse> {
			return scalarResponse<SubmissionResponse>(
				await runFetch(
					new Request(endpoint(deploymentId, SUBMISSIONS_PATH).href, {
						method: 'POST',
						headers: headers({ 'content-type': 'application/json' }),
						body: request.bytes,
					}),
				),
				limits.maxSubmissionResponseBytes,
			);
		},
		async publishDocument(request): Promise<DocumentAcceptance> {
			const response = await runFetch(
				new Request(
					endpoint(
						deploymentId,
						planePath(request.address, 'document-publications'),
					).href,
					{
						method: 'POST',
						headers: headers({
							'content-type': 'application/octet-stream',
							'x-epicenter-authority-lifetime': request.authorityLifetime,
							'x-epicenter-document-protocol': request.protocolVersion,
							'x-epicenter-document-digest': request.digest,
						}),
						body: request.payload,
					},
				),
			);
			return planeResponse<DocumentAcceptance>(response, [
				'accepted',
				'document-bound',
				'record-not-live',
				'lifetime-mismatch',
			]);
		},
		async publishBlob(publication): Promise<BlobAcceptance> {
			const init: RequestInit & { duplex?: 'half' } = {
				method: 'POST',
				headers: headers({
					'content-type': 'application/octet-stream',
					'x-epicenter-authority-lifetime':
						publication.request.authorityLifetime,
					'x-epicenter-blob-protocol': publication.request.protocolVersion,
					'x-epicenter-blob-digest': publication.request.digest,
				}),
				body: publication.bytes,
			};
			if (publication.bytes instanceof ReadableStream) init.duplex = 'half';
			const response = await runFetch(
				new Request(
					endpoint(
						deploymentId,
						planePath(publication.request.address, 'blob-publications'),
					).href,
					init,
				),
			);
			return planeResponse<BlobAcceptance>(response, [
				'accepted',
				'blob-conflict',
				'record-not-live',
				'lifetime-mismatch',
			]);
		},
	};
}

/** Build the ordinary public attachment session over the HTTP transport. */
export function createHttpRecordSyncSession<
	TBlobRead extends RecordBlobHttpBody,
>({
	deploymentId,
	principalId,
	credentials,
	firstAttachmentChoice,
	limits,
	fetch,
}: {
	deploymentId: string;
	principalId: string;
	credentials: SyncCredentialProvider;
	firstAttachmentChoice?: FirstAttachmentChoice;
	limits?: ValidatedLimits;
	fetch?: Fetch;
}): RecordSyncSession<TBlobRead> {
	return {
		attachment: { deploymentId, principalId },
		...(firstAttachmentChoice === undefined ? {} : { firstAttachmentChoice }),
		credentials,
		transport: createHttpRecordSyncTransport<TBlobRead>({
			deploymentId,
			credentials,
			...(limits === undefined ? {} : { limits }),
			...(fetch === undefined ? {} : { fetch }),
		}),
	};
}
