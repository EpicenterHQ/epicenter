import type {
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
	DocumentInspection,
	DocumentPublicationState,
} from './document-store.js';
import type {
	ReplicaRecordLanes,
	ReplicaStoreSync,
	SealedRequest,
} from './replica-store.js';

export type BrowserReplicaOwnerOperation =
	| {
			kind: 'open';
			limits: ValidatedLimits;
			initialize?: { replicaId: string; authorityLifetime?: string };
			storage?: {
				databaseFilename: string;
				poolDirectory: string;
				poolName: string;
			};
	  }
	| { kind: 'record'; address: RecordAddress }
	| { kind: 'sync' }
	| { kind: 'sealed-request' }
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
	| { kind: 'document-publication'; address: RecordAddress }
	| {
			kind: 'settle-document-publication';
			address: RecordAddress;
			proof: DocumentPublicationReceipt | DocumentBoundRefusal;
	  }
	| { kind: 'erase' }
	| { kind: 'integrity-check' }
	| { kind: 'reopen' }
	| { kind: 'dispose' };

export type BrowserReplicaStoreOperation = Exclude<
	BrowserReplicaOwnerOperation,
	{ kind: 'open' | 'dispose' }
>;

export type BrowserReplicaOwnerResult =
	| undefined
	| ReplicaRecordLanes
	| ReplicaStoreSync
	| SealedRequest
	| DocumentInspection
	| DocumentPublicationState
	| Uint8Array
	| string
	| null;

export type BrowserReplicaOwnerRequest = {
	type: 'request';
	id: number;
	operation: BrowserReplicaOwnerOperation;
};

export type BrowserReplicaOwnerMessage =
	| { type: 'result'; id: number; value: BrowserReplicaOwnerResult }
	| { type: 'error'; id: number; name: string; message: string };
