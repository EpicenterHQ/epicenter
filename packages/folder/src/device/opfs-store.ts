/**
 * A device store over this origin's private file system (OPFS), for
 * `openDevice` from `@epicenter/folder/browser`. Every operation runs in one
 * dedicated Worker this store starts at its first call and owns
 * (`opfs-worker.ts`, decision 55); this side only posts requests and reads
 * replies.
 *
 * A browser that gives the page no private storage, as WebKit does in an
 * ephemeral context, refuses `getDirectory()`: each call is then
 * `Unavailable`, its cause a `DeviceError.StorageRefused`, never a throw.
 * OPFS is evictable (`persist()` was false in every headless probe): a local
 * web variant's files are this browser's alone (ADR-0700), and live as
 * long as the browser keeps them.
 *
 * Other tabs' writes arrive on the broadcast channel the Worker posts every
 * landed change to (`CHANGES`); a store skips the ones it asked for itself.
 */
import { ClientError, type Version } from '@epicenter/definition/contract';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { createChanges } from '../changes.js';
import type { Changed, Reply } from './opfs-worker.js';
import type { DeviceExpectation, DeviceStore } from './store.js';

/**
 * The broadcast channel every device store and worker of this origin shares.
 * The Worker names it too, since importing a value from it would run it here.
 */
const CHANGES = 'epicenter-device';

export const DeviceError = defineErrors({
	/** The browser gives this page no private file storage (`navigator.storage.getDirectory()` rejected). */
	StorageRefused: ({ cause }: { cause: unknown }) => ({
		message: `This browser gives the page no private file storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The device's Worker could not start or stopped. */
	WorkerFailed: ({ cause }: { cause: unknown }) => ({
		message: `The device's file worker failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type DeviceError = InferErrors<typeof DeviceError>;

type Request =
	| { op: 'list' }
	| { op: 'read'; path: string }
	| {
			op: 'write';
			path: string;
			bytes: Uint8Array | null;
			expected: DeviceExpectation;
			from: string;
	  }
	| {
			op: 'append';
			path: string;
			bytes: Uint8Array;
			create: boolean;
			announce: boolean;
			from: string;
	  };

export function opfsStore(): DeviceStore {
	let worker: Worker | undefined;
	let closed = false;
	let next = 0;
	const waiting = new Map<number, (reply: Reply) => void>();
	/** Names this store's writes on the broadcast channel, to skip them there. */
	const writer = crypto.randomUUID();
	const changes = createChanges((emit) => {
		if (typeof BroadcastChannel === 'undefined') return () => {};
		const channel = new BroadcastChannel(CHANGES);
		channel.onmessage = ({ data }: MessageEvent<Changed>) => {
			if (data?.from !== writer)
				emit(Array.isArray(data?.paths) ? data.paths : null);
		};
		return () => channel.close();
	});

	function start() {
		// The literal `new Worker(new URL(…, import.meta.url))` is what Vite
		// and other bundlers recognize and ship as a Worker.
		const started = new Worker(new URL('./opfs-worker.ts', import.meta.url), {
			type: 'module',
			name: 'epicenter-device',
		});
		started.addEventListener('message', (event: MessageEvent<Reply>) => {
			const settle = waiting.get(event.data.id);
			waiting.delete(event.data.id);
			settle?.(event.data);
		});
		started.addEventListener('error', (event) => {
			event.preventDefault();
			const message =
				event instanceof ErrorEvent && event.message
					? event.message
					: 'the worker could not start';
			fail(message);
			started.terminate();
			if (worker === started) worker = undefined;
		});
		return started;
	}

	/** Answer every call still waiting with `WorkerFailed`. */
	function fail(message: string) {
		for (const [id, settle] of waiting)
			settle({ id, ok: false, refused: false, name: 'WorkerFailed', message });
		waiting.clear();
	}

	async function call(request: Request, transfer: Transferable[] = []) {
		if (closed)
			return ClientError.Unavailable({
				cause: DeviceError.WorkerFailed({ cause: 'the device was closed' })
					.error,
			});
		if (typeof Worker === 'undefined')
			return ClientError.Unavailable({
				cause: DeviceError.WorkerFailed({
					cause: 'this context has no Worker',
				}).error,
			});
		let target: Worker;
		try {
			worker ??= start();
			target = worker;
		} catch (cause) {
			return ClientError.Unavailable({
				cause: DeviceError.WorkerFailed({ cause }).error,
			});
		}
		const id = next++;
		const reply = await new Promise<Reply>((resolve) => {
			waiting.set(id, resolve);
			target.postMessage({ ...request, id }, transfer);
		});
		if (reply.ok) return Ok(reply.value);
		const cause = reply.refused
			? DeviceError.StorageRefused({ cause: reply.message }).error
			: reply.name === 'WorkerFailed'
				? DeviceError.WorkerFailed({ cause: reply.message }).error
				: new Error(reply.message);
		return ClientError.Unavailable({ cause });
	}

	return {
		async list() {
			const listed = await call({ op: 'list' });
			if (listed.error !== null) return listed;
			return Ok(listed.data as { path: string; stamp: string }[]);
		},
		async read(path) {
			const read = await call({ op: 'read', path });
			if (read.error !== null) return read;
			return Ok(
				read.data as {
					bytes: Uint8Array;
					version: Version;
					stamp: string;
				} | null,
			);
		},
		async write(path, bytes, expected) {
			// A copy goes to the Worker, so the caller's bytes stay usable.
			const owned = bytes === null ? null : bytes.slice();
			const written = await call(
				{ op: 'write', path, bytes: owned, expected, from: writer },
				owned === null ? [] : [owned.buffer],
			);
			if (written.error !== null) return written;
			return Ok(written.data as 'landed' | 'stale');
		},
		async append(path, bytes, { create, announce }) {
			const owned = bytes.slice();
			const appended = await call(
				{ op: 'append', path, bytes: owned, create, announce, from: writer },
				[owned.buffer],
			);
			if (appended.error !== null) return appended;
			return Ok(appended.data as 'landed' | 'stale');
		},
		watch: changes.watch,
		close() {
			closed = true;
			worker?.terminate();
			worker = undefined;
			fail('the device was closed');
		},
	};
}
