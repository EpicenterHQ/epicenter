/**
 * The native `Folder`: the handle `openFolder({ directory, tables })` returns
 * over an ordinary directory, the same handle (`handle.ts`) and `Result`
 * semantics as the browser's default local folder (`local-folder.ts`).
 *
 * The directory's files are the saved data. There is no store beside them:
 * every read goes to the host's storage (`boundary.ts`), and every save is
 * one unconditional `put` of one file: the last one to land wins. Row
 * changes are composed by the handle's owner (`handle.ts`), which writes them
 * through these same file writes. A host checks a put where it lands, under
 * the directory's save lock: Bun takes it in this process (`bun.ts` here),
 * the desktop shell for the page (`tauri.ts` here).
 *
 * A schema only interprets. A row that does not fit comes back with its
 * exact source, its raw fields, and its issues, and a save never validates
 * against the schema, so unknown fields survive. Malformed frontmatter stays
 * readable as source for full-text repair.
 *
 * Opening writes nothing. A file a person left in the directory is read as
 * it is, and only a save of that path ever replaces it.
 *
 * The engine keeps no drafts. A refused or failed save returns its error;
 * a reply lost after publication may leave its outcome unconfirmed.
 */
import type { TSchema as Schema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileRead, FolderStorage } from '../boundary.js';
import type { FileError } from '../errors.js';
import type { DocumentOptions, Folder, FolderChange } from '../folder.js';
import { type EngineFiles, type EngineTable, folderHandle } from '../handle.js';
import { hashBytes } from '../hash.js';
import { callObserver } from '../observer.js';
import { readablePath } from '../paths.js';
import { ReadError, SaveError } from '../shared/errors.js';
import type { FileContent } from '../shared/merge.js';
import { type Row, readRow } from '../shared/row.js';
import type { FolderWatch } from './watch.js';

const encoder = new TextEncoder();

/**
 * Structural admission for existing source. The host checks literal names
 * and refuses links. New paths must also pass `pathProblem`.
 */
const structural = readablePath;

/** Existing rows may have names a new cross-platform save would refuse. */
const readableId = (table: string, id: string) =>
	typeof id === 'string' &&
	!id.includes('/') &&
	structural(`${table}/${id}.md`);

/** Text a file write can store: UTF-8 without NUL or lone surrogates. */
const storableText = (text: string) =>
	!text.includes('\0') && text.isWellFormed();

/**
 * A process-wide registry of open handles by directory, so a save on one
 * handle reaches the others in this process at once. The optional directory
 * watch separately reports outside processes' changes as observation hints.
 */
const peers = new Map<string, Set<(change: FolderChange) => void>>();

/** The handle over `storage`; `directory` keys peer handles in this process. */
export function createNativeFolder<
	const TTables extends Record<string, Schema>,
>({
	storage,
	tables,
	directory,
	saveAfterMs,
	watch,
}: {
	readonly storage: FolderStorage;
	readonly tables: TTables;
	readonly directory: string;
	readonly watch?: FolderWatch;
} & DocumentOptions): Folder<TTables> {
	const listeners = new Set<(change: FolderChange) => void>();
	function hear(change: FolderChange) {
		for (const listener of [...listeners])
			callObserver('change listener', listener, change);
	}
	const others = peers.get(directory) ?? new Set();
	const fromPeer = (change: FolderChange) => hear(change);

	/** Tell this handle's listeners and every other handle of the directory. */
	function landed(paths: readonly string[]) {
		if (paths.length === 0) return;
		const sorted = [...new Set(paths)].sort();
		hear({ paths: sorted, origin: 'this-handle' });
		for (const peer of [...others])
			if (peer !== fromPeer) peer({ paths: sorted, origin: 'other-handle' });
	}

	/** The file at `path`, `null` when none is there, or why it cannot be read. */
	async function current(
		path: string,
	): Promise<Result<FileRead | null, FileError>> {
		const read = await storage.read(path);
		if (read.error === null) return Ok(read.data);
		if (read.error.name === 'NotFound') return Ok(null);
		return Err(read.error);
	}

	/**
	 * The stored spelling of the first segment of `path` that is stored under
	 * another case, as the browser engine's `CaseTwin` names it.
	 */
	async function caseTwin(path: string): Promise<string | undefined> {
		const segments = path.split('/');
		for (let index = 0; index < segments.length; index++) {
			const parent = segments.slice(0, index).join('/');
			const { data: children, error } = await storage.children(parent);
			if (error !== null) return undefined;
			const names = [...children.files, ...children.directories];
			const name = segments[index]!;
			if (names.includes(name)) continue;
			const twin = names.find(
				(other) => other.toLowerCase() === name.toLowerCase(),
			);
			return twin === undefined
				? undefined
				: [...segments.slice(0, index), twin].join('/');
		}
		return undefined;
	}

	/** A storage answer for a save of `path`, as the save's refusal or failure. */
	async function refusal(path: string, error: FileError): Promise<SaveError> {
		switch (error.name) {
			case 'NotAFile':
				return SaveError.Occupied({
					path,
					existing: error.path,
					kind: 'directory',
				}).error;
			case 'NotADirectory':
				return SaveError.Occupied({ path, existing: error.path, kind: 'file' })
					.error;
			case 'InvalidPath': {
				const twin = await caseTwin(path);
				return twin === undefined
					? SaveError.InvalidPath({ path }).error
					: SaveError.CaseTwin({ path, existing: twin }).error;
			}
			default:
				return SaveError.StorageFailed({ cause: error }).error;
		}
	}

	/**
	 * After a put whose reply was lost: whether `path` now holds what it
	 * sent. A file with the sent bytes, or none for a removal, is the put
	 * landing; anything else is unknown.
	 */
	async function confirmed(path: string, bytes: Uint8Array | null) {
		const { data: found, error } = await current(path);
		if (error !== null) return false;
		if (bytes === null) return found === null;
		return found !== null && found.sha256 === (await hashBytes(bytes));
	}

	/**
	 * Publish `bytes` at `path`, or remove its file, whatever is there: a put
	 * expecting `'any'`, which is never stale.
	 */
	async function put(
		path: string,
		bytes: Uint8Array | null,
	): Promise<Result<undefined, SaveError>> {
		const { error } = await storage.put(path, bytes, 'any');
		if (error === null) {
			landed([path]);
			return Ok(undefined);
		}
		if (error.name === 'Unconfirmed' && (await confirmed(path, bytes))) {
			landed([path]);
			return Ok(undefined);
		}
		// Nothing to remove where a directory stands.
		if (bytes === null && error.name === 'NotAFile') return Ok(undefined);
		return Err(await refusal(path, error));
	}

	async function read<T>(
		work: () => Promise<Result<T, FileError | ReadError>>,
	): Promise<Result<T, ReadError>> {
		const result = await work();
		if (result.error === null || result.error.name === 'StorageFailed')
			return result as Result<T, ReadError>;
		return ReadError.StorageFailed({ cause: result.error });
	}

	function table<const TSchema extends Schema>(
		name: string,
		schema: TSchema,
	): EngineTable<TSchema> {
		const rowPath = (id: string) => `${name}/${id}.md`;
		return {
			list() {
				return read(async () => {
					const { data: children, error } = await storage.children(name);
					if (error !== null)
						return error.name === 'NotFound' || error.name === 'NotADirectory'
							? Ok([])
							: Err(error);
					const rows: Row<TSchema>[] = [];
					for (const file of children.files) {
						if (!file.endsWith('.md')) continue;
						const id = file.slice(0, -3);
						if (!readableId(name, id)) continue;
						const { data: found, error: readError } = await current(
							rowPath(id),
						);
						if (readError !== null) {
							// A link or special entry is no row; files still lists it.
							if (
								readError.name === 'InvalidPath' ||
								readError.name === 'NotAFile'
							)
								continue;
							return Err(readError);
						}
						if (found !== null) rows.push(readRow(id, found.bytes, schema));
					}
					return Ok(rows);
				});
			},
			get(id) {
				return read(async () => {
					if (!readableId(name, id)) return Ok(undefined);
					const { data: found, error } = await current(rowPath(id));
					if (error !== null)
						return error.name === 'NotAFile' ? Ok(undefined) : Err(error);
					return Ok(
						found === null ? undefined : readRow(id, found.bytes, schema),
					);
				});
			},
		};
	}

	function files(): EngineFiles {
		return {
			list(prefix = '') {
				return read(async () => {
					if (prefix !== '' && !structural(prefix.replace(/\/$/, '')))
						return Ok([]);
					const { data: listing, error } = await storage.list();
					if (error !== null) return Err(error);
					return Ok(
						listing.files
							.map((file) => file.path)
							.filter((path) => path.startsWith(prefix))
							.sort(),
					);
				});
			},
			read(path) {
				return read(async () => {
					if (!structural(path)) return Ok(undefined);
					const { data: found, error } = await current(path);
					if (error !== null)
						return error.name === 'NotAFile' ? Ok(undefined) : Err(error);
					if (found === null) return Ok(undefined);
					return Ok({ path, content: new Blob([new Uint8Array(found.bytes)]) });
				});
			},
			async write(path, content: FileContent) {
				if (!structural(path)) return SaveError.InvalidPath({ path });
				if (typeof content === 'string' && !storableText(content))
					return SaveError.NotText();
				const bytes =
					typeof content === 'string' ? encoder.encode(content) : content;
				// A new file may not take a stored name's other spelling; what
				// cannot be read here is the put's to refuse.
				const { data: found, error } = await current(path);
				if (error === null && found === null) {
					const twin = await caseTwin(path);
					if (twin !== undefined)
						return SaveError.CaseTwin({ path, existing: twin });
				}
				return put(path, bytes);
			},
			async delete(path) {
				if (!structural(path)) return SaveError.InvalidPath({ path });
				return put(path, null);
			},
		};
	}

	let stopWatching: (() => void) | undefined;
	const engine = {
		files: files(),
		tables: Object.fromEntries(
			Object.entries(tables).map(([name, schema]) => [
				name,
				table(name, schema),
			]),
		) as Record<string, EngineTable>,
		subscribe(listener: (change: FolderChange) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			stopWatching?.();
			listeners.clear();
			others.delete(fromPeer);
			if (others.size === 0 && peers.get(directory) === others)
				peers.delete(directory);
		},
	};
	// Install observation after the handle owns its listener, before a caller can read.
	try {
		peers.set(directory, others);
		others.add(fromPeer);
		const folder = folderHandle(engine, tables, { saveAfterMs });
		stopWatching = watch?.((paths) => hear({ paths, origin: 'other-handle' }));
		return folder;
	} catch (cause) {
		engine.close();
		throw cause;
	}
}
