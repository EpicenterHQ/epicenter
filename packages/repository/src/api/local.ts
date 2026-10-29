/**
 * The in-process host: a replica in this process (Bun, a script, a test),
 * served to the repository as its worker would serve a page. Every answer
 * and every change arrives asynchronously and in order, a change before the
 * answer to the write that made it, as across a worker's messages.
 *
 * `end()` stops the session as a worker's loss would (calls in flight and
 * later ones reject, and the repository shows `opening`); `resume()` opens a
 * new one, over the same replica or another opened on the same database.
 *
 * Blobs go to the device store given (`createFileBlobStore` in Bun; memory
 * by default), and with an `lfs` client the upload track runs here, as in a
 * browser's worker: from the start, and after every change.
 */
import { type Collection, type PageServer, servePage } from '../client/page.js';
import { type BlobStore, createMemoryBlobStore } from '../client/blobs.js';
import { type Bytes, serveBytes } from '../client/bytes.js';
import type { Replica } from '../client/replica.js';
import { startUploads, type Uploads } from '../client/uploads.js';
import type { LfsClient } from '../wire/client.js';
import type { App, Definitions, Lens } from '../core/lens.js';
import { type Host, type HostState, openRepository, type Repository, type Session } from './repository.js';

/** An app's note collections as a replica serves them. */
export function collectionsOf(app: { lenses: Lens[] }): Collection[] {
	return app.lenses.flatMap((lens) => (lens.kind === 'note' ? [{ name: lens.name, view: lens.view, template: lens.template, memory: lens.memory }] : []));
}

const ended = () => Promise.reject(new Error('The session ended'));

function sessionOver(page: PageServer, bytes: Bytes, alive: () => boolean): Session {
	const answer = <T>(run: () => T): Promise<T> => (alive() ? Promise.resolve().then(() => (alive() ? run() : ended())) : ended());
	return {
		snapshot: () => answer(() => page.snapshot()),
		row: (path) => answer(() => page.read(path)),
		files: () => answer(() => page.files()),
		waiting: () => answer(() => page.waiting()),
		query: (sql, params) => answer(() => page.query(sql, params)),
		change(changes, token) {
			if (!alive()) return ended();
			// Applied when called, in order, as a worker applies messages in order; answered after the changes it made are heard.
			const result = page.change(changes, token);
			return Promise.resolve().then(() => (alive() ? result : ended()));
		},
		watch(listener) {
			return page.watch((delta) =>
				queueMicrotask(() => {
					if (alive()) listener(delta);
				}),
			);
		},
		put: (blobs, changes, token) => (alive() ? bytes.put(blobs, changes, token).then((result) => (alive() ? result : ended())) : ended()),
		open: (path) => (alive() ? bytes.open(path).then((result) => (alive() ? result : ended())) : ended()),
	};
}

/** Serve `replica` in this process; `end` and `resume` stand in for a worker's loss and a new one. */
export function createLocalHost({
	replica,
	app,
	store = createMemoryBlobStore(),
	lfs = null,
}: {
	replica: Replica;
	app: { lenses: Lens[] };
	/** Where this device keeps blob bytes. */
	store?: BlobStore<Blob>;
	/** The server's LFS endpoint, for the upload track and downloads; null keeps bytes here only. */
	lfs?: LfsClient | null;
}) {
	const watchers = new Set<(state: HostState) => void>();
	let state: HostState = { status: 'opening' };
	let generation = 0;
	let stopPage: (() => void) | null = null;
	const set = (next: HostState) => {
		state = next;
		for (const watcher of watchers) watcher(next);
	};
	let uploads: Uploads | null = null;
	function start(over: Replica) {
		const mine = ++generation;
		const page = servePage(over, collectionsOf(app));
		const alive = () => generation === mine;
		// The page's own watch on the replica stops with the session.
		const stops: (() => void)[] = [];
		uploads?.stop();
		const track = lfs === null ? null : startUploads({ replica: over, store, lfs });
		uploads = track;
		if (track !== null) stops.push(over.watch(() => track.kick()), () => track.stop());
		const session = sessionOver(
			{
				...page,
				watch(listener) {
					const stop = page.watch(listener);
					stops.push(stop);
					return stop;
				},
			},
			serveBytes({ replica: { read: over.read, blobLimit: over.blobLimit, change: page.change }, store, lfs }),
			alive,
		);
		stopPage = () => {
			for (const stop of stops.splice(0)) stop();
		};
		set({ status: 'open', session });
	}
	const host: Host = {
		subscribe(onState) {
			watchers.add(onState);
			onState(state);
			return () => {
				watchers.delete(onState);
			};
		},
		close() {
			generation++;
			stopPage?.();
			set({ status: 'closed' });
			watchers.clear();
		},
	};
	queueMicrotask(() => {
		if (state.status === 'opening') start(replica);
	});
	return {
		host,
		/** The session ends, as when a worker is lost. */
		end(next: Exclude<HostState, { status: 'open' }> = { status: 'opening' }) {
			generation++;
			stopPage?.();
			set(next);
		},
		/** A new session, over `over` (by default the same replica). */
		resume(over: Replica = replica) {
			start(over);
		},
		/** Resolve once the upload track has nothing to send now. */
		uploaded: () => uploads?.idle() ?? Promise.resolve(),
	};
}

/** Open `app`'s repository over a replica in this process. */
export function openLocalRepository<TDefs extends Definitions>({
	app,
	replica,
	store,
	lfs,
}: {
	app: App<TDefs>;
	replica: Replica;
	store?: BlobStore<Blob>;
	lfs?: LfsClient | null;
}): Repository<TDefs> {
	return openRepository({ app, host: createLocalHost({ replica, app, ...(store === undefined ? {} : { store }), ...(lfs === undefined ? {} : { lfs }) }).host });
}
