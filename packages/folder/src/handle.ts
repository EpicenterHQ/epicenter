/**
 * The caller-facing `Folder` over an engine, the same on every host: its one
 * edit owner, local save status, the saves and actions `close` waits for,
 * and the error a released handle throws. The browser's default local folder
 * (`local-folder.ts`) and the native directory folder (`native/engine.ts`)
 * each supply the engine.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import {
	ActionError,
	CLOSING,
	createEditOwner,
	type Pending,
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
import { ownFields } from './shared/content/canonical.js';
import { SaveError } from './shared/errors.js';

/**
 * What a save left at its path: the exact content storage kept, merged
 * with what landed meanwhile, or `null` for no file. A save that changed
 * nothing answers what was already there.
 */
export type Stored = { readonly stored: FileContent | null };

/** An engine's files: the public operations, with what each write stored. */
export type EngineFiles = Omit<FolderFileOperations, 'write'> & {
	write(
		path: string,
		from: FileContent | null,
		content: FileContent,
		/** Named assignments reapplied inside each guarded write attempt. */
		fields?: Record<string, unknown>,
		frontmatter?: 'required' | 'optional',
	): Promise<Result<Stored, SaveError>>;
};

/** An engine's table: the public operations, with what each set stored. */
export type EngineTable<TSchema extends Schema = Schema> = Omit<
	FolderTableOperations<TSchema>,
	'set'
> & {
	set(
		id: string,
		from: Pick<Row, 'text' | 'issues'> | null,
		change: RowChange,
	): Promise<Result<{ sent: Row<TSchema> } & Stored, SaveError>>;
};

/** What an engine gives the handle: its files, tables, changes, and release. */
export type FolderEngine = {
	readonly files: EngineFiles;
	readonly tables: Record<string, EngineTable>;
	/** Hear every committed change, calling the listener before the save resolves. */
	subscribe(listener: (change: FolderChange) => void): () => void;
	/** Release listeners and storage; the handle calls it once, after started saves settled. */
	close(): void;
};

/** A copy of caller bytes the caller cannot change afterwards. */
const owned = <T extends FileContent | null>(content: T): T =>
	(content instanceof Uint8Array ? content.slice() : content) as T;

/** A row source the caller cannot change afterwards. */
const ownRow = (from: Pick<Row, 'text' | 'issues'> | null) =>
	from === null
		? null
		: {
				text: from.text,
				issues:
					from.issues === null
						? null
						: from.issues.map((issue) => ({ ...issue, path: [...issue.path] })),
			};

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

/**
 * One save running: whether the engine reported its change, and the edit
 * owner's tick for what it stored, its commit's once reported.
 */
type Submission = { heard: boolean; tick: number };

const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

/** The handle over `engine`, typed by `tables`, saving held input as `options` say. */
export function folderHandle<const TTables extends Record<string, Schema>>(
	engine: FolderEngine,
	tables: TTables,
	{ saveAfterMs }: EditOptions = {},
): Folder<TTables> {
	let closing: Promise<Pending[]> | undefined;
	/** Set by close once nothing it waits for remains, before the engine is released. */
	let released = false;
	/** Saves and complete admitted actions share one lifetime registry. */
	const inflight = new Set<Promise<unknown>>();
	let saves = 0;
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
	/**
	 * The saves of one path run one at a time: the last save queued for each
	 * path, which the next one waits for, and the one running now, which an
	 * own change notice of that path reports.
	 */
	const queued = new Map<string, Promise<void>>();
	const running = new Map<string, Submission>();

	/** Listeners and settle refuse from the moment close is called. */
	function assertOpen() {
		if (closing !== undefined) throw new Error('The folder is closed');
	}

	/** Storage refuses once close released the engine. */
	function assertUsable() {
		if (released) throw new Error('The folder is closed');
	}

	/**
	 * `status` changes when a save starts or ends, when held input changes
	 * what it reports, and when close is called. A save that succeeded, a
	 * no-op retry included, clears the last storage failure.
	 */
	function publishStatus() {
		const { unsaved, failures, working } = edits.getAggregate();
		const next: FolderStatus = {
			saving: saves > 0 || working,
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

	/**
	 * Tell the edit owner what changed that no save of this handle stored,
	 * then this handle's listeners. An engine reports a save's change, naming
	 * its path, while that save runs, and only one save of a path runs at a
	 * time, so an own notice of a path saving is exactly that save's, whose
	 * stored content the owner gets from the save itself. Any other change,
	 * such as another handle's save or a sync, which names no path, is not.
	 */
	function hear(change: FolderChange) {
		if (change.paths === null) edits.changed(null);
		else if (change.origin === 'other-handle') edits.changed(change.paths);
		else {
			const elsewhere = change.paths.filter((path) => {
				const submission = running.get(path);
				if (submission === undefined) return true;
				submission.heard = true;
				submission.tick = edits.now();
				return false;
			});
			if (elsewhere.length > 0) edits.changed(elsewhere);
		}
		for (const listener of [...changeListeners])
			callObserver('change listener', listener, change);
	}

	/** Register work before it can notify listeners or begin other work. */
	function track<T>(run: () => Promise<T>): Promise<T> {
		const operation = Promise.withResolvers<T>();
		inflight.add(operation.promise);
		const done = () => inflight.delete(operation.promise);
		operation.promise.then(done, done);
		// `run` can notify a status observer synchronously. That observer may
		// close the folder, so close must already see this save.
		try {
			Promise.resolve(run()).then(operation.resolve, operation.reject);
		} catch (cause) {
			operation.reject(cause);
		}
		return operation.promise;
	}

	/** An admitted action, or any caller while close drains, can start saves after an await. */
	async function drainWork() {
		while (inflight.size > 0) await Promise.allSettled([...inflight]);
	}

	/**
	 * Run a save of `path`, counted in status from the call, after the saves
	 * of `path` called before it. Once it landed, the edit owner holds what
	 * `kept` says it left stored, `undefined` when that is unknown, as of its
	 * commit, before the save resolves. A save that landed without the engine reporting a
	 * change, because its content was already stored, is reported here, so
	 * readers reread.
	 */
	function save<T>(
		path: string,
		work: () => Promise<Result<T, SaveError>>,
		kept: (saved: T) => FileContent | null | undefined,
	) {
		const submission: Submission = { heard: false, tick: 0 };
		const before = queued.get(path);
		const turn = Promise.withResolvers<void>();
		queued.set(path, turn.promise);
		/** Let the next save of `path` run. */
		const release = () => {
			running.delete(path);
			if (queued.get(path) === turn.promise) queued.delete(path);
			turn.resolve();
			saves--;
		};
		return track(async () => {
			saves++;
			publishStatus();
			let result: Result<T, SaveError>;
			try {
				// With none queued, the engine takes its input at the call.
				if (before !== undefined) await before;
				running.set(path, submission);
				// A save the engine reports as no change stored nothing newer
				// than what was there when it started.
				submission.tick = edits.now();
				result = await work();
				if (result.error === null) {
					edits.stored(path, kept(result.data), submission.tick);
					if (!submission.heard) hear({ paths: [path], origin: 'this-handle' });
				}
			} catch (cause) {
				release();
				publishStatus();
				throw cause;
			}
			release();
			if (result.error === null) storageFailure = null;
			else if (result.error.name === 'StorageFailed')
				storageFailure = result.error;
			publishStatus();
			return result;
		});
	}

	// Saves are tracked and counted in status, so close waits for every save
	// started before it releases the engine. The public members below refuse
	// only after that release.
	// A save queued behind another of its path keeps the bytes as they were
	// at the call.
	/** What a delete left: no file once it went, unknown here when it kept a file changed meanwhile. */
	const deletedKept = ({ deleted }: { deleted: boolean }) =>
		deleted ? null : undefined;
	const written = ({ stored }: Stored) => stored;
	const files: FolderFileOperations = {
		list: (prefix) => engine.files.list(prefix),
		read: (path) => engine.files.read(path),
		async write(path, from, content) {
			const [base, change] = [owned(from), owned(content)];
			const saved = await save(
				path,
				() => engine.files.write(path, base, change),
				written,
			);
			return saved.error === null ? Ok(undefined) : saved;
		},
		delete(path, from) {
			const base = owned(from);
			return save(path, () => engine.files.delete(path, base), deletedKept);
		},
	};
	const tableOperations = Object.fromEntries(
		Object.keys(tables).map((name) => {
			const table = engine.tables[name] as EngineTable;
			const rowPath = (id: string) => `${name}/${id}.md`;
			/** A set answers the row it submitted, not what storage kept. */
			const submitted = async (
				saving: Promise<Result<{ sent: Row } & Stored, SaveError>>,
			) => {
				const saved = await saving;
				return saved.error === null ? Ok({ sent: saved.data.sent }) : saved;
			};
			const operations: FolderTableOperations = {
				list: () => table.list(),
				get: (id) => table.get(id),
				// With none queued the engine takes its input at the call; a save
				// queued behind another of its path keeps a copy taken then.
				set(id, from, change) {
					const path = rowPath(id);
					const edit = ownChange(change);
					if (edit.error !== null) return Promise.resolve(edit);
					if (!queued.has(path))
						return submitted(
							save(path, () => table.set(id, from, edit.data), written),
						);
					const base = ownRow(from);
					return submitted(
						save(path, () => table.set(id, base, edit.data), written),
					);
				},
				delete(id, from) {
					const path = rowPath(id);
					const base = queued.has(path) ? ownRow(from) : from;
					return save(path, () => table.delete(id, base), deletedKept);
				},
			};
			return [name, operations];
		}),
	);
	const edits = createEditOwner({
		files,
		async writeDocument(path, prepare) {
			const saved = await save(
				path,
				async () => {
					const submission = await prepare();
					if (submission.error !== null) return submission;
					const { from, text, fields, frontmatter } = submission.data;
					const written = await engine.files.write(
						path,
						from,
						text,
						fields,
						frontmatter,
					);
					return written.error !== null
						? written
						: Ok({
								...written.data,
								prepared: { base: from, sent: text },
							});
				},
				written,
			);
			return saved.error !== null
				? { error: saved.error }
				: { error: null, prepared: saved.data.prepared };
		},
		saveAfterMs,
		onAggregate: publishStatus,
		track,
		drainWork,
		waitForPaths: (paths) =>
			Promise.allSettled(paths.map((path) => queued.get(path))),
	});
	const stopEngine = engine.subscribe(hear);

	/** Every member of `operations`, refused once close released the engine. */
	function usable<T extends Record<string, (...args: never[]) => unknown>>(
		operations: T,
	): T {
		return Object.fromEntries(
			Object.entries(operations).map(([name, operation]) => [
				name,
				(...args: never[]) => {
					assertUsable();
					return operation(...args);
				},
			]),
		) as T;
	}

	/**
	 * Reads keep the edit owner's documents current: a row list or get
	 * answers the documents of its rows, and a file read the document of a
	 * path seeds text source. Each carries the tick it started at, so a read
	 * that a save or a reported change overtook changes nothing there.
	 */
	const readFiles: FolderFileOperations = {
		...files,
		async read(path) {
			const tick = edits.startRead();
			try {
				const result = await files.read(path);
				if (result.error === null)
					try {
						edits.readFile(
							path,
							tick,
							result.data === undefined
								? null
								: new Uint8Array(await result.data.content.arrayBuffer()),
						);
					} catch {
						// The caller reads the same content and meets the failure itself.
					}
				return result;
			} finally {
				edits.endRead();
			}
		},
	};
	function readRows(name: string, table: FolderTableOperations) {
		return {
			...table,
			async list() {
				const tick = edits.startRead();
				try {
					const result = await table.list();
					if (result.error === null) edits.listed(name, tick, result.data);
					return result;
				} finally {
					edits.endRead();
				}
			},
			async get(id) {
				const tick = edits.startRead();
				try {
					const result = await table.get(id);
					if (result.error === null) edits.got(name, id, tick, result.data);
					return result;
				} finally {
					edits.endRead();
				}
			},
		} satisfies FolderTableOperations;
	}

	const readTables = Object.fromEntries(
		Object.entries(tableOperations).map(([name, table]) => [
			name,
			readRows(name, table),
		]),
	);

	const folder: Folder<Record<string, Schema>> = {
		files: {
			...usable(readFiles),
			edit: (path, schema) => edits.edit(path, schema),
		},
		tables: Object.fromEntries(
			Object.entries(readTables).map(([name, table]) => [
				name,
				{
					...usable(table),
					edit: (id: string) =>
						edits.edit(`${name}/${id}.md`, tables[name], true),
				},
			]),
		),
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
		run(paths, action) {
			if (closing !== undefined)
				return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
			return edits.run(paths, action);
		},
		async settle() {
			assertOpen();
			// Saves already started, the folder's own and direct ones alike;
			// reads are not waited for.
			const unsaved = await edits.settle();
			await drainWork();
			return unsaved;
		},
		close() {
			if (closing !== undefined) return closing;
			// Assigned before the fence publishes, so a listener it calls is
			// refused and a close it calls answers this same promise.
			const completion = Promise.withResolvers<Pending[]>();
			closing = completion.promise;
			(async () => {
				// New input, actions and listeners already refuse; storage stays
				// usable for what close waits for.
				const sending = edits.close();
				publishStatus();
				await sending;
				// Release in the same turn the registry is found empty: a write
				// or an edit's save any earlier continuation started is waited
				// for, and one called after this turn finds storage released and
				// throws, or, for `save()`, does nothing. What is still held then
				// is the answer. Status is told after, so a listener cannot start
				// one in between.
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
