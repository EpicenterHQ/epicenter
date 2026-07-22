import type {
	BrowserReplicaCandidateStart,
	BrowserReplicaCandidateStatus,
} from '../src/store/replica/browser-candidate-protocol.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from '../src/store/replica/browser-owner-protocol.js';

export type BrowserReplicaCandidateEvidenceDriver = {
	open(options: Omit<BrowserReplicaCandidateStart, 'type'>): Promise<void>;
	request(
		operation: BrowserReplicaStoreOperation,
	): Promise<BrowserReplicaOwnerResult>;
	status(): BrowserReplicaCandidateStatus;
	takeInvalidations(): string[];
	terminate(): void;
	close(): Promise<void>;
};
