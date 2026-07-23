import type {
	BlobAcceptance,
	BlobPublicationRequest,
} from '../blob-v1/index.js';
import type { DocumentAcceptance } from '../document-v1/index.js';
import type {
	FactsRequest,
	FactsResponse,
	RecordAddress,
	SubmissionResponse,
} from '../protocol/v1/index.js';
import type {
	CapturedDocumentPublication,
	ReplicaAttachment,
} from '../store/replica/index.js';
import type { SyncStatus } from './supervisor.js';

export type BrowserAuthorityRequest =
	| { kind: 'facts'; request: FactsRequest }
	| { kind: 'submission'; bytes: string }
	| {
			kind: 'document';
			address: RecordAddress;
			publication: CapturedDocumentPublication;
	  }
	| {
			kind: 'blob';
			address: RecordAddress;
			publication: BlobPublicationRequest;
			bytes: Blob;
	  };

export type BrowserAuthorityResult =
	| FactsResponse
	| SubmissionResponse
	| DocumentAcceptance
	| BlobAcceptance;

export type BrowserRuntimeControlOperation =
	| {
			kind: 'runtime-attach';
			attachment: ReplicaAttachment;
			choice?: 'bring' | 'discard';
	  }
	| { kind: 'runtime-status' }
	| { kind: 'runtime-nudge' }
	| { kind: 'runtime-sign-in' }
	| { kind: 'runtime-sign-out' };

export type BrowserRuntimeControlResult =
	| undefined
	| SyncStatus
	| { kind: 'attached' | 'first-attachment-choice' };

export type BrowserRuntimeEvent =
	| {
			type: 'runtime-sync-status';
			ownerSession: string;
			status: SyncStatus;
	  }
	| {
			type: 'runtime-authority-replacement';
			ownerSession: string;
			token: string;
	  }
	| {
			type: 'authority-request';
			id: number;
			request: BrowserAuthorityRequest;
	  };

export type BrowserAuthorityResponse =
	| {
			type: 'authority-result';
			id: number;
			value: BrowserAuthorityResult;
	  }
	| {
			type: 'authority-error';
			id: number;
			name: string;
			message: string;
	  };
