import type { TSchema as Schema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	pathProblem,
	readablePath,
	rowAddressProblem,
	writableExistingPath,
} from '../paths.js';
import { readDocument } from '../shared/document.js';
import { ReadError, SaveError } from '../shared/errors.js';
import { changeMarkdown } from '../shared/markdown-codec.js';
import { type FileContent, merge, sameContent } from '../shared/merge.js';
import { type Row, type RowChange, readRow, rowChange } from '../shared/row.js';
import { changeSnapshot } from './git/snapshot.js';
import {
	openStorage,
	type RepositorySnapshot,
	StorageFailure,
	snapshotContent,
	snapshotObject,
} from './storage.js';

export { ReadError, SaveError } from '../shared/errors.js';

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
	{ files, directories }: RepositorySnapshot,
): string | undefined {
	if (files.has(path) || directories.has(path)) return undefined;
	const parts = path.split('/');
	for (const paths of [files.keys(), directories])
		for (const existing of paths) {
			const other = existing.split('/');
			for (
				let index = 0;
				index < Math.min(parts.length, other.length);
				index++
			) {
				if (parts[index]!.toLowerCase() !== other[index]!.toLowerCase()) break;
				if (parts[index] !== other[index])
					return other.slice(0, index + 1).join('/');
			}
		}
	return undefined;
}

/** A delete answers whether the file went, not what a save stored. */
const deleted = (
	saved: Result<{ deleted: boolean; stored: FileContent | null }, SaveError>,
): Result<{ deleted: boolean }, SaveError> =>
	saved.error !== null ? saved : Ok({ deleted: saved.data.deleted });

/**
 * Internal local engine, absent from the package exports. The public opener
 * owns this handle; sync separately owns credentials and network work.
 */
export async function openRepository<
	const TTables extends Record<string, Schema> = Record<never, never>,
>(id: string, schemas: TTables = {} as TTables) {
	// Refuse before opening a database connection that would then leak.
	for (const name of Object.keys(schemas))
		if (!isTableName(name))
			throw new Error(`Table name must be one filename segment: ${name}`);
	const storage = await openStorage(id);
	function assertOpen() {
		if (storage.closed) throw new Error('Repository is closed');
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
		rowFields?: Record<string, unknown>,
		checkBody = false,
		replaceExact = false,
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
				if (!validPath(path) && !snapshot.files.has(path))
					return SaveError.InvalidPath({ path });
				if (change !== null) {
					const directories = snapshot.directories;
					const twin = caseTwin(path, snapshot);
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
						if (snapshot.files.has(parent))
							return SaveError.Occupied({
								path,
								existing: parent,
								kind: 'file',
							});
					}
				}
				const current = snapshotContent(snapshot, path);
				if (replaceExact && sameContent(current, change))
					return Ok({ deleted: false, stored: current });
				if (replaceExact && !sameContent(current, base))
					return SaveError.Conflict({ path, base, current });
				if (
					(rowFields !== undefined || checkBody) &&
					current !== null
				) {
					const row = readDocument(path, current);
					const problem = row.issues?.[0];
					if (problem?.kind === 'not-text') return SaveError.NotText();
					if (checkBody && row.body === undefined)
						return SaveError.Unparseable({
							reason: 'The source has no known body boundary',
						});
					if (rowFields !== undefined && problem?.kind === 'frontmatter')
						return SaveError.Unparseable({ reason: problem.message });
				}
				const merged = replaceExact
					? { content: change }
					: await merge(path, { base, current, change });
				let content = merged.content;
				if (checkBody && content !== null) {
					const result = readDocument(
						path,
						typeof content === 'string'
							? new TextEncoder().encode(content)
							: content,
					);
					if (result.issues?.[0]?.kind === 'not-text')
						return SaveError.NotText();
					if (result.body === undefined)
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
					);
					if (applied.error !== null)
						return SaveError.Unparseable({ reason: applied.error.reason });
					content = applied.data.text;
				}
				if (sameContent(content, current))
					return Ok({
						deleted:
							content === null &&
							!snapshot.files.has(path) &&
							!snapshot.directories.has(path),
						stored: current,
					});
				const changes = new Map<string, FileContent | null>([[path, content]]);
				const candidate = await changeSnapshot({
					root: snapshot.state.workingTree,
					edits: changes,
					read: async (oid) => snapshotObject(snapshot, oid),
				});
				if (
					await storage.publish({
						expected: snapshot.state.workingTree,
						workingTree: candidate.tree,
						objects: candidate.objects,
						retiredBytes: [...snapshot.objects.values()].reduce(
							(sum, object) => sum + object.bytes.byteLength,
							0,
						),
						paths: [path],
					})
				) {
					return Ok({
						deleted: content === null,
						stored: content,
					});
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
					for (const path of [...snapshot.files.keys()].sort()) {
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
			async set(
				id: string,
				from: Pick<Row, 'text' | 'issues'> | null,
				change: RowChange,
			): Promise<
				Result<{ sent: Row<TSchema>; stored: FileContent | null }, SaveError>
			> {
				assertOpen();
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
					change.body !== undefined,
				);
				if (saved.error !== null) return Err(saved.error);
				return Ok({
					sent: readRow(id, sent.data.text, schema),
					stored: saved.data.stored,
				});
			},
			async delete(
				id: string,
				from: Pick<Row, 'text' | 'issues'> | null,
			): Promise<Result<{ deleted: boolean }, SaveError>> {
				if (!validId(name, id) && (from === null || !readableId(name, id)))
					return SaveError.InvalidId({ id });
				if (from?.issues?.some((issue) => issue.kind === 'not-text'))
					return SaveError.NotText();
				return deleted(await saveFile(rowPath(id), from?.text ?? null, null));
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
					return [...snapshot.files.keys()]
						.filter(
							(path) =>
								snapshot.files.get(path)?.mode !== '160000' &&
								path.startsWith(prefix),
						)
						.sort();
				});
			},
			read(path: string) {
				return read(async () => {
					if (!readablePath(path)) return undefined;
					const content = snapshotContent(await storage.capture([path]), path);
					if (content === null) return undefined;
					return { path, content: new Blob([new Uint8Array(content)]) };
				});
			},
			async write(
				path: string,
				from: FileContent | null,
				content: FileContent,
				fields?: Record<string, unknown>,
				checkBody?: boolean,
				replaceExact = false,
			): Promise<Result<{ stored: FileContent | null }, SaveError>> {
				assertOpen();
				const result = await saveFile(path, from, content, fields, checkBody, replaceExact);
				return result.error !== null
					? Err(result.error)
					: Ok({ stored: result.data.stored });
			},
			async delete(path: string, from: FileContent | null) {
				assertOpen();
				return deleted(await saveFile(path, from, null));
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

		/** Listen for committed file changes; storage owns the connection lifetime. */
		onChange: storage.subscribe,
		close: storage.close,
	};
}

export type LocalRepository = Awaited<ReturnType<typeof openRepository>>;
