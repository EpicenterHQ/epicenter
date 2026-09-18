import type { Account } from '@epicenter/auth';
import type { BlobSources, BlobStore, RemoteBlobs } from '@epicenter/blobs';
import type { AccountIdentity } from '@epicenter/principal';
import type { AiTransport } from './ai.js';
import type { AiConnections } from './ai-connections.js';
import type { createBrowserSecrets } from '@epicenter/device/browser';
import type { claimApp } from '@epicenter/device/library-claim';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { acquireAppData } from './data/store/browser.js';
import type { RecordingFactory } from './recorder.js';

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

/** Complete resources beneath the shared App lifecycle; no ambient fallback. */
export type AppRuntime = {
	/** Disposable runtimes reserve synchronously, before the returned promise settles. */
	claim: typeof claimApp;
	data: typeof acquireAppData;
	sqlite: DeviceSqliteOwner;
	blobs: AppBlobFactory;
	recording: RecordingFactory;
	secrets: typeof createBrowserSecrets;
	ai: AppAiBinding;
};
