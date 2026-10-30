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
 * { "id": "…", "paths": { "recordings/x.md": "<sha256>" }, "state": "pending", "receipt": null }
 * ```
 *
 * `paths` holds each file's path and the version the device held when the
 * capture was recorded. The upload (phase 5) sends a capture as one write
 * carrying its id, records the server's receipt here (`acknowledge`), and
 * only then deletes the device's copies (`finish`), each only at its
 * recorded version, so an edit made since survives. A resend after a lost
 * reply carries the same id, and the server answers with the first receipt.
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
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { DeviceStore } from './store.js';

/** Where a device keeps its outbox sidecars. */
export const OUTBOX_DIRECTORY = '.epicenter/outbox';

/** What the server answers for a capture it committed (phase 4's translator). */
export type Receipt = {
	commit: string;
	paths: string[];
	blobs: Record<string, string>;
};

/** One capture: the files it holds, at the versions recorded, and how far its upload got. */
export type Capture = {
	id: string;
	paths: Record<string, Version>;
	/** `pending` until the server's receipt is recorded, then `acknowledged`. */
	state: 'pending' | 'acknowledged';
	receipt: Receipt | null;
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

/** A capture id: one path segment, safe on every disk, as `timeId()` makes. */
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

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
	const { id, paths, state, receipt } = value;
	if (typeof id !== 'string' || !CAPTURE_ID.test(id)) return null;
	if (!Object.values(paths).every((version) => typeof version === 'string'))
		return null;
	if (state === 'pending' && receipt === null)
		return { id, paths: paths as Capture['paths'], state, receipt };
	if (
		state === 'acknowledged' &&
		isRecord(receipt) &&
		typeof receipt.commit === 'string'
	)
		return {
			id,
			paths: paths as Capture['paths'],
			state,
			receipt: receipt as Receipt,
		};
	return null;
}

const encodeCapture = (capture: Capture) =>
	encoder.encode(`${JSON.stringify(capture, null, '\t')}\n`);

export function createOutbox<TContract extends Contract>(
	compiled: CompiledContract,
	store: DeviceStore,
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
			const capture: Capture = { id, paths, state: 'pending', receipt: null };
			const path = sidecarPath(id);
			const written = await store.write(path, encodeCapture(capture), 'absent');
			if (written.error !== null) return written;
			if (written.data === 'stale') return ClientError.Occupied({ path });
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
		/** Record the server's receipt for capture `id`: the files may now go. */
		async acknowledge(
			id: string,
			receipt: Receipt,
		): Promise<Result<Capture, NotFound | Conflict | Invalid | Unavailable>> {
			const found = await read(id);
			if (found.error !== null) return found;
			const capture: Capture = {
				...found.data.capture,
				state: 'acknowledged',
				receipt,
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
		 * Delete an acknowledged capture's files, each only while it holds
		 * its recorded version, then its sidecar. `kept` names the files
		 * changed since, which stay on the device for another capture.
		 */
		async finish(
			id: string,
		): Promise<
			Result<
				{ kept: string[] },
				NotFound | Conflict | Invalid | Unavailable | OutboxError
			>
		> {
			const found = await read(id);
			if (found.error !== null) return found;
			const { capture, version } = found.data;
			if (capture.state !== 'acknowledged')
				return OutboxError.NotAcknowledged({ id });
			const kept: string[] = [];
			for (const [path, held] of Object.entries(capture.paths)) {
				const removed = await store.write(path, null, held);
				if (removed.error !== null) return removed;
				if (removed.data === 'stale') {
					const now = await store.read(path);
					if (now.error !== null) return now;
					if (now.data !== null) kept.push(path);
				}
			}
			const path = sidecarPath(id);
			const removed = await store.write(path, null, version);
			if (removed.error !== null) return removed;
			if (removed.data === 'stale')
				return ClientError.Conflict({ path, current: null });
			return Ok({ kept });
		},
	};
}

/** A device's outbox, typed for its contract. */
export type Outbox<TContract extends Contract> = ReturnType<
	typeof createOutbox<TContract>
>;

const outboxes = new WeakMap<object, Outbox<Contract>>();

/** Make `outbox` the one `outboxOf(device)` returns. */
export function registerOutbox(device: object, outbox: Outbox<Contract>) {
	outboxes.set(device, outbox);
}

/**
 * The outbox of a client `openDevice` returned. It is not a member of the
 * client, whose members are the contract's collections, any name of which
 * a contract may choose.
 */
export function outboxOf<TContract extends Contract>(
	device: Client<TContract>,
): Outbox<TContract> {
	const outbox = outboxes.get(device);
	if (outbox === undefined)
		throw new Error('outboxOf takes a client that openDevice returned');
	return outbox as Outbox<TContract>;
}
