import type {
	Intent,
	RecordAddress,
	SubmissionResponse,
} from '../src/protocol/v1/index.js';
import type {
	DocumentAction,
	DocumentActionResult,
} from '../src/store/conformance/document-cases.test-support.js';
import type {
	FactsPage,
	RecordLanes,
	ReplicaSync,
	SealWitness,
} from '../src/store/conformance/replica-cases.test-support.js';
import type { DocumentInspection } from '../src/store/replica/index.js';

export type BrowserReplicaAction =
	| DocumentAction
	| { kind: 'local-write'; intent: Intent }
	| { kind: 'seal' }
	| { kind: 'settle'; response: SubmissionResponse }
	| { kind: 'install-facts'; page: FactsPage }
	| { kind: 'erase' };

export type BrowserReplicaObservation =
	| { kind: 'record'; address: RecordAddress }
	| { kind: 'sync' }
	| { kind: 'sealed-request' }
	| { kind: 'snapshot' }
	| { kind: 'reconstruct-sealed-request' }
	| { kind: 'inspect-document'; address: RecordAddress }
	| { kind: 'export-document'; address: RecordAddress }
	| { kind: 'owed-documents'; after: RecordAddress | null; limit: number }
	| { kind: 'owed-query-plans' };

export type BrowserOwedQueryPlans = {
	document: string[];
	blob: string[];
};

export type BrowserReplicaTestRequest =
	| {
			kind: 'open';
			storage: {
				databaseFilename: string;
				poolDirectory: string;
				poolName: string;
			};
			initialize?: { replicaId: string; authorityLifetime?: string };
			databaseBytes?: Uint8Array;
	  }
	| { kind: 'observe'; observation: BrowserReplicaObservation }
	| { kind: 'analyze'; action: BrowserReplicaAction }
	| { kind: 'commit'; action: BrowserReplicaAction }
	| { kind: 'crash'; action: BrowserReplicaAction; boundary: number }
	| { kind: 'export' }
	| { kind: 'reopen' }
	| { kind: 'close'; remove: boolean };

export type BrowserReplicaAnalysis = {
	boundaries: number;
	result?: SealWitness | DocumentActionResult;
	error?: { name: string; message: string };
};

export type BrowserReplicaTestResult =
	| undefined
	| Uint8Array
	| BrowserReplicaAnalysis
	| BrowserOwedQueryPlans
	| RecordAddress[]
	| DocumentInspection
	| DocumentActionResult
	| RecordLanes
	| ReplicaSync
	| SealWitness
	| string
	| null;

export type BrowserReplicaTestInbound = {
	type: 'request';
	id: number;
	request: BrowserReplicaTestRequest;
};

export type BrowserReplicaTestOutbound =
	| { type: 'result'; id: number; value: BrowserReplicaTestResult }
	| { type: 'error'; id: number; name: string; message: string }
	| { type: 'crash-boundary'; id: number };

export type BrowserReplicaStorageIdentity = {
	databaseFilename: string;
	poolDirectory: string;
	poolName: string;
};

export type BrowserReplicaConformanceEvidenceDriver = {
	open(fixture: {
		replicaId: string;
		authorityLifetime?: string;
	}): Promise<void>;
	observe(
		observation: BrowserReplicaObservation,
	): Promise<BrowserReplicaTestResult>;
	analyze(action: BrowserReplicaAction): Promise<BrowserReplicaAnalysis>;
	commit(action: BrowserReplicaAction): Promise<BrowserReplicaTestResult>;
	reopen(): Promise<void>;
	dispose(): Promise<void>;
	openStorage(
		storage: BrowserReplicaStorageIdentity,
		fixture?: { replicaId: string; authorityLifetime?: string },
		databaseBytes?: number[],
	): Promise<void>;
	exportDatabase(): Promise<number[]>;
	crashCurrent(action: BrowserReplicaAction, boundary: number): Promise<void>;
	closeCurrent(remove: boolean): Promise<void>;
};
