import type { JsonValue, RecordAddress } from '../protocol/v1/index.js';
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
	| { kind: 'attachment' }
	| {
			kind: 'prepare-attachment';
			attachment: ReplicaAttachment;
			firstAttachmentChoice?: 'bring' | 'discard';
	  }
	| { kind: 'sync-status' }
	| { kind: 'parked-work'; after?: RecordAddress }
	| { kind: 'inspect-record'; address: RecordAddress };

export type BrowserRecordRequest = {
	type: 'request';
	id: number;
	operation: BrowserRecordOperation;
};

export type BrowserRecordResult =
	| { kind: 'open' }
	| { kind: 'read'; record: ReplicaVisibleRecord | null }
	| { kind: 'read-page'; page: ReplicaVisibleRecordPage }
	| { kind: 'create-record'; recordKey: string }
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
	| { kind: 'attachment'; attachment: ReplicaAttachmentState }
	| {
			kind: 'prepare-attachment';
			attached: boolean;
			discarded: boolean;
	  }
	| { kind: 'sync-status'; status: BrowserRecordSyncStatus }
	| { kind: 'parked-work'; page: ReplicaParkedWorkPage }
	| { kind: 'inspect-record'; inspection: RecordInspection };

export type BrowserRecordSyncStatus = Omit<RecordSyncStatus, 'lastError'> & {
	state: RecordSyncState;
	lastError?: string;
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
						| 'sync-status';
				}
			>;
	  };
