/**
 * A contract's collections over any place's store (memory, this browser's
 * storage, the desktop's folder, a directory, or the account's
 * repository): what each holds as the folder shows it, and the one write
 * every folder write is made of. A folder holds this; nothing outside this
 * package does.
 *
 * A read gives each file's version, and `write` lands only over the version
 * read (or where nothing is), so a write never replaces bytes its writer
 * did not see: the store answers `'stale'` instead, and the folder reads
 * again (ADR-0774). Every version comes from the store and stays inside
 * this package. No store merges (ADR-0773): what landed is what was sent.
 *
 * Reads are lenient: a note written by hand, in any key order, reads, and
 * one whose front matter does not parse or fit is shown as invalid with its
 * text. A collection's listeners hear every write that lands through here
 * before the write resolves, and the store's outside changes (other tabs,
 * the shell's watcher, other programs) as they come, each only when it
 * touches a path the contract gives the collection.
 */
import {
	type CompiledCollection,
	type CompiledContract,
	type Contract,
	compileContract,
} from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import { createChanges, forCollection } from '../changes.js';
import { noteCodec, type Params, paramsOf } from '../note-codec.js';
import type { Store, Unavailable, Version } from './store.js';

/** A store that can still add to the end of a file: this browser's, until the recorder writes a take once. */
type Appending = Store & {
	append?(
		path: string,
		bytes: Uint8Array,
		options: { create: boolean; announce: boolean },
	): Promise<Result<'landed' | 'stale', Unavailable>>;
};

/** An entry as an app reads it: a note's placeholders, fields and body, or a file's placeholders. */
export type Entry = Record<string, unknown>;

/** A file as last read: where it is, its version, and what the folder shows of it. */
export type Seen = {
	path: string;
	params: Params;
	version: Version;
	/** A note's text, null when it is not UTF-8; null for any other file. */
	text: string | null;
	/** What `items()` shows: a note that reads, or a file's placeholders; null for a note that does not read. */
	item: Entry | null;
	/** What `invalid()` shows of a note that does not read; null otherwise. */
	invalid: Entry | null;
};

/** A file read now: its bytes, and what the folder shows of it. */
export type Read = Seen & { bytes: Uint8Array };

/** One collection of a contract over a store. */
export type CollectionFiles = {
	kind: 'note' | 'file';
	/** The fields the contract declares, in its order (none for a file collection). */
	keys: readonly string[];
	compiled: CompiledCollection;
	/** The path `args` names, or why it names none. */
	pathOf(args: Params): Result<string, { message: string }>;
	/** The placeholders `args` holds. */
	paramsOf(args: Params): Params;
	/** Every file the collection holds, reading only the notes whose stamp changed since the last listing. */
	list(): Promise<Result<Seen[], Unavailable>>;
	/** The file at `path` now, or null when nothing is there. */
	read(path: string): Promise<Result<Read | null, Unavailable>>;
	/**
	 * Write `bytes` at `path`, or remove the file for null, over `over`, the
	 * version read there (null for nothing there): what landed, null for a
	 * removal, or `'stale'` when the path no longer holds `over`.
	 */
	write(
		path: string,
		bytes: Uint8Array | null,
		over: Version | null,
	): Promise<Result<Seen | null | 'stale', Unavailable>>;
	/** Add `bytes` to the end of the file at `path`, where the store can; `'stale'` when it is not as `create` says. */
	append:
		| ((
				path: string,
				bytes: Uint8Array,
				options: { create: boolean; announce: boolean },
		  ) => Promise<Result<'landed' | 'stale', Unavailable>>)
		| null;
	/** Hear that the collection's files changed; returns the stop. */
	subscribe(listener: () => void): () => void;
};

/** A contract's collections over a store, and the store, to close. */
export type DeviceClient = {
	collections: ReadonlyMap<string, CollectionFiles>;
	store: Store;
};

/**
 * The collections of `contract` over `store`. A contract that is not well
 * formed throws: one written in code is a bug to fix, not a state to handle.
 */
export function createDeviceClient(
	contract: Contract,
	outside: Store,
): DeviceClient {
	const { data: compiled, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });
	const store = observed(outside);
	const collections = new Map<string, CollectionFiles>();
	for (const collection of compiled.collections)
		collections.set(
			collection.name,
			collectionFiles(compiled, collection, store),
		);
	return { collections, store: outside };
}

/**
 * `store`, whose listeners also hear every write that lands through it,
 * before the write resolves, so a reader never lags this device's own writes.
 */
function observed(store: Appending): Appending {
	const changes = createChanges((emit) => {
		let stop: (() => void) | undefined;
		let stopped = false;
		void store
			.watch((paths) => emit(paths === 'all' ? null : paths))
			.then((watching) => {
				if (watching.error !== null) return;
				if (stopped) watching.data();
				else stop = watching.data;
			});
		return () => {
			stopped = true;
			stop?.();
		};
	});
	return {
		list: store.list,
		read: store.read,
		async write(path, bytes, over) {
			const written = await store.write(path, bytes, over);
			if (written.error === null && written.data !== 'stale')
				changes.emit([path]);
			return written;
		},
		...(store.append && {
			async append(
				path: string,
				bytes: Uint8Array,
				options: { create: boolean; announce: boolean },
			) {
				const appended = await store.append!(path, bytes, options);
				if (appended.data === 'landed' && (options.create || options.announce))
					changes.emit([path]);
				return appended;
			},
		}),
		watch: async (changed) =>
			Ok(changes.watch((paths) => changed(paths ?? 'all'))),
		close: store.close,
	};
}

/**
 * The directory a collection's files all sit under: its template's leading
 * literal directories (`recordings` for `recordings/{id}.md`), the hint a
 * listing passes so a store that can lists no more than it must.
 */
function directoryOf(collection: CompiledCollection): string {
	const literal: string[] = [];
	for (const segment of collection.template.segments.slice(0, -1)) {
		if (!('literal' in segment)) break;
		literal.push(segment.literal);
	}
	return literal.join('/');
}

function collectionFiles(
	compiled: CompiledContract,
	collection: CompiledCollection,
	store: Appending,
): CollectionFiles {
	const codec = noteCodec(collection);
	const kind = collection.kind === 'note' ? 'note' : 'file';

	/** What the folder shows of the file at `path` holding `bytes`. */
	function seen(
		path: string,
		params: Params,
		bytes: Uint8Array,
		version: Version,
	): Seen {
		if (kind === 'file')
			return { path, params, version, text: null, item: params, invalid: null };
		const text = codec.text(bytes);
		const decoded =
			text === null ? codec.unreadable() : codec.decode(path, text);
		if (decoded.error !== null)
			return {
				path,
				params,
				version,
				text,
				item: null,
				invalid: { ...params, path, issues: decoded.error.issues, text },
			};
		return {
			path,
			params,
			version,
			text,
			// Fields first: a front matter key cannot shadow a placeholder or the body.
			item: { ...decoded.data.fields, ...params, body: decoded.data.body },
			invalid: null,
		};
	}

	/** Each note as last read, by path, kept while the version a listing gives is unchanged. */
	const known = new Map<string, Seen>();

	return {
		kind,
		keys: collection.keys,
		compiled: collection,
		pathOf: (args) => collection.pathOf(args),
		paramsOf: (args) => paramsOf(collection, args),
		async list() {
			const { data: listed, error } = await store.list([
				directoryOf(collection),
			]);
			if (error !== null) return { data: null, error };
			const paths: { path: string; params: Params; version: Version }[] = [];
			for (const { path, version } of listed.sort((a, b) =>
				a.path < b.path ? -1 : 1,
			)) {
				const claim = compiled.claim(path);
				if (claim?.collection.name === collection.name)
					paths.push({ path, params: claim.params, version });
			}
			// A file collection's listing names each file: its bytes are not read.
			const unread =
				kind === 'file'
					? []
					: paths.filter(({ path, version }) => known.get(path)?.version !== version);
			const reads = await store.read(unread.map(({ path }) => path));
			if (reads.error !== null) return reads;
			for (const [index, { path, params }] of unread.entries()) {
				const read = reads.data[index];
				if (read === undefined) continue;
				// Removed since the listing: it is no longer the collection's.
				if ('gone' in read) known.delete(path);
				else known.set(path, seen(path, params, read.bytes, read.version));
			}
			const present = new Set(paths.map(({ path }) => path));
			for (const path of known.keys())
				if (!present.has(path)) known.delete(path);
			const out: Seen[] = [];
			for (const { path, params, version } of paths) {
				if (kind === 'file') {
					out.push({
						path,
						params,
						version,
						text: null,
						item: params,
						invalid: null,
					});
					continue;
				}
				const entry = known.get(path);
				if (entry !== undefined) out.push(entry);
			}
			return Ok(out);
		},
		async read(path) {
			const params = compiled.claim(path)?.params ?? {};
			const read = await store.read([path]);
			if (read.error !== null) return read;
			const [file] = read.data;
			if (file === undefined || 'gone' in file) return Ok(null);
			const { bytes, version } = file;
			return Ok({ ...seen(path, params, bytes, version), bytes });
		},
		async write(path, bytes, over) {
			const written = await store.write(path, bytes, over ?? 'absent');
			if (written.error !== null) return written;
			if (written.data === 'stale') return Ok('stale');
			const landed = written.data;
			if (bytes === null || landed === null) return Ok(null);
			const params = compiled.claim(path)?.params ?? {};
			return Ok(seen(path, params, bytes, landed));
		},
		append: store.append
			? (path, bytes, options) => store.append!(path, bytes, options)
			: null,
		subscribe(listener) {
			const hear = forCollection(compiled, collection.name, listener);
			let stop: (() => void) | undefined;
			let stopped = false;
			void store
				.watch((paths) => hear(paths === 'all' ? null : paths))
				.then((watching) => {
					if (watching.error !== null) return;
					if (stopped) watching.data();
					else stop = watching.data;
				});
			return () => {
				stopped = true;
				stop?.();
			};
		},
	};
}
