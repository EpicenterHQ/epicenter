/**
 * The typed client a contract derives (`Client<T>` from
 * `@epicenter/definition/contract`), over a device's files: what
 * `openDevice` returns from `/node` and `/browser`.
 *
 * Every note this writes is in house style (decision 29): the contract's
 * keys first in its order, any other keys after them sorted, block YAML,
 * the body untouched. Reads are lenient: a note written by hand, in any key
 * order, reads, and its next write through here formats it.
 *
 * Every update and delete carries the version its writer read (`over`), and
 * the store lands it only while the file still holds that version, so a
 * write never replaces bytes its writer did not see. A file deleted since it
 * was read is a `Conflict` whose `current` is null.
 *
 * A collection's listeners hear every change that lands through this client
 * before the write resolves, and the store's outside changes (other tabs,
 * the shell's watcher, other programs) as they come, each only when it
 * touches a path the contract gives the collection.
 */
import {
	type Client,
	ClientError,
	type CompiledCollection,
	type CompiledContract,
	type Contract,
	compileContract,
	type Version,
} from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { createChanges, forCollection } from '../changes.js';
import { hashBytes } from '../hash.js';
import {
	createdFields,
	defined,
	invalidNote,
	noteCodec,
	noteValue,
	type Params,
	paramsOf,
	pathOf,
	type Value,
} from '../note-codec.js';
import type { DeviceStore } from './store.js';

const encoder = new TextEncoder();

/** The store under each client `createDeviceClient` made, for `storeOf`. */
const stores = new WeakMap<object, DeviceStore>();

/** The store under a client `openDevice` returned. */
export function storeOf(device: object): DeviceStore {
	const store = stores.get(device);
	if (store === undefined)
		throw new Error('expected a client that openDevice returned');
	return store;
}

/** The sha256 that is a device version. */
export const versionOf = async (bytes: Uint8Array) =>
	(await hashBytes(bytes)) as Version;

/**
 * The client of `contract` over `store`. A contract that is not well formed
 * throws: one written in code is a bug to fix, not a state to handle.
 */
export function createDeviceClient<TContract extends Contract>(
	contract: TContract,
	outside: DeviceStore,
): Client<TContract> {
	const { data: compiled, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });
	const store = observed(outside);
	const clients: Record<string, unknown> = {};
	for (const collection of compiled.collections)
		clients[collection.name] = {
			...(collection.kind === 'note'
				? noteClient(compiled, collection, store)
				: fileClient(compiled, collection, store)),
			subscribe: (listener: () => void) =>
				store.watch(forCollection(compiled, collection.name, listener)),
		};
	const client = clients as Client<TContract>;
	stores.set(client, store);
	return client;
}

/**
 * `store`, whose listeners also hear every write that lands through it,
 * before the write resolves, so a reader never lags this device's own writes.
 */
function observed(store: DeviceStore): DeviceStore {
	const changes = createChanges((emit) => store.watch(emit));
	return {
		list: store.list,
		read: store.read,
		async write(path, bytes, expected) {
			const written = await store.write(path, bytes, expected);
			if (written.data === 'landed') changes.emit([path]);
			return written;
		},
		watch: changes.watch,
		close: store.close,
	};
}

/**
 * The paths of `collection` in `store`, with their placeholder values and
 * stamps. A path is the collection's only when the contract's claim gives
 * it to that collection.
 */
async function claimed(
	compiled: CompiledContract,
	collection: CompiledCollection,
	store: DeviceStore,
) {
	const { data: listed, error } = await store.list();
	if (error !== null) return { data: null, error };
	const out: { path: string; params: Params; stamp: string }[] = [];
	for (const { path, stamp } of listed.sort((a, b) =>
		a.path < b.path ? -1 : 1,
	)) {
		const claim = compiled.claim(path);
		if (claim?.collection.name === collection.name)
			out.push({ path, params: claim.params, stamp });
	}
	return Ok(out);
}

/** A `Conflict` naming the version now at `path`, null when nothing is there. */
async function conflict(store: DeviceStore, path: string) {
	const { data: current, error } = await store.read(path);
	if (error !== null) return { data: null, error };
	return ClientError.Conflict({ path, current: current?.version ?? null });
}

/** Remove the file at `path` while it holds `over`. */
async function remove(store: DeviceStore, path: string, over: Version) {
	const { data: outcome, error } = await store.write(path, null, over);
	if (error !== null) return { data: null, error };
	if (outcome === 'stale') return conflict(store, path);
	return Ok(undefined);
}

function noteClient(
	compiled: CompiledContract,
	collection: CompiledCollection,
	store: DeviceStore,
) {
	const codec = noteCodec(collection);

	/** The document in `bytes`, when it parses and its fields fit. */
	function decode(path: string, bytes: Uint8Array) {
		const text = codec.text(path, bytes);
		if (text.error !== null) return text;
		return codec.decode(path, text.data);
	}

	/** `document` in house style as bytes, when its fields fit. */
	function encode(path: string, document: Parameters<typeof codec.encode>[1]) {
		const encoded = codec.encode(path, document);
		if (encoded.error !== null) return encoded;
		return Ok({
			bytes: encoder.encode(encoded.data.text),
			document: encoded.data.document,
		});
	}

	return {
		async list() {
			const { data: paths, error } = await claimed(compiled, collection, store);
			if (error !== null) return { data: null, error };
			const items: ReturnType<typeof noteValue>[] = [];
			const unfit: ReturnType<typeof invalidNote>[] = [];
			for (const { path, params } of paths) {
				const read = await store.read(path);
				if (read.error !== null) return read;
				// Removed since the listing: it is no longer the collection's.
				if (read.data === null) continue;
				const { bytes, version } = read.data;
				const text = codec.text(path, bytes);
				const decoded =
					text.error === null ? codec.decode(path, text.data) : text;
				if (decoded.error !== null)
					unfit.push(
						invalidNote(params, path, decoded.error.issues, text.data, version),
					);
				else items.push(noteValue(params, decoded.data, version));
			}
			return Ok({ items, invalid: unfit });
		},
		async get(args: Params) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			const read = await store.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null) return ClientError.NotFound({ path: path.data });
			const decoded = decode(path.data, read.data.bytes);
			if (decoded.error !== null) return decoded;
			return Ok(
				noteValue(paramsOf(collection, args), decoded.data, read.data.version),
			);
		},
		async create({ body = '', ...value }: Value) {
			const path = pathOf(collection, value);
			if (path.error !== null) return path;
			const params = paramsOf(collection, value);
			if (typeof body !== 'string')
				return codec.invalid(path.data, 'body', 'The body is not a string');
			const encoded = encode(path.data, {
				fields: createdFields(collection, value),
				body,
			});
			if (encoded.error !== null) return encoded;
			const version = await versionOf(encoded.data.bytes);
			const written = await store.write(
				path.data,
				encoded.data.bytes,
				'absent',
			);
			if (written.error !== null) return written;
			if (written.data === 'stale')
				return ClientError.Occupied({ path: path.data });
			return Ok(noteValue(params, encoded.data.document, version));
		},
		async update(args: Params, patch: Value, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			const read = await store.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null || read.data.version !== over)
				return ClientError.Conflict({
					path: path.data,
					current: read.data?.version ?? null,
				});
			const text = codec.text(path.data, read.data.bytes);
			if (text.error !== null) return text;
			const parsed = codec.parse(path.data, text.data);
			if (parsed.error !== null) return parsed;
			const { body = parsed.data.body, version: _version, ...changes } = patch;
			if (typeof body !== 'string')
				return codec.invalid(path.data, 'body', 'The body is not a string');
			const encoded = encode(path.data, {
				fields: defined({ ...parsed.data.fields, ...changes }),
				body,
			});
			if (encoded.error !== null) return encoded;
			const version = await versionOf(encoded.data.bytes);
			const params = paramsOf(collection, args);
			if (version === over)
				return Ok(noteValue(params, encoded.data.document, version));
			const written = await store.write(path.data, encoded.data.bytes, over);
			if (written.error !== null) return written;
			if (written.data === 'stale') return conflict(store, path.data);
			return Ok(noteValue(params, encoded.data.document, version));
		},
		async replace(args: Params, text: string, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			if (typeof text !== 'string')
				return codec.invalid(path.data, undefined, 'The text is not a string');
			const decoded = codec.decode(path.data, text);
			if (decoded.error !== null) return decoded;
			const encoded = encode(path.data, decoded.data);
			if (encoded.error !== null) return encoded;
			const version = await versionOf(encoded.data.bytes);
			const params = paramsOf(collection, args);
			const written = await store.write(path.data, encoded.data.bytes, over);
			if (written.error !== null) return written;
			if (written.data === 'stale') return conflict(store, path.data);
			return Ok(noteValue(params, encoded.data.document, version));
		},
		async delete(args: Params, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null)
				return ClientError.NotFound({ path: collection.template.source });
			return remove(store, path.data, over);
		},
	};
}

function fileClient(
	compiled: CompiledContract,
	collection: CompiledCollection,
	store: DeviceStore,
) {
	/** Versions by path, kept while the stamp a listing gives is unchanged. */
	const known = new Map<string, { stamp: string; version: Version }>();
	/** A path no placeholders could name holds nothing. */
	const nowhere = () =>
		ClientError.NotFound({ path: collection.template.source });

	return {
		async list() {
			const { data: paths, error } = await claimed(compiled, collection, store);
			if (error !== null) return { data: null, error };
			const items: (Params & { version: Version })[] = [];
			for (const { path, params, stamp } of paths) {
				const cached = known.get(path);
				if (cached?.stamp === stamp) {
					items.push({ ...params, version: cached.version });
					continue;
				}
				const read = await store.read(path);
				if (read.error !== null) return read;
				if (read.data === null) continue;
				known.set(path, { stamp: read.data.stamp, version: read.data.version });
				items.push({ ...params, version: read.data.version });
			}
			return Ok({ items });
		},
		async get(args: Params) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			const read = await store.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null) return ClientError.NotFound({ path: path.data });
			const { bytes, version } = read.data;
			return Ok({ ...paramsOf(collection, args), bytes, version });
		},
		async create({ bytes, ...value }: Value) {
			const path = pathOf(collection, value);
			if (path.error !== null) return path;
			if (!(bytes instanceof Uint8Array))
				return ClientError.Invalid({
					path: path.data,
					issues: [{ field: 'bytes', message: 'bytes is not a Uint8Array' }],
				});
			const version = await versionOf(bytes);
			const written = await store.write(path.data, bytes, 'absent');
			if (written.error !== null) return written;
			if (written.data === 'stale')
				return ClientError.Occupied({ path: path.data });
			return Ok({ ...paramsOf(collection, value), version });
		},
		async update(
			args: Params,
			{ bytes }: { bytes: Uint8Array },
			{ over }: { over: Version },
		) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			const version = await versionOf(bytes);
			const written = await store.write(path.data, bytes, over);
			if (written.error !== null) return written;
			if (written.data === 'stale') return conflict(store, path.data);
			return Ok({ ...paramsOf(collection, args), version });
		},
		async delete(args: Params, { over }: { over: Version }) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			return remove(store, path.data, over);
		},
	};
}
