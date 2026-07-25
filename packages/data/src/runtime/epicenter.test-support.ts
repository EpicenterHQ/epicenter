import * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from '../blob-v1/index.js';
import {
	BLOB_PUBLICATION_VERSION,
	BlobSourceReadFailure,
} from '../blob-v1/index.js';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPull,
	documentVersionOf,
} from '../document-v1/index.js';
import { sha256HexBytes } from '../protocol/v1/canonical.js';
import {
	type AuthorityState,
	createAuthority,
	type Fact,
	type FactsRequest,
	parseFactsRequest,
	parseSubmissionRequest,
	type RecordAddress,
	readFacts,
	type SubmissionRequest,
	type SubmissionResponse,
	submit,
} from '../protocol/v1/index.js';
import { makeLimits } from '../protocol/v1/kernel.test-support.js';
import type { AuthorityCarrier, DocumentPullCarrier } from './supervisor.js';

export const TEST_LIMITS = makeLimits();

function unwrap<T>(result: Result<T, { message: string }>): T {
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

export class MemoryBlobFiles implements BlobFileStore<Uint8Array, Uint8Array> {
	readonly content = new Map<string, Uint8Array>();
	stagingSweepCount = 0;
	private staged = new Map<string, Uint8Array>();

	async stage(source: Uint8Array): Promise<StagedBlob> {
		if (!(source instanceof Uint8Array)) {
			throw new BlobSourceReadFailure(new TypeError('expected bytes'));
		}
		const bytes = new Uint8Array(source);
		const digest = sha256HexBytes(bytes);
		this.staged.set(digest, bytes);
		return { id: digest, digest };
	}
	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staged.get(staged.id);
		if (bytes === undefined) throw new Error('missing staged bytes');
		this.content.set(`${owner.ownerKey}:${owner.digest}`, bytes);
		this.staged.delete(staged.id);
	}
	async open(owner: OwnedBlobFile): Promise<Uint8Array> {
		const bytes = this.content.get(`${owner.ownerKey}:${owner.digest}`);
		if (bytes === undefined) throw new Error('missing blob bytes');
		return new Uint8Array(bytes);
	}
	async sweepStaging(): Promise<void> {
		this.stagingSweepCount += 1;
		this.staged.clear();
	}
	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const keep = new Set(
			owned.map((item) => `${item.ownerKey}:${item.digest}`),
		);
		for (const key of this.content.keys()) {
			if (!keep.has(key)) this.content.delete(key);
		}
	}
}

export function createTestCarrier(): AuthorityCarrier<Uint8Array> &
	DocumentPullCarrier & {
		install(
			fact:
				| {
						address: RecordAddress;
						state: 'live';
						payload: Extract<Fact, { state: 'live' }>['payload'];
				  }
				| { address: RecordAddress; state: 'tombstone' | 'unset' },
		): void;
		reset(lifetime: string): void;
		/** Join state into the authority's document without a replica round trip. */
		seedDocument(address: RecordAddress, update: Uint8Array): void;
		pullCount: number;
		bodiedPullCount: number;
	} {
	let state: AuthorityState = unwrap(
		createAuthority('runtime-life', TEST_LIMITS),
	);
	// The authority's committed document per address, as joined complete state.
	const documents = new Map<string, Uint8Array>();

	function join(address: RecordAddress, update: Uint8Array): void {
		const key = JSON.stringify([
			address.namespace,
			address.collection,
			address.recordKey,
		]);
		const document = new Y.Doc({ gc: true });
		try {
			const existing = documents.get(key);
			if (existing !== undefined) Y.applyUpdateV2(document, existing);
			Y.applyUpdateV2(document, update);
			documents.set(key, new Uint8Array(Y.encodeStateAsUpdateV2(document)));
		} finally {
			document.destroy();
		}
	}

	return {
		pullCount: 0,
		bodiedPullCount: 0,
		seedDocument(address, update) {
			join(address, update);
		},
		async pullDocument(address, request): Promise<DocumentPull> {
			this.pullCount += 1;
			if (request.authorityLifetime !== state.lifetime) {
				return {
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: state.lifetime,
				};
			}
			const committed = documents.get(
				JSON.stringify([
					address.namespace,
					address.collection,
					address.recordKey,
				]),
			);
			if (committed === undefined) {
				return { kind: 'absent', activeAuthorityLifetime: state.lifetime };
			}
			const documentVersion = documentVersionOf(committed);
			if (documentVersion === request.knownDocumentVersion) {
				return {
					kind: 'unchanged',
					activeAuthorityLifetime: state.lifetime,
					documentVersion,
				};
			}
			this.bodiedPullCount += 1;
			return {
				kind: 'state',
				activeAuthorityLifetime: state.lifetime,
				documentVersion,
				update: new Uint8Array(committed),
			};
		},
		reset(lifetime) {
			documents.clear();
			state = unwrap(createAuthority(lifetime, TEST_LIMITS));
		},
		install(fact) {
			const request: SubmissionRequest = {
				authorityLifetime: state.lifetime,
				replicaId: 'ssssssssssssssssssssssss',
				submissionNumber:
					(state.replicas.get('ssssssssssssssssssssssss')
						?.lastSubmissionNumber ?? 0) + 1,
				intents: [
					fact.state === 'live'
						? { address: fact.address, op: 'replace', value: fact.payload }
						: { address: fact.address, op: fact.state },
				],
			};
			state = unwrap(
				submit(
					state,
					unwrap(parseSubmissionRequest(request, TEST_LIMITS)),
					TEST_LIMITS,
				),
			).state;
		},
		async fetchFacts(request: FactsRequest) {
			const admitted = unwrap(parseFactsRequest(request, TEST_LIMITS));
			const result = readFacts(state, admitted, TEST_LIMITS);
			if (
				result.error !== null &&
				request.authorityLifetime !== undefined &&
				request.authorityLifetime !== state.lifetime
			) {
				return unwrap(
					readFacts(
						state,
						unwrap(parseFactsRequest({ afterSequence: 0 }, TEST_LIMITS)),
						TEST_LIMITS,
					),
				);
			}
			return unwrap(result);
		},
		async submit(bytes: string): Promise<SubmissionResponse> {
			const result = unwrap(
				submit(
					state,
					unwrap(parseSubmissionRequest(JSON.parse(bytes), TEST_LIMITS)),
					TEST_LIMITS,
				),
			);
			state = result.state;
			return result.response;
		},
		async publishDocument(address, publication): Promise<DocumentAcceptance> {
			join(address, publication.payload);
			return {
				kind: 'accepted',
				receipt: {
					authorityLifetime: state.lifetime,
					address,
					protocolVersion: DOCUMENT_PUBLICATION_VERSION,
					digest: publication.digest,
				},
			};
		},
		async publishBlob(address: RecordAddress, publication) {
			return {
				kind: 'accepted',
				receipt: {
					authorityLifetime: state.lifetime,
					address,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: publication.digest,
				},
			};
		},
	};
}
