import type {
	BlobCaptureBoundary,
	BlobCrashOutbound,
	BlobCrashRequest,
	BlobCrashResult,
	BlobCrashState,
	BlobCrashStorage,
	BlobDiscardBoundary,
	BrowserBlobCrashDriver,
} from './blob-crash-contract.js';

declare global {
	interface Window {
		browserBlobCrashEvidence: BrowserBlobCrashDriver;
	}
}

type Pending = {
	reject(cause: unknown): void;
	resolve(value: BlobCrashResult): void;
};

function storageFor(id: string): BlobCrashStorage {
	return {
		databaseFilename: '/replica.sqlite3',
		id,
		poolDirectory: `.epicenter-blob-crash-${id}`,
		poolName: `epicenter-blob-crash-${id}`,
		rootDirectory: `epicenter-blob-crash-${id}`,
	};
}

function createClient() {
	const worker = new Worker(
		new URL('./blob-crash-worker.ts', import.meta.url),
		{
			type: 'module',
		},
	);
	const pending = new Map<number, Pending>();
	const boundaries = new Map<
		number,
		{ reject(cause: unknown): void; resolve(): void }
	>();
	let nextId = 0;
	let terminated = false;

	function rejectAll(cause: Error): void {
		for (const request of pending.values()) request.reject(cause);
		for (const boundary of boundaries.values()) boundary.reject(cause);
		pending.clear();
		boundaries.clear();
	}

	worker.addEventListener(
		'message',
		({ data }: MessageEvent<BlobCrashOutbound>) => {
			if (data.type === 'boundary') {
				const boundary = boundaries.get(data.id);
				if (boundary === undefined) return;
				boundaries.delete(data.id);
				boundary.resolve();
				return;
			}
			const request = pending.get(data.id);
			if (request === undefined) return;
			pending.delete(data.id);
			if (data.type === 'result') request.resolve(data.value);
			else {
				const error = new Error(data.message);
				error.name = data.name;
				request.reject(error);
			}
		},
	);
	worker.addEventListener('error', ({ message }) => {
		rejectAll(new Error(message || 'browser blob crash worker failed'));
	});

	function request(request: BlobCrashRequest): Promise<BlobCrashResult> {
		if (terminated) throw new Error('browser blob crash worker is terminated');
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { reject, resolve });
			worker.postMessage({ id, request, type: 'request' });
		});
	}

	function waitForBoundary(request: BlobCrashRequest): Promise<void> {
		if (terminated) throw new Error('browser blob crash worker is terminated');
		const id = nextId++;
		return new Promise((resolve, reject) => {
			boundaries.set(id, { reject, resolve });
			worker.postMessage({ id, request, type: 'request' });
		});
	}

	return {
		request,
		waitForBoundary,
		terminate() {
			if (terminated) return;
			terminated = true;
			worker.terminate();
			rejectAll(new Error('browser blob crash worker terminated'));
		},
	};
}

let current: ReturnType<typeof createClient> | undefined;

function requireCurrent() {
	if (current === undefined)
		throw new Error('browser blob evidence is not open');
	return current;
}

async function open(id: string, initialize: boolean): Promise<void> {
	if (current !== undefined) await close(false);
	current = createClient();
	await current.request({
		initialize,
		kind: 'open',
		storage: storageFor(id),
	});
}

async function close(remove: boolean): Promise<void> {
	const opened = current;
	current = undefined;
	if (opened === undefined) return;
	try {
		await opened.request({ kind: 'close', remove });
	} finally {
		opened.terminate();
	}
}

async function crash(request: BlobCrashRequest): Promise<void> {
	const opened = requireCurrent();
	await opened.waitForBoundary(request);
	current = undefined;
	opened.terminate();
}

window.browserBlobCrashEvidence = Object.freeze({
	open,
	seed: async () => {
		await requireCurrent().request({ kind: 'seed' });
	},
	capture: async (text: string, crashAt?: BlobCaptureBoundary) =>
		(await requireCurrent().request({
			kind: 'capture',
			text,
			...(crashAt === undefined ? {} : { crashAt }),
		})) as string,
	discard: async ({
		crashAt,
		sweep,
	}: {
		crashAt?: BlobDiscardBoundary;
		sweep: boolean;
	}) => {
		await requireCurrent().request({
			kind: 'discard',
			sweep,
			...(crashAt === undefined ? {} : { crashAt }),
		});
	},
	sweep: async () => {
		await requireCurrent().request({ kind: 'sweep' });
	},
	state: async () =>
		(await requireCurrent().request({ kind: 'state' })) as BlobCrashState,
	crashCapture: (text: string, boundary: BlobCaptureBoundary) =>
		crash({ crashAt: boundary, kind: 'capture', text }),
	crashDiscard: (boundary: BlobDiscardBoundary) =>
		crash({ crashAt: boundary, kind: 'discard', sweep: true }),
	close,
});
