import type { TSchema as Schema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type GitObject, hashObject, writeCommit } from '../git/raw-objects.js';
import {
	pathProblem,
	readablePath,
	rowAddressProblem,
	writableExistingPath,
} from '../paths.js';
import { ReadError, SaveError } from '../shared/errors.js';
import { type FileContent, merge, sameContent } from '../shared/merge.js';
import { type Row, type RowChange, readRow, rowChange } from '../shared/row.js';
import { changeSnapshot } from './git/snapshot.js';
import {
	openStorage,
	type RepositorySnapshot,
	type StorageChange,
	StorageFailure,
	shadowed,
	snapshotContent,
	snapshotDirectories,
	snapshotObject,
	snapshotPaths,
} from './storage.js';

export { ReadError, SaveError } from '../shared/errors.js';

const encoder = new TextEncoder();

/** Exact request identity captured by the transaction that published pending C. */
export type PendingCommit = { base: string | null; head: string };

const validPath = (path: string) =>
	readablePath(path) && pathProblem(path) === undefined;

const readableId = (table: string, id: string) =>
	typeof id === 'string' &&
	!id.includes('/') &&
	readablePath(`${table}/${id}.md`);

const validId = (table: string, id: string) =>
	typeof id === 'string' &&
	id !== '' &&
	id.isWellFormed() &&
	rowAddressProblem(table, id) === undefined;

/** A table is one top-level directory. */
export const isTableName = (name: string) =>
	typeof name === 'string' &&
	name.isWellFormed() &&
	!name.includes('/') &&
	pathProblem(name) === undefined;

function caseTwin(
	path: string,
	paths: ReadonlySet<string>,
): string | undefined {
	if (paths.has(path)) return undefined;
	const parts = path.split('/');
	for (const existing of paths) {
		const other = existing.split('/');
		for (let index = 0; index < Math.min(parts.length, other.length); index++) {
			if (parts[index]!.toLowerCase() !== other[index]!.toLowerCase()) break;
			if (parts[index] !== other[index])
				return other.slice(0, index + 1).join('/');
		}
	}
	return undefined;
}

/** Normalize E against C, so restoring C removes a pending edit rather than adding work. */
function editPatch(
	snapshot: RepositorySnapshot,
	changes: ReadonlyMap<string, FileContent | null>,
) {
	const patch = new Map<string, FileContent | null | undefined>();
	const prospective = new Map([...snapshot.edits, ...changes]);
	for (const [path, text] of changes) {
		const entry = snapshot.head.files.get(path);
		if (text === null) {
			patch.set(
				path,
				entry === undefined && !snapshot.head.directories.has(path)
					? undefined
					: null,
			);
			continue;
		}
		const committed =
			entry === undefined || entry.mode === '160000'
				? null
				: snapshotObject(snapshot, entry.oid).bytes;
		const slash = path.lastIndexOf('/');
		const parent = slash < 0 ? '' : path.slice(0, slash);
		patch.set(
			path,
			sameContent(text, committed) && !shadowed(prospective, parent)
				? undefined
				: text,
		);
	}
	return patch;
}

/**
 * Internal local engine, absent from the package exports. The public opener will
 * own the local handle; optional sync integration owns credentials and network work.
 */
export async function openRepository<
	const TTables extends Record<string, Schema> = Record<never, never>,
>(id: string, schemas: TTables = {} as TTables) {
	// Refuse before opening a database connection that would then leak.
	for (const name of Object.keys(schemas))
		if (!isTableName(name))
			throw new Error(`Table name must be one filename segment: ${name}`);
	const storage = await openStorage(id);
	let closed = false;
	function assertOpen() {
		if (closed) throw new Error('Repository is closed');
	}

	async function read<T>(
		work: () => Promise<T>,
	): Promise<Result<T, ReadError>> {
		assertOpen();
		try {
			return Ok(await work());
		} catch (cause) {
			if (!(cause instanceof StorageFailure)) throw cause;
			return ReadError.StorageFailed({ cause });
		}
	}

	async function save<T>(
		work: () => Promise<Result<T, SaveError>>,
	): Promise<Result<T, SaveError>> {
		assertOpen();
		try {
			return await work();
		} catch (cause) {
			if (!(cause instanceof StorageFailure)) throw cause;
			return SaveError.StorageFailed({ cause });
		}
	}

	async function saveFile(
		path: string,
		from: FileContent | null,
		content: FileContent | null,
		rowFields = false,
	) {
		// A mutable caller buffer must not change the edit's witness during retries.
		const base = from instanceof Uint8Array ? from.slice() : from;
		const change = content instanceof Uint8Array ? content.slice() : content;
		return save(async () => {
			if (!validPath(path) && (base === null || !writableExistingPath(path)))
				return SaveError.InvalidPath({ path });
			if (
				typeof change === 'string' &&
				(change.includes('\0') || !change.isWellFormed())
			)
				return SaveError.NotText();
			for (;;) {
				// Trees identify structural collisions; only this path needs blob bytes.
				const snapshot = await storage.capture([path]);
				const paths = snapshotPaths(snapshot);
				if (!validPath(path) && !paths.has(path))
					return SaveError.InvalidPath({ path });
				if (change !== null) {
					const directories = snapshotDirectories(snapshot);
					const twin = caseTwin(path, new Set([...paths, ...directories]));
					if (twin !== undefined)
						return SaveError.CaseTwin({ path, existing: twin });
					if (directories.has(path))
						return SaveError.Occupied({
							path,
							existing: path,
							kind: 'directory',
						});
					for (
						let end = path.lastIndexOf('/');
						end > 0;
						end = path.lastIndexOf('/', end - 1)
					) {
						const parent = path.slice(0, end);
						if (paths.has(parent))
							return SaveError.Occupied({
								path,
								existing: parent,
								kind: 'file',
							});
					}
				}
				const current = snapshotContent(snapshot, path);
				if (rowFields && current !== null) {
					const row = readRow('', current, {});
					const problem = row.issues?.[0];
					if (problem?.kind === 'not-text') return SaveError.NotText();
					if (problem?.kind === 'frontmatter')
						return SaveError.Unparseable({ reason: problem.message });
				}
				const merged = await merge(path, { base, current, change });
				if (sameContent(merged.content, current))
					return Ok({
						deleted:
							merged.content === null &&
							!paths.has(path) &&
							!snapshotDirectories(snapshot).has(path),
					});
				const changes = new Map<string, FileContent | null>([
					[path, merged.content],
				]);
				if (
					await storage.publish({
						revision: snapshot.state.revision,
						edits: editPatch(snapshot, changes),
					})
				) {
					return Ok({ deleted: merged.content === null });
				}
			}
		});
	}

	function table<const TSchema extends Schema>(name: string, schema: TSchema) {
		const rowPath = (id: string) => `${name}/${id}.md`;
		return {
			list() {
				return read(async () => {
					const snapshot = await storage.capture({ rows: name });
					const rows: Row<TSchema>[] = [];
					for (const path of [...snapshotPaths(snapshot)].sort()) {
						if (!path.startsWith(`${name}/`) || !path.endsWith('.md')) continue;
						const id = path.slice(name.length + 1, -3);
						if (!readableId(name, id)) continue;
						const content = snapshotContent(snapshot, path);
						if (content !== null) rows.push(readRow(id, content, schema));
					}
					return rows;
				});
			},
			get(id: string) {
				return read(async () => {
					if (!readableId(name, id)) return undefined;
					const content = snapshotContent(
						await storage.capture([rowPath(id)]),
						rowPath(id),
					);
					return content === null ? undefined : readRow(id, content, schema);
				});
			},
			set(
				id: string,
				from: Row<TSchema> | null,
				change: RowChange,
			): Promise<Result<{ sent: Row<TSchema> }, SaveError>> {
				return save(async () => {
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
						change.fields !== undefined,
					);
					if (saved.error !== null) return Err(saved.error);
					return Ok({ sent: readRow(id, sent.data.text, schema) });
				});
			},
			delete(
				id: string,
				from: Row<TSchema> | null,
			): Promise<Result<{ deleted: boolean }, SaveError>> {
				if (!validId(name, id) && (from === null || !readableId(name, id)))
					return Promise.resolve(SaveError.InvalidId({ id }));
				if (from?.issues?.some((issue) => issue.kind === 'not-text'))
					return Promise.resolve(SaveError.NotText());
				return saveFile(rowPath(id), from?.text ?? null, null);
			},
		};
	}

	function files() {
		return {
			list(prefix = '') {
				return read(async () => {
					if (prefix !== '' && !readablePath(prefix.replace(/\/$/, '')))
						return [];
					const snapshot = await storage.capture({ prefix });
					return [...snapshotPaths(snapshot)]
						.filter(
							(path) =>
								(snapshot.edits.has(path) ||
									snapshot.head.files.get(path)?.mode !== '160000') &&
								path.startsWith(prefix),
						)
						.sort()
						.map((path) => path);
				});
			},
			read(path: string) {
				return read(async () => {
					if (!readablePath(path)) return undefined;
					const content = snapshotContent(await storage.capture([path]), path);
					if (content === null) return undefined;
					const bytes =
						typeof content === 'string' ? encoder.encode(content) : content;
					return { path, content: new Blob([new Uint8Array(bytes)]) };
				});
			},
			async write(
				path: string,
				from: FileContent | null,
				content: FileContent,
			): Promise<Result<void, SaveError>> {
				assertOpen();
				const result = await saveFile(path, from, content);
				return result.error !== null ? Err(result.error) : Ok(undefined);
			},
			delete(path: string, from: FileContent | null) {
				assertOpen();
				return saveFile(path, from, null);
			},
		};
	}

	return {
		id,
		/** Internal shared durable owner, used by sync and transaction evidence. */
		storage,
		files: files(),
		tables: Object.fromEntries(
			Object.entries(schemas).map(([name, schema]) => [
				name,
				table(name, schema),
			]),
		) as {
			[TName in keyof TTables]: ReturnType<typeof table<TTables[TName]>>;
		},

		/**
		 * Build at most one pending commit. A retry reuses exact C, even if E has
		 * grown since it was published. The network layer must settle C first.
		 */
		async prepareCommit(author: {
			name: string;
			email: string;
			timestamp: number;
		}): Promise<Result<PendingCommit | null, SaveError>> {
			return save(async () => {
				for (;;) {
					const snapshot = await storage.capture('commit');
					const { remoteBase, pendingCommit, revision } = snapshot.state;
					if (remoteBase === undefined) return Ok(null);
					if (pendingCommit !== null)
						return Ok({ base: remoteBase, head: pendingCommit });
					if (snapshot.edits.size === 0) return Ok(null);
					const candidate = await changeSnapshot({
						root: snapshot.head.root,
						edits: snapshot.edits,
						read: async (oid) => snapshotObject(snapshot, oid),
					});
					const commit: GitObject = {
						type: 'commit',
						bytes: writeCommit({
							tree: candidate.tree,
							parents: remoteBase === null ? [] : [remoteBase],
							author,
							message: 'Save repository changes\n',
						}),
					};
					const oid = await hashObject(commit);
					candidate.objects.set(oid, commit);
					if (
						await storage.publish({
							revision,
							objects: candidate.objects,
							refs: { remoteBase, pendingCommit: oid },
							edits: new Map(
								[...snapshot.edits.keys()].map((path) => [path, undefined]),
							),
						})
					)
						return Ok({ base: remoteBase, head: oid });
				}
			});
		},

		/**
		 * Listen for committed changes to file contents, from this handle or
		 * another connection. The returned function stops it; `close` stops all.
		 */
		onChange(listener: (change: StorageChange) => void): () => void {
			assertOpen();
			return storage.subscribe(listener);
		},

		close() {
			closed = true;
			storage.close();
		},
	};
}

export type LocalRepository = Awaited<ReturnType<typeof openRepository>>;
