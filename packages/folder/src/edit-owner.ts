/**
 * One owner per opened Folder, holding each path's source, input, save queue
 * and fence. File and table accessors expose the same FileEdit contract;
 * schemas interpret source without owning input.
 *
 * Text and structured commands change one source draft immediately. The
 * draft retains its exact observed source across reads and outside writes.
 * A save compares that source at the guarded storage attempt, and newer
 * typing survives the submitted revision landing or failing.
 *
 * Ordered reads cannot replace knowledge of a later save. Public text reads
 * seed source without another read, while unheld binary reads retain no
 * bytes. Readers share immutable snapshots by path and interpretation;
 * document fields always describe the source getText() actually answers.
 *
 * Fenced actions save input before running. Close refuses new input at once,
 * waits for saves and actions, and attempts remaining input once; `save()`
 * may attempt it again until the handle releases storage, which alone ends
 * the owner's life. Getters keep answering held input after close, for
 * recovery.
 */
import { diffArrays } from 'diff';
import { type Static, type TSchema, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderFileOperations } from './folder.js';
import { callObserver } from './observer.js';
import { readablePath } from './paths.js';
import {
	ownFields,
	sameValue as sharedValue,
} from './shared/content/canonical.js';
import { mergeLinesWith } from './shared/content/merge-lines.js';
import { ReadError, SaveError } from './shared/errors.js';
import { changeMarkdown, readMarkdown } from './shared/markdown-codec.js';
import { type FileContent, mergeWith, sameContent } from './shared/merge.js';
import type { MarkdownValue, Row } from './shared/row.js';

/** How long after its last change input saves, unless the folder was opened with another pause. */
export const SAVE_AFTER_MS = 1000;

/** Why nothing starts while the folder closes. */
export const CLOSING = 'The folder is closing, so nothing was changed.';

/** Why input and other actions wait while a file is deleted. */
export const DELETING = 'This file is being deleted.';

/** Why input and other actions wait while an exclusive change of a file runs. */
export const BUSY = 'Another change to this file is still running.';

/** A fence cannot throw away input that storage refused to save. */
export const UNSAVED =
	'This file has unsaved changes. Try again or discard them first.';

/** How often one `read()` reads again while reported changes overtake it. */
const READ_ATTEMPTS = 8;

/**
 * An action refused before it changed anything, with the reason: the folder
 * is closing, another action holds the file, its input did not save.
 */
export const ActionError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type ActionError = InferErrors<typeof ActionError>;

/** Why new input was refused, before any of it was accepted. */
export const ChangeError = defineErrors({
	Locked: ({ reason }: { reason: string }) => ({ message: reason, reason }),
	NoSource: () => ({
		message: 'There is no file to edit. It may be loading or gone.',
	}),
	NotText: () => ({
		message:
			'This file is not text, so it cannot be edited here. Its bytes stay as they are.',
	}),
	InvalidFields: ({ reason }: { reason: string }) => ({
		message: `Fields cannot be applied: ${reason}`,
		reason,
	}),
});
export type ChangeError = InferErrors<typeof ChangeError>;

/** Accepted into memory, or refused. A later save reports failures through `getBuffer().unsaved`. */
export type ChangeResult = Result<void, ChangeError>;

/** Generic frontmatter, when no read schema is bound to an editor. */
const anyFields = Type.Record(Type.String(), Type.Unknown());
export type AnyFieldsSchema = typeof anyFields;

/** Fields and body contributed together; undefined removes a field. */
export type DocumentChange<TRowSchema extends TSchema = typeof anyFields> = {
	readonly fields?: Readonly<Partial<Static<TRowSchema>>>;
	readonly body?: string;
};

/** The editable source interpreted by this handle's read schema. */
export type MarkdownContent<TRowSchema extends TSchema = typeof anyFields> =
	Readonly<MarkdownValue<TRowSchema>>;

/** Exact unsaved source, independent of the schema used to view it. */
type Pending = {
	readonly path: string;
	readonly text: string;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

/** Why stored content cannot supply an editable buffer. */
export const SourceUnavailable = defineErrors({
	SourceUnavailable: ({ reason }: { reason: 'missing' | 'not-text' }) => ({
		reason,
		message:
			reason === 'missing'
				? 'The saved file no longer exists.'
				: 'The saved file is not text.',
	}),
});
export type SourceUnavailable = InferErrors<typeof SourceUnavailable>;
export type SaveFailure = Exclude<SaveError, { name: 'Conflict' }>;
export type SaveConflict = Extract<SaveError, { name: 'Conflict' }>;
/** Held work, whose text belongs to the enclosing ready buffer. */
export type Unsaved =
	| { status: 'dirty' | 'saving'; error?: never }
	| { status: 'failed'; error: SaveFailure }
	| { status: 'conflict'; error: SaveConflict };
/** A detached, copyable source retained after discard, settle or close. */
export type Recovery = { path: string; text: string } & Unsaved;
export type SaveFailureRecovery = Extract<
	Recovery,
	{ status: 'failed' | 'conflict' }
>;
/** Latest non-save feedback. Read and refusal causes remain separately owned. */
export type BufferIssue =
	| ReadError
	| ChangeError
	| ActionError
	| SourceUnavailable
	| SaveError;
/** Effective source availability; held input always supplies a ready buffer. */
export type BufferSnapshot = { error?: BufferIssue } & (
	| { status: 'unread' | 'loading' }
	| { status: 'unavailable'; error: BufferIssue }
	| { status: 'ready'; text: string; unsaved?: Unsaved }
);
const UNREAD: BufferSnapshot = Object.freeze({ status: 'unread' });
const MISSING = Object.freeze(
	SourceUnavailable.SourceUnavailable({ reason: 'missing' }).error,
);
const NOT_TEXT = Object.freeze(
	SourceUnavailable.SourceUnavailable({ reason: 'not-text' }).error,
);

/** A delete's outcome: whether the file went, or why nothing started. */
export type DeleteResult = Result<
	{ deleted: boolean },
	SaveError | ReadError | ActionError
>;

/** One path's editable source, structured interpretation, input, saves and fence. */
export type FileEdit<TRowSchema extends TSchema = typeof anyFields> = {
	readonly path: string;
	getText(): string | undefined;
	getMarkdown(): MarkdownContent<TRowSchema> | undefined;
	getBuffer(): BufferSnapshot;
	isLocked(): boolean;
	/** Refresh this path. Read the current snapshot through the getters afterwards. */
	read(): Promise<Result<void, ReadError>>;
	subscribe(listener: () => void): () => void;
	/** Accept fields and body together, over the currently known source. */
	change(change: DocumentChange<TRowSchema>): ChangeResult;
	/** Replace the editable source, over the currently displayed draft. */
	replaceText(text: string): ChangeResult;
	/** Attempt held input, including an earlier failure, or join its running attempt. */
	save(): Promise<Result<void, SaveError | ActionError>>;
	/** Resolve the last whole-file conflict against the exact source it reported. */
	resolveConflict(
		choice: 'current' | 'draft' | { text: string },
	): Promise<Result<void, ReadError | SaveError | ActionError>>;
	/** Release held input, returning it for recovery. Refused while a save or action runs. */
	discard(): Result<Recovery | undefined, ActionError>;
	delete(): Promise<DeleteResult>;
};

/** Explicit line merge for callers composing edits from an older render. */
export function mergeText(base: string, current: string, change: string) {
	if (base === current) return change;
	return mergeLinesWith(diffArrays, { base, current, change }).content;
}

/** Explicit file merge for callers that choose content merging themselves. */
export function mergeFileText(
	path: string,
	base: string,
	current: string,
	change: string,
): string {
	return mergeWith(diffArrays, path, { base, current, change })
		.content as string;
}

/**
 * The pause before held input saves: `saveAfterMs`, a finite number of
 * milliseconds from zero up, or `SAVE_AFTER_MS`. Throws a `RangeError`
 * for any other value; openers check it before opening anything.
 */
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

type Input = {
	readonly pending: Pending;
	/** The exact source first edited, or the last submitted source that landed. */
	readonly from: FileContent | null;
	/** Private guard for an explicit resolution; callers can inspect or copy error bytes. */
	readonly conflictCurrent?: FileContent | null;
	readonly revision: number;
};

/** The exact stored content, `null` for no file, `undefined` while unknown. */
type Known = FileContent | null | undefined;

/** A read's outcome, which every read joining it shares. */
type ReadOutcome =
	| { readonly error: ReadError }
	| {
			readonly error: null;
			/** Whether it was newer than everything known of the path. */
			readonly newest: boolean;
	  };

/** An answer computed from what it depends on, kept while they hold. */
type Kept<T> = {
	readonly doc: Known;
	readonly input: Input | undefined;
	readonly value: T;
};

type PathState = {
	/** What is stored at the path, as last known. */
	doc: Known;
	/**
	 * The tick `doc` is known as of: the read that answered it, the save
	 * that stored it, or the reported change that made it unknown. A read
	 * started before it is older and changes nothing.
	 */
	docAt: number;
	/**
	 * The tick of the newest thing known of the path, `docAt` or a change
	 * reported after it that a reread has not answered yet.
	 */
	asOf: number;
	/** The read of the path running now, the tick it started at, and its outcome. */
	reading:
		| { readonly tick: number; readonly done: Promise<ReadOutcome> }
		| undefined;
	/** Why the last read of the path failed, until one succeeds. */
	error: ReadError | undefined;
	/** The tick of the read whose outcome `error` tells; an older read's outcome changes nothing. */
	statusAt: number;
	input: Input | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The save loop, while one runs. */
	running: Promise<Result<void, SaveError>> | undefined;
	/** Asked to save again while a save ran. */
	again: boolean;
	/** The action holding the path, while one runs. */
	action: { readonly reason: string } | undefined;
	readonly listeners: Set<() => void>;
	/** The document read as a row, and as text. */
	decoded:
		| { readonly content: FileContent; readonly text: string | undefined }
		| undefined;
	/** What the source and document getters answered, while their inputs hold. */
	text: Kept<string | undefined> | undefined;
	documents: WeakMap<TSchema, MarkdownContent>;
	buffer: BufferSnapshot | undefined;
	refusal:
		| {
				error: BufferIssue;
				kind: ReturnType<typeof sourceKind>;
				text: string | undefined;
				reason: string | undefined;
				running: PathState['running'];
		  }
		| undefined;
};

/** What the owner tells the handle: input held, failures, and whether work runs. */
export type EditAggregate = {
	readonly unsaved: readonly string[];
	readonly failures: readonly SaveFailureRecovery[];
	readonly working: boolean;
};

const rowPath = (table: string, id: string) => `${table}/${id}.md`;

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** A copy the caller cannot change afterwards. */
const owned = (content: FileContent) =>
	typeof content === 'string' ? content : content.slice();

/** `content` as text: strict UTF-8 without NUL or lone surrogates, or `undefined`. */
function textOf(content: FileContent): string | undefined {
	let text: string;
	if (typeof content === 'string') text = content;
	else
		try {
			text = strict.decode(content);
		} catch {
			return undefined;
		}
	return text.includes('\0') || !text.isWellFormed() ? undefined : text;
}

/** Whether a row's source is not text, as a row list reads one without its bytes. */
const notText = ({ issues }: Pick<Row, 'issues'>) =>
	issues?.some((issue) => issue.kind === 'not-text') ?? false;

function sourceKind(state: PathState) {
	if (
		state.input !== undefined ||
		(state.doc !== undefined &&
			state.doc !== null &&
			textOf(state.doc) !== undefined)
	)
		return 'text';
	return state.doc === undefined
		? 'unread'
		: state.doc === null
			? 'missing'
			: 'not-text';
}

function withState(
	input: Input,
	state: { saving: boolean; error: SaveError | undefined },
): Input {
	return { ...input, pending: { ...input.pending, ...state } };
}

const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

/**
 * Make the edit owner over a folder handle's own storage operations, tracked
 * like the handle's public calls so its close waits for the held input they
 * send; `folderHandle` makes one owner per handle and tells it
 * what its reads answered, what its saves stored, and which changes another
 * handle reported.
 */
export function createEditOwner({
	files,
	replaceSource,
	saveAfterMs,
	onAggregate,
	track,
	drainWork,
	waitForPaths,
}: {
	readonly files: FolderFileOperations;
	readonly replaceSource: (
		path: string,
		from: FileContent | null,
		text: string,
	) => Promise<Result<void, SaveError>>;
	readonly saveAfterMs?: number;
	/** Called after anything `aggregate` reports may have changed. */
	readonly onAggregate: () => void;
	/** One handle registry owns saves, each input's save loop, and complete actions. */
	readonly track: <T>(action: () => Promise<T>) => Promise<T>;
	readonly drainWork: () => Promise<void>;
	readonly waitForPaths: (paths: readonly string[]) => Promise<unknown>;
}) {
	const pause = saveDelay(saveAfterMs);
	const states = new Map<string, PathState>();
	/** Paths with input held, kept for the aggregate. */
	const held = new Set<string>();
	/** Reserved actions count as saving; lifetime-only work does not. */
	let reservations = 0;
	let revisions = 0;
	/** Orders reads against what overtakes them: saves stored and changes reported. */
	let clock = 0;
	/** Reads of the handle running now; a forgotten path's tick matters only to them. */
	let reads = 0;
	/** A change reported for every path: reads started before it are older. */
	let floor = 0;
	/** Paths whose readers want the change another handle reported read. */
	let rereads: Set<string> | undefined;
	let saves = 0;
	let aggregate: EditAggregate = { unsaved: [], failures: [], working: false };
	let phase: 'open' | 'closing' | 'closed' = 'open';
	let notifying = 0;

	function stateOf(path: string): PathState {
		let state = states.get(path);
		if (state === undefined) {
			state = {
				doc: undefined,
				docAt: floor,
				asOf: floor,
				reading: undefined,
				error: undefined,
				statusAt: 0,
				input: undefined,
				timer: undefined,
				running: undefined,
				again: false,
				action: undefined,
				listeners: new Set(),
				decoded: undefined,
				text: undefined,
				documents: new WeakMap(),
				buffer: undefined,
				refusal: undefined,
			};
			states.set(path, state);
		}
		return state;
	}

	/**
	 * Forget a path that holds nothing anyone asked for. A document stays
	 * while someone subscribes, input is held, or a read or list answered it
	 * and no view let it go since; the tick of a forgotten one stays while
	 * reads that it overtook may still answer.
	 */
	function prune(path: string) {
		const state = states.get(path);
		if (
			state !== undefined &&
			state.input === undefined &&
			state.timer === undefined &&
			state.running === undefined &&
			state.action === undefined &&
			state.reading === undefined &&
			state.listeners.size === 0 &&
			state.doc === undefined &&
			state.error === undefined &&
			state.refusal === undefined &&
			reads === 0
		)
			states.delete(path);
	}

	function updateAggregate() {
		const unsaved = [...held].sort();
		const failures = unsaved.flatMap((path) => {
			const pending = states.get(path)?.input?.pending;
			if (pending === undefined) return [];
			const recovery = recoveryOf(pending);
			return recovery.status === 'failed' || recovery.status === 'conflict'
				? [recovery]
				: [];
		});
		const working = reservations > 0 || saves > 0;
		if (
			sameList(unsaved, aggregate.unsaved) &&
			sameList(failures, aggregate.failures) &&
			working === aggregate.working
		)
			return;
		aggregate = { unsaved, failures, working };
		onAggregate();
	}

	const snapshots = new WeakMap<
		Pending,
		{ unsaved: Unsaved; recovery: Recovery }
	>();
	function snapshotOf(pending: Pending) {
		const previous = snapshots.get(pending);
		if (previous !== undefined) return previous;
		const unsaved: Unsaved = Object.freeze(
			pending.saving
				? { status: 'saving' }
				: pending.error === undefined
					? { status: 'dirty' }
					: pending.error.name === 'Conflict'
						? { status: 'conflict', error: pending.error }
						: { status: 'failed', error: pending.error },
		);
		const value = {
			unsaved,
			recovery: Object.freeze({
				path: pending.path,
				text: pending.text,
				...unsaved,
			}),
		};
		snapshots.set(pending, value);
		return value;
	}
	const recoveryOf = (pending: Pending) => snapshotOf(pending).recovery;
	function refusalOf(state: PathState) {
		const refusal = state.refusal;
		if (
			refusal !== undefined &&
			(refusal.kind !== sourceKind(state) ||
				refusal.text !== shownText(state) ||
				refusal.reason !== lockReason(state) ||
				refusal.running !== state.running)
		)
			state.refusal = undefined;
		return state.refusal?.error;
	}
	function record<TResult extends Result<unknown, BufferIssue>>(
		path: string,
		result: TResult,
	): TResult {
		const state = stateOf(path);
		const previous = state.refusal;
		if (
			result.error !== null &&
			previous?.error.name === result.error.name &&
			previous.error.message === result.error.message &&
			refusalOf(state) !== undefined
		)
			return result;
		const changed = state.refusal !== undefined || result.error !== null;
		state.refusal =
			result.error === null
				? undefined
				: {
						error: result.error,
						kind: sourceKind(state),
						text: shownText(state),
						reason: lockReason(state),
						running: state.running,
					};
		if (changed) {
			// A listener may issue a refused command before finishing its own work.
			// Expose the issue now, but notify after that publication has unwound.
			if (notifying > 0) queueMicrotask(() => publish(path));
			else publish(path);
		}
		return result;
	}
	function execute<TResult extends Result<unknown, BufferIssue>>(
		path: string,
		operation: () => TResult,
	): TResult {
		const state = stateOf(path);
		const previous = state.refusal;
		state.refusal = undefined;
		const result = operation();
		if (result.error !== null) {
			if (state.refusal === undefined) state.refusal = previous;
			return record(path, result);
		}
		// Publication inside the command may already have recorded a newer issue.
		if (previous !== undefined && state.refusal === undefined) publish(path);
		return result;
	}

	function bufferOf(state: PathState): BufferSnapshot {
		const text = shownText(state);
		const sourceIssue =
			state.doc === null
				? MISSING
				: state.doc !== undefined && decodedOf(state, state.doc) === undefined
					? NOT_TEXT
					: undefined;
		const error = refusalOf(state) ?? state.error ?? sourceIssue;
		const next: BufferSnapshot =
			text !== undefined
				? {
						status: 'ready',
						text,
						error,
						unsaved:
							state.input === undefined
								? undefined
								: snapshotOf(state.input.pending).unsaved,
					}
				: state.reading !== undefined
					? { status: 'loading', error }
					: (state.error !== undefined || sourceIssue !== undefined) &&
							error !== undefined
						? { status: 'unavailable', error }
						: { status: 'unread', error };
		const previous = state.buffer;
		if (
			previous?.status === next.status &&
			previous.error === next.error &&
			(previous.status !== 'ready' ||
				next.status !== 'ready' ||
				(previous.text === next.text && previous.unsaved === next.unsaved))
		)
			return previous;
		state.buffer = Object.freeze(next);
		return state.buffer;
	}

	/** Tell the listeners of `path`, or of every path, that what they read may differ. */
	function publish(path: string | undefined) {
		const touched =
			path === undefined
				? [...states.values()]
				: [states.get(path)].filter((state) => state !== undefined);
		notifying++;
		try {
			for (const state of touched) {
				refusalOf(state);
				for (const listener of [...state.listeners])
					callObserver('edit listener', listener, undefined);
			}
		} finally {
			notifying--;
		}
		if (path !== undefined) prune(path);
		updateAggregate();
	}

	function setInput(path: string, state: PathState, input: Input | undefined) {
		state.input = input;
		if (input === undefined) held.delete(path);
		else held.add(path);
		publish(path);
	}

	/** Hold `doc` as what is stored at `path`, known as of `tick`. */
	function know(path: string, state: PathState, doc: Known, tick: number) {
		state.docAt = tick;
		state.asOf = Math.max(state.asOf, tick);
		const same =
			doc === state.doc ||
			(doc !== undefined &&
				state.doc !== undefined &&
				sameContent(doc, state.doc));
		if (same) return prune(path);
		state.doc = doc;
		publish(path);
	}

	/**
	 * Something known of `path` as of `tick` answered `doc`: a read that
	 * started then, or a save that committed then. It replaces only an older
	 * document of a path whose document is held; `seed` lets it make one,
	 * for a read or list that asked for it. Answers whether it was newer than
	 * everything known of the path.
	 */
	function answered(path: string, tick: number, doc: Known, seed: boolean) {
		const state = states.get(path);
		if (state === undefined || (!seed && state.doc === undefined)) {
			if (!seed) return false;
			know(path, stateOf(path), doc, tick);
			return true;
		}
		if (tick < state.docAt) return false;
		const newest = tick > state.asOf;
		know(path, state, doc, tick);
		return newest;
	}

	/** A read of `path` started at `tick` succeeded: unless a newer read answered, the last read no longer failed. */
	function readFine(path: string, tick: number) {
		const state = states.get(path);
		if (state === undefined || tick < state.statusAt) return;
		state.statusAt = tick;
		if (state.error === undefined) return;
		state.error = undefined;
		publish(path);
	}

	/** Read `path` again soon, once however often it is asked for in this turn. */
	function rereadSoon(path: string) {
		if (rereads === undefined) {
			const paths = new Set<string>();
			rereads = paths;
			queueMicrotask(() => {
				rereads = undefined;
				if (phase !== 'open') return;
				for (const reread of paths)
					void readPath(reread, states.get(reread)?.asOf ?? -1);
			});
		}
		rereads.add(path);
	}

	/**
	 * Note that what is stored at `path` changed in a way no read here
	 * showed. What is known stays, as older than the change: a save that
	 * committed before it, or a read that started before it, may still
	 * replace it. It is read again now for a reader, held input or a read
	 * running, and for anyone else once they subscribe.
	 */
	function overtaken(path: string) {
		const state = states.get(path);
		if (state === undefined || state.doc === undefined) {
			if (state?.reading !== undefined) {
				state.asOf = ++clock;
				rereadSoon(path);
				return;
			}
			if (state === undefined && reads === 0) return;
			const next = state ?? stateOf(path);
			next.asOf = ++clock;
			return;
		}
		state.asOf = ++clock;
		if (
			state.listeners.size > 0 ||
			state.input !== undefined ||
			state.reading !== undefined
		)
			rereadSoon(path);
	}

	/**
	 * Read `path` into its document, joining a read started after `after`,
	 * whose outcome it shares.
	 */
	function readPath(path: string, after: number): Promise<ReadOutcome> {
		const state = stateOf(path);
		const running = state.reading;
		if (running !== undefined && running.tick > after) return running.done;
		const tick = ++clock;
		reads++;
		const done = (async (): Promise<ReadOutcome> => {
			try {
				const read = await files.read(path);
				if (read.error !== null) return { error: read.error };
				const content =
					read.data === undefined
						? null
						: new Uint8Array(await read.data.content.arrayBuffer());
				return { error: null, newest: answered(path, tick, content, true) };
			} catch (cause) {
				return { error: ReadError.StorageFailed({ cause }).error };
			}
		})();
		state.reading = { tick, done };
		publish(path);
		void done.then((outcome) => {
			const now = stateOf(path);
			if (now.reading?.tick === tick) now.reading = undefined;
			// The status tells the newest read's outcome. An older failure tells
			// nothing a newer read or a save since it started already answered;
			// its own callers still get it.
			if (outcome.error === null) readFine(path, tick);
			else if (tick > now.statusAt && tick > now.docAt) {
				now.statusAt = tick;
				now.error = outcome.error;
			}
			publish(path);
			finishRead();
		});
		return done;
	}

	function finishRead() {
		if (--reads > 0) return;
		for (const path of [...states.keys()]) prune(path);
	}

	/** One `read()`: read again, joining the reread, while a reported change overtakes it. */
	async function read(path: string): Promise<Result<void, ReadError>> {
		if (phase !== 'open') throw new Error('The folder is closed');
		for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
			const outcome = await readPath(path, states.get(path)?.asOf ?? floor);
			if (outcome.error !== null) return { data: null, error: outcome.error };
			if (outcome.newest) break;
			// Overtaken: what it read is held as older than the reported change,
			// which another read answers next.
		}
		return Ok(undefined);
	}

	const isLocked = (state: PathState | undefined) =>
		phase !== 'open' || state?.action !== undefined;

	function clearTimer(state: PathState) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}

	function schedule(path: string, state: PathState) {
		clearTimer(state);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void flush(path);
		}, pause);
	}

	/**
	 * Attempt held input once, or join a running save. A failed attempt stops;
	 * another request can try it again. An action sends its held input itself.
	 */
	function flush(path: string, forAction = false) {
		const state = states.get(path);
		if (state === undefined) return Promise.resolve(Ok(undefined));
		clearTimer(state);
		if (state.action !== undefined && !forAction)
			return Promise.resolve(Ok(undefined));
		const input = state.input;
		if (state.running !== undefined) {
			state.again = true;
			return state.running;
		}
		if (input === undefined) return Promise.resolve(Ok(undefined));
		// Set before the loop starts: it tells listeners at once, and one
		// that asks for another save then joins this one.
		const started = Promise.withResolvers<Result<void, SaveError>>();
		state.running = started.promise;
		saves++;
		// Registered for its whole loop, not only each storage call, so close
		// cannot release between one attempt and the next.
		track(() => drain(path, state)).then(started.resolve, started.reject);
		return started.promise;
	}

	async function send(
		path: string,
		input: Input,
	): Promise<Result<void, SaveError>> {
		try {
			return await replaceSource(path, input.from, input.pending.text);
		} catch (cause) {
			return SaveError.StorageFailed({ cause });
		}
	}

	async function drain(
		path: string,
		state: PathState,
	): Promise<Result<void, SaveError>> {
		let outcome: Result<void, SaveError> = Ok(undefined);
		try {
			do {
				state.again = false;
				const input = state.input;
				if (input === undefined) return outcome;
				clearTimer(state);
				setInput(
					path,
					state,
					withState(input, { saving: true, error: undefined }),
				);
				outcome = await send(path, input);
				const { error } = outcome;
				const settled = state.input;
				if (settled === undefined) return outcome;
				if (error !== null) {
					const same = settled.revision === input.revision;
					// The error belongs to the input that was sent; newer input has
					// not been tried.
					setInput(path, state, {
						...withState(settled, {
							saving: false,
							error: same || error.name === 'Conflict' ? error : undefined,
						}),
						conflictCurrent:
							error.name === 'Conflict'
								? error.current === null
									? null
									: owned(error.current)
								: settled.conflictCurrent,
					});
					// A listener may have typed and requested another save during
					// publication. The same failed revision stops this attempt.
					if (state.input?.revision === input.revision) return outcome;
					continue;
				}
				// The document already holds what storage kept (`stored`).
				if (
					settled.revision === input.revision ||
					settled.pending.text === input.pending.text
				)
					setInput(path, state, undefined);
				else
					setInput(path, state, {
						...settled,
						from: input.pending.text,
						pending: { ...settled.pending, saving: false, error: undefined },
					});
				// Close drains eligible input accepted before its fence, including
				// input a listener added as this attempt finished.
			} while (state.again || phase !== 'open');
			return outcome;
		} finally {
			// Stop accepting joins in the same turn that draining ends. A
			// queued listener can then start the next save, never join a dead one.
			state.running = undefined;
			saves--;
			publish(path);
		}
	}

	/**
	 * Send available input now, then newly released paths after actions drain.
	 */
	async function settle(): Promise<Recovery[]> {
		const attempted = new Map<string, number>();
		const sendReady = () =>
			[...held].flatMap((path) => {
				const state = states.get(path);
				const input = state?.input;
				if (
					input === undefined ||
					state?.action !== undefined ||
					attempted.get(path) === input.revision
				)
					return [];
				attempted.set(path, input.revision);
				return [flush(path)];
			});
		// Unrelated network work must not postpone the input already in memory.
		await Promise.allSettled(sendReady());
		await drainWork();
		// Reservations may have released paths meanwhile. Don't retry a failed
		// revision that this same settle already attempted.
		await Promise.allSettled(sendReady());
		return heldPending();
	}

	/** The input held now, by path. */
	function heldPending(): Recovery[] {
		return [...held].sort().flatMap((path) => {
			const pending = states.get(path)?.input?.pending;
			return pending === undefined ? [] : [recoveryOf(pending)];
		});
	}

	/**
	 * Reserve every path before publishing or awaiting anything. Scopes do not
	 * queue behind overlapping scopes: either every path is taken or none is.
	 * Admitted work is tracked before listeners can close the folder. A path
	 * stays reserved until the saves queued on it when the action ended have
	 * finished, so a write the action started and did not await lands before
	 * new input there is taken.
	 */
	function fence<T>(
		paths: readonly string[],
		reason: string,
		action: () => Promise<T>,
	): Promise<Result<T, ActionError>> {
		const uniquePaths = [...new Set(paths)];
		for (const path of uniquePaths) {
			if (!readablePath(path))
				return Promise.resolve(
					ActionError.NotStarted({
						reason: SaveError.InvalidPath({ path }).error.message,
					}),
				);
			const conflict = states.get(path)?.action;
			if (conflict !== undefined)
				return Promise.resolve(
					ActionError.NotStarted({ reason: conflict.reason }),
				);
		}
		const reserved = uniquePaths.map((path) => {
			const state = stateOf(path);
			state.action = { reason };
			clearTimer(state);
			return { path, state };
		});
		// Capture already-queued storage before publication can admit more work.
		const queued = waitForPaths(uniquePaths);
		if (reserved.length > 0) reservations++;
		// Track before publishing: a listener may close the folder immediately.
		return track(async () => {
			try {
				for (const { path } of reserved) publish(path);
				await queued;
				await Promise.all(reserved.map(({ state }) => state.running));
				await Promise.all(reserved.map(({ path }) => flush(path, true)));
				if (reserved.some(({ state }) => state.input !== undefined))
					return ActionError.NotStarted({ reason: UNSAVED });
				return Ok(await action());
			} finally {
				// Settles whether those saves landed or failed; the action's own
				// outcome is what this answers.
				await waitForPaths(uniquePaths);
				for (const { state } of reserved) state.action = undefined;
				if (reserved.length > 0) reservations--;
				for (const { path } of reserved) publish(path);
			}
		});
	}

	/** Delete the file as `action` finds it stored. */
	async function remove(path: string): Promise<DeleteResult> {
		if (phase !== 'open') return ActionError.NotStarted({ reason: CLOSING });
		const outcome = await fence([path], DELETING, async () => {
			try {
				const stored = await files.read(path);
				if (stored.error !== null) return stored;
				if (stored.data === undefined) return Ok({ deleted: false });
				return await files.delete(
					path,
					new Uint8Array(await stored.data.content.arrayBuffer()),
				);
			} catch (cause) {
				return SaveError.StorageFailed({ cause });
			}
		});
		return outcome.error === null ? outcome.data : outcome;
	}

	/** Let go of held input on request, unless a save or action of it runs. */
	function discard(path: string): Result<Recovery | undefined, ActionError> {
		const state = states.get(path);
		const reason =
			lockReason(state) ?? (state?.running !== undefined ? BUSY : undefined);
		if (reason !== undefined)
			return record(path, ActionError.NotStarted({ reason }));
		const recovery =
			state?.input === undefined ? undefined : recoveryOf(state.input.pending);
		if (state !== undefined) {
			clearTimer(state);
			state.refusal = undefined;
			setInput(path, state, undefined);
		}
		return Ok(recovery);
	}

	/**
	 * Listen to `path`; a document a reported change overtook is read again
	 * for the new listener, and the last listener to stop lets go of a
	 * document no input needs.
	 */
	function subscribeTo(path: string, listener: () => void) {
		const state = stateOf(path);
		const own = () => listener();
		state.listeners.add(own);
		if (
			state.doc !== undefined &&
			state.docAt < state.asOf &&
			state.reading === undefined
		)
			rereadSoon(path);
		return () => {
			const current = states.get(path);
			if (current === undefined || !current.listeners.delete(own)) return;
			if (current.listeners.size > 0) return;
			// A view that subscribes again in the same turn, as React and Svelte
			// may when they re-run, keeps the document it showed.
			queueMicrotask(() => {
				const now = states.get(path);
				if (now === undefined || now.listeners.size > 0) return;
				if (now.input === undefined && now.running === undefined) {
					// Let go of the bytes and everything read from them.
					now.doc = undefined;
					now.decoded = undefined;
					now.text = undefined;
					now.buffer = undefined;
					now.refusal = undefined;
					now.documents = new WeakMap();
				}
				prune(path);
			});
		};
	}

	/** `value` for what it depends on now, the same value while they hold. */
	function kept<T>(
		previous: Kept<T> | undefined,
		state: PathState,
		compute: () => T,
	): Kept<T> {
		if (
			previous !== undefined &&
			previous.doc === state.doc &&
			previous.input === state.input
		)
			return previous;
		return { doc: state.doc, input: state.input, value: compute() };
	}

	/** The stored document as text, or `undefined` when it is not text. */
	function decodedOf(state: PathState, content: FileContent) {
		if (state.decoded?.content !== content)
			state.decoded = { content, text: textOf(content) };
		return state.decoded.text;
	}

	function lockReason(state: PathState | undefined) {
		if (phase !== 'open') return CLOSING;
		return state?.action?.reason;
	}

	/** The dirty source stays pinned while reads update known storage. */
	function shownText(state: PathState): string | undefined {
		if (state.input !== undefined) return state.input.pending.text;
		const doc = state.doc;
		return doc === undefined || doc === null
			? undefined
			: decodedOf(state, doc);
	}

	function edit<TRowSchema extends TSchema = typeof anyFields>(
		path: string,
		schema?: TRowSchema,
	): FileEdit<TRowSchema> {
		const readSchema = schema ?? anyFields;
		const getText = (): string | undefined => {
			const state = states.get(path);
			if (state === undefined) return undefined;
			state.text = kept(state.text, state, () => shownText(state));
			return state.text.value;
		};
		const getMarkdown = (): MarkdownContent<TRowSchema> | undefined => {
			const state = states.get(path);
			const text = getText();
			if (state === undefined || text === undefined) return undefined;
			const previous = state.documents.get(readSchema);
			if (previous?.text === text)
				return previous as MarkdownContent<TRowSchema>;
			const value = readMarkdown(text, readSchema);
			state.documents.set(readSchema, value);
			return value as MarkdownContent<TRowSchema>;
		};
		const submitText = (typed: string): ChangeResult => {
			const state = states.get(path);
			const reason = lockReason(state);
			if (reason !== undefined) return ChangeError.Locked({ reason });
			const current = getText();
			if (current === undefined) {
				const doc = state?.doc;
				return doc !== undefined && doc !== null
					? ChangeError.NotText()
					: ChangeError.NoSource();
			}
			if (typed === current) return Ok(undefined);
			const input = state?.input;
			const from =
				input === undefined ? owned(state!.doc as FileContent) : input.from;
			const target = stateOf(path);
			if (
				from !== null &&
				textOf(from) === typed &&
				target.running === undefined
			) {
				clearTimer(target);
				setInput(path, target, undefined);
				return Ok(undefined);
			}
			setInput(path, target, {
				pending: {
					path,
					text: typed,
					saving: input?.pending.saving ?? false,
					error:
						input?.pending.error?.name === 'Conflict'
							? input.pending.error
							: undefined,
				},
				from,
				conflictCurrent: input?.conflictCurrent,
				revision: ++revisions,
			});
			schedule(path, target);
			return Ok(undefined);
		};
		const change = (change: DocumentChange<TRowSchema>): ChangeResult => {
			const state = states.get(path);
			const reason = lockReason(state);
			if (reason !== undefined) return ChangeError.Locked({ reason });
			const ownedFields = ownFields(change.fields ?? {});
			if (ownedFields.error !== null)
				return ChangeError.InvalidFields({ reason: ownedFields.error.reason });
			const source = getText();
			if (source === undefined) {
				const doc = state?.doc;
				return doc !== undefined && doc !== null
					? ChangeError.NotText()
					: ChangeError.NoSource();
			}
			const parsed = readMarkdown(source, anyFields);
			const fields: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(ownedFields.data)) {
				if (
					parsed.fields !== undefined &&
					sharedValue(parsed.fields[key], value)
				)
					continue;
				Object.defineProperty(fields, key, { value, enumerable: true });
			}
			const body = change.body === parsed.body ? undefined : change.body;
			if (Object.keys(fields).length === 0 && body === undefined)
				return Ok(undefined);
			const put = changeMarkdown(parsed, {
				fields: Object.keys(fields).length === 0 ? undefined : fields,
				body,
			});
			if (put.error !== null)
				return ChangeError.InvalidFields({ reason: put.error.reason });
			return submitText(put.data.text);
		};
		const save = async (): Promise<Result<void, SaveError | ActionError>> => {
			const state = states.get(path);
			const reason = phase === 'closed' ? CLOSING : state?.action?.reason;
			if (reason !== undefined)
				return record(path, ActionError.NotStarted({ reason }));
			const hadRefusal = state?.refusal !== undefined;
			if (state !== undefined) state.refusal = undefined;
			const saving = flush(path);
			if (hadRefusal) publish(path);
			return saving;
		};
		return {
			path,
			getText,
			getMarkdown,
			getBuffer: () => {
				const state = states.get(path);
				return state === undefined ? UNREAD : bufferOf(state);
			},
			isLocked: () => isLocked(states.get(path)),
			read: () => read(path),
			subscribe: (listener) => subscribeTo(path, listener),
			replaceText: (text) => execute(path, () => submitText(text)),
			change: (value) => execute(path, () => change(value)),
			save,
			async resolveConflict(choice) {
				const state = states.get(path);
				const input = state?.input;
				const error = input?.pending.error;
				const reason =
					lockReason(state) ??
					(state?.running !== undefined ? BUSY : undefined);
				if (reason !== undefined)
					return record(path, ActionError.NotStarted({ reason }));
				if (
					state === undefined ||
					input === undefined ||
					error?.name !== 'Conflict'
				)
					return record(
						path,
						ActionError.NotStarted({
							reason: 'There is no conflict to resolve.',
						}),
					);
				state.refusal = undefined;
				if (choice === 'current') {
					const refreshed = await read(path);
					if (refreshed.error !== null) return refreshed;
					if (state.input !== input || state.doc === undefined)
						return record(
							path,
							ActionError.NotStarted({
								reason: 'The input changed while resolving the conflict.',
							}),
						);
					const current =
						input.conflictCurrent === undefined
							? error.current
							: input.conflictCurrent;
					if (sameContent(state.doc, current)) {
						setInput(path, state, undefined);
						return Ok(undefined);
					}
					const conflict = SaveError.Conflict({
						path,
						base: input.from,
						current: state.doc,
					});
					setInput(path, state, {
						...input,
						conflictCurrent: state.doc === null ? null : owned(state.doc),
						pending: {
							...input.pending,
							error: conflict.error,
						},
					});
					return conflict;
				}
				const text = choice === 'draft' ? input.pending.text : choice.text;
				setInput(path, state, {
					from:
						input.conflictCurrent === undefined
							? error.current
							: input.conflictCurrent,
					pending: { path, text, saving: false, error: undefined },
					revision: ++revisions,
				});
				return save();
			},
			discard: () => discard(path),
			async delete() {
				const state = states.get(path);
				if (state !== undefined) state.refusal = undefined;
				const result = await remove(path);
				if (
					result.error === null ||
					states.get(path)?.input?.pending.error === result.error
				)
					return result;
				return record(path, result);
			},
		};
	}

	/**
	 * Called once by the handle when close begins: refuse new input and send
	 * what is held once. `save()` keeps attempting its path until `release`.
	 */
	async function close(): Promise<void> {
		phase = 'closing';
		onAggregate();
		publish(undefined);
		await settle();
	}

	/**
	 * Called once by the handle, in the turn it finds nothing left to wait for
	 * and releases storage: from then on `save()` does nothing. Answers the
	 * input still held then, for the handle's one close completion.
	 */
	function release(): Recovery[] {
		phase = 'closed';
		return heldPending();
	}

	return {
		edit,
		run: <T>(paths: readonly string[], action: () => Promise<T>) =>
			fence(paths, BUSY, action),
		settle,
		close,
		release,
		getAggregate() {
			return aggregate;
		},
		/** A read of the handle starts: answers its tick, for the answer it gives. */
		startRead() {
			reads++;
			return ++clock;
		},
		/** A read of the handle started at `tick` ended, answered or not. */
		endRead() {
			finishRead();
		},
		/** The tick of something that just happened, such as a save's commit. */
		now() {
			return ++clock;
		},
		/** A list of `table` started at `tick` answered `rows`: every row of it. */
		listed(table: string, tick: number, rows: readonly Row[]) {
			const listedPaths = new Set<string>();
			for (const listedRow of rows) {
				const path = rowPath(table, listedRow.id);
				listedPaths.add(path);
				// A row that is not text comes without its bytes.
				if (notText(listedRow)) overtaken(path);
				else answered(path, tick, listedRow.text, true);
				readFine(path, tick);
			}
			const prefix = `${table}/`;
			for (const [path, state] of [...states])
				if (
					path.startsWith(prefix) &&
					path.endsWith('.md') &&
					!path.slice(prefix.length).includes('/') &&
					state.doc !== undefined &&
					!listedPaths.has(path)
				) {
					answered(path, tick, null, false);
					readFine(path, tick);
				}
		},
		/** A get of row `id` started at `tick` answered `found`. */
		got(table: string, id: string, tick: number, found: Row | undefined) {
			const path = rowPath(table, id);
			if (found !== undefined && notText(found)) overtaken(path);
			else answered(path, tick, found === undefined ? null : found.text, true);
			readFine(path, tick);
		},
		/** A read of file `path` started at `tick` answered `content`; text seeds source; binary bytes are kept only for a path already held. */
		readFile(path: string, tick: number, content: Uint8Array | null) {
			const seed = content !== null && textOf(content) !== undefined;
			if (answered(path, tick, content, seed)) readFine(path, tick);
		},
		/**
		 * A save of the handle that committed at `tick` stored `content` at
		 * `path`, or `null` for no file: newer than any read started before the
		 * commit, older than one started after it. Kept only for a path whose
		 * document is known or being read; an action's or a direct save's bytes
		 * are not held for anyone. `undefined` when what it kept is unknown, as
		 * for a delete that kept a file changed meanwhile.
		 */
		stored(path: string, content: Known, tick: number) {
			if (content === undefined) return overtaken(path);
			const state = states.get(path);
			if (state === undefined) {
				if (reads > 0) know(path, stateOf(path), undefined, tick);
				return;
			}
			if (state.doc === undefined && state.reading === undefined) {
				// Nothing older that a list may still answer replaces it either.
				state.docAt = Math.max(state.docAt, tick);
				return;
			}
			answered(path, tick, content === null ? null : owned(content), true);
		},
		/** Another handle, or a sync, changed `paths`, or any path for `null`. */
		changed(paths: readonly string[] | null) {
			if (paths === null) {
				floor = ++clock;
				for (const path of [...states.keys()]) overtaken(path);
				return;
			}
			for (const path of paths) overtaken(path);
		},
	};
}

export type EditOwner = ReturnType<typeof createEditOwner>;
