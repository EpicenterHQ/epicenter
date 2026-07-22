import type {
	BrowserReplicaOwnerOperation,
	BrowserReplicaOwnerResult,
} from '../src/store/replica/browser-owner-protocol.js';

export type BrowserReplicaOwnerEvidenceDriver = {
	open(
		storageId: string,
		fixture: { replicaId: string; authorityLifetime?: string },
	): Promise<void>;
	request(
		operation: Exclude<BrowserReplicaOwnerOperation, { kind: 'open' }>,
	): Promise<BrowserReplicaOwnerResult>;
	dispose(): Promise<void>;
	terminate(): void;
};
