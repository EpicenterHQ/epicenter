/**
 * The one owner of each path's editable document over an opened `Folder`.
 * `folderHandle` makes it with the handle, for the handle's whole life;
 * `folder.tables.<name>.edit(id)` and `folder.files.edit(path)` answer
 * passive handles over it, keyed by the file's path. It knows no UI
 * framework or cache.
 *
 * - **Document.** Each path holds what the folder last knew is stored there:
 *   its exact content, no file, or nothing known yet. `read()` reads it and
 *   `getReadStatus()` says what is known and how the last read went. The
 *   handle's own row lists and gets answer the documents of their rows, and
 *   its file reads and saves keep a document already held current; a save
 *   hands over the exact content storage kept, merged with what landed
 *   meanwhile. A read that started before newer knowledge of the path
 *   arrived is older than it and changes nothing. A change another handle
 *   reported is read again for a path someone subscribes to, holds input
 *   for, or reads; any other document stays, as older than the change, so
 *   input typed over it still merges with storage, and is read again once
 *   someone subscribes. A failed read keeps what is known. An action or a
 *   status subscription alone holds no document, and a view that lets go
 *   lets go of its document.
 * - **Text.** A file is text only as strict UTF-8 without NUL; any other
 *   bytes are `not-text`, which a text edit shows nothing of and never
 *   types over. A byte-order mark stays in the text.
 * - **Input.** A row edit holds typed fields and a body; a text edit holds a
 *   file's whole exact text, or a field patch over any Markdown file. One
 *   path holds one input, one save queue and one fence. Row and text views
 *   show that input together. A whole-text change takes over applicable row
 *   or field input; row changes patch held text without another save queue.
 *   `getRow()` answers the stored row with held input put into its source
 *   and read again, so its fields, body, text and issues agree; over a
 *   source whose frontmatter does not parse it shows the held input over it
 *   with the source's issues. Making a handle reads and holds nothing.
 * - **Bases.** A change types over what the edit shows now. Each typed field,
 *   and the body, keeps a base: its value in the document when first typed,
 *   or what the last landed save sent for it, so a value typed back to what
 *   is stored still saves, and a unit nobody typed merges from storage.
 *   Whole text keeps the content it was first typed over, or the text the
 *   last landed save sent. A row save starts from the latest document typed
 *   over whose frontmatter parses, with every base put in; a field patch
 *   rereads the stored file when it saves.
 * - **Saving.** Input saves `saveAfterMs` after its last change, or at once on
 *   `save()`. The saves of one path run one at a time, through the folder's
 *   own `set` and `write`, which merge each with what landed meanwhile. A
 *   landed save lets go of its input at once, unless typing changed it
 *   meanwhile; the document already holds what storage kept, so nothing
 *   waits for a reread.
 * - **A failed save** keeps the input and its error until a save lands or the
 *   input is discarded. Any failed input saves again only on `retry()`
 *   or new input.
 * - **A fence** (`exclusive`, and `delete` on it) takes the path at once,
 *   waits for its running save, sends new input once and refuses if that
 *   fails, then runs alone.
 * - **Close** refuses input and reads from the moment it is called, waits for
 *   fenced actions, sends new input once, and answers what did not save.
 *   Handles and the folder's status still answer what is held afterwards.
 *
 * Every answer of `getRow`, `getText`, `getPending` and `getReadStatus` is
 * immutable and kept until what it answers changes, so a reader can compare
 * it by identity. Each handle's listeners hear their path change.
 */
import { diffArrays } from 'diff';
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderFileOperations, FolderTableOperations } from './folder.js';
import { callObserver } from './observer.js';
import { mergeLinesWith } from './shared/content/merge-lines.js';
import { documentChange, readDocument } from './shared/document.js';
import { ReadError, SaveError } from './shared/errors.js';
import { type FileContent, merge, sameContent } from './shared/merge.js';
import { type Issue, type Row, readRow, rowChange } from './shared/row.js';

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

const GONE =
	'The file no longer exists; discard the field edit before recreating it';

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

/**
 * What one change types into a row: fields by name, where `undefined`
 * removes one, and the whole body. A frontmatter field named `body` is
 * `fields.body`. The owner keeps the values it is given, so pass values the
 * caller does not change afterwards.
 */
export type RowEditChange<TRowSchema extends TSchema = TSchema> = {
	readonly fields?: Readonly<Partial<Static<TRowSchema>>>;
	readonly body?: string;
};

/** One row's input that has not saved. Replaced, never changed, on each change. */
export type RowPending<TRowSchema extends TSchema = TSchema> = {
	readonly kind: 'row';
	readonly path: string;
	readonly table: string;
	readonly id: string;
	/** Typed fields over the row; `undefined` removes a field. */
	readonly fields: Readonly<Partial<Static<TRowSchema>>>;
	/** The typed body, or `undefined` while only fields are typed. */
	readonly body: string | undefined;
	readonly saving: boolean;
	/** Why the last save of this input failed, until one lands. */
	readonly error: SaveError | undefined;
};

/** A file's whole exact text that has not saved. */
export type TextPending = {
	readonly kind: 'text';
	readonly path: string;
	readonly text: string;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

/** Fields typed into any Markdown file, saved over the file as stored then. */
export type FieldsPending = {
	readonly kind: 'fields';
	readonly path: string;
	/** Typed fields by name; `undefined` removes a field, unlike `null`. */
	readonly fields: Readonly<Record<string, unknown>>;
	readonly saving: boolean;
	readonly error: SaveError | undefined;
};

export type Pending<TRowSchema extends TSchema = TSchema> =
	| RowPending<TRowSchema>
	| TextPending
	| FieldsPending;

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

type Edit<TPending, TValue> = {
	readonly path: string;
	/** The held input, or `undefined`; the same value until it changes. */
	getPending(): TPending | undefined;
	/** Whether input is refused: another action holds the file, or the folder closes. */
	isLocked(): boolean;
	/** What is known of the file and how reading it goes; the same value until it changes. */
	getReadStatus(): ReadStatus;
	/**
	 * Read the file now, and answer what the edit shows afterwards:
	 * `undefined` when no file is there, or for a text edit, when it is not
	 * text (`getReadStatus().known` says which). A read that newer knowledge
	 * overtook, such as a save that landed meanwhile, answers what the edit
	 * shows then. A failed read keeps what was shown. A read already running
	 * is joined, with its outcome. Rejects once the folder closes.
	 */
	read(): Promise<Result<TValue | undefined, ReadError>>;
	/**
	 * Call `listener` after anything this edit answers may have changed: its
	 * document, its read status, its input, its fence, or the folder's
	 * close. A document already read, or answered by a row list, stays
	 * current while someone subscribes: one a change another handle reported
	 * overtook is read again, also when the subscription starts. Subscribing
	 * to a path never read asks for no document and reads nothing. Answers
	 * the stop.
	 */
	subscribe(listener: () => void): () => void;
	/** Send new input now, or join its running save. Failed input waits for retry or a change. */
	save(): Promise<void>;
	/** Explicitly attempt held input again, including a failed save. Joins a running save. */
	retry(): Promise<void>;
	/** Let go of held input, answering it so the caller can copy it first. Refused while a save or action runs. */
	discard(): TPending | undefined;
	/** Send held input, then delete the file as it is stored. A file changed meanwhile is kept. */
	delete(): Promise<DeleteResult>;
};

/** Input typed into row `id` of a table, answered by `folder.tables.<name>.edit(id)`. */
export type RowEdit<TRowSchema extends TSchema = TSchema> = Edit<
	Pending<TRowSchema>,
	Row<TRowSchema>
> & {
	/**
	 * The row as last known stored, with held input in it, or `undefined`
	 * while nothing is known or no file is there. Its issues say whether it
	 * fits the schema with what is typed. Reads nothing.
	 */
	getRow(): Row<TRowSchema> | undefined;
	/**
	 * Type `change` over the row `getRow()` answers now. Fields and body are
	 * taken together, as one change. Answers `Ok` when accepted into memory,
	 * or the refusal reason. Acceptance does not mean saved: a later save
	 * reports through `getPending().error` and folder status.
	 */
	change(change: RowEditChange<TRowSchema>): ChangeResult;
};

/** A file's whole text or a field patch over it, answered by `folder.files.edit(path)`. */
export type TextEdit = Edit<Pending, string> & {
	/**
	 * The held text, the held fields over the stored file, or the stored
	 * file as text with any byte-order mark kept; `undefined` while nothing
	 * is known or held, no file is there, or it is not text. Reads nothing.
	 */
	getText(): string | undefined;
	/**
	 * Type `text` as the whole file over what `getText()` answers now. Typed
	 * over held fields, it keeps them in its text and takes the place of
	 * the field patch. Refused over a file that is not text.
	 */
	change(text: string): ChangeResult;
	/**
	 * Type `fields` into the file's frontmatter, adding a frontmatter block
	 * if there is none: into held text, or as a patch the save applies to
	 * the file as stored then, which needs nothing read. Refused when the
	 * fields do not apply to what is known, and over a file known to be
	 * missing or not text.
	 */
	changeFields(fields: Readonly<Record<string, unknown>>): ChangeResult;
	/**
	 * Take the file alone: input is refused from now on, held input is sent
	 * once, and `action` runs only if it saved. Refused while another action
	 * holds the file or the folder closes. `action` reads and saves the file
	 * through `file`, which still works while the folder closes, so an action
	 * already taken finishes; close waits for it. Nothing it reads or saves
	 * is held for the edit.
	 */
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
 * The folder's line merge of whole texts, the rule a save applies to a body
 * or to text (ADR-0622): what `change` did to `base`, merged into `current`;
 * where both changed one region, `change` wins.
 */
export function mergeText(base: string, current: string, change: string) {
	if (base === current) return change;
	return mergeLinesWith(diffArrays, { base, current, change }).content;
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

type RowInput = {
	readonly kind: 'row';
	readonly pending: RowPending;
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
	readonly revision: number;
};

type FieldsInput = {
	readonly kind: 'fields';
	readonly pending: FieldsPending;
	readonly revision: number;
};

type Input = RowInput | TextInput | FieldsInput;

/** What a field patch's save read and sent, so text typed meanwhile can take in its fields. */
type Prepared = { readonly read: Uint8Array; readonly sent: string };

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
	parsed: { readonly content: FileContent; readonly row: Row } | undefined;
	decoded:
		| { readonly content: FileContent; readonly text: string | undefined }
		| undefined;
	/** What `getRow` and `getText` answered, while their inputs hold. */
	row: Kept<Row | undefined> | undefined;
	text: Kept<string | undefined> | undefined;
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

/** A row's fields as a record, whether or not they fit its schema. */
const fieldsOf = (row: Pick<Row, 'fields'>): Record<string, unknown> =>
	row.fields as Record<string, unknown>;

/** Whether the source's frontmatter parses, so fields can be put into it. */
const parses = ({ issues }: Source) =>
	issues === null || issues.every((issue) => issue.kind === 'schema');

/** Whether a row's source is not text, as a row list reads one without its bytes. */
const notText = ({ issues }: Pick<Row, 'issues'>) =>
	issues?.some((issue) => issue.kind === 'not-text') ?? false;

/** The fields and body typed, as a change of the row's source. */
const changeOf = ({ fields, body }: RowPending) => ({
	fields:
		Object.keys(fields).length === 0
			? undefined
			: (fields as Record<string, unknown>),
	body,
});

/** The row a row input's save starts from: its source with every base put in. */
function baseOf({ source, bases }: RowInput): Source {
	const fields =
		Object.keys(bases.fields).length === 0 ? undefined : bases.fields;
	if (fields === undefined && bases.body === undefined) return source;
	const based = rowChange(source, { fields, body: bases.body });
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
) {
	return documentChange(readDocument(path, bytesOf(content)), change);
}

function withState(
	input: Input,
	state: { saving: boolean; error: SaveError | undefined },
): Input {
	switch (input.kind) {
		case 'row':
			return { ...input, pending: { ...input.pending, ...state } };
		case 'text':
			return { ...input, pending: { ...input.pending, ...state } };
		case 'fields':
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
	tables,
	schemas,
	saveAfterMs,
	onAggregate,
}: {
	readonly files: FolderFileOperations;
	readonly tables: Readonly<Record<string, FolderTableOperations>>;
	/** Each table's schema, to read a row from its stored text. */
	readonly schemas: Readonly<Record<string, TSchema>>;
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
				parsed: undefined,
				decoded: undefined,
				row: undefined,
				text: undefined,
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
			if (!seed || tick < floor) return false;
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
			know(path, state ?? stateOf(path), undefined, ++clock);
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
	async function read<T>(
		path: string,
		answer: () => T,
	): Promise<Result<T, ReadError>> {
		if (closing !== undefined) throw new Error('The folder is closed');
		for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
			const outcome = await readPath(path, states.get(path)?.asOf ?? floor);
			if (outcome.error !== null) return { data: null, error: outcome.error };
			if (outcome.newest) break;
			// Overtaken: what it read is held as older than the reported change,
			// which another read answers next.
		}
		return Ok(answer());
	}

	const isLocked = (state: PathState | undefined) =>
		closing !== undefined || state?.action !== undefined;

	function rowsOf(table: string) {
		const rows = tables[table];
		if (rows === undefined) throw new Error(`No table ${table}`);
		return rows;
	}

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
	 * Send new input, or join a running save. Every failed revision waits
	 * for explicit retry or new input. An action sends its held input itself.
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
		if (input === undefined || input.pending.error !== undefined)
			return Promise.resolve();
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
	function requested(path: string, retry = false): Promise<void> {
		if (closing !== undefined) return close().then(() => {});
		const state = states.get(path);
		if (
			retry &&
			state !== undefined &&
			!isLocked(state) &&
			state.running === undefined &&
			state.input?.pending.error !== undefined
		) {
			setInput(
				path,
				state,
				withState(state.input, { saving: false, error: undefined }),
			);
		}
		// Clearing the error publishes: a listener may have saved, changed,
		// discarded, fenced or closed meanwhile. Never reinstall that input.
		if (closing !== undefined) return close().then(() => {});
		return flush(path);
	}

	async function send(
		path: string,
		input: Input,
	): Promise<{ error: SaveError | null; prepared?: Prepared }> {
		try {
			switch (input.kind) {
				case 'text':
					return await files.write(path, input.from, input.pending.text);
				case 'row': {
					const { table, id } = input.pending;
					// Typing only the body is no field edit, which a row whose
					// frontmatter does not parse would refuse.
					return await rowsOf(table).set(
						id,
						baseOf(input),
						changeOf(input.pending),
					);
				}
				case 'fields': {
					const stored = await files.read(path);
					if (stored.error !== null)
						return {
							error: SaveError.StorageFailed({ cause: stored.error }).error,
						};
					if (stored.data === undefined)
						return { error: SaveError.Unparseable({ reason: GONE }).error };
					const read = new Uint8Array(await stored.data.content.arrayBuffer());
					const patched = changed(path, read, {
						fields: input.pending.fields,
					});
					if (patched.error !== null)
						return {
							error: SaveError.Unparseable({ reason: patched.error.reason })
								.error,
						};
					return {
						...(await files.write(path, read, patched.data.text)),
						prepared: { read, sent: patched.data.text },
					};
				}
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
		if (after.kind === 'row' && before.kind === 'row') {
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
				after.pending.text === before.pending.text
					? undefined
					: {
							...after,
							from: before.pending.text,
							pending: { ...after.pending, ...cleared },
						},
			);
			return;
		}
		if (after.kind === 'fields' && before.kind === 'fields') {
			const sent = before.pending.fields;
			let fields: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(after.pending.fields))
				if (!Object.hasOwn(sent, key) || !Object.is(sent[key], value))
					fields = withValue(fields, key, value);
			setInput(
				path,
				state,
				Object.keys(fields).length === 0
					? undefined
					: { ...after, pending: { ...after.pending, fields, ...cleared } },
			);
			return;
		}
		setInput(path, state, withState(after, cleared));
		if (before.kind === 'row') {
			const base = baseOf(before);
			const sent = rowChange(base, changeOf(before.pending));
			if (sent.error === null)
				prepared = { read: bytesOf(base.text), sent: sent.data.text };
		}
		if (
			after.kind !== 'text' ||
			(before.kind !== 'fields' && before.kind !== 'row') ||
			prepared === undefined
		)
			return;
		// Text typed over a row or field patch while it saved keeps the content the
		// person saw, which may lack a change the save merged from storage.
		// Rebase that content by what the patch sent, so the landed fields are
		// in it and a later revert of them in the text is a change.
		const rebased = await merge(path, {
			base: prepared.read,
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
				if (input === undefined || input.pending.error !== undefined) return;
				setInput(
					path,
					state,
					withState(input, { saving: true, error: input.pending.error }),
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
					// publication. Only the failed revision must wait for retry.
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
	 * Send each eligible path once, after fenced actions; answers the input
	 * that did not save. Failed revisions stay held for retry or new input.
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
	 * Take `path` before the first await, wait for its running save, send held
	 * input once, and run `action` only if nothing stays unsaved. `action`
	 * reaches the file through its own `file`, which works while the folder
	 * closes, so an action already taken can finish, and ends with it.
	 */
	function fence<T>(
		path: string,
		reason: string,
		action: (file: ExclusiveFile) => Promise<T>,
	): Promise<Result<T, ActionError>> {
		if (closing !== undefined)
			return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
		const state = stateOf(path);
		if (state.action !== undefined)
			return Promise.resolve(
				ActionError.NotStarted({ reason: state.action.reason }),
			);
		state.action = { reason };
		clearTimer(state);
		let taken = true;
		const ended = () => {
			if (!taken)
				throw new Error('This exclusive change of the file has ended');
		};
		const file: ExclusiveFile = {
			path,
			read: () => (ended(), files.read(path)),
			write: (from, content) => (ended(), files.write(path, from, content)),
			delete: (from) => (ended(), files.delete(path, from)),
		};
		const work = (async (): Promise<Result<T, ActionError>> => {
			try {
				await state.running;
				if (state.input !== undefined) {
					await flush(path, true);
					if (state.input !== undefined)
						return ActionError.NotStarted({ reason: UNSAVED });
				}
				return Ok(await action(file));
			} finally {
				taken = false;
				state.action = undefined;
			}
		})();
		actions.add(work);
		const done = () => {
			actions.delete(work);
			publish(path);
		};
		work.then(done, done);
		publish(path);
		return work;
	}

	/** Delete the file as `action` finds it stored. */
	async function remove(
		path: string,
		action: () => Promise<Result<{ deleted: boolean }, SaveError | ReadError>>,
	): Promise<DeleteResult> {
		const outcome = await fence(path, DELETING, async () => {
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
					now.parsed = undefined;
					now.decoded = undefined;
					now.row = undefined;
					now.text = undefined;
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

	/** The stored document of `path` read as row `id`. */
	function storedRow(state: PathState, id: string, schema: TSchema) {
		const content = state.doc;
		if (content === undefined || content === null) return undefined;
		if (state.parsed?.content !== content)
			state.parsed = { content, row: readRow(id, content, schema) };
		return state.parsed.row;
	}

	/** The stored document as text, or `undefined` when it is not text. */
	function decodedOf(state: PathState, content: FileContent) {
		if (state.decoded?.content !== content)
			state.decoded = { content, text: textOf(content) };
		return state.decoded.text;
	}

	function lockReason(state: PathState | undefined) {
		return closing !== undefined ? CLOSING : state?.action?.reason;
	}

	/** Why typed fields do not apply over a row whose frontmatter does not parse. */
	const UNAPPLIED: Issue = {
		kind: 'frontmatter',
		message: 'The typed fields do not apply to this file as it is stored.',
		path: [],
	};

	/** The path's current text, with every applicable unsaved change over its document. */
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
			input.kind === 'row'
				? changeOf(input.pending)
				: { fields: input.pending.fields },
		);
		if (put.error === null) return put.data.text;
		// A broken header may refuse fields while still accepting the held body.
		// Unapplied fields remain in pending for copying, retry or explicit discard.
		if (input.kind === 'row' && input.pending.body !== undefined) {
			const body = changed(path, stored, { body: input.pending.body });
			if (body.error === null) return body.data.text;
		}
		return stored;
	}

	function row(table: string, id: string): RowEdit {
		const path = rowPath(table, id);
		const schema: TSchema | undefined = schemas[table];
		if (schema === undefined) throw new Error(`No table ${table}`);
		/** Read the shared editable text as this table's row. */
		function shown(state: PathState): Row | undefined {
			const stored = storedRow(state, id, schema as TSchema);
			const input = state.input;
			if (stored === undefined || input === undefined) return stored;
			const text = shownText(path, state);
			const row =
				text === undefined ? stored : readRow(id, text, schema as TSchema);
			if (input.kind === 'text' || parses(row)) return row;
			// Fields that cannot be put into the source stay visible as invalid input.
			return {
				...row,
				fields: { ...fieldsOf(row), ...input.pending.fields },
				body: input.kind === 'row' ? (input.pending.body ?? row.body) : row.body,
				issues: row.issues ?? [UNAPPLIED],
			} as Row;
		}
		const getRow = (): Row | undefined => {
			const state = states.get(path);
			if (state === undefined) return undefined;
			state.row = kept(state.row, state, () => shown(state));
			return state.row.value;
		};
		const getReadStatus = () => {
			const state = states.get(path);
			return state === undefined ? NOTHING : statusOf(state);
		};
		return {
			path,
			getRow,
			getPending: () => states.get(path)?.input?.pending,
			isLocked: () => isLocked(states.get(path)),
			getReadStatus,
			read: () => read(path, getRow),
			subscribe: (listener) => subscribeTo(path, listener),
			change(change) {
				const state = states.get(path);
				const reason = lockReason(state);
				if (reason !== undefined) return ChangeError.Locked({ reason });
				const input = state?.input;
				const typed = (change.fields ?? {}) as Record<string, unknown>;
				const keys = Object.keys(typed);
				if (keys.length === 0 && change.body === undefined)
					return Ok(undefined);
				const stored =
					state === undefined ? undefined : storedRow(state, id, schema);
				if (stored === undefined) return ChangeError.NoSource();
				if (notText(stored)) return ChangeError.NotText();
				if (input !== undefined && input.kind !== 'row') {
					const current = shown(state as PathState);
					const put = rowChange(current as Row, change);
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
					return text(path).change(put.data.text);
				}
				// A unit not held yet starts from the document it is typed over;
				// one already held is replaced, a revert included.
				let fields: Record<string, unknown> = input?.pending.fields ?? {};
				let baseFields = input?.bases.fields ?? {};
				for (const key of keys) {
					if (!Object.hasOwn(fields, key))
						baseFields = withValue(
							baseFields,
							key,
							fieldValue(fieldsOf(stored), key),
						);
					fields = withValue(fields, key, typed[key]);
				}
				let body = input?.pending.body;
				let baseBody = input?.bases.body;
				if (change.body !== undefined) {
					if (body === undefined) baseBody = stored.body;
					body = change.body;
				}
				const source: Source = { text: stored.text, issues: stored.issues };
				const pending: RowPending = {
					kind: 'row',
					path,
					table,
					id,
					fields,
					body,
					saving: input?.pending.saving ?? false,
					error: undefined,
				};
				// Over a source that parses, what is typed must make a row.
				if (parses(source)) {
					const put = rowChange(source, changeOf(pending));
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
				}
				const next = stateOf(path);
				setInput(path, next, {
					kind: 'row',
					pending,
					source:
						input === undefined || parses(source) || !parses(input.source)
							? source
							: input.source,
					bases: { fields: baseFields, body: baseBody },
					revision: ++revisions,
				});
				schedule(path, next);
				return Ok(undefined);
			},
			save: () => requested(path),
			retry: () => requested(path, true),
			discard: () => discard(path),
			delete: () =>
				remove(path, async () => {
					const rows = rowsOf(table);
					const stored = await rows.get(id);
					if (stored.error !== null) return stored;
					if (stored.data === undefined) return Ok({ deleted: false });
					return rows.delete(id, stored.data);
				}),
		};
	}

	function text(path: string): TextEdit {
		const getText = (): string | undefined => {
			const state = states.get(path);
			if (state === undefined) return undefined;
			state.text = kept(state.text, state, () => shownText(path, state));
			return state.text.value;
		};
		/** The stored text a new input starts from, or why there is none. */
		function storedText(
			state: PathState | undefined,
		): Result<string, ChangeError> {
			const doc = state?.doc;
			if (state === undefined || doc === undefined || doc === null)
				return ChangeError.NoSource();
			const stored = decodedOf(state, doc);
			return stored === undefined ? ChangeError.NotText() : Ok(stored);
		}
		return {
			path,
			getText,
			getPending: () => states.get(path)?.input?.pending,
			isLocked: () => isLocked(states.get(path)),
			getReadStatus: () => {
				const state = states.get(path);
				return state === undefined ? NOTHING : statusOf(state);
			},
			read: () => read(path, getText),
			subscribe: (listener) => subscribeTo(path, listener),
			change(typed) {
				const state = states.get(path);
				const reason = lockReason(state);
				if (reason !== undefined) return ChangeError.Locked({ reason });
				const input = state?.input;
				let from: FileContent;
				if (input?.kind === 'text') from = input.from;
				else if (input?.kind === 'row') {
					const stored = storedText(state);
					if (stored.error !== null) return stored;
					const preview = changed(path, stored.data, changeOf(input.pending));
					if (preview.error !== null)
						return ChangeError.InvalidFields({ reason: preview.error.reason });
					// Untyped units start from the latest document the person saw;
					// only the row's held units keep their earlier merge bases.
					from = baseOf({ ...input, source: readDocument(path, bytesOf(stored.data)) }).text;
				} else {
					const stored = storedText(state);
					if (stored.error !== null) return stored;
					if (input?.kind === 'fields') {
						const preview = changed(path, stored.data, {
							fields: input.pending.fields,
						});
						if (preview.error !== null)
							return ChangeError.InvalidFields({
								reason: preview.error.reason,
							});
					}
					from = owned(state?.doc as FileContent);
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
					revision: ++revisions,
				});
				schedule(path, target);
				return Ok(undefined);
			},
			changeFields(fields) {
				const state = states.get(path);
				const reason = lockReason(state);
				if (reason !== undefined) return ChangeError.Locked({ reason });
				const input = state?.input;
				if (input?.kind === 'row')
					return row(input.pending.table, input.pending.id).change({ fields });
				let next: TextInput | FieldsInput;
				if (input?.kind === 'text') {
					const put = changed(path, input.pending.text, { fields });
					if (put.error !== null)
						return ChangeError.InvalidFields({ reason: put.error.reason });
					next = {
						...input,
						pending: {
							...input.pending,
							text: put.data.text,
							error: undefined,
						},
						revision: ++revisions,
					};
				} else {
					let patch: Record<string, unknown> = input?.pending.fields ?? {};
					for (const [key, value] of Object.entries(fields))
						patch = withValue(patch, key, value);
					// A patch applies to the file as stored when it saves, so it
					// needs nothing read; what is known must take it.
					if (state?.doc !== undefined) {
						const stored = storedText(state);
						if (stored.error !== null) return stored;
						const put = changed(path, stored.data, { fields: patch });
						if (put.error !== null)
							return ChangeError.InvalidFields({ reason: put.error.reason });
					}
					next = {
						kind: 'fields',
						pending: {
							kind: 'fields',
							path,
							fields: patch,
							saving: input?.pending.saving ?? false,
							error: undefined,
						},
						revision: ++revisions,
					};
				}
				const target = stateOf(path);
				setInput(path, target, next);
				schedule(path, target);
				return Ok(undefined);
			},
			save: () => requested(path),
			retry: () => requested(path, true),
			discard: () => discard(path),
			delete: () =>
				remove(path, async () => {
					const stored = await files.read(path);
					if (stored.error !== null) return stored;
					if (stored.data === undefined) return Ok({ deleted: false });
					const bytes = new Uint8Array(await stored.data.content.arrayBuffer());
					return files.delete(path, bytes);
				}),
			exclusive: (action) => fence(path, BUSY, action),
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
		row,
		text,
		settle,
		close,
		get aggregate() {
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
		/** Whether `path` holds a document a file read should keep current. */
		holds(path: string) {
			return states.get(path)?.doc !== undefined;
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
		/** A read of file `path` started at `tick` answered `content`; kept only for a path held. */
		readFile(path: string, tick: number, content: Uint8Array | null) {
			if (answered(path, tick, content, false)) readFine(path, tick);
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
