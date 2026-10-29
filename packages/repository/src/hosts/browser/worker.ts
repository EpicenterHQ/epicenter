/**
 * The owning tab's worker: it holds one replica's SQLite database, its blob
 * bytes and its socket to the server, runs the replica, and answers its one
 * tab. The tab starts it only while holding the replica's Web Lock and tells
 * it to close before giving the lock up, so one runs per replica per origin,
 * apart from the moments when an old one is still letting go.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { BlobStoreError, Sealed } from '../../client/blobs.js';
import { openReplica, type Replica } from '../../client/replica.js';
import { connectSocket } from '../../client/socket.js';
import type { SqlDriver, SqlValue } from '../../sql.js';
import { createWireClient } from '../../wire/client.js';
import { OBJECTS, readManifest, replicaDirectory, writeManifest } from './layout.js';
import { type Call, type Init, SaveError, type TabMessage, type WorkerMessage } from './messages.js';
import { createOpfsBlobStore, type OpfsBlobStore } from './objects.js';
import { clearReported, openReplicaDatabase, storageWasFull } from './sqlite.js';

const log = createLogger('repository/browser-worker');

const post = (message: WorkerMessage) => postMessage(message);

/** A Result as it crosses to the tab: an error's `cause` may not be cloneable, so it goes as its message. */
function plain<T, E extends { cause?: unknown }>(result: Result<T, E>): Result<T, E> {
	if (result.error === null || result.error.cause === undefined) return result;
	return { data: null, error: { ...result.error, cause: extractErrorMessage(result.error.cause) } };
}

/** What the tab may call, by name. */
function replicaMethods(replica: Replica, blobs: OpfsBlobStore) {
	return {
		read: (path: string) => replica.read(path),
		paths: () => replica.paths(),
		state: (path: string) => replica.state(path),
		held: () => replica.held(),
		query: (sql: string, params?: SqlValue[]) => replica.query(sql, params),
		busy: () => replica.busy(),
		/** Paths whose text has not reached the server: unsent, in flight, or held. */
		unsent: () => replica.unsent(),
		/**
		 * Save texts, each merged with what this device shows if that moved
		 * since `over`. Stored, or not at all: a save storage refuses (full,
		 * or failing) changes nothing, and says so before anything is acknowledged.
		 */
		write(changes: Record<string, string | null>, over?: Record<string, string | null>): Result<undefined, SaveError> {
			clearReported();
			try {
				replica.writeAll(changes, over === undefined ? {} : { over });
				return Ok(undefined);
			} catch (cause) {
				if (storageWasFull()) return SaveError.QuotaExceeded();
				return SaveError.Failed({ reason: extractErrorMessage(cause) });
			}
		},
		/** Seal a blob's bytes into this replica's objects. */
		seal: async (blob: Blob): Promise<Result<Sealed, BlobStoreError>> => plain(await blobs.seal(blob.stream() as ReadableStream<Uint8Array>)),
		/** A blob's bytes, as a File the page reads or shows, which outlives this worker. */
		blob: (oid: string) => blobs.read(oid),
		hasBlob: (oid: string) => blobs.has(oid),
		evictBlob: (oid: string) => blobs.evict(oid),
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

	async function start({ replica: id, create, views, headers }: Init) {
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
			app: { lenses: views },
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
		replica.watch((paths) => post({ type: 'changed', paths }));
		methods = replicaMethods(replica, blobs);
		close = async () => {
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
