import type {
	DocumentAcceptance,
	DocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import type {
	AuthorityError,
	FactsResponse,
	RecordAddress,
	SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { measureDocumentState } from '@epicenter/sync/document-v3';
import type { Result } from 'wellcrafted/result';

import { createAuthorityDocumentV1 } from '../document-authority-v1.js';
import { DataAuthority } from '../scalar-v1-cloudflare.js';

type DocumentState = {
	authorityLifetime: string;
	captureRevision: number;
	nextCaptureRevision: number;
	chainEntries: number;
	chainBytes: number;
	digest: string | null;
	measure: ReturnType<typeof measureDocumentState> | null;
};

type EvidenceDatabase = SqliteDatabase & {
	all<TRow extends Record<string, unknown>>(
		sql: string,
		parameters?: readonly (string | number | null | Uint8Array)[],
	): TRow[];
};

/**
 * Evidence-only subclass that reads the private production relation after
 * inherited DataAuthority operations settle. It adds no behavior to the
 * authority path under measurement.
 */
export class DocumentBoundEvidenceAuthority extends DataAuthority {
	async evidenceState(address: RecordAddress): Promise<DocumentState> {
		const authorityLifetime = await this.currentAuthorityLifetime();
		const database = (this as unknown as { database: EvidenceDatabase })
			.database;
		const record = database.all<{
			record_id: number;
			capture_revision: number;
		}>(
			`SELECT record_id, capture_revision
			FROM records
			WHERE namespace = ? AND collection = ? AND record_key = ?`,
			[address.namespace, address.collection, address.recordKey],
		)[0];
		const meta = database.all<{ next_capture_revision: number }>(
			`SELECT next_capture_revision
			FROM meta WHERE singleton = 1`,
		)[0];
		if (record === undefined || meta === undefined) {
			throw new Error('document-bound evidence record is missing');
		}
		const chain = database.all<{ bytes: Uint8Array | ArrayBuffer }>(
			`SELECT bytes FROM record_documents
			WHERE record_id = ? ORDER BY seq`,
			[record.record_id],
		);
		const update = createAuthorityDocumentV1(database).exportDocument(address);
		return {
			authorityLifetime,
			captureRevision: record.capture_revision,
			nextCaptureRevision: meta.next_capture_revision,
			chainEntries: chain.length,
			chainBytes: chain.reduce(
				(total, entry) =>
					total +
					(entry.bytes instanceof Uint8Array
						? entry.bytes.byteLength
						: entry.bytes.byteLength),
				0,
			),
			digest: update === undefined ? null : documentPayloadDigest(update),
			measure: update === undefined ? null : measureDocumentState(update),
		};
	}
}

type AuthorityStub = {
	readFacts(request: unknown): Promise<Result<FactsResponse, AuthorityError>>;
	submit(request: unknown): Promise<Result<SubmissionResponse, AuthorityError>>;
	acceptDocument(request: unknown): Promise<DocumentAcceptance>;
	evidenceState(address: RecordAddress): Promise<DocumentState>;
};

type Env = {
	DATA_AUTHORITY: {
		getByName(name: string): AuthorityStub;
	};
};

function addressFrom(url: URL): RecordAddress {
	const namespace = url.searchParams.get('namespace');
	const collection = url.searchParams.get('collection');
	const recordKey = url.searchParams.get('recordKey');
	if (namespace === null || collection === null || recordKey === null) {
		throw new TypeError('record address is missing');
	}
	return { namespace, collection, recordKey };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const object = url.searchParams.get('object');
		if (object === null)
			return new Response('object is missing', { status: 400 });
		const authority = env.DATA_AUTHORITY.getByName(object);
		switch (url.pathname) {
			case '/initialize': {
				const addresses = (await request.json()) as RecordAddress[];
				const initial = await authority.readFacts({ afterSequence: 0 });
				if (initial.error !== null) return Response.json(initial);
				const submitted = await authority.submit({
					authorityLifetime: initial.data.authorityLifetime,
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					submissionNumber: 1,
					intents: addresses.map((address) => ({
						address,
						op: 'replace',
						value: { title: `Evidence ${address.recordKey}` },
					})),
				});
				return Response.json({
					authorityLifetime: initial.data.authorityLifetime,
					submitted,
				});
			}
			case '/publish': {
				const payload = new Uint8Array(await request.arrayBuffer());
				const publication: DocumentPublicationRequest = {
					authorityLifetime: request.headers.get('x-authority-lifetime') ?? '',
					address: addressFrom(url),
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					payload,
					digest: documentPayloadDigest(payload),
				};
				const started = performance.now();
				const acceptance = await authority.acceptDocument(publication);
				return Response.json({
					acceptance,
					authorityMilliseconds: performance.now() - started,
				});
			}
			case '/inspect':
				return Response.json(await authority.evidenceState(addressFrom(url)));
			default:
				return new Response(null, { status: 404 });
		}
	},
};
