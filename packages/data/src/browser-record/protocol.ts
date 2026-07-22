import type {
	BlobAcceptance,
	BlobPublicationRequest,
} from '../blob-v1/index.js';
import type {
	DocumentAcceptance,
	DocumentPublicationRequest,
} from '../document-v1/index.js';
import type { LensDefinition } from '../lens.js';
import type {
	FactsRequest,
	FactsResponse,
	JsonValue,
	RecordAddress,
	SubmissionResponse,
} from '../protocol/v1/index.js';
import type { RecordInspection } from '../record-epicenter.js';
import type {
	RecordSyncState,
	RecordSyncStatus,
} from '../record-sync-supervisor.js';
import type {
	BlobInspection,
	ReplicaAttachment,
	ReplicaAttachmentState,
	ReplicaParkedWorkPage,
	ReplicaVisibleRecord,
	ReplicaVisibleRecordPage,
	SealedRequest,
} from '../store/replica/index.js';

export type BrowserRecordOperation =
	| { kind: 'open' }
	| { kind: 'read'; address: RecordAddress }
	| {
			kind: 'read-page';
			namespace: string;
			collection: string;
			after?: string;
			limit?: number;
	  }
	| {
			kind: 'create-record';
			namespace: string;
			collection: string;
			payload: Record<string, JsonValue>;
	  }
	| {
			kind: 'create-record-with-blob';
			namespace: string;
			collection: string;
			payload: Record<string, JsonValue>;
			bytes: Blob;
	  }
	| {
			kind: 'patch-live';
			address: RecordAddress;
			patch: { set: Record<string, JsonValue>; unset: string[] };
	  }
	| { kind: 'tombstone-live'; address: RecordAddress }
	| { kind: 'replace'; address: RecordAddress; value: JsonValue }
	| { kind: 'unset'; address: RecordAddress }
	| { kind: 'export-document'; address: RecordAddress }
	| {
			kind: 'append-local-document-update';
			address: RecordAddress;
			update: Uint8Array;
	  }
	| {
			kind: 'install-accepted-document-update';
			address: RecordAddress;
			update: Uint8Array;
	  }
	| { kind: 'put-blob'; address: RecordAddress; bytes: Blob }
	| { kind: 'read-blob'; address: RecordAddress }
	| { kind: 'inspect-blob'; address: RecordAddress }
	| { kind: 'parked-work'; after?: RecordAddress }
	| { kind: 'inspect-record'; address: RecordAddress }
	| { kind: 'capture-snapshot'; lens?: LensDefinition }
	| {
			kind: 'attach-sync';
			transportKey: number;
			attachment: ReplicaAttachment;
			firstAttachmentChoice?: 'bring' | 'discard';
	  };

export type BrowserRecordRequest = {
	type: 'request';
	id: number;
	operation: BrowserRecordOperation;
};

export type BrowserRecordResult =
	| {
			kind: 'open';
			attachment: ReplicaAttachmentState;
			syncStatus: BrowserRecordSyncStatus;
	  }
	| { kind: 'read'; record: ReplicaVisibleRecord | null }
	| { kind: 'read-page'; page: ReplicaVisibleRecordPage }
	| { kind: 'create-record'; recordKey: string }
	| { kind: 'create-record-with-blob'; recordKey: string }
	| { kind: 'patch-live'; record: ReplicaVisibleRecord | null }
	| { kind: 'tombstone-live'; deleted: boolean }
	| { kind: 'replace' }
	| { kind: 'unset' }
	| {
			kind: 'export-document';
			recordState: 'live' | 'unset' | 'not-openable';
			update?: Uint8Array;
	  }
	| { kind: 'append-local-document-update' }
	| { kind: 'install-accepted-document-update' }
	| { kind: 'put-blob'; digest: string }
	| { kind: 'read-blob'; bytes: Blob | null }
	| { kind: 'inspect-blob'; inspection: BlobInspection }
	| { kind: 'parked-work'; page: ReplicaParkedWorkPage }
	| { kind: 'inspect-record'; inspection: RecordInspection }
	| {
			kind: 'capture-snapshot';
			artifact: Blob;
			metadata: import('../store/replica/index.js').SnapshotArtifactMetadata;
	  }
	| {
			kind: 'attach-sync';
			attachment: ReplicaAttachmentState;
			syncStatus: BrowserRecordSyncStatus;
	  };

export type BrowserRecordAuthorityOperation =
	| { kind: 'read-facts'; request: FactsRequest }
	| { kind: 'submit'; request: SealedRequest }
	| { kind: 'publish-document'; request: DocumentPublicationRequest }
	| {
			kind: 'publish-blob';
			request: BlobPublicationRequest;
			bytes: Blob;
	  };

export type BrowserRecordAuthorityResult =
	| { kind: 'read-facts'; response: FactsResponse }
	| { kind: 'submit'; response: SubmissionResponse }
	| { kind: 'publish-document'; acceptance: DocumentAcceptance }
	| { kind: 'publish-blob'; acceptance: BlobAcceptance };

export type BrowserRecordAuthorityErrorCode =
	| 'transport-unavailable'
	| 'transport-failed'
	| 'lifetime-mismatch';

export type BrowserRecordSyncStatus = Omit<RecordSyncStatus, 'lastError'> & {
	state: RecordSyncState;
	lastError?: { name: string; message: string };
};

export type BrowserRecordCandidateStart = {
	type: 'start';
	coordinationId?: string;
	storage?: {
		databaseFilename: string;
		poolDirectory: string;
		poolName: string;
	};
};

export type BrowserRecordWorkerInbound =
	| BrowserRecordCandidateStart
	| BrowserRecordRequest
	| {
			type: 'transport-register';
			transportKey: number;
			attachment: ReplicaAttachment;
			hasCredentials: boolean;
	  }
	| {
			type: 'transport-credentials';
			transportKey: number;
			hasCredentials: boolean;
	  }
	| { type: 'transport-unregister'; transportKey: number }
	| {
			type: 'authority-result';
			authorityId: number;
			transportKey: number;
			ownerSession: string;
			ownerGeneration: number;
			result: BrowserRecordAuthorityResult;
	  }
	| {
			type: 'authority-error';
			authorityId: number;
			transportKey: number;
			ownerSession: string;
			ownerGeneration: number;
			code: BrowserRecordAuthorityErrorCode;
			activeAuthorityLifetime?: string;
	  }
	| { type: 'close' };

export type BrowserRecordCandidateStatus = {
	type: 'status';
	role: 'waiting' | 'follower' | 'owner';
	ownerSession: string | null;
	ownerGeneration: number | null;
};

export type BrowserRecordWorkerMessage =
	| { type: 'result'; id: number; result: BrowserRecordResult }
	| { type: 'error'; id: number; name: string; message: string }
	| {
			type: 'records-invalidated';
			token: string;
			addresses: RecordAddress[];
	  }
	| { type: 'blob-invalidated'; token: string; address: RecordAddress }
	| {
			type: 'address-revoked';
			token: string;
			address: RecordAddress;
			message: string;
	  }
	| {
			type: 'sync-status';
			token: string;
			status: BrowserRecordSyncStatus;
	  }
	| {
			type: 'attachment';
			token: string;
			attachment: ReplicaAttachmentState;
	  }
	| {
			type: 'authority-request';
			authorityId: number;
			transportKey: number;
			ownerSession: string;
			ownerGeneration: number;
			operation: BrowserRecordAuthorityOperation;
	  }
	| {
			type: 'authority-cancel';
			authorityId: number;
			transportKey: number;
			ownerSession: string;
			ownerGeneration: number;
	  }
	| { type: 'owner-lost'; name: string; message: string }
	| BrowserRecordCandidateStatus
	| { type: 'closed' }
	| { type: 'fatal'; name: string; message: string };

export type BrowserRecordCoordinationMessage =
	| { version: 1; type: 'discover'; candidateId: string }
	| {
			version: 1;
			type: 'owner';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
	  }
	| {
			version: 1;
			type: 'request';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			request: BrowserRecordRequest;
	  }
	| {
			version: 1;
			type: 'response';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			message: Extract<
				BrowserRecordWorkerMessage,
				{ type: 'result' | 'error' }
			>;
	  }
	| {
			version: 1;
			type: 'event';
			ownerSession: string;
			ownerGeneration: number;
			message: Extract<
				BrowserRecordWorkerMessage,
				{
					type:
						| 'records-invalidated'
						| 'blob-invalidated'
						| 'address-revoked'
						| 'sync-status'
						| 'attachment';
				}
			>;
	  }
	| {
			version: 1;
			type: 'transport';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			transportKey: number;
			attachment: ReplicaAttachment;
			hasCredentials: boolean;
	  }
	| {
			version: 1;
			type: 'transport-remove';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			transportKey: number;
	  }
	| {
			version: 1;
			type: 'authority-request';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			authorityId: number;
			transportKey: number;
			operation: BrowserRecordAuthorityOperation;
	  }
	| {
			version: 1;
			type: 'authority-cancel';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			authorityId: number;
			transportKey: number;
	  }
	| {
			version: 1;
			type: 'authority-result';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			authorityId: number;
			transportKey: number;
			result: BrowserRecordAuthorityResult;
	  }
	| {
			version: 1;
			type: 'authority-error';
			candidateId: string;
			ownerSession: string;
			ownerGeneration: number;
			authorityId: number;
			transportKey: number;
			code: BrowserRecordAuthorityErrorCode;
			activeAuthorityLifetime?: string;
	  };
