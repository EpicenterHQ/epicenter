import type {
	DocumentPublishOutcome,
	DocumentPullResponse,
} from '../documents.js';
import type {
	Address,
	JsonValue,
	RowAddress,
	ValueAddress,
} from '../protocol/index.js';
import type { FactsRequest, SubmissionRequest } from '../protocol/v1/index.js';
import type { TransportOutcome } from '../replica/v1-replica.js';
import type { SyncState } from '../v1-sync-supervisor.js';

/**
 * One network call the worker asks the sync-attached page to perform on its
 * behalf. The page owns credentials and fetch; the worker owns the replica,
 * the documents, and every synchronization decision.
 */
export type SessionTransportRequest =
	| { kind: 'facts'; request: FactsRequest }
	| { kind: 'submission'; request: SubmissionRequest }
	| { kind: 'document-publish'; address: RowAddress; update: Uint8Array }
	| {
			kind: 'document-pull';
			address: RowAddress;
			sinceVersion: string | undefined;
	  };

/**
 * The scalar outcomes cross the port as values, not exceptions.
 *
 * An authority refusal and a network failure need different recoveries, and a
 * structured-clone boundary cannot carry an error subclass, so a thrown refusal
 * would arrive on the worker side as an anonymous message and be retried like a
 * dropped connection.
 */
export type SessionTransportResponse =
	| { kind: 'facts'; outcome: TransportOutcome }
	| { kind: 'submission'; outcome: TransportOutcome }
	| { kind: 'document-publish'; outcome: DocumentPublishOutcome }
	| { kind: 'document-pull'; response: DocumentPullResponse };

export type SerializedTableDefinition = {
	namespace: string;
	table: string;
	fields: Record<string, unknown>;
	optionalFields: string[];
};

export type SerializedValueDefinition = {
	address: ValueAddress;
	value: unknown;
};

export type BrowserOperation =
	| { kind: 'open' }
	| {
			kind: 'table-create';
			definition: SerializedTableDefinition;
			fields: Record<string, unknown>;
	  }
	| {
			kind: 'table-get';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			address: RowAddress;
			patch: Record<string, unknown>;
	  }
	| {
			kind: 'table-delete';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| {
			kind: 'table-entries-page';
			definition: SerializedTableDefinition;
			after?: string;
	  }
	| {
			kind: 'value-get';
			definition: SerializedValueDefinition;
			address: ValueAddress;
	  }
	| {
			kind: 'value-set';
			definition: SerializedValueDefinition;
			address: ValueAddress;
			value: JsonValue;
	  }
	| {
			kind: 'value-unset';
			definition: SerializedValueDefinition;
			address: ValueAddress;
	  }
	| {
			kind: 'document-open';
			definition: SerializedTableDefinition;
			address: RowAddress;
	  }
	| { kind: 'document-update'; documentId: number; update: Uint8Array }
	| { kind: 'document-pull'; documentId: number }
	| { kind: 'document-issue'; documentId: number }
	| { kind: 'document-close'; documentId: number }
	| {
			kind: 'attach-sync';
			transportKey: number;
			deploymentId: string;
			principalId: string;
			hasCredentials: boolean;
			canPublishDocuments: boolean;
			canPullDocuments: boolean;
	  }
	| { kind: 'sync-credentials'; transportKey: number; hasCredentials: boolean }
	| { kind: 'disconnect' };

export type BrowserRequest = {
	type: 'request';
	id: number;
	operation: BrowserOperation;
};

export type BrowserTransportResult =
	| {
			type: 'transport-result';
			transportId: number;
			transportKey: number;
			response: SessionTransportResponse;
	  }
	| {
			type: 'transport-error';
			transportId: number;
			transportKey: number;
			name: string;
			message: string;
	  };

export type BrowserWorkerInbound = BrowserRequest | BrowserTransportResult;

export type BrowserInvalidation = {
	type: 'invalidation';
	change: Address;
};

export type BrowserWorkerMessage =
	| { type: 'result'; id: number; value: unknown }
	| { type: 'error'; id: number; name: string; message: string }
	| BrowserInvalidation
	| {
			type: 'document-update';
			documentId: number;
			update: Uint8Array;
	  }
	| {
			type: 'document-revoked';
			documentId: number;
			message: string;
	  }
	| {
			type: 'sync-status';
			state: SyncState;
			lastError?: string;
	  }
	| {
			type: 'transport-request';
			transportId: number;
			transportKey: number;
			request: SessionTransportRequest;
	  }
	| {
			type: 'transport-cancel';
			transportId: number;
			transportKey: number;
	  };
