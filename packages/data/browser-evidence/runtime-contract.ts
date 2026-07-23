import type { PublicationStatus } from '../src/runtime/index.js';
import type { SyncStatus } from '../src/runtime/supervisor.js';

export type BrowserRuntimeStorageIdentity = {
	databaseFilename: string;
	poolDirectory: string;
	poolName: string;
	lockName?: string;
	blobDirectory?: string;
};

export type BrowserRuntimeReplicaOwner = {
	deploymentId: string;
	principalId: string;
};

export type BrowserRuntimeEvidenceDriver = {
	open(options: {
		coordinationId: string;
		storage: BrowserRuntimeStorageIdentity;
		replicaId?: string;
		/** Immutable identity of the replica this open targets (ADR-0178). */
		owner: BrowserRuntimeReplicaOwner | null;
		/** Supply the page's authority carrier for this runtime lifetime. */
		withCarrier?: boolean;
	}): Promise<void>;
	create(title: string): Promise<string>;
	get(id: string): Promise<{ id: string; title: string; body?: string } | null>;
	update(id: string, title: string): Promise<void>;
	setTheme(value: string): Promise<void>;
	unsetTheme(): Promise<void>;
	getTheme(): Promise<string | null>;
	openDocument(label: string, id: string): Promise<void>;
	insertDocument(label: string, index: number, text: string): void;
	documentText(label: string): string;
	whenDocumentDurable(label: string): Promise<void>;
	beginDocumentDurability(label: string): void;
	documentDurabilitySettled(): boolean;
	waitForDocumentDurability(): Promise<void>;
	holdDocumentAcknowledgements(): void;
	documentAcknowledgementHeld(): boolean;
	releaseDocumentAcknowledgements(): void;
	closeDocument(label: string): Promise<void>;
	captureBlob(id: string, text: string): Promise<void>;
	readBlob(id: string): Promise<string | null>;
	publication(id: string): Promise<PublicationStatus>;
	status(): SyncStatus;
	setOnline(value: boolean): void;
	nudgeOnline(): void;
	holdDocumentReceipts(): void;
	releaseDocumentReceipts(): void;
	replaceAuthority(lifetime: string): void;
	authorityCounts(): {
		facts: number;
		submissions: number;
		documents: number;
		blobs: number;
	};
	disposeRuntimeKeepingDocuments(): Promise<void>;
	beginDisposeRuntimeKeepingDocuments(): void;
	disposalSettled(): boolean;
	waitForDisposal(): Promise<void>;
	dispose(): Promise<void>;
	terminate(): void;
};
