/**
 * The typed client a contract derives (`Client<T>`), over the repository on
 * the server: what `openRemote` returns. The same methods and errors as the
 * device client; a version here is the Git blob id on `main`.
 *
 * Notes are written in house style, formatted here because the client knows
 * the contract (decision 47). A file's bytes travel as a Git LFS object, and
 * the write names the object.
 *
 * Every write carries what its writer read, as the device client's do:
 *
 * - `create` reads the path first, and is `Occupied` when anything is there;
 * - `update` reads the file first, and is a `Conflict` when its version is
 *   not `over`; then writes with `over` as the base;
 * - `delete` writes with `over` as the base, and the server keeps a file
 *   changed since (an edit beats a delete), which is a `Conflict` here.
 *
 * A write that races another between the read and the write lands by the
 * server's merge rules (decision 15): a note merges, a file lands beside as
 * a conflict copy. The client then answers with what landed: the merged
 * note, or for a file `Occupied` or `Conflict`, since its bytes are not at
 * the path.
 *
 * A collection's listeners hear this client's own writes (a file's bytes
 * included) before they resolve, and, while any listens, every move of
 * `main` by another writer: one poller per client reads `main` every
 * `POLL_MS`, and stops with the last listener or the account. The notify
 * Durable Object (decision 18) will replace the poll here, with no change to
 * callers.
 */

import {
	isNamespaceId,
	isRepositoryName,
} from '@epicenter/constants/repositories';
import {
	type Client,
	ClientError,
	type CompiledCollection,
	type CompiledContract,
	type Contract,
	compileContract,
	type Version,
} from '@epicenter/definition/contract';
import { gitBlobHash } from '@epicenter/definition/merge';
import type { CanonicalDocument } from '@epicenter/definition/note';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { createChanges, forCollection } from '../changes.js';
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
import {
	createWire,
	type FileWrite,
	type RemoteAccount,
	RemoteError,
	type Wire,
	type WriteReceipt,
} from './wire.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;
type Conflict = InferError<typeof ClientError.Conflict>;

/** How many notes a listing reads at once. */
const READS_AT_ONCE = 8;

/** How often a remote with listeners reads `main` to hear that it moved. */
const POLL_MS = 3000;

/**
 * The client of `contract` over `repository` (`<owner>/<name>`, by default
 * `~/<contract name>`) as `account` reaches it. A contract that is not well
 * formed, or a `repository` that names none, throws.
 */
export function createRemoteClient<TContract extends Contract>(
	contract: TContract,
	account: RemoteAccount,
	repository?: string,
): Client<TContract> {
	const { data: compiled, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });
	const path = repository ?? `~/${compiled.name}`;
	const [owner = '', name = '', extra] = path.split('/');
	if (
		extra !== undefined ||
		(owner !== '~' && !isNamespaceId(owner)) ||
		!isRepositoryName(name)
	)
		throw new Error(
			`'${path}' names no repository: use <owner>/<name>, where <owner> is a person's handle or ~`,
		);
	const { wire, changes } = observedWire(account, createWire(account, path));
	const clients: Record<string, unknown> = {};
	for (const collection of compiled.collections)
		clients[collection.name] = {
			...(collection.kind === 'note'
				? noteClient(compiled, collection, wire)
				: fileClient(compiled, collection, wire)),
			subscribe: (listener: () => void) =>
				changes.watch(forCollection(compiled, collection.name, listener)),
		};
	return clients as Client<TContract>;
}

/**
 * `wire`, whose writes that land tell its listeners the paths they wrote,
 * with the listeners of every move of `main` while any listens: a poll of
 * `main` every `POLL_MS`, which cannot say what moved (null). The server
 * becoming unreachable, or reachable again, is a change too: what a reader
 * can show changed with it.
 */
function observedWire(account: RemoteAccount, wire: Wire) {
	/** The commit `main` was at when last read; undefined before the first read. */
	let seen: string | null | undefined;
	let reachable = true;
	const changes = createChanges((emit) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		async function poll() {
			if (stopped || account.signal.aborted) return;
			const head = await wire.head();
			if (stopped) return;
			if (head.error === null) {
				if (!reachable || (seen !== undefined && head.data !== seen))
					emit(null);
				seen = head.data;
				reachable = true;
			} else if (reachable) {
				reachable = false;
				emit(null);
			}
			timer = setTimeout(poll, POLL_MS);
		}
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
	const observed: Wire = {
		...wire,
		async write(request) {
			const written = await wire.write(request);
			if (written.data?.landed) changes.emit(written.data.receipt.paths);
			return written;
		},
	};
	return { wire: observed, changes };
}

/**
 * The folder a collection's files all sit under: its template's leading
 * literal directories (`recordings` for `recordings/{id}.md`), so a listing
 * reads no more of the repository than it must.
 */
function rootOf(collection: CompiledCollection): string {
	const directories = collection.template.segments.slice(0, -1);
	const literal: string[] = [];
	for (const segment of directories) {
		if (!('literal' in segment)) break;
		literal.push(segment.literal);
	}
	return literal.join('/');
}

/** The files on `main` that the contract gives to `collection`. */
async function claimed(
	compiled: CompiledContract,
	collection: CompiledCollection,
	wire: Wire,
) {
	const listed = await wire.list(rootOf(collection));
	if (listed.error !== null) return listed;
	const out: { path: string; params: Params; blob: Version }[] = [];
	for (const { path, blob } of listed.data) {
		const claim = compiled.claim(path);
		if (claim?.collection.name === collection.name)
			out.push({ path, params: claim.params, blob });
	}
	return Ok(out);
}

/** A `Conflict` naming the version now at `path` on `main`. */
async function conflict(wire: Wire, path: string) {
	const read = await wire.read(path);
	if (read.error !== null) return read;
	return ClientError.Conflict({ path, current: read.data?.blob ?? null });
}

/** `Unavailable` for a write the server refused in a way this client does not expect. */
const refusedWrite = (answer: {
	status: number;
	code: string | null;
	message: string;
}) => ClientError.Unavailable({ cause: RemoteError.Refused(answer).error });

/** The outcome the receipt records for `path`. */
const outcomeOf = (receipt: WriteReceipt, path: string) =>
	receipt.outcomes.find((outcome) => outcome.path === path);

/** Write `file` alone. */
const writeOne = (wire: Wire, file: FileWrite) => wire.write({ files: [file] });

/** Delete the file at `path` while `main` holds `over` there. */
async function remove(
	wire: Wire,
	path: string,
	over: Version,
): Promise<Result<undefined, Unavailable | Conflict>> {
	const written = await writeOne(wire, { path, delete: true, base: over });
	if (written.error !== null) return written;
	const answer = written.data;
	if (!answer.landed) {
		// `over` is not a version of this repository, or names nothing it holds.
		if (answer.code === 'base_not_found' || answer.code === 'conflict')
			return conflict(wire, path);
		return refusedWrite(answer);
	}
	const outcome = outcomeOf(answer.receipt, path)?.outcome;
	if (outcome === 'deleted') return Ok(undefined);
	return ClientError.Conflict({
		path,
		current: (answer.receipt.blobs[path] ?? null) as Version | null,
	});
}

/** Run `task` over `items`, at most `limit` at once, keeping their order. */
async function eachAtMost<T, R>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await task(items[index] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

function noteClient(
	compiled: CompiledContract,
	collection: CompiledCollection,
	wire: Wire,
) {
	const codec = noteCodec(collection);

	/** The note at `path` on `main`, decoded, or null when nothing is there. */
	async function readNote(path: string, params: Params) {
		const read = await wire.read(path);
		if (read.error !== null) return read;
		if (read.data === null) return Ok(null);
		const { blob, text } = read.data;
		if (typeof text !== 'string')
			return codec.invalid(path, undefined, 'The note is not text on main');
		const decoded = codec.decode(path, text);
		if (decoded.error !== null) return decoded;
		return Ok(noteValue(params, decoded.data, blob));
	}

	/**
	 * Write `text` at `path` and answer with the note that landed: `document`
	 * when the server took it as sent, else the note `main` now holds.
	 */
	async function land(
		path: string,
		params: Params,
		text: string,
		document: CanonicalDocument,
		base?: Version,
	) {
		const written = await writeOne(wire, { path, text, base });
		if (written.error !== null) return written;
		const answer = written.data;
		if (!answer.landed) {
			if (answer.code === 'base_not_found' || answer.code === 'conflict')
				return conflict(wire, path);
			return refusedWrite(answer);
		}
		const blob = answer.receipt.blobs[path];
		if (blob === gitBlobHash(text))
			return Ok(noteValue(params, document, blob as Version));
		// Another write raced this one and the server merged them.
		const now = await readNote(path, params);
		if (now.error !== null) return now;
		if (now.data === null) return ClientError.Conflict({ path, current: null });
		return Ok(now.data);
	}

	return {
		async list() {
			const paths = await claimed(compiled, collection, wire);
			if (paths.error !== null) return paths;
			const reads = await eachAtMost(paths.data, READS_AT_ONCE, ({ path }) =>
				wire.read(path),
			);
			const items: ReturnType<typeof noteValue>[] = [];
			const unfit: ReturnType<typeof invalidNote>[] = [];
			for (const [index, { path, params }] of paths.data.entries()) {
				const read = reads[index];
				if (read === undefined) continue;
				if (read.error !== null) return read;
				// Removed since the listing: it is no longer the collection's.
				if (read.data === null) continue;
				const { text, blob } = read.data;
				const decoded =
					typeof text === 'string'
						? codec.decode(path, text)
						: codec.invalid(path, undefined, 'The note is not text on main');
				if (decoded.error !== null)
					unfit.push(
						invalidNote(
							params,
							path,
							decoded.error.issues,
							typeof text === 'string' ? text : null,
							blob,
						),
					);
				else items.push(noteValue(params, decoded.data, blob));
			}
			return Ok({ items, invalid: unfit });
		},
		async get(args: Params) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			const note = await readNote(path.data, paramsOf(collection, args));
			if (note.error !== null) return note;
			if (note.data === null) return ClientError.NotFound({ path: path.data });
			return Ok(note.data);
		},
		async create({ body = '', ...value }: Value) {
			const path = pathOf(collection, value);
			if (path.error !== null) return path;
			if (typeof body !== 'string')
				return codec.invalid(path.data, 'body', 'The body is not a string');
			const encoded = codec.encode(path.data, {
				fields: createdFields(collection, value),
				body,
			});
			if (encoded.error !== null) return encoded;
			const there = await wire.read(path.data);
			if (there.error !== null) return there;
			if (there.data !== null) return ClientError.Occupied({ path: path.data });
			return land(
				path.data,
				paramsOf(collection, value),
				encoded.data.text,
				encoded.data.document,
			);
		},
		async update(args: Params, patch: Value, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			const read = await wire.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null || read.data.blob !== over)
				return ClientError.Conflict({
					path: path.data,
					current: read.data?.blob ?? null,
				});
			if (typeof read.data.text !== 'string')
				return codec.invalid(path.data, undefined, 'The note is not text');
			const parsed = codec.parse(path.data, read.data.text);
			if (parsed.error !== null) return parsed;
			const { body = parsed.data.body, version: _version, ...changes } = patch;
			if (typeof body !== 'string')
				return codec.invalid(path.data, 'body', 'The body is not a string');
			const encoded = codec.encode(path.data, {
				fields: defined({ ...parsed.data.fields, ...changes }),
				body,
			});
			if (encoded.error !== null) return encoded;
			const params = paramsOf(collection, args);
			if (gitBlobHash(encoded.data.text) === over)
				return Ok(noteValue(params, encoded.data.document, over));
			return land(
				path.data,
				params,
				encoded.data.text,
				encoded.data.document,
				over,
			);
		},
		async replace(args: Params, text: string, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null) return path;
			if (typeof text !== 'string')
				return codec.invalid(path.data, undefined, 'The text is not a string');
			const decoded = codec.decode(path.data, text);
			if (decoded.error !== null) return decoded;
			const encoded = codec.encode(path.data, decoded.data);
			if (encoded.error !== null) return encoded;
			const read = await wire.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null || read.data.blob !== over)
				return ClientError.Conflict({
					path: path.data,
					current: read.data?.blob ?? null,
				});
			const params = paramsOf(collection, args);
			if (gitBlobHash(encoded.data.text) === over)
				return Ok(noteValue(params, encoded.data.document, over));
			return land(
				path.data,
				params,
				encoded.data.text,
				encoded.data.document,
				over,
			);
		},
		async delete(args: Params, { over }: { over: Version }) {
			const path = pathOf(collection, args);
			if (path.error !== null)
				return ClientError.NotFound({ path: collection.template.source });
			return remove(wire, path.data, over);
		},
	};
}

function fileClient(
	compiled: CompiledContract,
	collection: CompiledCollection,
	wire: Wire,
) {
	/** A path no placeholders could name holds nothing. */
	const nowhere = () =>
		ClientError.NotFound({ path: collection.template.source });

	/**
	 * Upload `bytes` and write them at `path` over `base`: the version that
	 * landed there, or null when the server put them beside it as a
	 * conflict copy because `main` changed.
	 */
	async function land(
		path: string,
		bytes: Uint8Array,
		base?: Version,
	): Promise<Result<Version | null, Unavailable>> {
		const uploaded = await wire.upload([bytes]);
		if (uploaded.error !== null) return uploaded;
		const [lfs] = uploaded.data;
		if (lfs === undefined) throw new Error('one object for one file');
		const written = await writeOne(wire, { path, lfs, base });
		if (written.error !== null) return written;
		const answer = written.data;
		if (!answer.landed) {
			if (answer.code === 'base_not_found') return Ok(null);
			return refusedWrite(answer);
		}
		const landed = outcomeOf(answer.receipt, path);
		if (landed?.landed !== path) return Ok(null);
		return Ok((answer.receipt.blobs[path] ?? null) as Version | null);
	}

	return {
		async list() {
			const paths = await claimed(compiled, collection, wire);
			if (paths.error !== null) return paths;
			return Ok({
				items: paths.data.map(({ params, blob }) => ({
					...params,
					version: blob,
				})),
			});
		},
		async get(args: Params) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			const read = await wire.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null) return ClientError.NotFound({ path: path.data });
			const { lfs, blob } = read.data;
			if (!lfs)
				return ClientError.Unavailable({
					cause: RemoteError.Refused({
						status: 200,
						code: 'not_lfs',
						message: `${path.data} is not a Git LFS pointer on main`,
					}).error,
				});
			const bytes = await wire.download(lfs);
			if (bytes.error !== null) return bytes;
			return Ok({
				...paramsOf(collection, args),
				bytes: bytes.data,
				version: blob,
			});
		},
		async create({ bytes, ...value }: Value) {
			const path = pathOf(collection, value);
			if (path.error !== null) return path;
			if (!(bytes instanceof Uint8Array))
				return ClientError.Invalid({
					path: path.data,
					issues: [{ field: 'bytes', message: 'bytes is not a Uint8Array' }],
				});
			const there = await wire.read(path.data);
			if (there.error !== null) return there;
			if (there.data !== null) return ClientError.Occupied({ path: path.data });
			const landed = await land(path.data, bytes);
			if (landed.error !== null) return landed;
			if (landed.data === null)
				return ClientError.Occupied({ path: path.data });
			return Ok({ ...paramsOf(collection, value), version: landed.data });
		},
		async update(
			args: Params,
			{ bytes }: { bytes: Uint8Array },
			{ over }: { over: Version },
		) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			const read = await wire.read(path.data);
			if (read.error !== null) return read;
			if (read.data === null || read.data.blob !== over)
				return ClientError.Conflict({
					path: path.data,
					current: read.data?.blob ?? null,
				});
			const landed = await land(path.data, bytes, over);
			if (landed.error !== null) return landed;
			if (landed.data === null) return conflict(wire, path.data);
			return Ok({ ...paramsOf(collection, args), version: landed.data });
		},
		async delete(args: Params, { over }: { over: Version }) {
			const path = collection.pathOf(args);
			if (path.error !== null) return nowhere();
			return remove(wire, path.data, over);
		},
	};
}
