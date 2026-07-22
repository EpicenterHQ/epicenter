import type { JsonValue, RecordAddress } from '../protocol/v1/index.js';
import type { RecordInspection } from '../record-epicenter.js';
import type { RecordSyncState } from '../record-sync-supervisor.js';
import type {
	BlobInspection,
	ReplicaAttachmentState,
	ReplicaParkedWorkPage,
	ReplicaVisibleRecord,
	ReplicaVisibleRecordPage,
	ReplicaWorkSummary,
} from '../store/replica/index.js';

export const DESKTOP_RECORD_ROUTE = '/api/data/records';
export const EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME =
	'EpicenterDesktopRecordMovedError';
export const EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME =
	'EpicenterDesktopRecordRequestError';
export const EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME =
	'EpicenterDesktopRecordOperationError';

/** Inclusive ceiling shared by inline and host-owned record blob sources. */
export const MAX_RECORD_BLOB_BYTES = 5 * 1024 * 1024 * 1024;

export type DesktopRecordNativeCapture = {
	kind: 'native-capture';
	captureId: string;
	byteLength: number;
};

export type DesktopRecordBlobOperationSource =
	| { kind: 'bytes'; bytesBase64: string }
	| DesktopRecordNativeCapture;

export type DesktopRecordOperation =
	| { kind: 'open' }
	| { kind: 'read'; address: RecordAddress }
	| {
			kind: 'read-page';
			namespace: string;
			collection: string;
			after?: string;
			limit?: number;
	  }
	| {
			kind: 'create-record';
			namespace: string;
			collection: string;
			payload: Record<string, JsonValue>;
	  }
	| {
			kind: 'create-record-with-blob';
			namespace: string;
			collection: string;
			payload: Record<string, JsonValue>;
			source: DesktopRecordBlobOperationSource;
	  }
	| {
			kind: 'patch-live';
			address: RecordAddress;
			patch: { set: Record<string, JsonValue>; unset: string[] };
	  }
	| { kind: 'tombstone-live'; address: RecordAddress }
	| { kind: 'replace'; address: RecordAddress; value: JsonValue }
	| { kind: 'unset'; address: RecordAddress }
	| { kind: 'export-document'; address: RecordAddress }
	| {
			kind: 'append-local-document-update';
			address: RecordAddress;
			updateBase64: string;
	  }
	| {
			kind: 'install-accepted-document-update';
			address: RecordAddress;
			updateBase64: string;
	  }
	| { kind: 'put-blob'; address: RecordAddress; bytesBase64: string }
	| { kind: 'read-blob'; address: RecordAddress }
	| { kind: 'inspect-blob'; address: RecordAddress }
	| { kind: 'parked-work'; after?: RecordAddress }
	| { kind: 'inspect-record'; address: RecordAddress }
	| { kind: 'events'; after: number }
	| { kind: 'disconnect' };

export type DesktopRecordSyncStatus = {
	state: RecordSyncState;
	work: ReplicaWorkSummary;
	authorityLifetime?: string;
	lastError?: { name: string; message: string };
};

export type DesktopRecordEvent =
	| { cursor: number; kind: 'records-invalidated'; addresses: RecordAddress[] }
	| { cursor: number; kind: 'blob-invalidated'; address: RecordAddress }
	| {
			cursor: number;
			kind: 'address-revoked';
			address: RecordAddress;
			message: string;
	  }
	| {
			cursor: number;
			kind: 'attachment';
			attachment: ReplicaAttachmentState;
	  }
	| {
			cursor: number;
			kind: 'sync-status';
			status: DesktopRecordSyncStatus;
	  };

export type DesktopRecordResult =
	| {
			kind: 'open';
			generation: number;
			cursor: number;
			attachment: ReplicaAttachmentState;
			syncStatus: DesktopRecordSyncStatus;
	  }
	| { kind: 'read'; record: ReplicaVisibleRecord | null }
	| { kind: 'read-page'; page: ReplicaVisibleRecordPage }
	| { kind: 'create-record'; recordKey: string }
	| { kind: 'create-record-with-blob'; recordKey: string }
	| { kind: 'patch-live'; record: ReplicaVisibleRecord | null }
	| { kind: 'tombstone-live'; deleted: boolean }
	| { kind: 'replace' }
	| { kind: 'unset' }
	| {
			kind: 'export-document';
			recordState: 'live' | 'unset' | 'not-openable';
			updateBase64?: string;
	  }
	| { kind: 'append-local-document-update' }
	| { kind: 'install-accepted-document-update' }
	| { kind: 'put-blob'; digest: string }
	| { kind: 'read-blob'; bytesBase64: string | null }
	| { kind: 'inspect-blob'; inspection: BlobInspection }
	| { kind: 'parked-work'; page: ReplicaParkedWorkPage }
	| { kind: 'inspect-record'; inspection: RecordInspection }
	| {
			kind: 'events';
			cursor: number;
			events: DesktopRecordEvent[];
			overflowed: boolean;
	  }
	| { kind: 'disconnect' };

export type DesktopRecordRequest = {
	surfaceId: string;
	generation?: number;
	mutationId?: number;
	operation: DesktopRecordOperation;
};

export type DesktopRecordResponse =
	| { result: DesktopRecordResult; error: null }
	| { result: null; error: DesktopRecordError };

export type DesktopRecordError =
	| {
			name: typeof EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME;
			message: 'Desktop record surface generation changed';
	  }
	| {
			name: typeof EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME;
			message: 'Desktop record request is invalid';
	  }
	| {
			name: typeof EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME;
			message: 'Desktop record operation failed';
	  };

export function desktopRecordUrl(baseUrl: string): string {
	return new URL(DESKTOP_RECORD_ROUTE, baseUrl).toString();
}

export function isDesktopRecordMutation(
	operation: DesktopRecordOperation,
): boolean {
	switch (operation.kind) {
		case 'create-record':
		case 'create-record-with-blob':
		case 'patch-live':
		case 'tombstone-live':
		case 'replace':
		case 'unset':
		case 'append-local-document-update':
		case 'install-accepted-document-update':
		case 'put-blob':
			return true;
		case 'open':
		case 'read':
		case 'read-page':
		case 'export-document':
		case 'read-blob':
		case 'inspect-blob':
		case 'parked-work':
		case 'inspect-record':
		case 'events':
		case 'disconnect':
			return false;
		default:
			return operation satisfies never;
	}
}
