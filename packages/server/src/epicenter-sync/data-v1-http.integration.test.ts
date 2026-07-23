/**
 * Data V1 Cross-Plane HTTP Integration Proof
 *
 * Carries one record's scalar fact, Yjs document, and immutable blob from a
 * file-backed Bun replica through the production Bun HTTP authority. A second
 * replica installs the accepted state, then a tombstone reaps every plane on
 * both replicas and the authority.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobAcceptance,
} from '@epicenter/data/blob-v1';
import { createBunBlobFileStore } from '@epicenter/data/bun';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
} from '@epicenter/data/document-v1';
import {
	type FactsResponse,
	SCALAR_SYNC_V1_LIMITS,
	type SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Hono, type MiddlewareHandler } from 'hono';

import { createReplicaBlobStore } from '../../../data/src/store/replica/blob-store.js';
import {
	openReplicaStore,
	type ReplicaStore,
} from '../../../data/src/store/replica/index.js';
import type { Env } from '../types.js';
import {
	BLOB_DIGEST_HEADER,
	BLOB_LIFETIME_HEADER,
	BLOB_PROTOCOL_HEADER,
} from './blob-v1-route.js';
import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
} from './document-v1-route.js';
import {
	createBunScalarV1Runtime,
	mountBunScalarV1App,
} from './scalar-v1-bun.js';
import {
	SCALAR_V1_FACTS_PATH,
	SCALAR_V1_SUBMISSIONS_PATH,
} from './scalar-v1-route.js';

const PRINCIPAL_ID = asPrincipalId('cross-plane-proof-principal');
const ADDRESS = {
	namespace: 'so.epicenter.whispering',
	collection: 'recordings',
	recordKey: 'cccccccccccccccccccccccc',
} as const;
const DOCUMENT_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/document-publications`;
const BLOB_PUBLICATION_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/blob-publications`;
const BLOB_READ_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/blob`;

type OpenedReplica = {
	raw: Database;
	store: ReplicaStore;
	blobs: ReturnType<
		typeof createReplicaBlobStore<
			AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
			ReadableStream<Uint8Array>
		>
	>;
};

function openReplica(root: string, replicaId?: string): OpenedReplica {
	mkdirSync(root, { recursive: true });
	const raw = new Database(join(root, 'epicenter.sqlite'), {
		create: true,
		strict: true,
	});
	try {
		const database = createBunSqliteAdapter(raw);
		return {
			raw,
			store: openReplicaStore({
				database,
				limits: SCALAR_SYNC_V1_LIMITS,
				...(replicaId === undefined ? {} : { initialize: { replicaId } }),
			}),
			blobs: createReplicaBlobStore(database, createBunBlobFileStore(root)),
		};
	} catch (cause) {
		raw.close();
		throw cause;
	}
}

function openHttpAuthority(root: string) {
	const runtime = createBunScalarV1Runtime({ dir: root });
	const app = new Hono<Env>();
	const auth: MiddlewareHandler<Env> = async (c, next) => {
		c.set('principal', { id: PRINCIPAL_ID });
		await next();
	};
	mountBunScalarV1App(app, {
		auth,
		resolveDocumentPrincipal: async () => {
			throw new Error('WebSocket upgrade is outside the HTTP proof');
		},
		runtime,
	});
	return { app, runtime };
}

async function readFacts(app: Hono<Env>, store: ReplicaStore): Promise<void> {
	const sync = store.sync();
	const url = new URL(`http://localhost${SCALAR_V1_FACTS_PATH}`);
	url.searchParams.set('afterSequence', String(sync.afterSequence));
	if (sync.authorityLifetime !== null) {
		url.searchParams.set('authorityLifetime', sync.authorityLifetime);
	}
	const request = {
		...(sync.authorityLifetime === null
			? {}
			: { authorityLifetime: sync.authorityLifetime }),
		afterSequence: sync.afterSequence,
	};
	const response = await app.request(url.toString());
	expect(response.status).toBe(200);
	store.installFacts({
		request,
		response: (await response.json()) as FactsResponse,
	});
}

async function submit(app: Hono<Env>, store: ReplicaStore) {
	const sealed = store.seal();
	const response = await app.request(SCALAR_V1_SUBMISSIONS_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: sealed.bytes,
	});
	expect(response.status).toBe(200);
	const accepted = (await response.json()) as SubmissionResponse;
	store.settle(accepted);
	return accepted;
}

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('content').insert(0, value);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function documentText(update: Uint8Array | undefined): string | undefined {
	if (update === undefined) return undefined;
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		return document.get('content').toString();
	} finally {
		document.destroy();
	}
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

async function* blobSource(value: string): AsyncIterable<Uint8Array> {
	yield new TextEncoder().encode(value);
}

async function streamText(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string | undefined> {
	return stream === null ? undefined : new Response(stream).text();
}

test('scalar, document, and blob state converge through one authority and tombstone together', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-data-v1-http-proof-'));
	const firstRoot = join(root, 'first');
	const secondRoot = join(root, 'second');
	let first = openReplica(firstRoot, 'aaaaaaaaaaaaaaaaaaaaaaaa');
	const second = openReplica(secondRoot, 'bbbbbbbbbbbbbbbbbbbbbbbb');
	const authority = openHttpAuthority(join(root, 'authority'));
	try {
		await first.blobs.reopenSweep();
		await second.blobs.reopenSweep();
		await readFacts(authority.app, first.store);
		await readFacts(authority.app, second.store);

		first.store.localWrite({
			address: ADDRESS,
			op: 'replace',
			value: { title: 'Cross-plane recording' },
		});
		first.store.appendLocalDocumentUpdate(
			ADDRESS,
			documentUpdate('durable transcript'),
		);
		await first.blobs.capture(ADDRESS, blobSource('durable audio'));
		await submit(authority.app, first.store);

		const document = first.store.documentPublication(ADDRESS);
		if (document.kind !== 'ready') {
			throw new Error('document publication was not ready');
		}
		const documentResponse = await authority.app.request(DOCUMENT_PATH, {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				[DOCUMENT_LIFETIME_HEADER]: document.publication.authorityLifetime,
				[DOCUMENT_PROTOCOL_HEADER]: DOCUMENT_PUBLICATION_VERSION,
				[DOCUMENT_DIGEST_HEADER]: document.publication.digest,
			},
			body: bodyOf(document.publication.payload),
		});
		expect(documentResponse.status).toBe(200);
		const documentAcceptance =
			(await documentResponse.json()) as DocumentAcceptance;
		if (documentAcceptance.kind !== 'accepted') {
			throw new Error('authority refused the bounded document');
		}
		first.store.settleDocumentPublication(ADDRESS, documentAcceptance.receipt, {
			revision: document.publication.capturedRevision,
			digest: document.publication.digest,
		});
		expect(first.store.inspectDocument(ADDRESS)?.owed).toBe(false);

		const blob = await first.blobs.publication(ADDRESS);
		if (blob === null) throw new Error('blob publication was not ready');
		const blobBytes = await new Response(blob.bytes).arrayBuffer();
		const blobHeaders = {
			'content-type': 'application/octet-stream',
			[BLOB_LIFETIME_HEADER]: blob.request.authorityLifetime,
			[BLOB_PROTOCOL_HEADER]: BLOB_PUBLICATION_VERSION,
			[BLOB_DIGEST_HEADER]: blob.request.digest,
		};
		const blobResponse = await authority.app.request(BLOB_PUBLICATION_PATH, {
			method: 'POST',
			headers: blobHeaders,
			body: blobBytes,
		});
		expect(blobResponse.status).toBe(200);
		const blobAcceptance = (await blobResponse.json()) as BlobAcceptance;
		await first.blobs.settle(ADDRESS, blobAcceptance);
		expect(first.blobs.inspect(ADDRESS).kind).toBe('accepted');

		const documentRetry = await authority.app.request(DOCUMENT_PATH, {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				[DOCUMENT_LIFETIME_HEADER]: document.publication.authorityLifetime,
				[DOCUMENT_PROTOCOL_HEADER]: DOCUMENT_PUBLICATION_VERSION,
				[DOCUMENT_DIGEST_HEADER]: document.publication.digest,
			},
			body: bodyOf(document.publication.payload),
		});
		expect((await documentRetry.json()) as DocumentAcceptance).toEqual(
			documentAcceptance,
		);
		const blobRetry = await authority.app.request(BLOB_PUBLICATION_PATH, {
			method: 'POST',
			headers: blobHeaders,
			body: blobBytes,
		});
		expect((await blobRetry.json()) as BlobAcceptance).toEqual(blobAcceptance);

		await readFacts(authority.app, second.store);
		const authorityDocument = authority.runtime
			.locateAuthority(PRINCIPAL_ID)
			.exportDocument(ADDRESS);
		if (authorityDocument === undefined) {
			throw new Error('authority document was not exportable');
		}
		second.store.installAcceptedDocumentUpdate(ADDRESS, authorityDocument);
		expect(second.store.record(ADDRESS)?.confirmed).toMatchObject({
			state: 'live',
			payload: { title: 'Cross-plane recording' },
		});
		expect(documentText(second.store.exportDocument(ADDRESS))).toBe(
			'durable transcript',
		);
		const remoteBlob = await authority.app.request(BLOB_READ_PATH);
		expect(remoteBlob.status).toBe(200);
		expect(await remoteBlob.text()).toBe('durable audio');

		first.raw.close();
		first = openReplica(firstRoot);
		await first.blobs.reopenSweep();
		expect(documentText(first.store.exportDocument(ADDRESS))).toBe(
			'durable transcript',
		);
		expect(await streamText(await first.blobs.read(ADDRESS))).toBe(
			'durable audio',
		);

		first.store.localWrite({ address: ADDRESS, op: 'tombstone' });
		expect(first.store.exportDocument(ADDRESS)).toBeUndefined();
		expect(first.blobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
		await first.blobs.sweepDebris();
		await submit(authority.app, first.store);
		await readFacts(authority.app, second.store);
		expect(second.store.record(ADDRESS)?.confirmed?.state).toBe('tombstone');
		expect(second.store.exportDocument(ADDRESS)).toBeUndefined();
		expect(second.blobs.inspect(ADDRESS)).toEqual({ kind: 'absent' });
		expect((await authority.app.request(BLOB_READ_PATH)).status).toBe(404);
		expect(
			authority.runtime.locateAuthority(PRINCIPAL_ID).exportDocument(ADDRESS),
		).toBeUndefined();
	} finally {
		first.raw.close();
		second.raw.close();
		await authority.runtime.close();
		rmSync(root, { recursive: true, force: true });
	}
});
