import type { Account } from '@epicenter/auth';
import type { BlobSources, BlobStore, RemoteBlobs } from '@epicenter/blobs';
import type { SecretStore } from '@epicenter/device';
import type { AccountIdentity } from '@epicenter/principal';
import type { AiTransport } from './ai.js';
import type { AiConnections } from './ai-connections.js';

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: RemoteBlobs | null;
};

export type AppBlobFactory = (input: {
	appId: string;
	account?: Account;
}) => AppBlobComposition;

/** Independent inference transport and connections selection. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	connections?: (appId: string, account?: AccountIdentity) => AiConnections;
	/** Omission disables custom endpoint requests; it never selects ambient fetch. */
	configuredFetch?: AiTransport['fetch'];
};

export type AppSecretFactory = (
	appId: string,
	options?: { assertUsable?: () => void; account?: AccountIdentity },
) => { value: SecretStore; close(): Promise<void> };
