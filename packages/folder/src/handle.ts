/**
 * The caller-facing `Folder` over an engine, the same on every host: its one
 * edit owner, local save status, the saves `close` waits for, and the error
 * a closed handle throws. The browser's default local folder
 * (`local-folder.ts`) and the native directory folder (`native/engine.ts`)
 * each supply the engine.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { createEditOwner, type Pending } from './edit-owner.js';
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

/** What an engine gives the handle: its files, tables, changes, and release. */
export type FolderEngine = {
	readonly files: FolderFileOperations;
	readonly tables: Record<string, FolderTableOperations>;
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

/** One save, and the commit its change notice was, once heard. */
type Submission = { commit: number | undefined };

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
	/** Saves started and not settled, which close waits for. Reads are not. */
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
	 * own change notice of that path is the commit of.
	 */
	const queued = new Map<string, Promise<void>>();
	const running = new Map<string, Submission>();
	/** The submission of each save promise, so the edit owner can ask what it landed as. */
	const receipts = new WeakMap<Promise<unknown>, Submission>();

	function assertOpen() {
		if (closing !== undefined) throw new Error('The folder is closed');
	}

	/**
	 * `status` changes when a save starts or ends, when held input changes
	 * what it reports, and when close is called. A save that succeeded, a
	 * no-op retry included, clears the last storage failure.
	 */
	function publishStatus() {
		const { unsaved, failures, working } = edits.aggregate;
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
	 * Tell this handle's listeners. An own change is a commit: reads starting
	 * from now show it. An engine reports a save's commit, naming its path,
	 * while that save runs, and only one save of a path runs at a time, so the
	 * notice is the commit of exactly that save. A change naming no path, such
	 * as a sync, is no save's.
	 */
	function hear(change: FolderChange) {
		if (change.origin === 'this-handle') {
			const commit = edits.committed();
			for (const path of change.paths ?? []) {
				const submission = running.get(path);
				if (submission !== undefined && submission.commit === undefined)
					submission.commit = commit;
			}
		}
		for (const listener of [...changeListeners])
			callObserver('change listener', listener, change);
	}

	/** Track the save so `close` can wait for it. */
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

	/**
	 * Run a save of `path`, counted in status from the call, after the saves
	 * of `path` called before it. A save that landed without the engine
	 * reporting a change, because its content was already stored, is
	 * reported here, so readers reread and own saves count as seen.
	 */
	function save<T>(path: string, work: () => Promise<Result<T, SaveError>>) {
		const submission: Submission = { commit: undefined };
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
		const saving = track(async () => {
			saves++;
			publishStatus();
			let result: Result<T, SaveError>;
			try {
				// With none queued, the engine takes its input at the call.
				if (before !== undefined) await before;
				running.set(path, submission);
				result = await work();
				if (result.error === null && submission.commit === undefined)
					hear({ paths: [path], origin: 'this-handle' });
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
		receipts.set(saving, submission);
		return saving;
	}

	// Saves are tracked and counted in status. The edit owner gets these
	// directly, so input accepted before close can still be sent while close
	// waits; the public members below refuse once close is called.
	// A save queued behind another of its path keeps the bytes as they were
	// at the call.
	const files: FolderFileOperations = {
		list: (prefix) => engine.files.list(prefix),
		read: (path) => engine.files.read(path),
		write(path, from, content) {
			const [base, change] = [owned(from), owned(content)];
			return save(path, () => engine.files.write(path, base, change));
		},
		delete(path, from) {
			const base = owned(from);
			return save(path, () => engine.files.delete(path, base));
		},
	};
	const tableOperations = Object.fromEntries(
		Object.keys(tables).map((name) => {
			const table = engine.tables[name] as FolderTableOperations;
			const rowPath = (id: string) => `${name}/${id}.md`;
			const operations: FolderTableOperations = {
				list: () => table.list(),
				get: (id) => table.get(id),
				// With none queued the engine takes its input at the call; a save
				// queued behind another of its path keeps a copy taken then.
				set(id, from, change) {
					const path = rowPath(id);
					if (!queued.has(path))
						return save(path, () => table.set(id, from, change));
					const edit = ownChange(change);
					if (edit.error !== null) return Promise.resolve(edit);
					const base = ownRow(from);
					return save(path, () => table.set(id, base, edit.data));
				},
				delete(id, from) {
					const path = rowPath(id);
					const base = queued.has(path) ? ownRow(from) : from;
					return save(path, () => table.delete(id, base));
				},
			};
			return [name, operations];
		}),
	);
	const edits = createEditOwner({
		files,
		tables: tableOperations,
		schemas: tables,
		saveAfterMs,
		onAggregate: publishStatus,
		receipt: (saving) => receipts.get(saving)?.commit,
	});
	const stopEngine = engine.subscribe(hear);

	/** Every member of `operations`, refused once close is called. */
	function opened<T extends Record<string, (...args: never[]) => unknown>>(
		operations: T,
	): T {
		return Object.fromEntries(
			Object.entries(operations).map(([name, operation]) => [
				name,
				(...args: never[]) => {
					assertOpen();
					return operation(...args);
				},
			]),
		) as T;
	}

	/**
	 * Reads note, on each row and file content they answer, the commit count
	 * when they started, so a view can tell which of this handle's saves the
	 * content it shows may lack (`shared/observation.ts`).
	 */
	const readFiles: FolderFileOperations = {
		...files,
		async read(path) {
			const read = edits.commits;
			const result = await files.read(path);
			if (result.error === null && result.data !== undefined)
				edits.noteRead(result.data.content, read);
			return result;
		},
	};
	function readRows(table: FolderTableOperations) {
		return {
			...table,
			async list() {
				const read = edits.commits;
				const result = await table.list();
				if (result.error === null)
					for (const row of result.data) edits.noteRead(row, read);
				return result;
			},
			async get(id) {
				const read = edits.commits;
				const result = await table.get(id);
				if (result.error === null && result.data !== undefined)
					edits.noteRead(result.data, read);
				return result;
			},
		} satisfies FolderTableOperations;
	}

	const folder: Folder<Record<string, Schema>> = {
		files: {
			...opened(readFiles),
			edit: (path) => edits.text(path),
		},
		tables: Object.fromEntries(
			Object.entries(tableOperations).map(([name, table]) => [
				name,
				{
					...opened(readRows(table)),
					edit: (id: string) => edits.row(name, id),
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
		async settle() {
			assertOpen();
			// Saves already started, the folder's own and direct ones alike;
			// reads are not waited for.
			const unsaved = await edits.settle();
			await Promise.allSettled([...inflight]);
			return unsaved;
		},
		close() {
			if (closing !== undefined) return closing;
			// Assigned before the fence publishes, so a listener it calls is
			// refused and a close it calls answers this same promise.
			const completion = Promise.withResolvers<Pending[]>();
			closing = completion.promise;
			(async () => {
				// The owner sends held input through its own operations; every
				// public call already throws.
				const unsaving = edits.close();
				publishStatus();
				const unsaved = await unsaving;
				await Promise.allSettled([...inflight]);
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
