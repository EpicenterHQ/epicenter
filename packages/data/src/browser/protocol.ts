import type {
	ExchangeRequest,
	ExchangeResponse,
	JsonValue,
} from '../protocol/index.js';
import type { SyncState } from '../sync-supervisor.js';

export type SerializedTableDefinition = {
	namespace: string;
	table: string;
	fields: Record<string, unknown>;
	optionalFields: string[];
};

export type SerializedValueDefinition = {
	namespace: string;
	value: string;
	schema: unknown;
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
			rowId: string;
	  }
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			rowId: string;
			patch: Record<string, unknown>;
	  }
	| {
			kind: 'table-delete';
			definition: SerializedTableDefinition;
			rowId: string;
	  }
	| {
			kind: 'table-list';
			definition: SerializedTableDefinition;
			options: unknown;
	  }
	| {
			kind: 'value-get';
			definition: SerializedValueDefinition;
	  }
	| {
			kind: 'value-set';
			definition: SerializedValueDefinition;
			value: JsonValue;
	  }
	| {
			kind: 'value-unset';
			definition: SerializedValueDefinition;
	  }
	| {
			kind: 'document-open';
			definition: SerializedTableDefinition;
			rowId: string;
	  }
	| { kind: 'document-update'; documentId: number; update: Uint8Array }
	| { kind: 'document-close'; documentId: number }
	| {
			kind: 'attach-sync';
			transportKey: number;
			deploymentId: string;
			principalId: string;
			hasCredentials: boolean;
	  }
	| { kind: 'sync-credentials'; transportKey: number; hasCredentials: boolean }
	| { kind: 'disconnect' };

export type BrowserRequest = {
	type: 'request';
	id: number;
	operation: BrowserOperation;
};

export type BrowserExchangeResult =
	| {
			type: 'exchange-result';
			transportId: number;
			response: ExchangeResponse;
	  }
	| {
			type: 'exchange-error';
			transportId: number;
			name: string;
			message: string;
	  };

export type BrowserWorkerInbound = BrowserRequest | BrowserExchangeResult;

export type BrowserInvalidation = {
	type: 'invalidation';
	token: string;
	change:
		| { kind: 'table'; namespace: string; table: string; rowIds: string[] }
		| { kind: 'value'; namespace: string; value: string };
	broadcast: boolean;
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
			type: 'exchange-request';
			transportId: number;
			transportKey: number;
			request: ExchangeRequest;
	  };

export type BrowserInvalidationSignal = Omit<BrowserInvalidation, 'broadcast'>;
