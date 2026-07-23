import type { BrowserSqliteDatabase } from '@epicenter/sqlite/browser';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';

import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import {
	createBrowserOpfsBlobFileStore,
	type OpfsDirectoryHandle,
} from '../src/store/replica/browser-opfs-blob-files.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
	type ReplicaBlobStore,
	type ReplicaStore,
} from '../src/store/replica/index.js';
import {
	BLOB_CRASH_ADDRESS,
	type BlobCaptureBoundary,
	type BlobCrashInbound,
	type BlobCrashOutbound,
	type BlobCrashRequest,
	type BlobCrashResult,
	type BlobCrashStorage,
	type BlobDiscardBoundary,
} from './blob-crash-contract.js';

type WorkerScope = {
	addEventListener(
		type: 'message',
		listener: (event: { data: BlobCrashInbound }) => void,
	): void;
	close(): void;
	postMessage(message: BlobCrashOutbound): void;
};

type IterableDirectory = OpfsDirectoryHandle & {
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

const scope = globalThis as unknown as WorkerScope;
const ATTACHMENT = {
	deploymentId: 'https://api.epicenter.so/',
	principalId: 'browser-blob-evidence',
};

let database: Database | undefined;
let pool: SAHPoolUtil | undefined;
let storage: BlobCrashStorage | undefined;
let replica: ReplicaStore | undefined;
let blobs: ReplicaBlobStore<Blob, Blob> | undefined;
let testRoot: IterableDirectory | undefined;
let captureCrash: BlobCaptureBoundary | undefined;
let activeRequestId: number | undefined;

function serializeError(cause: unknown): { message: string; name: string } {
	if (cause instanceof Error) {
		return { message: cause.message, name: cause.name };
	}
	return { message: String(cause), name: 'Error' };
}

function requireReplica(): ReplicaStore {
	if (replica === undefined) throw new Error('blob crash replica is not open');
	return replica;
}

function requireBlobs(): ReplicaBlobStore<Blob, Blob> {
	if (blobs === undefined) throw new Error('blob crash store is not open');
	return blobs;
}

function requireDatabase(): Database {
	if (database === undefined)
		throw new Error('blob crash database is not open');
	return database;
}

function crashFence(
	boundary: BlobCaptureBoundary | BlobDiscardBoundary,
): never {
	if (activeRequestId === undefined) {
		throw new Error(`crash boundary ${boundary} has no active request`);
	}
	scope.postMessage({ id: activeRequestId, type: 'boundary' });
	const fence = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(fence, 0, 0);
	throw new Error(`crash fence ${boundary} resumed`);
}

function captureHook(boundary: BlobCaptureBoundary): void {
	if (captureCrash === boundary) crashFence(boundary);
}

function adapterFor(target: Database) {
	return createBrowserSqliteAdapter(target as unknown as BrowserSqliteDatabase);
}

function configure(target: Database): void {
	target.exec(`
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = EXTRA;
		PRAGMA temp_store = MEMORY;
	`);
}

async function installPool(identity: BlobCrashStorage): Promise<SAHPoolUtil> {
	const sqlite = await sqlite3InitModule();
	let lastFailure: unknown;
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			return await sqlite.installOpfsSAHPoolVfs({
				directory: identity.poolDirectory,
				name: identity.poolName,
			});
		} catch (cause) {
			lastFailure = cause;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error(
		`browser blob crash pool remained locked: ${
			lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
		}`,
		{ cause: lastFailure },
	);
}

async function open(identity: BlobCrashStorage, initialize: boolean) {
	if (database !== undefined)
		throw new Error('blob crash worker is already open');
	storage = identity;
	pool = await installPool(identity);
	database = new pool.OpfsSAHPoolDb(identity.databaseFilename);
	configure(database);
	const root =
		(await navigator.storage.getDirectory()) as unknown as IterableDirectory;
	testRoot = (await root.getDirectoryHandle(identity.rootDirectory, {
		create: true,
	})) as IterableDirectory;
	const files = await createBrowserOpfsBlobFileStore(testRoot);
	const adapter = adapterFor(database);
	replica = openReplicaStore({
		database: adapter,
		limits: makeLimits(),
		...(initialize
			? {
					initialize: {
						authorityLifetime: 'lifetime-one',
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					},
				}
			: {}),
	});
	blobs = createReplicaBlobStore(adapter, files, {
		afterMembership: () => captureHook('afterMembership'),
		afterPromote: () => captureHook('afterPromote'),
		afterStage: () => captureHook('afterStage'),
	});
	await blobs.reopenSweep();
}

async function fileCounts(): Promise<{
	contentFiles: number;
	stagingFiles: number;
}> {
	if (testRoot === undefined) throw new Error('blob crash root is not open');
	const blobRoot = (await testRoot.getDirectoryHandle(
		'blobs',
	)) as IterableDirectory;
	const staging = (await blobRoot.getDirectoryHandle(
		'staging',
	)) as IterableDirectory;
	const content = (await blobRoot.getDirectoryHandle(
		'content',
	)) as IterableDirectory;
	let stagingFiles = 0;
	for await (const entry of staging.values()) {
		if (entry.kind === 'file') stagingFiles += 1;
	}
	let contentFiles = 0;
	for await (const owner of content.values()) {
		if (owner.kind !== 'directory') continue;
		const directory = (await content.getDirectoryHandle(
			owner.name,
		)) as IterableDirectory;
		for await (const entry of directory.values()) {
			if (entry.kind === 'file') contentFiles += 1;
		}
	}
	return { contentFiles, stagingFiles };
}

async function state(): Promise<BlobCrashResult> {
	const openedReplica = requireReplica();
	const openedBlobs = requireBlobs();
	const blob = openedBlobs.inspect(BLOB_CRASH_ADDRESS);
	const bytes =
		blob.kind === 'absent' ? null : await openedBlobs.read(BLOB_CRASH_ADDRESS);
	const integrity = adapterFor(requireDatabase()).all<{
		integrity_check: string;
	}>('PRAGMA integrity_check')[0]?.integrity_check;
	return {
		attachment: openedReplica.attachment(),
		blob,
		...(await fileCounts()),
		integrity: integrity ?? 'missing',
		recordState: openedReplica.visible(BLOB_CRASH_ADDRESS)?.state ?? null,
		text: bytes === null ? null : await bytes.text(),
	};
}

async function close(remove: boolean): Promise<void> {
	database?.close();
	database = undefined;
	replica = undefined;
	blobs = undefined;
	const openedPool = pool;
	pool = undefined;
	if (remove) {
		await openedPool?.removeVfs();
		const identity = storage;
		if (identity !== undefined) {
			const root =
				(await navigator.storage.getDirectory()) as unknown as IterableDirectory;
			await root
				.removeEntry(identity.rootDirectory, { recursive: true })
				.catch(() => undefined);
		}
	} else {
		openedPool?.pauseVfs();
	}
	storage = undefined;
	testRoot = undefined;
	scope.close();
}

async function execute(
	request: BlobCrashRequest,
	requestId: number,
): Promise<BlobCrashResult> {
	activeRequestId = requestId;
	try {
		switch (request.kind) {
			case 'open':
				await open(request.storage, request.initialize);
				return undefined;
			case 'seed':
				requireReplica().localWrite({
					address: BLOB_CRASH_ADDRESS,
					op: 'replace',
					value: { title: 'blob crash evidence' },
				});
				return undefined;
			case 'capture':
				captureCrash = request.crashAt;
				return await requireBlobs().capture(
					BLOB_CRASH_ADDRESS,
					new Blob([request.text]),
				);
			case 'discard':
				requireReplica().attach(ATTACHMENT, 'discard');
				if (request.crashAt === 'afterAttachment') {
					crashFence(request.crashAt);
				}
				if (request.sweep) await requireBlobs().sweepDebris();
				if (request.crashAt === 'afterSweep') {
					crashFence(request.crashAt);
				}
				return undefined;
			case 'sweep':
				await requireBlobs().sweepDebris();
				return undefined;
			case 'state':
				return state();
			case 'close':
				await close(request.remove);
				return undefined;
		}
	} finally {
		activeRequestId = undefined;
		captureCrash = undefined;
	}
}

scope.addEventListener('message', ({ data }) => {
	void execute(data.request, data.id)
		.then((value) => {
			scope.postMessage({ id: data.id, type: 'result', value });
		})
		.catch((cause: unknown) => {
			const error = serializeError(cause);
			scope.postMessage({ id: data.id, type: 'error', ...error });
		});
});
