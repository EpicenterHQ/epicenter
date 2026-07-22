import type {
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
	BrowserReplicaCandidateStatus,
} from '../src/store/replica/browser-candidate-protocol.js';
import type {
	BrowserReplicaOwnerResult,
	BrowserReplicaStoreOperation,
} from '../src/store/replica/browser-owner-protocol.js';
import type { BrowserReplicaCandidateEvidenceDriver } from './replica-candidate-contract.js';

declare global {
	interface Window {
		browserReplicaCandidateEvidence: BrowserReplicaCandidateEvidenceDriver;
	}
}

type PendingRequest = {
	resolve(value: BrowserReplicaOwnerResult): void;
	reject(cause: unknown): void;
};

let worker: Worker | undefined;
let nextRequestId = 0;
let currentStatus: BrowserReplicaCandidateStatus = {
	type: 'status',
	role: 'waiting',
	ownerSession: null,
};
let invalidations: string[] = [];
const pending = new Map<number, PendingRequest>();
const statusWaiters = new Set<() => void>();
let closeResolver: (() => void) | undefined;

function notifyStatus(): void {
	for (const waiter of statusWaiters) waiter();
}

function rejectPending(cause: Error): void {
	for (const request of pending.values()) request.reject(cause);
	pending.clear();
}

function waitUntilReady(): Promise<void> {
	if (currentStatus.role !== 'waiting' && currentStatus.ownerSession !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		function check(): void {
			if (
				currentStatus.role === 'waiting' ||
				currentStatus.ownerSession === null
			)
				return;
			statusWaiters.delete(check);
			resolve();
		}
		statusWaiters.add(check);
	});
}

async function open(
	options: Omit<BrowserReplicaCandidateStart, 'type'>,
): Promise<void> {
	if (worker !== undefined) await close();
	currentStatus = { type: 'status', role: 'waiting', ownerSession: null };
	invalidations = [];
	worker = new Worker(
		new URL('../src/browser-replica-candidate-worker.ts', import.meta.url),
		{ type: 'module' },
	);
	worker.addEventListener(
		'message',
		({ data: message }: MessageEvent<BrowserReplicaCandidateOutbound>) => {
			switch (message.type) {
				case 'status':
					currentStatus = message;
					notifyStatus();
					return;
				case 'invalidation':
					invalidations.push(message.token);
					return;
				case 'result':
				case 'error': {
					const target = pending.get(message.id);
					if (target === undefined) return;
					pending.delete(message.id);
					if (message.type === 'result') target.resolve(message.value);
					else {
						const error = new Error(message.message);
						error.name = message.name;
						target.reject(error);
					}
					return;
				}
				case 'closed':
					closeResolver?.();
					closeResolver = undefined;
					return;
				case 'fatal': {
					const error = new Error(message.message);
					error.name = message.name;
					rejectPending(error);
					return;
				}
			}
		},
	);
	worker.addEventListener('error', ({ message }) => {
		rejectPending(new Error(message || 'browser replica candidate failed'));
	});
	worker.postMessage({
		type: 'start',
		...options,
	} satisfies BrowserReplicaCandidateStart);
	await waitUntilReady();
}

function request(
	operation: BrowserReplicaStoreOperation,
): Promise<BrowserReplicaOwnerResult> {
	if (worker === undefined)
		throw new Error('browser replica candidate is not open');
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker?.postMessage({ type: 'request', id, operation });
	});
}

function status(): BrowserReplicaCandidateStatus {
	return structuredClone(currentStatus);
}

function takeInvalidations(): string[] {
	const captured = invalidations;
	invalidations = [];
	return captured;
}

function terminate(): void {
	const opened = worker;
	worker = undefined;
	opened?.terminate();
	rejectPending(new Error('browser replica candidate terminated'));
}

async function close(): Promise<void> {
	const opened = worker;
	worker = undefined;
	if (opened === undefined) return;
	try {
		await new Promise<void>((resolve) => {
			closeResolver = resolve;
			opened.postMessage({ type: 'close' });
		});
	} finally {
		opened.terminate();
		rejectPending(new Error('browser replica candidate closed'));
	}
}

window.browserReplicaCandidateEvidence = Object.freeze({
	open,
	request,
	status,
	takeInvalidations,
	terminate,
	close,
});
