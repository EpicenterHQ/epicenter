/**
 * A device's outbox: the captures made there that the server does not have
 * yet (decision 12). A browser keeps a new file made offline or signed out,
 * and uploads it once signed in and online: a create on the server, then a
 * delete on the device.
 *
 * Each capture is one sidecar at `.epicenter/outbox/<captureId>.json`, beside
 * the files it names, so it survives a reload and a crash:
 *
 * ```json
 * { "id": "…", "paths": { "recordings/x.md": "<sha256>" }, "bases": {}, "state": "pending", "receipt": null }
 * ```
 *
 * `paths` holds each file's path and the version the device held when the
 * capture was recorded; `bases`, for a file the server already holds, the
 * Git blob id there it replaces. The upload (`startUploading` in
 * `@epicenter/folder/remote`) sends a capture as one write, records the
 * server's reply and the versions it sent here (`acknowledge`, as `sent`),
 * and only then deletes the device's copies (`finish`), each only at the
 * version sent. The capture id names the sidecar; the server never sees it.
 * A write whose reply was lost goes again as the same write, which the
 * server judges like any other (decision 68). A file edited after it was
 * sent goes back in the outbox as an update over what landed.
 *
 * The sidecars are the device's own: hidden, so no collection claims them
 * and `epicenter check` skips them.
 */
import {
	type Client,
	ClientError,
	type CompiledContract,
	type Contract,
	type PlaceholdersOf,
	type Version,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { DeviceStore } from './store.js';

/** Where a device keeps its outbox sidecars. */
export const OUTBOX_DIRECTORY = '.epicenter/outbox';

/** What the server answered for a capture's write (the translator's reply). */
export type Receipt = {
	commit: string;
	paths: string[];
	/** The Git blob id that landed at each path. */
	blobs: Record<string, string>;
};

/** One capture: the files it holds, at the versions recorded, and how far its upload got. */
export type Capture = {
	id: string;
	paths: Record<string, Version>;
	/**
	 * For a file the server already holds, the Git blob id there that this
	 * capture's version replaces: an edit kept after an earlier capture of
	 * it landed. A path without a base is new to the server.
	 */
	bases: Record<string, string>;
	/** `pending` until the server's receipt is recorded, then `acknowledged`. */
	state: 'pending' | 'acknowledged';
	receipt: Receipt | null;
	/**
	 * The version of each file the upload read and sent, recorded with the
	 * receipt. A file may have changed between `add` and the upload, and
	 * again while the write was in flight; only these bytes landed.
	 */
	sent?: Record<string, Version>;
};

/** One file of a capture, as a create returned it: its collection, placeholders and version. */
export type OutboxFile<TContract extends Contract> = {
	[K in keyof TContract['collections'] & string]: {
		collection: K;
		version: Version;
	} & PlaceholdersOf<TContract['collections'][K]>;
}[keyof TContract['collections'] & string];

export const OutboxError = defineErrors({
	/** `finish` would delete a capture's files before the server has them. */
	NotAcknowledged: ({ id }: { id: string }) => ({
		message: `The capture ${id} has no receipt yet; its files stay on the device`,
		id,
	}),
});
export type OutboxError = InferErrors<typeof OutboxError>;

type NotFound = InferError<typeof ClientError.NotFound>;
type Occupied = InferError<typeof ClientError.Occupied>;
type Conflict = InferError<typeof ClientError.Conflict>;
type Invalid = InferError<typeof ClientError.Invalid>;
type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * A capture id: one path segment, safe on every disk, at most 64 characters,
 * as `timeId()` makes.
 */
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const sidecarPath = (id: string) => `${OUTBOX_DIRECTORY}/${id}.json`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The capture a sidecar's bytes hold, or null when they do not hold one. */
function parseCapture(bytes: Uint8Array): Capture | null {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes));
	} catch {
		return null;
	}
	if (!isRecord(value) || !isRecord(value.paths)) return null;
	const { id, paths, state, receipt, bases = {}, sent = {} } = value;
	if (typeof id !== 'string' || !CAPTURE_ID.test(id)) return null;
	const strings = (record: Record<string, unknown>) =>
		Object.values(record).every((version) => typeof version === 'string');
	if (!strings(paths) || !isRecord(bases) || !strings(bases)) return null;
	if (!isRecord(sent) || !strings(sent)) return null;
	const capture = {
		id,
		paths: paths as Capture['paths'],
		bases: bases as Capture['bases'],
	};
	if (state === 'pending' && receipt === null)
		return { ...capture, state, receipt };
	if (
		state === 'acknowledged' &&
		isRecord(receipt) &&
		typeof receipt.commit === 'string' &&
		isRecord(receipt.blobs)
	)
		return {
			...capture,
			state,
			receipt: {
				commit: receipt.commit,
				paths: receipt.paths as string[],
				blobs: receipt.blobs as Record<string, string>,
			},
			// A sidecar written before decision 68 may hold a server's replayed
			// receipt for other bytes than were sent: none of them is known to
			// have landed, so `finish` keeps every file and requeues it.
			sent: receipt.replayed === true ? {} : (sent as Record<string, Version>),
		};
	return null;
}

const encodeCapture = (capture: Capture) =>
	encoder.encode(`${JSON.stringify(capture, null, '\t')}\n`);

export function createOutbox<TContract extends Contract>(
	compiled: CompiledContract,
	store: DeviceStore,
	/** Told after each capture `add` records. */
	added: (capture: Capture) => void = () => {},
) {
	/** The capture `id` and its sidecar's version, or `NotFound`. */
	async function read(
		id: string,
	): Promise<
		Result<
			{ capture: Capture; version: Version },
			NotFound | Invalid | Unavailable
		>
	> {
		const path = sidecarPath(id);
		if (!CAPTURE_ID.test(id)) return ClientError.NotFound({ path });
		const { data: read, error } = await store.read(path);
		if (error !== null) return { data: null, error };
		if (read === null) return ClientError.NotFound({ path });
		const capture = parseCapture(read.bytes);
		if (capture === null)
			return ClientError.Invalid({
				path,
				issues: [{ field: '', message: 'The sidecar is not a capture' }],
			});
		return Ok({ capture, version: read.version });
	}

	return {
		/**
		 * Record a capture of `files`, each as its create returned it. Refused
		 * when a file no longer holds that version (`Conflict`), when the id
		 * is taken (`Occupied`), or when the id or a file's placeholders are
		 * not usable (`Invalid`).
		 *
		 * @example
		 * ```ts
		 * const id = timeId();
		 * const note = await device.recordings.create({ id, title });
		 * const audio = await device.audio.create({ id, ext, bytes });
		 * await outboxOf(device).add({ id, files: [
		 *   { collection: 'recordings', ...note.data },
		 *   { collection: 'audio', ...audio.data },
		 * ] });
		 * ```
		 */
		async add({
			id,
			files,
		}: {
			id: string;
			files: OutboxFile<TContract>[];
		}): Promise<Result<Capture, Occupied | Conflict | Invalid | Unavailable>> {
			if (!CAPTURE_ID.test(id))
				return ClientError.Invalid({
					path: null,
					issues: [
						{
							field: 'id',
							message: `The capture id ${JSON.stringify(id)} is not one path segment of letters, digits, - and _`,
						},
					],
				});
			const paths: Record<string, Version> = {};
			for (const file of files) {
				const collection = compiled.collections.find(
					({ name }) => name === file.collection,
				);
				const path = collection?.pathOf(file as Record<string, unknown>);
				if (path === undefined || path.error !== null)
					return ClientError.Invalid({
						path: null,
						issues: [
							{
								field: 'files',
								message:
									path?.error.message ??
									`The contract has no collection '${file.collection}'`,
							},
						],
					});
				const { data: held, error } = await store.read(path.data);
				if (error !== null) return { data: null, error };
				if (held?.version !== file.version)
					return ClientError.Conflict({
						path: path.data,
						current: held?.version ?? null,
					});
				paths[path.data] = file.version;
			}
			const capture: Capture = {
				id,
				paths,
				bases: {},
				state: 'pending',
				receipt: null,
			};
			const path = sidecarPath(id);
			const written = await store.write(path, encodeCapture(capture), 'absent');
			if (written.error !== null) return written;
			if (written.data === 'stale') return ClientError.Occupied({ path });
			added(capture);
			return Ok(capture);
		},
		/** Every capture still in the outbox, oldest id first, and the sidecars that hold none. */
		async list(): Promise<
			Result<{ items: Capture[]; invalid: string[] }, Unavailable>
		> {
			const { data: listed, error } = await store.list();
			if (error !== null) return { data: null, error };
			const items: Capture[] = [];
			const invalid: string[] = [];
			const sidecars = listed
				.map(({ path }) => path)
				.filter(
					(path) =>
						path.startsWith(`${OUTBOX_DIRECTORY}/`) &&
						path.endsWith('.json') &&
						!path.slice(OUTBOX_DIRECTORY.length + 1).includes('/'),
				)
				.sort();
			for (const path of sidecars) {
				const read = await store.read(path);
				if (read.error !== null) return read;
				if (read.data === null) continue;
				const capture = parseCapture(read.data.bytes);
				if (capture === null || sidecarPath(capture.id) !== path)
					invalid.push(path);
				else items.push(capture);
			}
			return Ok({ items, invalid });
		},
		/**
		 * Record the server's receipt for capture `id`, and the version of
		 * each file the upload sent: the files may now go, at those versions.
		 */
		async acknowledge(
			id: string,
			receipt: Receipt,
			sent: Record<string, Version>,
		): Promise<Result<Capture, NotFound | Conflict | Invalid | Unavailable>> {
			const found = await read(id);
			if (found.error !== null) return found;
			const capture: Capture = {
				...found.data.capture,
				state: 'acknowledged',
				receipt,
				sent,
			};
			const path = sidecarPath(id);
			const written = await store.write(
				path,
				encodeCapture(capture),
				found.data.version,
			);
			if (written.error !== null) return written;
			if (written.data === 'stale')
				return ClientError.Conflict({ path, current: null });
			return Ok(capture);
		},
		/**
		 * Let go of an acknowledged capture: delete each file the server now
		 * holds, then the sidecar. A file is deleted only while it holds the
		 * version the upload sent, which the server's reply shows landed
		 * (as written, merged into the note there, or as a conflict copy):
		 * not the version `add` recorded, since an edit reverted to those
		 * bytes while other bytes were in flight is not what landed.
		 *
		 * Every other file still on the device is `kept`, and never dropped:
		 * it goes back in the outbox as a new pending capture (`queued`),
		 * with the blob that landed at its path as its base, so it uploads as
		 * an update over that version. An edit made while a write was in
		 * flight therefore never loses work.
		 *
		 * A pending capture is refused while any of its files is still on the
		 * device; once all are gone there is nothing left to send, and its
		 * sidecar goes.
		 */
		async finish(
			id: string,
		): Promise<
			Result<
				{ kept: string[]; queued: Capture | null },
				NotFound | Occupied | Conflict | Invalid | Unavailable | OutboxError
			>
		> {
			const found = await read(id);
			if (found.error !== null) return found;
			const { capture, version } = found.data;
			const { receipt } = capture;
			if (receipt === null) {
				for (const path of Object.keys(capture.paths)) {
					const held = await store.read(path);
					if (held.error !== null) return held;
					if (held.data !== null) return OutboxError.NotAcknowledged({ id });
				}
				return removeSidecar(id, version, { kept: [], queued: null });
			}
			const kept: Record<string, Version> = {};
			for (const path of Object.keys(capture.paths)) {
				const held = await store.read(path);
				if (held.error !== null) return held;
				if (held.data === null) continue;
				const sent = capture.sent?.[path];
				if (held.data.version !== sent) {
					kept[path] = held.data.version;
					continue;
				}
				const removed = await store.write(path, null, sent);
				if (removed.error !== null) return removed;
				if (removed.data === 'stale') {
					// Edited between the read and the delete.
					const now = await store.read(path);
					if (now.error !== null) return now;
					if (now.data !== null) kept[path] = now.data.version;
				}
			}
			let queued: Capture | null = null;
			if (Object.keys(kept).length > 0) {
				queued = {
					id: timeId(),
					paths: kept,
					bases: Object.fromEntries(
						Object.keys(kept).flatMap((path) => {
							const blob = receipt.blobs[path];
							return blob ? [[path, blob]] : [];
						}),
					),
					state: 'pending',
					receipt: null,
				};
				const path = sidecarPath(queued.id);
				const written = await store.write(
					path,
					encodeCapture(queued),
					'absent',
				);
				if (written.error !== null) return written;
				if (written.data === 'stale') return ClientError.Occupied({ path });
				added(queued);
			}
			return removeSidecar(id, version, { kept: Object.keys(kept), queued });
		},
	};

	/** Remove capture `id`'s sidecar while it holds `version`, answering `result`. */
	async function removeSidecar<T>(id: string, version: Version, result: T) {
		const path = sidecarPath(id);
		const removed = await store.write(path, null, version);
		if (removed.error !== null) return removed;
		if (removed.data === 'stale')
			return ClientError.Conflict({ path, current: null });
		return Ok(result);
	}
}

/** A device's outbox, typed for its contract. */
export type Outbox<TContract extends Contract> = ReturnType<
	typeof createOutbox<TContract>
>;

/** What a device client is made of, for this package's uploader. */
export type DeviceParts = {
	compiled: CompiledContract;
	store: DeviceStore;
	outbox: Outbox<Contract>;
	/** Call `listener` after each new capture; returns the unsubscribe. */
	onCapture(listener: () => void): () => void;
};

const devices = new WeakMap<object, DeviceParts>();

/** Give `device` its outbox over `store`, and remember its parts. */
export function registerDevice(
	device: object,
	{ compiled, store }: { compiled: CompiledContract; store: DeviceStore },
) {
	const listeners = new Set<() => void>();
	const outbox = createOutbox(compiled, store, () => {
		for (const listener of listeners) listener();
	});
	devices.set(device, {
		compiled,
		store,
		outbox,
		onCapture(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
}

/** The parts of a client `openDevice` returned. */
export function deviceParts(device: object): DeviceParts {
	const parts = devices.get(device);
	if (parts === undefined)
		throw new Error('expected a client that openDevice returned');
	return parts;
}

/**
 * The outbox of a client `openDevice` returned. It is not a member of the
 * client, whose members are the contract's collections, any name of which
 * a contract may choose.
 */
export function outboxOf<TContract extends Contract>(
	device: Client<TContract>,
): Outbox<TContract> {
	return deviceParts(device).outbox as Outbox<TContract>;
}

