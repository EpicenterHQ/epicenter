/**
 * The owning tab's worker: it holds one replica's SQLite database, its blob
 * bytes and its socket to the server, runs the replica, and answers its one
 * tab. The tab starts it only while holding the replica's Web Lock and tells
 * it to close before giving the lock up, so one runs per replica per origin,
 * apart from the moments when an old one is still letting go.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type { BlobStoreError } from '../../client/blobs.js';
import { type BlobError, type Bytes, type OpenError, type Put, serveBytes } from '../../client/bytes.js';
import { type PageServer, servePage } from '../../client/page.js';
import { type Change, openReplica, type Replica } from '../../client/replica.js';
import { connectSocket } from '../../client/socket.js';
import { startUploads } from '../../client/uploads.js';
import type { SqlDriver, SqlValue } from '../../sql.js';
import { createLfsClient, createWireClient } from '../../wire/client.js';
import { OBJECTS, readManifest, replicaDirectory, writeManifest } from './layout.js';
import { type Call, type Init, SaveError, type TabMessage, type WorkerMessage } from './messages.js';
import { createOpfsBlobStore } from './objects.js';
import { clearReported, openReplicaDatabase, storageWasFull } from './sqlite.js';

const log = createLogger('repository/browser-worker');

const post = (message: WorkerMessage) => postMessage(message);

/** A Result as it crosses to the tab: an error's `cause` may not be cloneable, so it goes as its message. */
function plain<T, E extends object>(result: Result<T, E>): Result<T, E> {
	if (result.error === null || !('cause' in result.error) || result.error.cause === undefined) return result;
	return { data: null, error: { ...result.error, cause: extractErrorMessage(result.error.cause) } };
}

/** What the tab may call, by name. */
function replicaMethods(replica: Replica, page: PageServer, bytes: Bytes) {
	return {
		read: (path: string) => replica.read(path),
		/** Every note of the collections the page keeps in memory, as of one revision. */
		snapshot: () => page.snapshot(),
		/** One note as the page reads it, or null. */
		row: (path: string) => page.read(path),
		paths: () => replica.paths(),
		/** Every file this device shows, with its state. */
		files: () => page.files(),
		/** Every file not yet synced, with its state. */
		waiting: () => page.waiting(),
		state: (path: string) => replica.state(path),
		held: () => replica.held(),
		query: (sql: string, params?: SqlValue[]) => replica.query(sql, params),
		busy: () => replica.busy(),
		/** Paths whose text has not reached the server: unsent, in flight, or held. */
		unsent: () => replica.unsent(),
		/**
		 * Apply changes over what this device shows now, in one transaction:
		 * each path's resulting text and the revision come back. Stored, or
		 * not at all: a save storage refuses (full, or failing) changes
		 * nothing, and says so before anything is acknowledged.
		 */
		change(changes: Change[], token?: number) {
			clearReported();
			return page.change(changes, token);
		},
		/**
		 * Seal `blob` (the page's reference, not a copy) into this replica's
		 * objects, then store a pointer to it at `path`: a create, or with
		 * `replace` a replace, of the file this device shows there.
		 */
		put: async (path: string, blob: Blob, options: { replace: boolean }): Promise<Result<Put, BlobError | BlobStoreError>> => {
			clearReported();
			return plain(await bytes.put(path, blob, options));
		},
		/** A blob's bytes as a File, from this replica's objects or fetched and verified first; it outlives this worker. */
		open: (path: string): Promise<Result<File, OpenError>> => bytes.open(path),
	};
}
export type ReplicaMethods = ReturnType<typeof replicaMethods>;

/** Serve one replica from this worker once its tab sends `Init`. */
export function serveReplicaWorker() {
	let methods: ReplicaMethods | null = null;
	let close: (() => Promise<void>) | null = null;
	let closing = false;
	/** Calls that arrived before the database opened, answered in order once it does. */
	const early: Call[] = [];

	function call(methods: ReplicaMethods, { id, method, args }: Call) {
		let value: unknown;
		try {
			value = (methods[method] as (...given: unknown[]) => unknown)(...args);
		} catch (cause) {
			post({ type: 'failed', id, reason: extractErrorMessage(cause) });
			return;
		}
		Promise.resolve(value).then(
			(settled) => post({ type: 'answer', id, value: settled }),
			(cause: unknown) => post({ type: 'failed', id, reason: extractErrorMessage(cause) }),
		);
	}

	async function start({ replica: id, create, collections, headers }: Init) {
		if (create !== null && (await readManifest(id)) === null) await writeManifest(create);
		const manifest = await readManifest(id);
		const root = await replicaDirectory(id);
		if (manifest === null || root === null) return post({ type: 'missing' });
		const objects = await root.getDirectoryHandle(OBJECTS, { create: true });
		const opened = await openReplicaDatabase(id, {
			onWaiting: (reason) => post({ type: 'waiting', reason }),
			cancelled: () => closing,
		});
		if (closing) {
			if (opened.error === null) opened.data.close();
			return post({ type: 'closed' });
		}
		if (opened.error !== null) {
			log.error(opened.error);
			return post({ type: 'unavailable', reason: opened.error.message });
		}
		const driver: SqlDriver = opened.data;
		// The replica's database holds the server's id, learned when it first meets it.
		const binding = { repository: manifest.repository, server: null, account: manifest.account };
		const { data: replica, error } = openReplica({
			driver,
			binding,
			device: crypto.randomUUID(),
			app: { lenses: collections },
			after: (ms, run) => {
				setTimeout(run, ms);
			},
			now: () => Date.now(),
		});
		if (error !== null) {
			driver.close();
			log.error(error);
			return post({ type: 'unavailable', reason: error.message });
		}
		const connection = manifest.url === null ? null : connectSocket(replica, createWireClient({ url: manifest.url, headers, tickets: true }), { log });
		const blobs = createOpfsBlobStore(objects);
		const lfs = manifest.url === null ? null : createLfsClient({ url: manifest.url, headers });
		// The upload track: from here, after every change (a pointer saved, a catch-up after the socket attached), and again after a failure's wait.
		const uploads = lfs === null ? null : startUploads({ replica, store: blobs, lfs, log });
		const page = servePage(replica, collections, { failed: (cause) => (storageWasFull() ? SaveError.QuotaExceeded() : SaveError.Failed({ reason: extractErrorMessage(cause) })) });
		page.watch((delta) => {
			uploads?.kick();
			post({ type: 'changed', delta });
		});
		methods = replicaMethods(replica, page, serveBytes({ replica, store: blobs, lfs }));
		close = async () => {
			uploads?.stop();
			await blobs.close();
			connection?.close();
			replica.close();
			driver.close();
			post({ type: 'closed' });
		};
		post({ type: 'ready', manifest });
		for (const message of early.splice(0)) call(methods, message);
		if (closing) void close();
	}

	addEventListener('message', (event: MessageEvent<TabMessage>) => {
		const message = event.data;
		switch (message.type) {
			case 'init':
				void start(message).catch((cause: unknown) => post({ type: 'unavailable', reason: extractErrorMessage(cause) }));
				return;
			case 'close':
				closing = true;
				// Before the database opens, `start` sees `closing` and closes it.
				if (close !== null) void close();
				return;
			case 'call':
				if (methods === null) early.push(message);
				else call(methods, message);
				return;
			default:
				message satisfies never;
		}
	});
}
