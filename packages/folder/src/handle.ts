/**
 * The caller-facing `Folder` over an engine, the same on every host: its one
 * edit owner, whose per-path lane every write and delete enters and which
 * composes row changes, local save status, the writes and actions `close`
 * waits for, and the error a released handle throws. The browser's default
 * local folder (`local-folder.ts`) and the native directory folder
 * (`native/engine.ts`) each supply the engine: raw files and typed row reads.
 */
import { type TSchema as Schema, Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	createEditOwner,
	type Observation,
	observationOf,
	type Recovery,
	textProblem,
} from './edit-owner.js';
import type {
	EditOptions,
	FileContent,
	Folder,
	FolderChange,
	FolderFileOperations,
	FolderStatus,
	FolderTableOperations,
	Row,
	RowChange,
} from './folder.js';
import { callObserver } from './observer.js';
import { readablePath, rowAddressProblem } from './paths.js';
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

const anyFields = Type.Record(Type.String(), Type.Unknown());

/** Whether `id` names an existing row file this table can address. */
const readableId = (table: string, id: string) =>
	typeof id === 'string' &&
	!id.includes('/') &&
	readablePath(`${table}/${id}.md`);

/** Whether `id` may name a new row: one nonempty, portable segment. */
const validId = (table: string, id: string) =>
	typeof id === 'string' &&
	id !== '' &&
	id.isWellFormed() &&
	rowAddressProblem(table, id) === undefined;

/** What a row read found, as an observation of its file. */
const rowObservation = (row: Pick<Row, 'text' | 'issues'>): Observation =>
	row.issues?.some((issue) => issue.kind === 'not-text')
		? { kind: 'not-text' }
		: { kind: 'text', text: row.text };

/** What an engine gives the handle: its files, tables, changes, and release. */
export type FolderEngine = {
	readonly files: EngineFiles;
	readonly tables: Record<string, EngineTable>;
	/**
	 * Hear every committed change, calling the listener before the write
	 * resolves. Changes another handle, a sync, or a watcher reports reach
	 * the editors of their paths, which read again.
	 */
	subscribe(listener: (change: FolderChange) => void): () => void;
	/** Release listeners and storage; the handle calls it once, after admitted writes settled. */
	close(): void;
};

/** A copy of caller bytes the caller cannot change afterwards. */
const owned = (content: FileContent): FileContent =>
	content instanceof Uint8Array ? content.slice() : content;

/**
 * A row change the caller cannot change afterwards: its fields as the
 * canonical writer takes them, nested values and proxies included, or the
 * refusal the engine gives fields it cannot write.
 */
function ownChange(change: RowChange): Result<RowChange, SaveError> {
	if (change.fields === undefined) return Ok({ body: change.body });
	const fields = ownFields(change.fields);
	if (fields.error !== null)
		return SaveError.Unparseable({ reason: fields.error.reason });
	return Ok({ fields: fields.data, body: change.body });
}

const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

/** The handle over `engine`, typed by `tables`, saving held input as `options` say. */
export function folderHandle<const TTables extends Record<string, Schema>>(
	engine: FolderEngine,
	tables: TTables,
	{ saveAfterMs }: EditOptions = {},
): Folder<TTables> {
	let closing: Promise<Recovery[]> | undefined;
	/** Set by close once nothing it waits for remains, before the engine is released. */
	let released = false;
	/** Writes and admitted actions share one lifetime registry. */
	const inflight = new Set<Promise<unknown>>();
	let storageFailure: FolderStatus['storageFailure'] = null;
	let status: FolderStatus = {
		saving: false,
		storageFailure: null,
		unsaved: [],
		failures: [],
		closing: false,
	};
	const statusListeners = new Set<(status: FolderStatus) => void>();
	const changeListeners = new Set<(change: FolderChange) => void>();

	/** Listeners and settle refuse from the moment close is called. */
	function assertOpen() {
		if (closing !== undefined) throw new Error('The folder is closed');
	}

	/** Storage refuses once close released the engine. */
	function assertUsable() {
		if (released) throw new Error('The folder is closed');
	}

	function publishStatus() {
		const { unsaved, failures, working } = edits.getAggregate();
		const next: FolderStatus = {
			saving: working,
			storageFailure,
			unsaved,
			failures,
			closing: closing !== undefined,
		};
		if (
			next.saving === status.saving &&
			next.storageFailure === status.storageFailure &&
			sameList(next.unsaved, status.unsaved) &&
			sameList(next.failures, status.failures) &&
			next.closing === status.closing
		)
			return;
		status = next;
		for (const listener of [...statusListeners])
			callObserver('status listener', listener, next);
	}

	function tell(change: FolderChange) {
		for (const listener of [...changeListeners])
			callObserver('change listener', listener, change);
	}

	/**
	 * Tell the edit owner what changed that no command of this handle
	 * explains, then this handle's listeners. An engine reports a write's
	 * change while that write runs, and only one command of a path runs at a
	 * time, so an own notice of a path whose command runs is that command's.
	 */
	function hear(change: FolderChange) {
		if (change.paths === null) edits.changed(null);
		else if (change.origin === 'other-handle') edits.changed(change.paths);
		else {
			const elsewhere = edits.heard(change.paths);
			if (elsewhere.length > 0) edits.changed(elsewhere);
		}
		tell(change);
	}

	/** Register work before it can notify listeners or begin other work. */
	function track<T>(run: () => Promise<T>): Promise<T> {
		const operation = Promise.withResolvers<T>();
		inflight.add(operation.promise);
		const done = () => inflight.delete(operation.promise);
		operation.promise.then(done, done);
		try {
			Promise.resolve(run()).then(operation.resolve, operation.reject);
		} catch (cause) {
			operation.reject(cause);
		}
		return operation.promise;
	}

	/** An admitted action, or any caller while close drains, can start writes after an await. */
	async function drainWork() {
		while (inflight.size > 0) await Promise.allSettled([...inflight]);
	}

	/**
	 * A write's outcome, kept as the handle's last storage failure or its
	 * clearing. Status tells it with the command's end, in one change.
	 */
	async function recorded<T>(
		writing: Promise<Result<T, SaveError>>,
	): Promise<Result<T, SaveError>> {
		const result = await writing;
		if (result.error === null) storageFailure = null;
		else if (result.error.name === 'StorageFailed')
			storageFailure = result.error;
		return result;
	}

	const edits = createEditOwner({
		read: (path) => engine.files.read(path),
		write: (path, content) => recorded(engine.files.write(path, content)),
		saveAfterMs,
		onAggregate: publishStatus,
		track,
		drainWork,
		// A write that stored what was already there reports no change itself.
		announce: (path) => tell({ paths: [path], origin: 'this-handle' }),
	});
	const stopEngine = engine.subscribe(hear);

	const files: Folder<Record<string, Schema>>['files'] = {
		list(prefix) {
			assertUsable();
			return engine.files.list(prefix);
		},
		async read(path) {
			assertUsable();
			const at = edits.beginObservation();
			try {
				const result = await engine.files.read(path);
				// A passive editor's file is never decoded here; an engaged one learns it.
				if (edits.wantsRaw(path)) {
					let observation: Observation;
					if (result.error !== null)
						observation = { kind: 'failed', cause: result.error };
					else if (result.data === undefined) observation = { kind: 'missing' };
					else
						try {
							observation = observationOf(
								new Uint8Array(await result.data.content.arrayBuffer()),
							);
						} catch (cause) {
							observation = { kind: 'failed', cause };
						}
					edits.readRaw(path, at, observation);
				}
				return result;
			} finally {
				edits.endObservation();
			}
		},
		write(path, content) {
			assertUsable();
			// A write queued behind another of its path keeps the bytes of its call.
			return edits.write(path, owned(content));
		},
		delete(path) {
			assertUsable();
			return edits.remove(path, () => recorded(engine.files.delete(path)));
		},
		edit: (path, schema) => edits.edit(path, schema),
	};

	const folderTables = Object.fromEntries(
		Object.keys(tables).map((name) => {
			const table = engine.tables[name] as EngineTable;
			const rowPath = (id: string) => `${name}/${id}.md`;
			const schema = tables[name] as Schema;
			const operations: Folder<Record<string, Schema>>['tables'][string] = {
				// Every row read tells the owner the exact text it found, before
				// it answers, ordered against writes and changes meanwhile.
				async list() {
					assertUsable();
					const at = edits.beginObservation();
					try {
						const result = await table.list();
						if (result.error === null)
							edits.listed(
								`${name}/`,
								at,
								result.data.map((row) => ({
									path: rowPath(row.id),
									observation: rowObservation(row),
								})),
							);
						return result;
					} finally {
						edits.endObservation();
					}
				},
				async get(id) {
					assertUsable();
					const at = edits.beginObservation();
					try {
						const result = await table.get(id);
						if (readableId(name, id))
							edits.got(
								rowPath(id),
								at,
								result.error !== null
									? { kind: 'failed', cause: result.error }
									: result.data === undefined
										? { kind: 'missing' }
										: rowObservation(result.data),
							);
						return result;
					} finally {
						edits.endObservation();
					}
				},
				set(id, change) {
					assertUsable();
					return setRow(id, change);
				},
				delete(id) {
					assertUsable();
					if (!readableId(name, id))
						return Promise.resolve(SaveError.InvalidId({ id }));
					const path = rowPath(id);
					return edits.remove(path, () => recorded(engine.files.delete(path)));
				},
				edit: (id) => edits.edit(rowPath(id), tables[name]),
			};
			/**
			 * Compose `change` over the row's held text, or over the file read
			 * in the lane when nothing is held, and publish it.
			 */
			async function setRow(
				id: string,
				change: RowChange,
			): Promise<Result<Row, SaveError>> {
				if (!readableId(name, id)) return SaveError.InvalidId({ id });
				if (
					change.body !== undefined &&
					(typeof change.body !== 'string' ||
						textProblem(change.body) !== undefined)
				)
					return SaveError.NotText();
				const owned = ownChange(change);
				if (owned.error !== null) return owned;
				const saved = await edits.compose(rowPath(id), (text) => {
					if (text === null && !validId(name, id))
						return SaveError.InvalidId({ id });
					const changed = changeMarkdown(
						text === null ? null : readMarkdown(text, anyFields),
						owned.data,
					);
					return changed.error === null
						? Ok(changed.data.text)
						: SaveError.Unparseable({ reason: changed.error.reason });
				});
				if (saved.error === null) return Ok(readRow(id, saved.data, schema));
				// A name only some disks hold is never made as a new row.
				return saved.error.name === 'InvalidPath'
					? SaveError.InvalidId({ id })
					: saved;
			}
			return [name, operations];
		}),
	);

	const folder: Folder<Record<string, Schema>> = {
		files,
		tables: folderTables,
		refresh(paths) {
			assertOpen();
			return edits.refreshKnown(paths);
		},
		onChange(listener) {
			assertOpen();
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
		getStatus() {
			return status;
		},
		onStatusChange(listener) {
			assertOpen();
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		run(action) {
			if (closing !== undefined) return Promise.resolve(ActionError.Closing());
			return track(async () => Ok(await action()));
		},
		async settle() {
			assertOpen();
			return edits.settle();
		},
		close() {
			if (closing !== undefined) return closing;
			// Assigned before anything is told, so a listener that closes again
			// answers this same promise.
			const completion = Promise.withResolvers<Recovery[]>();
			closing = completion.promise;
			(async () => {
				// New input, actions and listeners already refuse; storage stays
				// usable for what close waits for.
				const sending = edits.close();
				publishStatus();
				await sending;
				// Release in the same turn the registry is found empty: a write
				// any earlier continuation started is waited for, and one called
				// after this turn finds storage released and throws, or, for an
				// editor's `save()`, refuses. What is still held then is the
				// answer. Status is told after, so a listener cannot start one in
				// between.
				while (inflight.size > 0) await Promise.allSettled([...inflight]);
				released = true;
				const unsaved = edits.release();
				publishStatus();
				statusListeners.clear();
				changeListeners.clear();
				stopEngine();
				engine.close();
				return unsaved;
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
	return folder as unknown as Folder<TTables>;
}
