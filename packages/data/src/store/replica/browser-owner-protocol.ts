import type {
	FactsRequest,
	FactsResponse,
	Intent,
	RecordAddress,
	SubmissionResponse,
	ValidatedLimits,
} from '../../protocol/v1/index.js';
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
	| { kind: 'erase' }
	| { kind: 'integrity-check' }
	| { kind: 'reopen' }
	| { kind: 'dispose' };

export type BrowserReplicaOwnerResult =
	| undefined
	| ReplicaRecordLanes
	| ReplicaStoreSync
	| SealedRequest
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
