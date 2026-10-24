/**
 * The caller-facing `Folder` over an engine, the same on every host: its one
 * document owner, whose per-path I/O slot every document read, write and delete enters and which
 * composes row changes, local save status, synchronous release, and the error
 * a released handle throws. The browser's default
 * local folder (`local-folder.ts`) and the native directory folder
 * (`native/engine.ts`) each supply the engine: raw files and typed row reads.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { createDocumentOwner, textProblem } from './document-owner.js';
import type {
	DocumentOptions,
	FileContent,
	Folder,
	FolderChange,
	FolderFileOperations,
	FolderTableOperations,
	RowChange,
} from './folder.js';
import { callObserver } from './observer.js';
import { readablePath } from './paths.js';
import { ownFields } from './shared/content/canonical.js';
import { SaveError } from './shared/errors.js';
import { changeMarkdown, readMarkdown } from './shared/markdown-codec.js';
import { readRow } from './shared/row.js';

/** An engine's files: raw reads and unconditional writes, unordered and untracked. */
export type EngineFiles = FolderFileOperations;

/** An engine's table: typed row reads. The handle composes every row change. */
export type EngineTable<TSchema extends Schema = Schema> = Pick<
	FolderTableOperations<TSchema>,
	'list' | 'get'
>;

/** Whether `id` names an existing row file this table can address. */
const readableId = (table: string, id: string) =>
	typeof id === 'string' &&
	!id.includes('/') &&
	readablePath(`${table}/${id}.md`);

/** What an engine gives the handle: its files, tables, changes, and release. */
export type FolderEngine = {
	readonly files: EngineFiles;
	readonly tables: Record<string, EngineTable>;
	/**
	 * Hear committed changes from the engine. The handle suppresses path-scoped
	 * `this-handle` notices and announces them after the document owner installs
	 * the outcome. Unknown-scope and `other-handle` notices invalidate documents.
	 */
	subscribe(listener: (change: FolderChange) => void): () => void;
	/** Release listeners and storage; the handle calls it once, at close; admitted writes may still finish or fail afterwards. */
	close(): void;
};

/** A copy of caller bytes the caller cannot change afterwards. */
const owned = (content: FileContent): FileContent =>
	content instanceof Uint8Array ? content.slice() : content;

/**
 * Serialize a row replacement, owning its fields as the canonical writer
 * takes them, nested values and proxies included.
 */
function rowText(change: RowChange): Result<string, SaveError> {
	if (
		change.body !== undefined &&
		(typeof change.body !== 'string' || textProblem(change.body) !== undefined)
	)
		return SaveError.NotText();
	const fields =
		change.fields === undefined ? Ok(undefined) : ownFields(change.fields);
	if (fields.error !== null)
		return SaveError.Unparseable({ reason: fields.error.reason });
	const changed = changeMarkdown(null, {
		fields: fields.data,
		body: change.body,
	});
	return changed.error === null
		? Ok(changed.data.text)
		: SaveError.Unparseable({ reason: changed.error.reason });
}

/** The handle over `engine`, typed by `tables`, saving held input as `options` say. */
export function folderHandle<const TTables extends Record<string, Schema>>(
	engine: FolderEngine,
	tables: TTables,
	{ saveAfterMs }: DocumentOptions = {},
): Folder<TTables> {
	const changeListeners = new Set<(change: FolderChange) => void>();

	/** New storage calls, listeners, and flush refuse as soon as close is called. */
	function assertOpen() {
		if (documents.getStatus().closing) throw new Error('The folder is closed');
	}

	function tell(change: FolderChange) {
		for (const listener of [...changeListeners])
			if (changeListeners.has(listener))
				callObserver('change listener', listener, change);
	}

	/**
	 * An engine can report a write before its awaiting caller has installed the
	 * new document text. That path is announced after installation instead.
	 * Other changes still reach listeners immediately.
	 */
	function hear(change: FolderChange) {
		if (change.origin === 'this-handle' && change.paths !== null) return;
		documents.changed(change.paths);
		tell(change);
	}

	const documents = createDocumentOwner({
		read: (path) => engine.files.read(path),
		write: (path, content) => engine.files.write(path, content),
		saveAfterMs,
		// Notify after installing the successful command's text, whether or not
		// the engine emitted its own early notice.
		announce: (path) => tell({ paths: [path], origin: 'this-handle' }),
	});
	const stopEngine = engine.subscribe(hear);

	const files: Folder<Record<string, Schema>>['files'] = {
		list(prefix) {
			assertOpen();
			return engine.files.list(prefix);
		},
		async read(path) {
			assertOpen();
			return engine.files.read(path);
		},
		write(path, content) {
			assertOpen();
			// A write queued behind another of its path keeps the bytes of its call.
			return documents.write(path, owned(content));
		},
		delete(path) {
			assertOpen();
			return documents.remove(path, () => engine.files.delete(path));
		},
		document(path) {
			if (!readablePath(path))
				throw new RangeError(
					`Not a folder-relative file path: ${String(path)}`,
				);
			return documents.document(path);
		},
	};

	const folderTables = Object.fromEntries(
		Object.keys(tables).map((name) => {
			const table = engine.tables[name] as EngineTable;
			const rowPath = (id: string) => `${name}/${id}.md`;
			const schema = tables[name] as Schema;
			const operations: Folder<Record<string, Schema>>['tables'][string] = {
				async list() {
					assertOpen();
					return table.list();
				},
				async get(id) {
					assertOpen();
					return table.get(id);
				},
				write(id, change) {
					assertOpen();
					if (id === '' || !readableId(name, id))
						return Promise.resolve(SaveError.InvalidId({ id }));
					const text = rowText(change);
					if (text.error !== null) return Promise.resolve(text);
					return documents.write(rowPath(id), text.data).then((saved) => {
						if (saved.error === null) return Ok(readRow(id, text.data, schema));
						return saved.error.name === 'InvalidPath'
							? SaveError.InvalidId({ id })
							: saved;
					});
				},
				delete(id) {
					assertOpen();
					if (!readableId(name, id))
						return Promise.resolve(SaveError.InvalidId({ id }));
					const path = rowPath(id);
					return documents.remove(path, () => engine.files.delete(path));
				},
				document(id) {
					if (!readableId(name, id))
						throw new RangeError(`Not a row ID in ${name}: ${String(id)}`);
					return documents.document(rowPath(id));
				},
				parse(text) {
					return readMarkdown(text, schema);
				},
			};

			return [name, operations];
		}),
	);

	const folder: Folder<Record<string, Schema>> = {
		files,
		tables: folderTables,
		refresh(paths) {
			assertOpen();
			return documents.refreshKnown(paths);
		},
		onChange(listener) {
			assertOpen();
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
		getStatus: documents.getStatus,
		onStatusChange: documents.onStatusChange,
		flush() {
			assertOpen();
			documents.flush();
		},
		close() {
			if (documents.getStatus().closing) return;
			documents.close();
			changeListeners.clear();
			stopEngine();
			engine.close();
		},
	};
	return folder as unknown as Folder<TTables>;
}
