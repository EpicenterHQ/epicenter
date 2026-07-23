import type {
	RecordAddress,
	ValidatedLimits,
} from '../../protocol/v1/index.js';
import type {
	BrowserAuthorityResponse,
	BrowserRuntimeEvent,
} from '../../runtime/browser-protocol.js';
import type { SyncStatus } from '../../runtime/supervisor.js';
import type {
	BrowserReplicaCandidateMessage,
	BrowserReplicaCandidateOperation,
} from './browser-owner-protocol.js';

export type BrowserReplicaCandidateStart = {
	type: 'start';
	limits: ValidatedLimits;
	initialize: { replicaId: string; authorityLifetime?: string };
	hasCarrier?: boolean;
	coordinationId?: string;
	storage?: {
		databaseFilename: string;
		poolDirectory: string;
		poolName: string;
	};
};

export type BrowserReplicaCandidateInbound =
	| BrowserReplicaCandidateStart
	| {
			type: 'request';
			id: number;
			operation: BrowserReplicaCandidateOperation;
	  }
	| { type: 'close' }
	| BrowserAuthorityResponse;

export type BrowserReplicaCandidateStatus = {
	type: 'status';
	role: 'waiting' | 'follower' | 'owner';
	ownerSession: string | null;
};

export type BrowserReplicaCandidateOutbound =
	| BrowserReplicaCandidateMessage
	| BrowserReplicaCandidateStatus
	| BrowserRuntimeEvent
	| {
			type: 'invalidation';
			token: string;
			sequence: number;
			ownerSession: string;
			addresses: RecordAddress[];
			all: boolean;
	  }
	| { type: 'closed' }
	| { type: 'fatal'; name: string; message: string };

export type BrowserReplicaCoordinationMessage =
	| {
			version: 3;
			type: 'discover';
			candidateId: string;
			knownOwnerSession: string | null;
	  }
	| {
			version: 3;
			type: 'owner';
			candidateId: string;
			recipientCandidateId: string | null;
			ownerSession: string;
			replacesOwnerSession: string | null;
			invalidationToken: string | null;
			invalidationSequence: number;
			invalidationAddresses: RecordAddress[];
			invalidationAll: boolean;
			authorityReplacementToken: string | null;
			runtimeStatus: SyncStatus | null;
	  }
	| {
			version: 3;
			type: 'request';
			candidateId: string;
			ownerSession: string;
			id: number;
			operation: BrowserReplicaCandidateOperation;
	  }
	| {
			version: 3;
			type: 'response';
			candidateId: string;
			ownerSession: string;
			message: BrowserReplicaCandidateMessage;
	  }
	| {
			version: 3;
			type: 'invalidation';
			ownerSession: string;
			token: string;
			sequence: number;
			addresses: RecordAddress[];
			all: boolean;
	  }
	| {
			version: 3;
			type: 'runtime-sync-status';
			ownerSession: string;
			status: SyncStatus;
	  }
	| {
			version: 3;
			type: 'runtime-authority-replacement';
			ownerSession: string;
			token: string;
	  };
