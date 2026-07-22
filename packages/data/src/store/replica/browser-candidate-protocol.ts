import type { ValidatedLimits } from '../../protocol/v1/index.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaStoreOperation,
} from './browser-owner-protocol.js';

export type BrowserReplicaCandidateStart = {
	type: 'start';
	limits: ValidatedLimits;
	initialize: { replicaId: string; authorityLifetime?: string };
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
			operation: BrowserReplicaStoreOperation;
	  }
	| { type: 'close' };

export type BrowserReplicaCandidateStatus = {
	type: 'status';
	role: 'waiting' | 'follower' | 'owner';
	ownerSession: string | null;
};

export type BrowserReplicaCandidateOutbound =
	| BrowserReplicaOwnerMessage
	| BrowserReplicaCandidateStatus
	| { type: 'invalidation'; token: string; ownerSession: string }
	| { type: 'closed' }
	| { type: 'fatal'; name: string; message: string };

export type BrowserReplicaCoordinationMessage =
	| { version: 1; type: 'discover'; candidateId: string }
	| {
			version: 1;
			type: 'owner';
			candidateId: string;
			ownerSession: string;
			replacesOwnerSession: string | null;
	  }
	| {
			version: 1;
			type: 'request';
			candidateId: string;
			ownerSession: string;
			id: number;
			operation: BrowserReplicaStoreOperation;
	  }
	| {
			version: 1;
			type: 'response';
			candidateId: string;
			ownerSession: string;
			message: BrowserReplicaOwnerMessage;
	  }
	| {
			version: 1;
			type: 'invalidation';
			ownerSession: string;
			token: string;
	  };
