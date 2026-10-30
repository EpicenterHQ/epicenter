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
 * OPFS is evictable (`persist()` was false in every headless probe), so what
 * the device holds should reach the server once it can (the outbox).
 */
import { ClientError, type Version } from '@epicenter/definition/contract';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import type { Reply } from './opfs-worker.js';
import type { DeviceStore } from './store.js';

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
			expected: string;
	  };

export function opfsStore(): DeviceStore {
	let worker: Worker | undefined;
	let next = 0;
	const waiting = new Map<number, (reply: Reply) => void>();

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
			for (const [id, settle] of waiting)
				settle({
					id,
					ok: false,
					refused: false,
					name: 'WorkerFailed',
					message,
				});
			waiting.clear();
			started.terminate();
			if (worker === started) worker = undefined;
		});
		return started;
	}

	async function call(request: Request, transfer: Transferable[] = []) {
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
				{ op: 'write', path, bytes: owned, expected },
				owned === null ? [] : [owned.buffer],
			);
			if (written.error !== null) return written;
			return Ok(written.data as 'landed' | 'stale');
		},
	};
}
