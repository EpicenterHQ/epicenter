import type {
	BrowserReplicaAction,
	BrowserReplicaAnalysis,
	BrowserReplicaConformanceEvidenceDriver,
	BrowserReplicaObservation,
	BrowserReplicaStorageIdentity,
	BrowserReplicaTestOutbound,
	BrowserReplicaTestRequest,
	BrowserReplicaTestResult,
} from './replica-conformance-contract.js';

declare global {
	interface Window {
		browserReplicaConformanceEvidence: BrowserReplicaConformanceEvidenceDriver;
	}
}

type PendingRequest = {
	resolve(value: BrowserReplicaTestResult): void;
	reject(cause: unknown): void;
};

function createWorkerClient() {
	const worker = new Worker(
		new URL('./replica-conformance-worker.ts', import.meta.url),
		{ type: 'module' },
	);
	const pending = new Map<number, PendingRequest>();
	const crashBoundaries = new Map<
		number,
		{ resolve(): void; reject(cause: unknown): void }
	>();
	let nextRequestId = 0;
	let isTerminated = false;

	function rejectPending(cause: Error): void {
		for (const request of pending.values()) request.reject(cause);
		for (const boundary of crashBoundaries.values()) boundary.reject(cause);
		pending.clear();
		crashBoundaries.clear();
	}

	worker.addEventListener(
		'message',
		({ data: message }: MessageEvent<BrowserReplicaTestOutbound>) => {
			if (message.type === 'crash-boundary') {
				const boundary = crashBoundaries.get(message.id);
				if (boundary === undefined) return;
				crashBoundaries.delete(message.id);
				boundary.resolve();
				return;
			}
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
		rejectPending(
			new Error(message || 'browser replica conformance worker failed'),
		);
	});

	function request(
		request: BrowserReplicaTestRequest,
	): Promise<BrowserReplicaTestResult> {
		if (isTerminated)
			throw new Error('browser replica conformance worker is terminated');
		const id = nextRequestId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			worker.postMessage({ type: 'request', id, request });
		});
	}

	return {
		request,
		crash(action: BrowserReplicaAction, boundary: number): Promise<void> {
			if (isTerminated)
				throw new Error('browser replica conformance worker is terminated');
			const id = nextRequestId++;
			return new Promise((resolve, reject) => {
				crashBoundaries.set(id, { resolve, reject });
				worker.postMessage({
					type: 'request',
					id,
					request: { kind: 'crash', action, boundary },
				});
			});
		},
		terminate(
			cause = new Error('browser replica conformance worker terminated'),
		) {
			if (isTerminated) return;
			isTerminated = true;
			worker.terminate();
			rejectPending(cause);
		},
	};
}

type WorkerClient = ReturnType<typeof createWorkerClient>;

function storageIdentity(id: string): BrowserReplicaStorageIdentity {
	return {
		databaseFilename: '/replica.sqlite3',
		poolDirectory: `.epicenter-replica-conformance-${id}`,
		poolName: `epicenter-replica-conformance-${id}`,
	};
}

let main: WorkerClient | undefined;

function requireMain(): WorkerClient {
	if (main === undefined)
		throw new Error('browser replica conformance fixture is not open');
	return main;
}

async function open(fixture: {
	replicaId: string;
	authorityLifetime?: string;
}): Promise<void> {
	if (main !== undefined) await dispose();
	await openStorage(storageIdentity(`main-${crypto.randomUUID()}`), fixture);
}

async function openStorage(
	storage: BrowserReplicaStorageIdentity,
	fixture?: { replicaId: string; authorityLifetime?: string },
	databaseBytes?: number[],
): Promise<void> {
	if (main !== undefined)
		throw new Error('browser replica conformance fixture is already open');
	main = createWorkerClient();
	await main.request({
		kind: 'open',
		storage,
		...(fixture === undefined ? {} : { initialize: fixture }),
		...(databaseBytes === undefined
			? {}
			: { databaseBytes: new Uint8Array(databaseBytes) }),
	});
}

async function observe(
	observation: BrowserReplicaObservation,
): Promise<BrowserReplicaTestResult> {
	return requireMain().request({ kind: 'observe', observation });
}

async function analyze(
	action: BrowserReplicaAction,
): Promise<BrowserReplicaAnalysis> {
	return (await requireMain().request({
		kind: 'analyze',
		action,
	})) as BrowserReplicaAnalysis;
}

async function commit(
	action: BrowserReplicaAction,
): Promise<BrowserReplicaTestResult> {
	return requireMain().request({ kind: 'commit', action });
}

async function exportDatabase(): Promise<number[]> {
	const bytes = (await requireMain().request({ kind: 'export' })) as Uint8Array;
	return [...bytes];
}

async function crashCurrent(
	action: BrowserReplicaAction,
	boundary: number,
): Promise<void> {
	await requireMain().crash(action, boundary);
}

async function reopen(): Promise<void> {
	await requireMain().request({ kind: 'reopen' });
}

async function dispose(): Promise<void> {
	await closeCurrent(true);
}

async function closeCurrent(remove: boolean): Promise<void> {
	const opened = main;
	main = undefined;
	if (opened === undefined) return;
	try {
		await opened.request({ kind: 'close', remove });
	} finally {
		opened.terminate();
	}
}

window.browserReplicaConformanceEvidence = Object.freeze({
	open,
	observe,
	analyze,
	commit,
	reopen,
	dispose,
	openStorage,
	exportDatabase,
	crashCurrent,
	closeCurrent,
});
