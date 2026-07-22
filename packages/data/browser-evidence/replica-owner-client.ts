import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import type {
	BrowserReplicaOwnerMessage,
	BrowserReplicaOwnerOperation,
	BrowserReplicaOwnerResult,
} from '../src/store/replica/browser-owner-protocol.js';
import type { BrowserReplicaOwnerEvidenceDriver } from './replica-owner-contract.js';

declare global {
	interface Window {
		browserReplicaOwnerEvidence: BrowserReplicaOwnerEvidenceDriver;
	}
}

type PendingRequest = {
	resolve(value: BrowserReplicaOwnerResult): void;
	reject(cause: unknown): void;
};

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

function rejectPending(cause: Error): void {
	for (const request of pending.values()) request.reject(cause);
	pending.clear();
}

function request(
	operation: BrowserReplicaOwnerOperation,
): Promise<BrowserReplicaOwnerResult> {
	if (worker === undefined)
		throw new Error('browser replica evidence is not open');
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker?.postMessage({ type: 'request', id, operation });
	});
}

async function open(
	storageId: string,
	fixture: { replicaId: string; authorityLifetime?: string },
): Promise<void> {
	if (worker !== undefined) await dispose();
	worker = new Worker(
		new URL('../src/browser-replica-worker.ts', import.meta.url),
		{ type: 'module', name: `epicenter-replica-${storageId}` },
	);
	worker.addEventListener(
		'message',
		({ data: message }: MessageEvent<BrowserReplicaOwnerMessage>) => {
			const target = pending.get(message.id);
			if (target === undefined) return;
			pending.delete(message.id);
			if (message.type === 'result') target.resolve(message.value);
			else {
				const error = new Error(message.message);
				error.name = message.name;
				target.reject(error);
			}
		},
	);
	worker.addEventListener('error', ({ message }) => {
		rejectPending(new Error(message || 'browser replica owner worker failed'));
	});
	await request({
		kind: 'open',
		limits: makeLimits(),
		initialize: fixture,
		storage: {
			databaseFilename: '/replica.sqlite3',
			poolDirectory: `.epicenter-replica-evidence-${storageId}`,
			poolName: `epicenter-replica-evidence-${storageId}`,
		},
	});
}

async function dispose(): Promise<void> {
	if (worker === undefined) return;
	const opened = worker;
	try {
		await request({ kind: 'dispose' });
	} finally {
		worker = undefined;
		opened.terminate();
		rejectPending(new Error('browser replica evidence disposed'));
	}
}

function terminate(): void {
	const opened = worker;
	worker = undefined;
	opened?.terminate();
	rejectPending(new Error('browser replica owner terminated'));
}

window.browserReplicaOwnerEvidence = Object.freeze({
	open,
	request(operation) {
		return request(operation);
	},
	dispose,
	terminate,
});
