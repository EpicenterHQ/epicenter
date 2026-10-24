/** Folder-owned editable text and one I/O slot for each addressed path. */
import { type Static, type TSchema, Type } from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStatus } from './folder.js';
import { callObserver } from './observer.js';
import { ownFields, parseRowSource } from './shared/content/canonical.js';
import { type ReadError, SaveError } from './shared/errors.js';
import { changeMarkdown } from './shared/markdown-codec.js';
import type { FileContent } from './shared/merge.js';

export const SAVE_AFTER_MS = 1000;
export const CLOSING = 'The folder is closing, so nothing was changed.';

export const ActionError = defineErrors({
	Closing: () => ({ message: CLOSING }),
});
export type ActionError = InferErrors<typeof ActionError>;

export const LoadError = defineErrors({
	Missing: ({ path }: { path: string }) => ({
		message: `${path} does not exist.`,
		path,
	}),
	NotText: ({ path }: { path: string }) => ({
		message: `${path} is not text, so it cannot be edited here. Its bytes stay as they are.`,
		path,
	}),
	ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `${path} could not be read: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
});
export type LoadError = InferErrors<typeof LoadError>;

export const ChangeError = defineErrors({
	Closing: () => ({ message: CLOSING }),
	NoContent: () => ({
		message:
			'There is no text yet. It may still be loading, or it could not be read.',
	}),
	InvalidText: ({ reason }: { reason: string }) => ({
		message: `The text cannot be saved: ${reason}`,
		reason,
	}),
	MalformedFrontmatter: ({
		reason,
		line,
	}: {
		reason: string;
		line?: number;
	}) => ({
		message: `The frontmatter must be repaired before this document can be patched: ${reason}`,
		reason,
		line,
	}),
	InvalidFields: ({ reason }: { reason: string }) => ({
		message: `Fields cannot be applied: ${reason}`,
		reason,
	}),
});
export type ChangeError = InferErrors<typeof ChangeError>;
export type ChangeResult = Result<void, ChangeError>;

const anyFields = Type.Record(Type.String(), Type.Unknown());
export type AnyFieldsSchema = typeof anyFields;

export type DocumentPatch<TRowSchema extends TSchema = AnyFieldsSchema> = {
	fields?: Partial<Static<TRowSchema>>;
	body?: string;
};

/** A cached observation of the one editable text, independent of schema. */
export type DocumentSnapshot = {
	/** Current accepted text, or the newest admitted write while no draft exists. */
	readonly text: string | undefined;
	readonly loadError: LoadError | undefined;
	/** A draft awaits a successful publication. */
	readonly isDirty: boolean;
	/** Any admitted write or delete of this path has not settled. */
	readonly isSaving: boolean;
	/** Latest failure for this edit run, hidden while its exact draft retries. */
	readonly saveError: SaveError | undefined;
};

export type SaveFailure = { readonly path: string; readonly error: SaveError };

/** One path's shared, folder-lifetime editable text. */
export type TextDocument<TRowSchema extends TSchema = AnyFieldsSchema> = {
	readonly path: string;
	/** Read the current cached state without starting I/O. */
	getSnapshot(): DocumentSnapshot;
	/** Hear the current state immediately and later changes; first demand starts a read. */
	subscribe(listener: (snapshot: DocumentSnapshot) => void): () => void;
	/** Accept complete source synchronously; autosave follows changed input. */
	replace(text: string): ChangeResult;
	/** Compose a structured change over the current text, independent of schema validation. */
	patch(patch: DocumentPatch<TRowSchema>): ChangeResult;
	/** Publish the text captured at this call. Each explicit call gets its own result. */
	save(): Promise<Result<void, ChangeError | SaveError>>;
	/** Read after earlier work on this path, preserving accepted local edits. */
	refresh(): Promise<Result<void, LoadError>>;
	/** Drop only local text not admitted as a write; write nothing. */
	discard(): string | undefined;
};

export function saveDelay(saveAfterMs: number = SAVE_AFTER_MS): number {
	if (
		typeof saveAfterMs !== 'number' ||
		!Number.isFinite(saveAfterMs) ||
		saveAfterMs < 0
	)
		throw new RangeError(
			`saveAfterMs must be a finite number of milliseconds from 0 up, not ${String(saveAfterMs)}`,
		);
	return saveAfterMs;
}

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function textProblem(text: string) {
	if (!text.isWellFormed()) return 'it contains a lone surrogate';
	if (text.includes('\0')) return 'it contains a NUL character';
	return undefined;
}

function observed(
	path: string,
	content: FileContent | null,
): Result<string, LoadError> {
	if (content === null) return LoadError.Missing({ path });
	if (typeof content === 'string')
		return textProblem(content) === undefined
			? Ok(content)
			: LoadError.NotText({ path });
	try {
		const text = strict.decode(content);
		return textProblem(text) === undefined
			? Ok(text)
			: LoadError.NotText({ path });
	} catch {
		return LoadError.NotText({ path });
	}
}

/** A path hint without trailing slashes; `''` names the whole folder. */
const normalizeHint = (hint: string) => hint.replace(/\/+$/, '');
const covers = (hint: string, path: string) =>
	hint === '' || path === hint || path.startsWith(`${hint}/`);
const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

type PendingWrite = {
	observation: Result<string, LoadError>;
	captured: Draft | undefined;
};
type DraftRun = { failure: SaveFailure | undefined };
type Draft = { text: string; run: DraftRun };
type DocumentState = {
	path: string;
	base: string | undefined;
	draft: Draft | undefined;
	loadError: LoadError | undefined;
	snapshot: DocumentSnapshot;
	handle: TextDocument | undefined;
	listeners: Set<(snapshot: DocumentSnapshot) => void>;
	timer: ReturnType<typeof setTimeout> | undefined;
	autoRequested: boolean;
	needsRead: boolean;
	/** A read still waiting at the end of this path's I/O slot. */
	waitingRead: Promise<Result<void, LoadError>> | undefined;
	tail: Promise<void>;
	pending: number;
	writes: PendingWrite[];
};

export function createDocumentOwner({
	read,
	write,
	saveAfterMs,
	announce,
}: {
	read: (
		path: string,
	) => Promise<Result<{ content: Blob } | undefined, ReadError>>;
	write: (
		path: string,
		content: FileContent,
	) => Promise<Result<void, SaveError>>;
	saveAfterMs?: number;
	announce: (path: string) => void;
}) {
	const pause = saveDelay(saveAfterMs);
	const documents = new Map<string, DocumentState>();
	let closed = false;
	let storageFailure: FolderStatus['storageFailure'] = null;
	let status: FolderStatus = {
		saving: false,
		savingPaths: [],
		storageFailure: null,
		unsaved: [],
		failures: [],
		closing: false,
	};
	const statusListeners = new Set<(status: FolderStatus) => void>();

	function visible(state: DocumentState): string | undefined {
		if (state.draft !== undefined) return state.draft.text;
		const last = state.writes.at(-1);
		return last === undefined
			? state.base
			: (last.observation.data ?? undefined);
	}

	function visibleFailure(state: DocumentState): SaveFailure | undefined {
		const draft = state.draft;
		if (draft === undefined) return undefined;
		if (state.writes.some((write) => write.captured === draft))
			return undefined;
		return draft.run.failure;
	}

	function updateStatus() {
		const values = [...documents.values()];
		const unsaved = values
			.filter((state) => state.draft !== undefined)
			.map((state) => state.path)
			.sort();
		const savingPaths = values
			.filter((state) => state.writes.length > 0)
			.map((state) => state.path)
			.sort();
		const failures = values
			.flatMap((state) => {
				const failure = visibleFailure(state);
				return failure === undefined ? [] : [failure];
			})
			.sort((a, b) => a.path.localeCompare(b.path));
		if (
			sameList(unsaved, status.unsaved) &&
			sameList(savingPaths, status.savingPaths) &&
			sameList(failures, status.failures) &&
			storageFailure === status.storageFailure &&
			closed === status.closing
		)
			return;
		status = {
			saving: savingPaths.length > 0,
			savingPaths,
			storageFailure,
			unsaved,
			failures,
			closing: closed,
		};
		const next = status;
		for (const listener of [...statusListeners]) {
			if (status !== next) break;
			if (statusListeners.has(listener))
				callObserver('status listener', listener, next);
		}
	}

	function notify(state: DocumentState) {
		const previous = state.snapshot;
		const text = visible(state);
		const isSaving = state.writes.length > 0;
		const loadError = state.loadError;
		const saveError = visibleFailure(state)?.error;
		if (
			previous.text !== text ||
			previous.loadError !== loadError ||
			previous.isDirty !== (state.draft !== undefined) ||
			previous.isSaving !== isSaving ||
			previous.saveError !== saveError
		) {
			const next: DocumentSnapshot = Object.freeze({
				text,
				loadError,
				isDirty: state.draft !== undefined,
				isSaving,
				saveError,
			});
			state.snapshot = next;
			for (const listener of [...state.listeners]) {
				if (state.snapshot !== next) break;
				if (state.listeners.has(listener))
					callObserver('document listener', listener, next);
			}
		}
		updateStatus();
	}

	function clearTimer(state: DocumentState) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}

	function schedule(state: DocumentState) {
		clearTimer(state);
		state.autoRequested = false;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			state.autoRequested = true;
			maybeAutosave(state);
		}, pause);
	}

	function enqueue<T>(
		state: DocumentState,
		work: () => Promise<T>,
	): Promise<T> {
		// A later read must follow this work rather than join an earlier read.
		state.waitingRead = undefined;
		const prior = state.tail;
		state.pending++;
		const task = (async () => {
			await prior;
			try {
				return await work();
			} finally {
				state.pending--;
				maybeAutosave(state);
				if (
					state.pending === 0 &&
					state.handle === undefined &&
					documents.get(state.path) === state
				)
					documents.delete(state.path);
			}
		})();
		state.tail = task.then(
			() => {},
			() => {},
		);
		return task;
	}

	function submit(
		state: DocumentState,
		content: FileContent | null,
		work: () => Promise<Result<void, SaveError>>,
		isDocumentSave: boolean,
	) {
		const publication: PendingWrite = {
			observation: observed(state.path, content),
			captured: state.draft,
		};
		state.writes.push(publication);
		clearTimer(state);
		state.autoRequested = false;
		const result = enqueue(state, async () => {
			let saved: Result<void, SaveError>;
			try {
				saved = await work();
			} catch (cause) {
				saved = SaveError.StorageFailed({ cause });
			}
			state.writes.splice(state.writes.indexOf(publication), 1);
			if (saved.error === null) {
				storageFailure = null;
				const observation = publication.observation;
				state.base = observation.error === null ? observation.data : undefined;
				state.loadError = observation.error ?? undefined;
				if (state.draft === publication.captured) state.draft = undefined;
				if (publication.captured !== undefined)
					publication.captured.run.failure = undefined;
			} else {
				if (saved.error.name === 'StorageFailed') storageFailure = saved.error;
				if (isDocumentSave && publication.captured !== undefined)
					publication.captured.run.failure = Object.freeze({
						path: state.path,
						error: saved.error,
					});
				if (
					!isDocumentSave &&
					publication.captured !== undefined &&
					state.draft === publication.captured
				)
					schedule(state);
			}
			notify(state);
			if (saved.error === null) announce(state.path);
			return saved;
		});
		notify(state);
		return result;
	}

	function maybeAutosave(state: DocumentState) {
		if (
			closed ||
			!state.autoRequested ||
			state.pending > 0 ||
			state.draft === undefined
		)
			return;
		state.autoRequested = false;
		const text = state.draft.text;
		void submit(state, text, () => write(state.path, text), true);
	}

	const closedRead = (state: DocumentState) =>
		LoadError.ReadFailed({
			path: state.path,
			cause: new Error('The folder is closed'),
		});

	function requestRead(state: DocumentState): Promise<Result<void, LoadError>> {
		if (state.waitingRead !== undefined) return state.waitingRead;
		const result = enqueue(
			state,
			async (): Promise<Result<void, LoadError>> => {
				// Another read may already wait behind a later write.
				if (state.waitingRead === result) state.waitingRead = undefined;
				if (closed) return closedRead(state);
				state.needsRead = false;
				let observation: Result<string, LoadError>;
				try {
					const found = await read(state.path);
					if (found.error !== null)
						observation = LoadError.ReadFailed({
							path: state.path,
							cause: found.error,
						});
					else if (found.data === undefined)
						observation = LoadError.Missing({ path: state.path });
					else
						observation = observed(
							state.path,
							new Uint8Array(await found.data.content.arrayBuffer()),
						);
				} catch (cause) {
					observation = LoadError.ReadFailed({ path: state.path, cause });
				}
				if (closed) return closedRead(state);
				if (observation.error === null) state.base = observation.data;
				state.loadError = observation.error ?? undefined;
				notify(state);
				return observation.error === null
					? Ok(undefined)
					: Err(observation.error);
			},
		);
		state.waitingRead = result;
		return result;
	}

	function demandRead(state: DocumentState) {
		if (!closed && state.needsRead) void requestRead(state);
	}

	function replace(state: DocumentState, text: string): ChangeResult {
		if (closed) return ChangeError.Closing();
		if (typeof text !== 'string')
			return ChangeError.InvalidText({ reason: 'it is not a string' });
		const problem = textProblem(text);
		if (problem !== undefined)
			return ChangeError.InvalidText({ reason: problem });
		if (
			text === visible(state) &&
			(state.draft !== undefined || state.writes.length === 0)
		)
			return Ok(undefined);
		state.draft = {
			text,
			run: state.draft?.run ?? { failure: undefined },
		};
		schedule(state);
		notify(state);
		return Ok(undefined);
	}

	function patch(state: DocumentState, value: DocumentPatch): ChangeResult {
		if (closed) return ChangeError.Closing();
		const fields =
			value.fields === undefined ? Ok(undefined) : ownFields(value.fields);
		if (fields.error !== null)
			return ChangeError.InvalidFields({ reason: fields.error.reason });
		const text = visible(state);
		if (text === undefined) return ChangeError.NoContent();
		if (value.body !== undefined) {
			if (typeof value.body !== 'string')
				return ChangeError.InvalidText({ reason: 'it is not a string' });
			const problem = textProblem(value.body);
			if (problem !== undefined)
				return ChangeError.InvalidText({ reason: problem });
		}
		const changed = changeMarkdown(
			{ text, issues: null },
			{ fields: fields.data, body: value.body },
		);
		if (changed.error !== null) {
			const parsed = parseRowSource(text);
			return parsed.error !== null
				? ChangeError.MalformedFrontmatter({
						reason: parsed.error.reason,
						line: parsed.error.line,
					})
				: ChangeError.InvalidFields({ reason: changed.error.reason });
		}
		return replace(state, changed.data.text);
	}

	function stateOf(path: string): DocumentState {
		let state = documents.get(path);
		if (state === undefined) {
			state = {
				path,
				base: undefined,
				draft: undefined,
				loadError: undefined,
				snapshot: Object.freeze({
					text: undefined,
					loadError: undefined,
					isDirty: false,
					isSaving: false,
					saveError: undefined,
				}),
				handle: undefined,
				listeners: new Set(),
				timer: undefined,
				autoRequested: false,
				needsRead: true,
				waitingRead: undefined,
				tail: Promise.resolve(),
				pending: 0,
				writes: [],
			};
			documents.set(path, state);
		}
		return state;
	}

	function document<TRowSchema extends TSchema = AnyFieldsSchema>(
		path: string,
	): TextDocument<TRowSchema> {
		const state = stateOf(path);
		if (state.handle === undefined) {
			state.handle = Object.freeze({
				path,
				getSnapshot: () => state.snapshot,
				subscribe(listener: (snapshot: DocumentSnapshot) => void) {
					if (closed) {
						callObserver('document listener', listener, state.snapshot);
						return () => {};
					}
					state.listeners.add(listener);
					callObserver('document listener', listener, state.snapshot);
					if (state.listeners.has(listener)) demandRead(state);
					return () => {
						state.listeners.delete(listener);
					};
				},
				replace: (text: string) => replace(state, text),
				patch: (value: DocumentPatch) => patch(state, value),
				save: () => {
					if (closed) return Promise.resolve(ChangeError.Closing());
					const text = visible(state);
					if (text === undefined)
						return Promise.resolve(ChangeError.NoContent());
					if (state.draft === undefined)
						state.draft = { text, run: { failure: undefined } };
					return submit(state, text, () => write(path, text), true);
				},
				refresh: () =>
					closed ? Promise.resolve(closedRead(state)) : requestRead(state),
				discard: () => {
					if (closed) return undefined;
					clearTimer(state);
					state.autoRequested = false;
					const dropped = state.draft?.text;
					state.draft = undefined;
					notify(state);
					return dropped;
				},
			} satisfies TextDocument);
		}
		return state.handle as TextDocument<TRowSchema>;
	}

	function markChanged(paths: readonly string[] | null) {
		for (const state of documents.values()) {
			if (
				paths !== null &&
				!paths.some((raw) => covers(normalizeHint(raw), state.path))
			)
				continue;
			state.needsRead = true;
			if (state.listeners.size > 0) demandRead(state);
		}
	}

	return {
		document,
		async refreshKnown(paths?: readonly string[]) {
			if (closed) return;
			const reads: Promise<Result<void, LoadError>>[] = [];
			for (const state of documents.values()) {
				if (
					paths !== undefined &&
					!paths.some((raw) => covers(normalizeHint(raw), state.path))
				)
					continue;
				state.needsRead = true;
				if (state.listeners.size > 0) reads.push(requestRead(state));
			}
			await Promise.all(reads);
		},
		write(path: string, content: FileContent) {
			return submit(stateOf(path), content, () => write(path, content), false);
		},
		remove(path: string, work: () => Promise<Result<void, SaveError>>) {
			return submit(stateOf(path), null, work, false);
		},
		changed: markChanged,
		flush() {
			for (const state of documents.values()) {
				if (state.draft === undefined) continue;
				clearTimer(state);
				state.autoRequested = true;
				maybeAutosave(state);
			}
		},
		close() {
			if (closed) return;
			closed = true;
			for (const state of documents.values()) {
				clearTimer(state);
				state.autoRequested = false;
				state.listeners.clear();
			}
			updateStatus();
			statusListeners.clear();
		},
		getStatus: () => status,
		onStatusChange(listener: (status: FolderStatus) => void) {
			if (closed) throw new Error('The folder is closed');
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
	};
}
