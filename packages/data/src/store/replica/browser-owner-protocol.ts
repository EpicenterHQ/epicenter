import type { BlobAcceptance } from '../../blob-v1/index.js';
import type {
	DocumentAcceptance,
	DocumentBoundRefusal,
	DocumentPublicationReceipt,
} from '../../document-v1/index.js';
import type {
	FactsRequest,
	FactsResponse,
	Intent,
	RecordAddress,
	SubmissionResponse,
	ValidatedLimits,
} from '../../protocol/v1/index.js';
import type {
	BrowserRuntimeControlOperation,
	BrowserRuntimeControlResult,
} from '../../runtime/browser-protocol.js';
import type { PublicationStatus } from '../../runtime/publication-status.js';
import type {
	BlobCaptureOutcome,
	BlobInspection,
	BlobPublicationState,
	BlobSettlementOutcome,
} from './blob-store.js';
import type {
	DocumentInspection,
	DocumentPublicationState,
	DocumentSettlementOutcome,
} from './document-store.js';
import type {
	ReplicaRecordLanes,
	ReplicaStoreSync,
	SealedRequest,
	SealOutcome,
	VisibleRecordState,
	VisibleRecordsPage,
} from './replica-store.js';

export type BrowserDocumentOpenResult =
	| { kind: 'ready'; update?: Uint8Array }
	| { kind: 'record-not-live' };

export type BrowserDocumentRefreshResult =
	| { kind: 'terminal' }
	| { kind: 'preserved'; update?: Uint8Array };

export type BrowserReplicaOwnerOperation =
	| {
			kind: 'open';
			limits: ValidatedLimits;
			owner: { deploymentId: string; principalId: string } | null;
			initialize?: { replicaId: string; authorityLifetime?: string };
			storage?: {
				databaseFilename: string;
				poolDirectory: string;
				poolName: string;
				lockName?: string;
				blobDirectory?: string;
			};
	  }
	| { kind: 'record'; address: RecordAddress }
	| { kind: 'visible-record'; address: RecordAddress }
	| {
			kind: 'visible-records-page';
			namespace: string;
			collection: string;
			afterRecordKey: string | null;
			limit: number;
	  }
	| { kind: 'is-visibly-live'; address: RecordAddress }
	| {
			kind: 'blocked-records-page';
			after: RecordAddress | null;
			limit: number;
	  }
	| { kind: 'publication-status'; address: RecordAddress }
	| {
			kind: 'runtime-table-update';
			intent: Extract<Intent, { op: 'patch' }>;
	  }
	| {
			kind: 'runtime-put-record';
			intent: Extract<Intent, { op: 'patch' }>;
	  }
	| { kind: 'runtime-delete-record'; address: RecordAddress }
	| {
			kind: 'runtime-value-write';
			intent: Extract<Intent, { op: 'replace' | 'unset' }>;
	  }
	| { kind: 'runtime-read-blob'; address: RecordAddress }
	| { kind: 'sync' }
	| { kind: 'sealed-request' }
	| { kind: 'owed-documents'; limit: number }
	| { kind: 'owed-blobs'; limit: number }
	| { kind: 'local-write'; intent: Intent }
	| { kind: 'seal' }
	| { kind: 'reconstruct-sealed-request' }
	| {
			kind: 'install-facts';
			page: { request: FactsRequest; response: FactsResponse };
	  }
	| { kind: 'settle'; response: SubmissionResponse }
	| {
			kind: 'append-local-document';
			address: RecordAddress;
			update: Uint8Array;
	  }
	| {
			kind: 'install-accepted-document';
			address: RecordAddress;
			update: Uint8Array;
	  }
	| { kind: 'inspect-document'; address: RecordAddress }
	| { kind: 'export-document'; address: RecordAddress }
	| { kind: 'open-runtime-document'; address: RecordAddress }
	| { kind: 'refresh-runtime-document'; address: RecordAddress }
	| { kind: 'document-publication'; address: RecordAddress }
	| {
			kind: 'settle-document-publication';
			address: RecordAddress;
			proof:
				| DocumentPublicationReceipt
				| DocumentBoundRefusal
				| Extract<DocumentAcceptance, { kind: 'record-not-live' }>;
			captured: { revision: number; digest: string };
	  }
	| { kind: 'capture-blob'; address: RecordAddress; bytes: Blob }
	| { kind: 'inspect-blob'; address: RecordAddress }
	| { kind: 'blob-publication'; address: RecordAddress }
	| {
			kind: 'settle-blob-publication';
			address: RecordAddress;
			acceptance: BlobAcceptance;
	  }
	| { kind: 'read-blob'; address: RecordAddress }
	| { kind: 'sweep-blob-debris' }
	| { kind: 'erase' }
	| { kind: 'integrity-check' }
	| { kind: 'reopen' }
	| { kind: 'dispose' };

export type BrowserReplicaRuntimeOperation =
	| BrowserReplicaOwnerOperation
	| BrowserRuntimeControlOperation;

export type BrowserReplicaStoreOperation = Exclude<
	BrowserReplicaOwnerOperation,
	{ kind: 'open' | 'dispose' }
>;

export type BrowserReplicaCandidateOperation =
	| BrowserReplicaStoreOperation
	| BrowserRuntimeControlOperation;

export type BrowserReplicaOwnerResult =
	| undefined
	| ReplicaRecordLanes
	| ReplicaStoreSync
	| SealOutcome
	| SealedRequest
	| RecordAddress[]
	| VisibleRecordState
	| VisibleRecordsPage
	| BrowserDocumentOpenResult
	| BrowserDocumentRefreshResult
	| PublicationStatus
	| { kind: 'written'; visible: VisibleRecordState }
	| { kind: 'written' | 'record-not-live' }
	| DocumentInspection
	| DocumentPublicationState
	| DocumentSettlementOutcome
	| BlobCaptureOutcome
	| BlobInspection
	| BlobPublicationState<Blob>
	| BlobSettlementOutcome
	| Blob
	| Uint8Array
	| string
	| boolean
	| null;

export type BrowserReplicaCandidateResult =
	| BrowserReplicaOwnerResult
	| BrowserRuntimeControlResult;

export type BrowserReplicaOwnerRequest = {
	type: 'request';
	id: number;
	operation: BrowserReplicaOwnerOperation;
};

export type BrowserReplicaOwnerMessage<TResult = BrowserReplicaOwnerResult> =
	| { type: 'result'; id: number; value: TResult }
	| { type: 'error'; id: number; name: string; message: string };

export type BrowserReplicaCandidateMessage =
	BrowserReplicaOwnerMessage<BrowserReplicaCandidateResult>;
