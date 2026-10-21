/**
 * One owner per opened Folder, holding each path's source, input, save queue
 * and fence. File and table accessors expose the same FileEdit contract;
 * schemas and strict table framing interpret source without owning input.
 *
 * Text and structured input share one path. Structured input keeps each
 * typed unit's base; whole text keeps the source it started from. A save
 * reserves its path before preparation, and newer typing survives the
 * submitted input landing or failing. Failed input stays recoverable until
 * another save, accepted change or explicit discard.
 *
 * Ordered reads cannot replace knowledge of a later save. Public text reads
 * seed source without another read, while unheld binary reads retain no
 * bytes. Readers share immutable snapshots by path and interpretation;
 * document fields always describe the source getText() actually answers.
 * Fields that no longer apply stay only in pending input.
 *
 * Fenced actions save input before running. Close refuses new input at once,
 * waits for saves and actions, and attempts remaining input once. Getters
 * keep answering held input after close, for recovery.
 */
import { diffArrays } from 'diff';
import { type Static, type TSchema, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderFileOperations } from './folder.js';
import { callObserver } from './observer.js';
import { readablePath } from './paths.js';
import { ownFields } from './shared/content/canonical.js';
import { mergeLinesWith } from './shared/content/merge-lines.js';
import { readDocument } from './shared/document.js';
import { ReadError, SaveError } from './shared/errors.js';
import { changeMarkdown, readMarkdown } from './shared/markdown-codec.js';
import {
	type FileContent,
	merge,
	mergeWith,
	sameContent,
} from './shared/merge.js';
import { type MarkdownValue, type Row } from './shared/row.js';

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

/** Accepted into memory, or refused. A later save reports failures through `getPending().error`. */
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

/** Structured input held over one path, whether it is currently applicable or not. */
export type DocumentPending = {
	readonly kind: 'document';
	readonly path: string;
	readonly fields: Readonly<Record<string, unknown>>;
	readonly body: string | undefined;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

/** Whole source held over one path. */
export type TextPending = {
	readonly kind: 'text';
	readonly path: string;
	readonly text: string;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

export type Pending = DocumentPending | TextPending;

/**
 * What an edit knows of its file, and how reading it goes. `known` is
 * `nothing` until a read or a row list says what is stored, and again
 * after its cached document is released; then `missing`
 * for no file, `file` for a file, or `not-text` for bytes that are not
 * UTF-8 text without NUL. `reading` while a read of the edit runs; `error`
 * is why the last read failed, until one succeeds, whatever is known.
 */
export type ReadStatus = {
	readonly known: 'nothing' | 'missing' | 'file' | 'not-text';
	readonly reading: boolean;
	readonly error: ReadError | undefined;
};

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
	getPending(): Pending | undefined;
	getReadStatus(): ReadStatus;
	isLocked(): boolean;
	/** Refresh this path. Read the current snapshot through the getters afterwards. */
	read(): Promise<Result<void, ReadError>>;
	subscribe(listener: () => void): () => void;
	/** Accept fields and body together, over the currently known source. */
	change(change: DocumentChange<TRowSchema>): ChangeResult;
	/** Replace the editable source, preserving its merge witness and any applicable patch. */
	replaceText(text: string): ChangeResult;
	/** Attempt held input, including an earlier failure, or join its running attempt. */
	save(): Promise<void>;
	/** Release held input, returning it for recovery. Refused while a save or action runs. */
	discard(): Pending | undefined;
	delete(): Promise<DeleteResult>;
	/** Fence this path, save held input, then perform one protected action. */
	exclusive<T>(
		action: (file: ExclusiveFile) => Promise<T>,
	): Promise<Result<T, ActionError>>;
};

/**
 * The one file an `exclusive` action holds: read it, save it from what was
 * read (`from`, as `folder.files.write` takes it), or delete it. It works
 * only while the action runs, the folder's close included.
 */
export type ExclusiveFile = {
	readonly path: string;
	read(): ReturnType<FolderFileOperations['read']>;
	write(
		from: FileContent | null,
		content: FileContent,
	): ReturnType<FolderFileOperations['write']>;
	delete(from: FileContent | null): ReturnType<FolderFileOperations['delete']>;
};

/**
 * The line merge for a body control (ADR-0622): what `change` did to
 * `base`, merged into `current`. Whole source uses mergeFileText;
 * where both changed one region, `change` wins.
 */
export function mergeText(base: string, current: string, change: string) {
	if (base === current) return change;
	return mergeLinesWith(diffArrays, { base, current, change }).content;
}

/** Merge whole source with the same Markdown field and text rules storage uses. */
export function mergeFileText(
	path: string,
	base: string,
	current: string,
	change: string,
): string {
	// Non-null string versions always produce non-null string content.
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

/** A row's source text, owned by the input rather than borrowed from a read. */
type Source = Pick<Row, 'text' | 'issues'>;

type DocumentInput = {
	readonly kind: 'document';
	readonly frontmatter: 'required' | 'optional';
	readonly pending: DocumentPending;
	/** The latest document typed over, preferring one whose frontmatter parses. */
	readonly source: Source;
	/** The base of each typed unit: as the document held it when first typed, or as last sent. */
	readonly bases: {
		readonly fields: Record<string, unknown>;
		readonly body: string | undefined;
	};
	/** Changes with each change, so a landed save knows whether typing followed it. */
	readonly revision: number;
};

type TextInput = {
	readonly kind: 'text';
	readonly pending: TextPending;
	/** The content the typing started from, or the text the last landed save sent. */
	readonly from: FileContent;
	/** Structured assignments made after source input still apply at storage. */
	readonly fields?: Record<string, unknown>;
	readonly frontmatter?: 'required' | 'optional';
	readonly revision: number;
};

type Input = DocumentInput | TextInput;

/** A structured save's merge base and submitted text, for input typed during saving. */
type Prepared = { readonly base: FileContent; readonly sent: string };

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
	running: Promise<void> | undefined;
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
	rows: WeakMap<TSchema, MarkdownContent>;
	status: ReadStatus;
};

/** What the owner tells the handle: input held, failures, and whether work runs. */
export type EditAggregate = {
	readonly unsaved: readonly string[];
	readonly failures: readonly Pending[];
	readonly working: boolean;
};

const rowPath = (table: string, id: string) => `${table}/${id}.md`;

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const bytesOf = (content: FileContent) =>
	typeof content === 'string' ? encoder.encode(content) : content;
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

const NOTHING: ReadStatus = Object.freeze({
	known: 'nothing',
	reading: false,
	error: undefined,
});

/** Set `key` as an own property, so a key such as `__proto__` stays data. */
function withValue(
	record: Record<string, unknown>,
	key: string,
	value: unknown,
): Record<string, unknown> {
	return Object.defineProperty({ ...record }, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

const fieldValue = (fields: Record<string, unknown>, key: string) =>
	Object.hasOwn(fields, key) ? fields[key] : undefined;

/** Whether the source's frontmatter parses, so fields can be put into it. */
const parses = ({ issues }: Source) =>
	issues === null || issues.every((issue) => issue.kind === 'schema');

/** Whether a row's source is not text, as a row list reads one without its bytes. */
const notText = ({ issues }: Pick<Row, 'issues'>) =>
	issues?.some((issue) => issue.kind === 'not-text') ?? false;

/** The fields and body typed, as a change of the row's source. */
const changeOf = ({ fields, body }: DocumentPending) => ({
	fields:
		Object.keys(fields).length === 0
			? undefined
			: (fields as Record<string, unknown>),
	body,
});

/** The row a row input's save starts from: its source with every base put in. */
function baseOf(input: DocumentInput): Source {
	const { source, bases } = input;
	const fields =
		Object.keys(bases.fields).length === 0 ? undefined : bases.fields;
	if (fields === undefined && bases.body === undefined) return source;
	const based = changeMarkdown(
		source,
		{ fields, body: bases.body },
		input.frontmatter,
	);
	if (based.error === null)
		return { text: based.data.text, issues: source.issues };
	// No source whose fields could take the bases was typed over. The engine
	// refuses fields over it and says why; the input stays held.
	return source;
}

/** `change` put into the file `content`, as text. */
function changed(
	path: string,
	content: FileContent,
	change: { fields?: Record<string, unknown>; body?: string },
	frontmatter: 'required' | 'optional' = 'optional',
) {
	return changeMarkdown(
		readDocument(path, bytesOf(content)),
		change,
		frontmatter,
	);
}

function withState(
	input: Input,
	state: { saving: boolean; error: SaveError | undefined },
): Input {
	switch (input.kind) {
		case 'document':
			return { ...input, pending: { ...input.pending, ...state } };
		case 'text':
			return { ...input, pending: { ...input.pending, ...state } };
	}
}

const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

/**
 * Make the edit owner over a folder handle's own storage operations. They
 * are tracked like the handle's public calls but stay open while its close
 * sends held input; `folderHandle` makes one owner per handle and tells it
 * what its reads answered, what its saves stored, and which changes another
 * handle reported.
 */
export function createEditOwner({
	files,
	writeDocument,
	saveAfterMs,
	onAggregate,
}: {
	readonly files: FolderFileOperations;
	readonly writeDocument: (
		path: string,
		prepare: () => Promise<
			Result<
				{
					from: FileContent;
					text: string;
					fields?: Record<string, unknown>;
					frontmatter: 'required' | 'optional';
				},
				SaveError
			>
		>,
	) => Promise<{ error: SaveError | null; prepared?: Prepared }>;
	readonly saveAfterMs?: number;
	/** Called after anything `aggregate` reports may have changed. */
	readonly onAggregate: () => void;
}) {
	const pause = saveDelay(saveAfterMs);
	const states = new Map<string, PathState>();
	/** Paths with input held, kept for the aggregate. */
	const held = new Set<string>();
	/** Fenced actions running, which settle and close wait for. */
	const actions = new Set<Promise<unknown>>();
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
	let editingStopped = false;
	let closing: Promise<Pending[]> | undefined;

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
				rows: new WeakMap(),
				status: NOTHING,
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
			reads === 0
		)
			states.delete(path);
	}

	function updateAggregate() {
		const unsaved = [...held].sort();
		const failures = unsaved.flatMap((path) => {
			const pending = states.get(path)?.input?.pending;
			return pending?.error !== undefined && !pending.saving ? [pending] : [];
		});
		const working = actions.size > 0 || saves > 0;
		if (
			sameList(unsaved, aggregate.unsaved) &&
			sameList(failures, aggregate.failures) &&
			working === aggregate.working
		)
			return;
		aggregate = { unsaved, failures, working };
		onAggregate();
	}

	/** What `state` says of reading, kept as the same value while it says the same. */
	function statusOf(state: PathState): ReadStatus {
		const doc = state.doc;
		const known: ReadStatus['known'] =
			doc === undefined
				? 'nothing'
				: doc === null
					? 'missing'
					: decodedOf(state, doc) === undefined
						? 'not-text'
						: 'file';
		const reading = state.reading !== undefined;
		const { status, error } = state;
		if (
			status.known === known &&
			status.reading === reading &&
			status.error === error
		)
			return status;
		state.status = Object.freeze({ known, reading, error });
		return state.status;
	}

	/** Tell the listeners of `path`, or of every path, that what they read may differ. */
	function publish(path: string | undefined) {
		const touched =
			path === undefined
				? [...states.values()]
				: [states.get(path)].filter((state) => state !== undefined);
		for (const state of touched)
			for (const listener of [...state.listeners])
				callObserver('edit listener', listener, undefined);
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
				if (closing !== undefined) return;
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
		if (closing !== undefined) throw new Error('The folder is closed');
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
		editingStopped || closing !== undefined || state?.action !== undefined;

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
		if (state === undefined) return Promise.resolve();
		clearTimer(state);
		if (state.action !== undefined && !forAction) return Promise.resolve();
		const input = state.input;
		if (state.running !== undefined) {
			state.again = true;
			return state.running;
		}
		if (input === undefined) return Promise.resolve();
		// Set before the loop starts: it tells listeners at once, and one
		// that asks for another save then joins this one.
		const started = Promise.withResolvers<void>();
		state.running = started.promise;
		saves++;
		drain(path, state).then(started.resolve, started.reject);
		return started.promise;
	}

	/**
	 * A save asked for from outside: from close on, nothing new is sent, and
	 * the asker waits for close, which sends held input once itself.
	 */
	function requested(path: string): Promise<void> {
		if (closing !== undefined) return close().then(() => {});
		return flush(path);
	}

	async function send(
		path: string,
		input: Input,
	): Promise<{ error: SaveError | null; prepared?: Prepared }> {
		try {
			switch (input.kind) {
				case 'text': {
					const frontmatter = input.frontmatter;
					if (frontmatter === undefined)
						return await files.write(path, input.from, input.pending.text);
					return await writeDocument(path, async () =>
						Ok({
							from: input.from,
							text: input.pending.text,
							fields: input.fields,
							frontmatter,
						}),
					);
				}
				case 'document':
					return await writeDocument(path, async () => {
						const found = await files.read(path);
						if (found.error !== null)
							return SaveError.StorageFailed({ cause: found.error });
						const latest =
							found.data === undefined
								? undefined
								: readDocument(
										path,
										new Uint8Array(await found.data.content.arrayBuffer()),
									);
						if (
							latest !== undefined &&
							Object.keys(input.pending.fields).length > 0 &&
							!parses(latest)
						)
							return SaveError.Unparseable({
								reason:
									latest.issues?.[0]?.message ?? 'The fields cannot be applied',
							});
						const base = baseOf(
							latest !== undefined && parses(latest)
								? { ...input, source: latest }
								: input,
						);
						const sent = changeMarkdown(
							base,
							changeOf(input.pending),
							input.frontmatter,
						);
						if (sent.error !== null)
							return SaveError.Unparseable({ reason: sent.error.reason });
						return Ok({
							from: base.text,
							text: sent.data.text,
							fields: changeOf(input.pending).fields,
							frontmatter: input.frontmatter,
						});
					});
			}
		} catch (cause) {
			return { error: SaveError.StorageFailed({ cause }).error };
		}
	}

	/** Keep what remains of the input once the save of `before` landed. */
	async function landed(
		path: string,
		state: PathState,
		before: Input,
		prepared: Prepared | undefined,
	) {
		const after = state.input;
		if (after === undefined) return;
		const cleared = { saving: false, error: undefined };
		if (after.kind === 'document' && before.kind === 'document') {
			// Typing during the save was over the input as sent, so a unit the
			// save sent now starts from what it sent, and one that still holds
			// exactly that is done. A unit first typed while the save ran keeps
			// the base it was typed over.
			const sent: Record<string, unknown> = before.pending.fields;
			let fields: Record<string, unknown> = {};
			let bases: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(after.pending.fields)) {
				const wasSent = Object.hasOwn(sent, key);
				if (wasSent && Object.is(sent[key], value)) continue;
				fields = withValue(fields, key, value);
				bases = withValue(
					bases,
					key,
					wasSent ? sent[key] : fieldValue(after.bases.fields, key),
				);
			}
			const sentBody = before.pending.body;
			const body =
				after.pending.body === sentBody ? undefined : after.pending.body;
			if (Object.keys(fields).length === 0 && body === undefined) {
				setInput(path, state, undefined);
				return;
			}
			setInput(path, state, {
				...after,
				bases: {
					fields: bases,
					body: body === undefined ? undefined : (sentBody ?? after.bases.body),
				},
				pending: { ...after.pending, fields, body, ...cleared },
			});
			return;
		}
		if (after.kind === 'text' && before.kind === 'text') {
			setInput(
				path,
				state,
				after.pending.text === before.pending.text &&
					after.fields === before.fields &&
					after.frontmatter === before.frontmatter
					? undefined
					: {
							...after,
							from: before.pending.text,
							pending: { ...after.pending, ...cleared },
						},
			);
			return;
		}

		setInput(path, state, withState(after, cleared));
		if (
			after.kind !== 'text' ||
			before.kind !== 'document' ||
			prepared === undefined
		)
			return;
		// Text typed over a structured patch while it saved keeps the content the
		// person saw, which may lack a change the save merged from storage.
		// Rebase that content by what the patch sent, so the landed fields are
		// in it and a later revert of them in the text is a change.
		const rebased = await merge(path, {
			base: prepared.base,
			current: after.from,
			change: prepared.sent,
		});
		const now = state.input;
		if (
			now?.kind === 'text' &&
			now.from === after.from &&
			rebased.content !== null
		)
			setInput(path, state, { ...now, from: rebased.content });
	}

	async function drain(path: string, state: PathState) {
		try {
			do {
				state.again = false;
				const input = state.input;
				if (input === undefined) return;
				clearTimer(state);
				setInput(
					path,
					state,
					withState(input, { saving: true, error: undefined }),
				);
				const { error, prepared } = await send(path, input);
				const settled = state.input;
				if (settled === undefined) return;
				if (error !== null) {
					const same = settled.revision === input.revision;
					// The error belongs to the input that was sent; newer input has
					// not been tried.
					setInput(
						path,
						state,
						withState(settled, {
							saving: false,
							error: same ? error : undefined,
						}),
					);
					// A listener may have typed and requested another save during
					// publication. The same failed revision stops this attempt.
					if (state.input?.revision === input.revision) return;
					continue;
				}
				// The document already holds what storage kept (`stored`).
				if (settled.revision === input.revision)
					setInput(path, state, undefined);
				else await landed(path, state, input, prepared);
				// Close drains eligible input accepted before its fence, including
				// input a listener added as this attempt finished.
			} while (state.again || closing !== undefined);
		} finally {
			// Stop accepting joins in the same turn that draining ends. A
			// queued listener can then start the next save, never join a dead one.
			state.running = undefined;
			saves--;
			publish(path);
		}
	}

	/**
	 * Attempt each held path once, after fenced actions; answer what did not save.
	 */
	async function settle(): Promise<Pending[]> {
		await Promise.allSettled([...actions]);
		await Promise.allSettled([...held].map((path) => flush(path)));
		return [...held].sort().flatMap((path) => {
			const pending = states.get(path)?.input?.pending;
			return pending === undefined ? [] : [pending];
		});
	}

	/**
	 * Reserve every path before publishing or awaiting anything. Scopes do not
	 * queue behind overlapping scopes: either every path is taken or none is.
	 * Admitted work is tracked before listeners can close the folder, and its
	 * file capabilities stay usable until the action ends, even during close.
	 */
	function fence<T>(
		paths: readonly string[],
		reason: string,
		action: (files: ReadonlyMap<string, ExclusiveFile>) => Promise<T>,
	): Promise<Result<T, ActionError>> {
		if (closing !== undefined)
			return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
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
		let taken = true;
		const ended = () => {
			if (!taken)
				throw new Error('This exclusive change of the file has ended');
		};
		const scopedFiles = new Map<string, ExclusiveFile>(
			reserved.map(({ path }) => [
				path,
				{
					path,
					read: () => (ended(), files.read(path)),
					write: (from, content) => (ended(), files.write(path, from, content)),
					delete: (from) => (ended(), files.delete(path, from)),
				},
			]),
		);
		const completion = Promise.withResolvers<Result<T, ActionError>>();
		const work = completion.promise;
		actions.add(work);
		for (const { path } of reserved) publish(path);
		// An empty scope is still work that settle/close must wait for.
		if (reserved.length === 0) updateAggregate();
		(async (): Promise<Result<T, ActionError>> => {
			try {
				await Promise.all(reserved.map(({ state }) => state.running));
				await Promise.all(reserved.map(({ path }) => flush(path, true)));
				if (reserved.some(({ state }) => state.input !== undefined))
					return ActionError.NotStarted({ reason: UNSAVED });
				return Ok(await action(scopedFiles));
			} finally {
				taken = false;
				for (const { state } of reserved) state.action = undefined;
			}
		})().then(completion.resolve, completion.reject);
		const done = () => {
			actions.delete(work);
			for (const { path } of reserved) publish(path);
			if (reserved.length === 0) updateAggregate();
		};
		work.then(done, done);
		return work;
	}

	/** Delete the file as `action` finds it stored. */
	async function remove(
		path: string,
		action: () => Promise<Result<{ deleted: boolean }, SaveError | ReadError>>,
	): Promise<DeleteResult> {
		const outcome = await fence([path], DELETING, async () => {
			try {
				return await action();
			} catch (cause) {
				return SaveError.StorageFailed({ cause });
			}
		});
		if (outcome.error !== null) return outcome;
		return outcome.data;
	}

	/** Let go of held input on request, unless a save or action of it runs. */
	function discard(path: string) {
		const state = states.get(path);
		if (state === undefined || isLocked(state) || state.running !== undefined)
			return undefined;
		const input = state.input;
		if (input === undefined) return undefined;
		clearTimer(state);
		setInput(path, state, undefined);
		return input.pending;
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
					now.documents = new WeakMap();
					now.rows = new WeakMap();
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
		if (closing !== undefined) return CLOSING;
		if (editingStopped) return 'Editing has stopped for this folder.';
		return state?.action?.reason;
	}

	/** Current source, with applicable held input. Unapplied fields stay only in pending. */
	function shownText(path: string, state: PathState): string | undefined {
		const input = state.input;
		if (input?.kind === 'text') return input.pending.text;
		const doc = state.doc;
		if (doc === undefined || doc === null) return undefined;
		const stored = decodedOf(state, doc);
		if (stored === undefined || input === undefined) return stored;
		const put = changed(
			path,
			stored,
			changeOf(input.pending),
			input.frontmatter,
		);
		if (put.error === null) return put.data.text;
		if (input.pending.body !== undefined) {
			const body = changed(
				path,
				stored,
				{ body: input.pending.body },
				input.frontmatter,
			);
			if (body.error === null) return body.data.text;
		}
		return stored;
	}

	function edit<TRowSchema extends TSchema = typeof anyFields>(
		path: string,
		schema?: TRowSchema,
		strictRow = false,
	): FileEdit<TRowSchema> {
		const readSchema = schema ?? anyFields;
		const getText = (): string | undefined => {
			const state = states.get(path);
			if (state === undefined) return undefined;
			state.text = kept(state.text, state, () => shownText(path, state));
			return state.text.value;
		};
		const getMarkdown = (): MarkdownContent<TRowSchema> | undefined => {
			const state = states.get(path);
			const text = getText();
			if (state === undefined || text === undefined) return undefined;
			const cache = strictRow ? state.rows : state.documents;
			const previous = cache.get(readSchema);
			if (previous?.text === text)
				return previous as MarkdownContent<TRowSchema>;
			const value = readMarkdown(
				text,
				readSchema,
				strictRow ? 'required' : 'optional',
			);
			cache.set(readSchema, value);
			return value as MarkdownContent<TRowSchema>;
		};
		function storedText(
			state: PathState | undefined,
		): Result<string, ChangeError> {
			const doc = state?.doc;
			if (state === undefined || doc === undefined || doc === null)
				return ChangeError.NoSource();
			const stored = decodedOf(state, doc);
			return stored === undefined ? ChangeError.NotText() : Ok(stored);
		}
		const submitText = (
			typed: string,
			structured?: Pick<TextInput, 'fields' | 'frontmatter'>,
		): ChangeResult => {
			const state = states.get(path);
			const reason = lockReason(state);
			if (reason !== undefined) return ChangeError.Locked({ reason });
			const input = state?.input;
			let from: FileContent;
			if (input?.kind === 'text') from = input.from;
			else {
				const stored = storedText(state);
				if (stored.error !== null) return stored;
				if (input !== undefined) {
					const preview = changed(
						path,
						stored.data,
						changeOf(input.pending),
						input.frontmatter,
					);
					if (preview.error !== null)
						return ChangeError.InvalidFields({ reason: preview.error.reason });
					from = baseOf({
						...input,
						source: readDocument(path, bytesOf(stored.data)),
					}).text;
				} else from = owned(state?.doc as FileContent);
			}
			const target = stateOf(path);
			setInput(path, target, {
				kind: 'text',
				pending: {
					kind: 'text',
					path,
					text: typed,
					saving: input?.pending.saving ?? false,
					error: undefined,
				},
				from,
				...structured,
				revision: ++revisions,
			});
			schedule(path, target);
			return Ok(undefined);
		};
		return {
			path,
			getText,
			getMarkdown,
			getPending: () => states.get(path)?.input?.pending,
			getReadStatus: () => {
				const state = states.get(path);
				return state === undefined ? NOTHING : statusOf(state);
			},
			isLocked: () => isLocked(states.get(path)),
			read: () => read(path),
			subscribe: (listener) => subscribeTo(path, listener),
			replaceText: (typed) => submitText(typed),
			change(change) {
				const state = states.get(path);
				const reason = lockReason(state);
				if (reason !== undefined) return ChangeError.Locked({ reason });
				const input = state?.input;
				const ownedFields = ownFields(change.fields ?? {});
				if (ownedFields.error !== null)
					return ChangeError.InvalidFields({
						reason: ownedFields.error.reason,
					});
				const typed = ownedFields.data;
				const keys = Object.keys(typed);
				if (keys.length === 0 && change.body === undefined)
					return Ok(undefined);
				if (input?.kind === 'text') {
					let fields = input.fields ?? {};
					for (const key of keys) fields = withValue(fields, key, typed[key]);
					const frontmatter =
						input.frontmatter === 'required' || strictRow
							? 'required'
							: 'optional';
					const put = changed(
						path,
						input.pending.text,
						{
							fields: keys.length === 0 ? undefined : typed,
							body: change.body,
						},
						frontmatter,
					);
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
					return submitText(put.data.text, {
						fields: Object.keys(fields).length === 0 ? undefined : fields,
						frontmatter,
					});
				}
				const stored = storedText(state);
				if (stored.error !== null) return stored;
				const source = readDocument(path, bytesOf(stored.data));
				let fields: Record<string, unknown> = input?.pending.fields ?? {};
				let baseFields = input?.bases.fields ?? {};
				for (const key of keys) {
					if (!Object.hasOwn(fields, key))
						baseFields = withValue(
							baseFields,
							key,
							fieldValue(source.fields ?? {}, key),
						);
					fields = withValue(fields, key, typed[key]);
				}
				let body = input?.pending.body;
				let baseBody = input?.bases.body;
				if (change.body !== undefined) {
					if (body === undefined) baseBody = source.body;
					body = change.body;
				}
				const pending: DocumentPending = {
					kind: 'document',
					path,
					fields,
					body,
					saving: input?.pending.saving ?? false,
					error: undefined,
				};
				const frontmatter = strictRow ? 'required' : 'optional';
				if (parses(source)) {
					const put = changeMarkdown(source, changeOf(pending), frontmatter);
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
				} else if (change.body !== undefined) {
					const put = changeMarkdown(
						source,
						{ body: change.body },
						frontmatter,
					);
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
				}
				const next = stateOf(path);
				setInput(path, next, {
					kind: 'document',
					frontmatter,
					pending,
					source:
						input === undefined || parses(source) || !parses(input.source)
							? { text: source.text, issues: source.issues }
							: input.source,
					bases: { fields: baseFields, body: baseBody },
					revision: ++revisions,
				});
				schedule(path, next);
				return Ok(undefined);
			},
			save: () => requested(path),
			discard: () => discard(path),
			delete: () =>
				remove(path, async () => {
					const stored = await files.read(path);
					if (stored.error !== null) return stored;
					if (stored.data === undefined) return Ok({ deleted: false });
					return files.delete(
						path,
						new Uint8Array(await stored.data.content.arrayBuffer()),
					);
				}),
			exclusive: (action) =>
				fence([path], BUSY, (files) => action(files.get(path)!)),
		};
	}

	/**
	 * Refuse new input, then wait for fenced actions and send every input
	 * once. Answers the input that did not save. Every call answers the same
	 * completion.
	 */
	function close(): Promise<Pending[]> {
		if (closing !== undefined) return closing;
		// Assigned before the fence publishes, so a listener that closes again
		// answers this same promise.
		const completion = Promise.withResolvers<Pending[]>();
		closing = completion.promise;
		publish(undefined);
		settle().then(completion.resolve, completion.reject);
		return closing;
	}

	return {
		edit,
		exclusive: <T>(
			paths: readonly string[],
			action: (files: ReadonlyMap<string, ExclusiveFile>) => Promise<T>,
		) => fence(paths, BUSY, action),
		stopEditing() {
			if (editingStopped) return;
			editingStopped = true;
			publish(undefined);
		},
		settle,
		close,
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
