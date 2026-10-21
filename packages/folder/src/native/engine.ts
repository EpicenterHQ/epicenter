/**
 * The native `Folder`: the handle `openFolder({ directory, tables })` returns
 * over an ordinary directory, the same handle (`handle.ts`) and `Result`
 * semantics as the browser's default local folder (`local-folder.ts`).
 *
 * The directory's files are the saved data. There is no store beside them:
 * every read goes to the host's storage (`boundary.ts`), and every save is
 * one `put` of one file, landing only while the path still holds the bytes
 * the save read (`ifMatch`). A save reads the file, merges the caller's
 * change with it by the shared rules (`shared/merge.ts`, `shared/row.ts`),
 * and puts the result guarded by what it read. When another writer lands
 * first, the put is `stale` and the save reads and merges again, so an edit
 * keeps what landed meanwhile. A host checks the guard where the change
 * lands, under the directory's save lock: Bun takes it in this process
 * (`bun.ts` here), the desktop shell for the page (`tauri.ts` here).
 *
 * A schema only interprets. A row that does not fit comes back with its
 * exact source, its raw fields, and its issues, and a save never validates
 * against the schema, so unknown fields and repairable frontmatter survive.
 *
 * Opening writes nothing. A file a person left in the directory is read as
 * it is, and only a save of that path, merged with its current bytes, ever
 * replaces it.
 *
 * The handle keeps no drafts. A refused or failed save returns its error and
 * leaves the file as it was, and the caller keeps what it meant to save.
 */
import type { TSchema as Schema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileRead, FolderStorage } from '../boundary.js';
import type { FileError } from '../errors.js';
import type { EditOptions, Folder, FolderChange } from '../folder.js';
import { type EngineFiles, type EngineTable, folderHandle } from '../handle.js';
import { hashBytes } from '../hash.js';
import { callObserver } from '../observer.js';
import {
	pathProblem,
	readablePath,
	rowAddressProblem,
	writableExistingPath,
} from '../paths.js';
import { frameRowText } from '../shared/content/markdown.js';
import { readDocument } from '../shared/document.js';
import { ReadError, SaveError } from '../shared/errors.js';
import { changeMarkdown } from '../shared/markdown-codec.js';
import { type FileContent, merge, sameContent } from '../shared/merge.js';
import { type Row, type RowChange, readRow, rowChange } from '../shared/row.js';

const encoder = new TextEncoder();

/**
 * How many times one save reads, merges, and puts again after another writer
 * landed first. Past it, the save fails and changes nothing.
 */
const SAVE_ATTEMPTS = 32;

/**
 * Why `tables` cannot be opened: the first name that is not one top-level
 * directory this folder can address on every disk, or `undefined`.
 */
export function invalidTable(
	tables: Record<string, Schema>,
): string | undefined {
	return Object.keys(tables).find(
		(name) => name.includes('/') || pathProblem(name) !== undefined,
	);
}

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

/** Whether `id` addresses a new writable row: one nonempty, portable segment. */
const validId = (table: string, id: string) =>
	typeof id === 'string' &&
	id !== '' &&
	id.isWellFormed() &&
	rowAddressProblem(table, id) === undefined;

/** A delete answers whether the file went, not what a save stored. */
const deleted = (
	saved: Result<{ deleted: boolean; stored: FileContent | null }, SaveError>,
): Result<{ deleted: boolean }, SaveError> =>
	saved.error !== null ? saved : Ok({ deleted: saved.data.deleted });

/**
 * A process-wide registry of open handles by directory, so a save on one
 * handle reaches the others in this process at once. Other processes' saves
 * are discovered by readers, not reported as handle events.
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
}: {
	readonly storage: FolderStorage;
	readonly tables: TTables;
	readonly directory: string;
} & EditOptions): Folder<TTables> {
	const listeners = new Set<(change: FolderChange) => void>();
	function hear(change: FolderChange) {
		for (const listener of [...listeners])
			callObserver('change listener', listener, change);
	}
	const others = peers.get(directory) ?? new Set();
	peers.set(directory, others);
	const fromPeer = (change: FolderChange) => hear(change);
	others.add(fromPeer);

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
	 * Publish `bytes` at `path`, or remove its file, only while it holds
	 * `ifMatch`. `'stale'` when another writer landed first.
	 */
	async function put(
		path: string,
		bytes: Uint8Array | null,
		ifMatch: string | null,
	): Promise<Result<'landed' | 'stale', SaveError>> {
		const { data: outcome, error } = await storage.put(path, bytes, ifMatch);
		if (error === null) return Ok(outcome);
		if (error.name === 'Unconfirmed' && (await confirmed(path, bytes)))
			return Ok('landed');
		return Err(await refusal(path, error));
	}

	/**
	 * Save `content` at `path`, or remove it for `null`, merged with whatever
	 * landed since `from`. `deleted` says the path holds no file afterward,
	 * and `stored` what it holds: the merged content, or what was already
	 * there for a save that changed nothing. Structured writes check their
	 * frontmatter policy and body boundary on every storage attempt.
	 */
	async function saveFile(
		path: string,
		from: FileContent | null,
		content: FileContent | null,
		rowFields?: Record<string, unknown>,
		frontmatter?: 'required' | 'optional',
	): Promise<
		Result<{ deleted: boolean; stored: FileContent | null }, SaveError>
	> {
		// A mutable caller buffer must not change the edit's witness during retries.
		const base = from instanceof Uint8Array ? from.slice() : from;
		const change = content instanceof Uint8Array ? content.slice() : content;
		if (
			!structural(path) ||
			(pathProblem(path) !== undefined &&
				(base === null || !writableExistingPath(path)))
		)
			return SaveError.InvalidPath({ path });
		if (
			typeof change === 'string' &&
			(change.includes('\0') || !change.isWellFormed())
		)
			return SaveError.NotText();
		for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
			const { data: found, error } = await current(path);
			if (error !== null) {
				// Nothing to remove where a directory stands.
				if (change === null && error.name === 'NotAFile')
					return Ok({ deleted: false, stored: null });
				return Err(await refusal(path, error));
			}
			if (pathProblem(path) !== undefined && found === null)
				return SaveError.InvalidPath({ path });
			if (change !== null && found === null) {
				const twin = await caseTwin(path);
				if (twin !== undefined)
					return SaveError.CaseTwin({ path, existing: twin });
			}
			const stored = found?.bytes ?? null;
			if (
				(rowFields !== undefined || frontmatter !== undefined) &&
				stored !== null
			) {
				const row = readDocument(path, stored);
				const problem = row.issues?.[0];
				if (problem?.kind === 'not-text') return SaveError.NotText();
				if (
					frontmatter === 'required' &&
					frameRowText(row.text).kind !== 'frontmatter'
				)
					return SaveError.Unparseable({
						reason: 'The source has no closed frontmatter',
					});
				if (frontmatter !== undefined && row.body === undefined)
					return SaveError.Unparseable({
						reason: 'The source has no known body boundary',
					});
				if (rowFields !== undefined && problem?.kind === 'frontmatter')
					return SaveError.Unparseable({ reason: problem.message });
			}
			const merged = await merge(path, { base, current: stored, change });
			let content = merged.content;
			if (frontmatter !== undefined && content !== null) {
				const result = readDocument(
					path,
					typeof content === 'string'
						? new TextEncoder().encode(content)
						: content,
				);
				if (result.issues?.[0]?.kind === 'not-text') return SaveError.NotText();
				if (
					(frontmatter === 'required' &&
						frameRowText(result.text).kind !== 'frontmatter') ||
					result.body === undefined
				)
					return SaveError.Unparseable({
						reason: 'The merged source has no known body boundary',
					});
			}
			if (rowFields !== undefined && content !== null) {
				const applied = changeMarkdown(
					readDocument(
						path,
						typeof content === 'string'
							? new TextEncoder().encode(content)
							: content,
					),
					{ fields: rowFields },
					frontmatter ?? 'optional',
				);
				if (applied.error !== null)
					return SaveError.Unparseable({ reason: applied.error.reason });
				content = applied.data.text;
			}
			if (sameContent(content, stored))
				return Ok({ deleted: content === null, stored });
			const bytes =
				content === null
					? null
					: typeof content === 'string'
						? encoder.encode(content)
						: content;
			const { data: outcome, error: putError } = await put(
				path,
				bytes,
				found?.sha256 ?? null,
			);
			if (putError !== null) return Err(putError);
			if (outcome === 'stale') continue;
			landed([path]);
			// A lost reply confirmed by the stored hash holds exactly `bytes` too.
			return Ok({ deleted: bytes === null, stored: bytes });
		}
		return SaveError.StorageFailed({
			cause: new Error(
				`${path} kept changing while it was saved, ${SAVE_ATTEMPTS} times`,
			),
		});
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
			async set(id, from, change: RowChange) {
				if (!validId(name, id) && (from === null || !readableId(name, id)))
					return SaveError.InvalidId({ id });
				if (
					change.body !== undefined &&
					(typeof change.body !== 'string' ||
						change.body.includes('\0') ||
						!change.body.isWellFormed())
				)
					return SaveError.NotText();
				if (from?.issues?.some((issue) => issue.kind === 'not-text'))
					return SaveError.NotText();
				const sent = rowChange(from, change);
				if (sent.error !== null)
					return SaveError.Unparseable({ reason: sent.error.reason });
				const saved = await saveFile(
					rowPath(id),
					from?.text ?? null,
					sent.data.text,
					change.fields,
					'required',
				);
				if (saved.error !== null) return Err(saved.error);
				return Ok({
					sent: readRow(id, sent.data.text, schema),
					stored: saved.data.stored,
				});
			},
			async delete(id, from) {
				if (!validId(name, id) && (from === null || !readableId(name, id)))
					return SaveError.InvalidId({ id });
				if (from?.issues?.some((issue) => issue.kind === 'not-text'))
					return SaveError.NotText();
				return deleted(await saveFile(rowPath(id), from?.text ?? null, null));
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
							.sort()
							.map((path) => path),
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
			async write(path, from, content, fields, frontmatter) {
				if (!structural(path)) return SaveError.InvalidPath({ path });
				const saved = await saveFile(path, from, content, fields, frontmatter);
				return saved.error !== null
					? Err(saved.error)
					: Ok({ stored: saved.data.stored });
			},
			async delete(path, from) {
				if (!structural(path)) return SaveError.InvalidPath({ path });
				return deleted(await saveFile(path, from, null));
			},
		};
	}

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
			listeners.clear();
			others.delete(fromPeer);
			if (others.size === 0 && peers.get(directory) === others)
				peers.delete(directory);
		},
	};
	return folderHandle(engine, tables, { saveAfterMs });
}
