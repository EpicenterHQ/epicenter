import type { RecordAddress } from '../src/protocol/v1/index.js';
import type {
	BlobInspection,
	ReplicaAttachmentState,
} from '../src/store/replica/index.js';

export const BLOB_CRASH_ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.browser-evidence',
	collection: 'assets',
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};

export type BlobCaptureBoundary =
	| 'afterStage'
	| 'afterPromote'
	| 'afterMembership';

export type BlobDiscardBoundary = 'afterAttachment' | 'afterSweep';

export type BlobCrashStorage = {
	id: string;
	databaseFilename: string;
	poolDirectory: string;
	poolName: string;
	rootDirectory: string;
};

export type BlobCrashState = {
	attachment: ReplicaAttachmentState;
	blob: BlobInspection;
	contentFiles: number;
	integrity: string;
	recordState: 'live' | 'tombstone' | 'unset' | null;
	stagingFiles: number;
	text: string | null;
};

export type BlobCrashRequest =
	| { kind: 'open'; storage: BlobCrashStorage; initialize: boolean }
	| { kind: 'seed' }
	| {
			kind: 'capture';
			text: string;
			crashAt?: BlobCaptureBoundary;
	  }
	| { kind: 'discard'; crashAt?: BlobDiscardBoundary; sweep: boolean }
	| { kind: 'sweep' }
	| { kind: 'state' }
	| { kind: 'close'; remove: boolean };

export type BlobCrashResult = undefined | string | BlobCrashState;

export type BlobCrashInbound = {
	id: number;
	request: BlobCrashRequest;
	type: 'request';
};

export type BlobCrashOutbound =
	| { id: number; type: 'boundary' }
	| { id: number; type: 'result'; value: BlobCrashResult }
	| { id: number; message: string; name: string; type: 'error' };

export type BrowserBlobCrashDriver = {
	open(id: string, initialize: boolean): Promise<void>;
	seed(): Promise<void>;
	capture(text: string, crashAt?: BlobCaptureBoundary): Promise<string>;
	discard(options: {
		crashAt?: BlobDiscardBoundary;
		sweep: boolean;
	}): Promise<void>;
	sweep(): Promise<void>;
	state(): Promise<BlobCrashState>;
	crashCapture(text: string, boundary: BlobCaptureBoundary): Promise<void>;
	crashDiscard(boundary: BlobDiscardBoundary): Promise<void>;
	close(remove: boolean): Promise<void>;
};
