/**
 * The one owner of unsaved input over an opened `Folder`. `folderHandle`
 * makes it with the handle, for the handle's whole life;
 * `folder.tables.<name>.edit(id)` and `folder.files.edit(path)` answer
 * passive handles over it, keyed by the file's path. It knows no UI
 * framework or cache.
 *
 * - **Input.** A row edit holds typed fields and a body; a text edit holds a
 *   file's whole exact text, or a field patch over any Markdown file. One
 *   path holds one input, one save queue and one fence. Field input may turn
 *   into text input, never the reverse, and a row's input excludes both.
 *   Making a handle reads and holds nothing.
 * - **Sources.** Each change names the source the person saw: a `source`
 *   that `shown` answered, or any row or bytes the caller names. A shown
 *   source also remembers what that view showed over it, held input
 *   included, so a change from a view that showed older input than is held
 *   now merges into the held input rather than replacing it, and a change
 *   from a view that showed the held input replaces it, a revert included.
 *   Each typed field, and the body, has a base: the value the person saw when
 *   first typing it, or what the last landed save sent for it. A row save
 *   starts from the latest source whose frontmatter parses, with every base
 *   put in. A field patch rereads the stored file when it saves. Units
 *   nobody typed merge from storage.
 * - **Saving.** Input saves `saveAfterMs` after its last change, or at once on
 *   `save()`. The saves of one path run one at a time, through the folder's
 *   own `set` and `write`, which merge each with what landed meanwhile. A
 *   landed save lets go of its input at once, unless typing changed it
 *   meanwhile, and nothing waits for a reread.
 * - **Own saves a read may not show yet.** Each landed save leaves the path's
 *   committed contribution: the whole text the person meant, composed from
 *   what the save changed over its source and the earlier contributions, and
 *   the last value of each field and of the body, each numbered by the
 *   commit that landed it. Each read of the handle notes, on the rows and
 *   file contents it answers, the commit count when it started
 *   (`shared/observation.ts`). `shown(observed)` puts back each contribution
 *   newer than the read that answered `observed`; a value no read of this
 *   handle answered is taken as older than every own save. Contributions
 *   stay until the file is deleted or the folder closes; a failed read never
 *   replays a save.
 * - **A failed save** keeps the input and its error until a save lands or the
 *   input is discarded. A failed field patch saves again only on `retry()`
 *   or new input.
 * - **A fence** (`exclusive`, and `delete` on it) takes the path at once,
 *   waits for its running save, sends held input once and refuses if that
 *   fails, then runs alone.
 * - **Close** refuses input from the moment it is called, waits for fenced
 *   actions, sends every input once, and answers what did not save. Handles
 *   and the folder's status still read what is held afterwards.
 *
 * Every pending value is immutable and replaced on each change, so a reader
 * can compare it by identity. Listeners hear the path that changed, or
 * `undefined` when every path may read differently.
 */
import { diffArrays } from 'diff';
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderFileOperations, FolderTableOperations } from './folder.js';
import { callObserver } from './observer.js';
import { mergeLinesWith } from './shared/content/merge-lines.js';
import { documentChange, readDocument } from './shared/document.js';
import { type ReadError, SaveError } from './shared/errors.js';
import { type FileContent, merge } from './shared/merge.js';
import { noteRead, readOf } from './shared/observation.js';
import { type Row, readRow, rowChange } from './shared/row.js';

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
	'This file has unsaved changes. Save or discard them first.';

const GONE =
	'The file no longer exists; discard the field edit before recreating it';

/**
 * An action refused before it changed anything, with the reason: the folder
 * is closing, another action holds the file, its input did not save.
 */
export const ActionError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type ActionError = InferErrors<typeof ActionError>;

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

export type Pending = RowPending | TextPending | FieldsPending;

/** A delete's outcome: whether the file went, or why nothing started. */
export type DeleteResult = Result<
	{ deleted: boolean },
	SaveError | ReadError | ActionError
>;

/**
 * What a view shows of a row: `source` is the observed row with this
 * handle's own saves that its read may not show, the source the next change
 * from this view names; `row` is `source` with held input over it.
 */
export type RowShown<TRow> = { readonly source: TRow; readonly row: TRow };

/**
 * What a view shows of a file: `source` is the observed bytes with this
 * handle's own saves that its read may not show, the source the next change
 * from this view names, or `undefined` with no observed bytes; `text` is the
 * held text, the held fields over `source`, or `source` decoded with any
 * byte-order mark kept. With no observed bytes, `text` is held input or this
 * handle's own saved text, for reading and copying only.
 */
export type TextShown = {
	readonly source: Uint8Array | undefined;
	readonly text: string | undefined;
};

type Edit<TPending> = {
	readonly path: string;
	/** The held input, or `undefined`; the same value until it changes. */
	readonly pending: TPending | undefined;
	/** Whether input is refused: another action holds the file, or the folder closes. */
	readonly locked: boolean;
	/**
	 * Call `listener` after every change of held input or own saves, with the
	 * path that changed, or `undefined` when every path may read differently.
	 * Every handle of a folder shares one function. Answers the stop.
	 */
	subscribe(listener: (path: string | undefined) => void): () => void;
	/** Let go of held input, answering it so the caller can copy it first. Refused while a save or action runs. */
	discard(): TPending | undefined;
	/** Send held input, then delete the file as it is stored. A file changed meanwhile is kept. */
	delete(): Promise<DeleteResult>;
};

/** Input typed into row `id` of a table, answered by `folder.tables.<name>.edit(id)`. */
export type RowEdit<TRowSchema extends TSchema = TSchema> = Edit<
	RowPending<TRowSchema>
> & {
	/**
	 * What a view of `observed` shows. The same value until `observed`, held
	 * input or own saves change; each new value has a `source` of its own.
	 */
	shown<TRow extends Row<TRowSchema>>(observed: TRow): RowShown<TRow>;
	/**
	 * Type `change` over `source`, the row the person saw: a `shown(...)`
	 * source, or any row the caller names. Fields and body are taken together,
	 * as one change. Answers whether it was taken: nothing is while the
	 * folder closes or an action holds the file, or while its text is held.
	 */
	change(source: Row<TRowSchema>, change: RowEditChange<TRowSchema>): boolean;
	/** Save what is held now, a failed save included; resolves once no save of it runs. */
	save(): Promise<void>;
};

/** A file's whole text or a field patch over it, answered by `folder.files.edit(path)`. */
export type TextEdit = Edit<TextPending | FieldsPending> & {
	/**
	 * What a view of `observed` shows. The same value until `observed`, held
	 * input or own saves change; each new value has a `source` of its own.
	 */
	shown(observed: Uint8Array | undefined): TextShown;
	/**
	 * Type `text` as the whole file over `source`, the bytes the person saw.
	 * The first change keeps a copy of what it was typed over; later typing
	 * keeps that, and may pass `undefined` when it typed over held text.
	 * Typed over held fields, it keeps them in its text and takes the place
	 * of the field patch.
	 */
	change(source: Uint8Array | undefined, text: string): boolean;
	/**
	 * Type `fields` into the file's frontmatter over `source`, adding a
	 * frontmatter block if there is none: into held text, or as a patch the
	 * save applies to the file as stored then. Refused when the fields do
	 * not apply.
	 */
	changeFields(
		source: Uint8Array | undefined,
		fields: Readonly<Record<string, unknown>>,
	): boolean;
	/** Save what is held now; a failed field patch waits for `retry`. */
	save(): Promise<void>;
	/** Save what is held now, a failed field patch included. */
	retry(): Promise<void>;
	/**
	 * Take the file alone: input is refused from now on, held input is sent
	 * once, and `action` runs only if it saved. Refused while another action
	 * holds the file or the folder closes. `action` reads and saves the file
	 * through `file`, which still works while the folder closes, so an action
	 * already taken finishes; close waits for it.
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

/** Which failed field patches a send repeats; see `flush`. */
type Retry = 'any' | 'storage' | 'none';

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
	/** The latest source typed over, preferring one whose frontmatter parses. */
	readonly source: Source;
	/** The base of each typed unit: as the person saw it first, or as last sent. */
	readonly bases: {
		readonly fields: Record<string, unknown>;
		readonly body: string | undefined;
		/** Up to which commit the body base already holds or supersedes own saves. */
		readonly bodyAsOf: number;
	};
	/** Changes with each change, so a landed save knows whether typing followed it. */
	readonly revision: number;
};

type TextInput = {
	readonly kind: 'text';
	readonly pending: TextPending;
	/** The content the typing started from, or the text the last landed save sent. */
	readonly from: FileContent;
	/** Up to which commit `from` already holds or supersedes own saves. */
	readonly fromAsOf: number;
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

/** A path's committed contribution: each unit with the commit that landed it. */
type Retained = {
	text: { readonly content: FileContent; readonly commit: number } | undefined;
	readonly fields: Map<
		string,
		{ readonly value: unknown; readonly commit: number }
	>;
	body: { readonly value: string; readonly commit: number } | undefined;
};

/**
 * What one view showed over the `source` that `shown` answered it, and up to
 * which commit that source holds or supersedes own saves: its read, or a
 * later own save it was shown with.
 */
type Presentation =
	| {
			readonly kind: 'row';
			readonly path: string;
			readonly asOf: number;
			readonly fields: Record<string, unknown>;
			readonly body: string;
	  }
	| {
			readonly kind: 'text';
			readonly path: string;
			readonly asOf: number;
			/** The text shown, held input included. */
			readonly text: string | undefined;
			/** The content that text was over: held text or fields, or the source. */
			readonly from: FileContent | undefined;
	  };

type Memo = { path: string; version: number; read: number; value: unknown };

type PathState = {
	input: Input | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The save loop, while one runs. */
	running: Promise<void> | undefined;
	/** Asked to save again while a save ran. */
	again: boolean;
	/** The action holding the path, while one runs. */
	action: { readonly reason: string } | undefined;
	retained: Retained | undefined;
	/** Changes whenever what `shown` answers may change. */
	version: number;
	/** `shown(undefined)`, the one observation no object identifies. */
	missing: Memo | undefined;
};

/** What the owner tells the handle: input held, failures, and whether work runs. */
export type EditAggregate = {
	readonly unsaved: readonly string[];
	readonly failures: readonly Pending[];
	readonly working: boolean;
};

const rowPath = (table: string, id: string) => `${table}/${id}.md`;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const bytesOf = (content: FileContent) =>
	typeof content === 'string' ? encoder.encode(content) : content;
const textOf = (content: FileContent) =>
	typeof content === 'string' ? content : decoder.decode(content);
/** A copy the caller cannot change afterwards. */
const owned = (content: FileContent) =>
	typeof content === 'string' ? content : content.slice();

/** The line merge of what `change` did to `base` into `current`, at once. */
const mergeText = (base: string, current: string, change: string) =>
	mergeLinesWith(diffArrays, { base, current, change }).content;

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

const valueOf = (fields: Record<string, unknown>, key: string) =>
	Object.hasOwn(fields, key) ? fields[key] : undefined;

/** A row's fields as a record, whether or not they fit its schema. */
const fieldsOf = (row: Pick<Row, 'fields'>): Record<string, unknown> =>
	row.fields as Record<string, unknown>;

function ownSource({ text, issues }: Source): Source {
	return {
		text,
		issues:
			issues === null
				? null
				: issues.map((issue) => ({ ...issue, path: [...issue.path] })),
	};
}

/** Whether the source's frontmatter parses, so fields can be put into it. */
const parses = ({ issues }: Source) =>
	issues === null || issues.every((issue) => issue.kind === 'schema');

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

const NOTHING_SHOWN: TextShown = { source: undefined, text: undefined };

/**
 * Make the edit owner over a folder handle's own storage operations. They
 * are tracked like the handle's public calls but stay open while its close
 * sends held input; `folderHandle` makes one owner per handle.
 */
export function createEditOwner({
	files,
	tables,
	schemas,
	saveAfterMs,
	onAggregate,
	receipt,
}: {
	readonly files: FolderFileOperations;
	readonly tables: Readonly<Record<string, FolderTableOperations>>;
	/** Each table's schema, to read a row back from text this handle saved. */
	readonly schemas: Readonly<Record<string, TSchema>>;
	readonly saveAfterMs?: number;
	/** Called after anything `aggregate` reports may have changed. */
	readonly onAggregate: () => void;
	/** The commit a save of `files` or `tables` landed as, once it resolved. */
	readonly receipt: (saving: Promise<unknown>) => number | undefined;
}) {
	const pause = saveDelay(saveAfterMs);
	const states = new Map<string, PathState>();
	/** Paths with input held, kept for the aggregate. */
	const held = new Set<string>();
	const listeners = new Set<(path: string | undefined) => void>();
	/** Fenced actions running, which settle and close wait for. */
	const actions = new Set<Promise<unknown>>();
	const memos = new WeakMap<object, Memo>();
	const presentations = new WeakMap<object, Presentation>();
	/** What the handle's reads are noted under (`shared/observation.ts`). */
	const self = {};
	let fenced = false;
	let revisions = 0;
	let versions = 0;
	/** How many saves of this handle have landed, its own no-op saves included. */
	let commits = 0;
	let saves = 0;
	let aggregate: EditAggregate = { unsaved: [], failures: [], working: false };
	let closing: Promise<Pending[]> | undefined;

	function subscribe(listener: (path: string | undefined) => void) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	function stateOf(path: string): PathState {
		let state = states.get(path);
		if (state === undefined) {
			state = {
				input: undefined,
				timer: undefined,
				running: undefined,
				again: false,
				action: undefined,
				retained: undefined,
				version: ++versions,
				missing: undefined,
			};
			states.set(path, state);
		}
		return state;
	}

	/** Forget a path that holds nothing. */
	function prune(path: string) {
		const state = states.get(path);
		if (
			state !== undefined &&
			state.input === undefined &&
			state.timer === undefined &&
			state.running === undefined &&
			state.action === undefined &&
			state.retained === undefined
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

	function publish(path: string | undefined) {
		if (path !== undefined) {
			const state = states.get(path);
			if (state !== undefined) state.version = ++versions;
			prune(path);
		}
		for (const listener of [...listeners])
			callObserver('edit listener', listener, path);
		updateAggregate();
	}

	function setInput(path: string, state: PathState, input: Input | undefined) {
		state.input = input;
		if (input === undefined) held.delete(path);
		else held.add(path);
		publish(path);
	}

	const isLocked = (state: PathState | undefined) =>
		fenced || state?.action !== undefined;

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
	 * Send the path's input now; resolves once no save of it runs. A failed
	 * field patch is sent again only as `retry` says: `'any'` on `retry()`
	 * and new input; `'storage'` at close, one last time when storage failed,
	 * never after a refusal that would refuse again, or that a file created
	 * or repaired since would turn into a change nobody saw; `'none'`
	 * otherwise. Row and text input is always sent. While an action holds
	 * the path, the action sends held input itself, so this starts nothing.
	 */
	function flush(path: string, retry: Retry = 'any', forAction = false) {
		const state = states.get(path);
		if (state === undefined) return Promise.resolve();
		clearTimer(state);
		if (state.action !== undefined && !forAction) return Promise.resolve();
		const input = state.input;
		const error = input?.kind === 'fields' ? input.pending.error : undefined;
		if (
			error !== undefined &&
			(retry === 'none' ||
				(retry === 'storage' && error.name !== 'StorageFailed'))
		)
			return Promise.resolve();
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
		drain(path, state)
			.finally(() => {
				state.running = undefined;
				saves--;
				publish(path);
			})
			.then(started.resolve, started.reject);
		return started.promise;
	}

	/**
	 * A save asked for from outside: from close on, nothing new is sent, and
	 * the asker waits for close, which sends held input once itself.
	 */
	function requested(path: string, retry: Retry): Promise<void> {
		if (closing !== undefined) return closing.then(() => {});
		return flush(path, retry);
	}

	/** A save's outcome, with the commit it landed as when it did. */
	async function landedAs(saving: Promise<Result<unknown, SaveError>>) {
		const { error } = await saving;
		return { error, at: receipt(saving) };
	}

	async function send(
		path: string,
		input: Input,
	): Promise<{
		error: SaveError | null;
		at?: number | undefined;
		prepared?: Prepared;
	}> {
		try {
			switch (input.kind) {
				case 'text':
					return await landedAs(
						files.write(path, input.from, input.pending.text),
					);
				case 'row': {
					const { table, id, fields, body } = input.pending;
					return await landedAs(
						rowsOf(table).set(id, baseOf(input), {
							// Typing only the body is no field edit, which a row whose
							// frontmatter does not parse would refuse.
							fields:
								Object.keys(fields).length === 0
									? undefined
									: (fields as Record<string, unknown>),
							body,
						}),
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
						...(await landedAs(files.write(path, read, patched.data.text))),
						prepared: { read, sent: patched.data.text },
					};
				}
			}
		} catch (cause) {
			return { error: SaveError.StorageFailed({ cause }).error };
		}
	}

	/**
	 * The path's own contributions over `content`: the last whole text in place
	 * of it, then later fields and body. `undefined` when there are none.
	 */
	function ownOver(
		path: string,
		retained: Retained | undefined,
		content: FileContent | undefined,
		after = -1,
	): FileContent | undefined {
		if (retained === undefined) return undefined;
		const text =
			retained.text !== undefined && retained.text.commit > after
				? retained.text.content
				: undefined;
		let fields: Record<string, unknown> | undefined;
		for (const [key, unit] of retained.fields)
			if (unit.commit > after) fields = withValue(fields ?? {}, key, unit.value);
		const body =
			retained.body !== undefined && retained.body.commit > after
				? retained.body.value
				: undefined;
		const start = text ?? content;
		if (start === undefined) return undefined;
		if (fields === undefined && body === undefined)
			return text === undefined ? undefined : start;
		const put = changed(path, start, { fields, body });
		return put.error === null ? put.data.text : text;
	}

	/**
	 * Keep what a landed save meant as the path's committed contribution.
	 * Whole text keeps only what the person changed over the source it was
	 * typed over, composed onto the own saves that source did not yet hold, so
	 * a text typed over an older view neither drops an own field save nor adds
	 * what storage merged in that the person never saw, and one typed over a
	 * newer view does not bring back an own save it superseded. A body is
	 * composed the same way, from its own base's age.
	 */
	async function commit(
		path: string,
		state: PathState,
		input: Input,
		at: number,
	) {
		const retained = (state.retained ??= {
			text: undefined,
			fields: new Map(),
			body: undefined,
		});
		if (input.kind === 'text') {
			const earlier = ownOver(path, retained, input.from, input.fromAsOf);
			const composed =
				earlier === undefined
					? input.pending.text
					: (
							await merge(path, {
								base: input.from,
								current: earlier,
								change: input.pending.text,
							})
						).content;
			retained.text = { content: composed ?? input.pending.text, commit: at };
			retained.fields.clear();
			retained.body = undefined;
			return;
		}
		const bases = input.kind === 'row' ? input.bases.fields : undefined;
		for (const [key, value] of Object.entries(input.pending.fields)) {
			// A field sent as the person saw it changed nothing of theirs.
			if (bases !== undefined && Object.is(valueOf(bases, key), value))
				continue;
			retained.fields.set(key, { value, commit: at });
		}
		if (input.kind !== 'row' || input.pending.body === undefined) return;
		const { body: base, bodyAsOf } = input.bases;
		// A body save is newer than any whole text, which clears it.
		const earlier =
			retained.body !== undefined && retained.body.commit > bodyAsOf
				? retained.body.value
				: retained.text !== undefined && retained.text.commit > bodyAsOf
					? readDocument(
							path,
							bytesOf(ownOver(path, retained, undefined, bodyAsOf) ?? ''),
						).body
					: undefined;
		const body =
			earlier === undefined || base === undefined
				? input.pending.body
				: mergeText(base, earlier, input.pending.body);
		if (base !== body) retained.body = { value: body, commit: at };
	}

	/** Keep what remains of the input once the save of `before` landed. */
	async function landed(
		path: string,
		state: PathState,
		before: Input,
		prepared: Prepared | undefined,
		at: number,
	) {
		const after = state.input;
		if (after === undefined) return;
		const cleared = { saving: false, error: undefined };
		if (after.kind === 'row' && before.kind === 'row') {
			// Typing after a view showed the sent input already merged into it, so
			// a unit the save sent now starts from what it sent, and one that
			// still holds exactly that is done. A unit first typed while the
			// save ran keeps the base it was typed over.
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
					wasSent ? sent[key] : valueOf(after.bases.fields, key),
				);
			}
			const sentBody = before.pending.body;
			const body = after.pending.body === sentBody ? undefined : after.pending.body;
			if (Object.keys(fields).length === 0 && body === undefined) {
				setInput(path, state, undefined);
				return;
			}
			setInput(path, state, {
				...after,
				bases: {
					fields: bases,
					body: body === undefined ? undefined : (sentBody ?? after.bases.body),
					bodyAsOf:
						body !== undefined && sentBody !== undefined
							? at
							: after.bases.bodyAsOf,
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
							fromAsOf: at,
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
		if (
			after.kind !== 'text' ||
			before.kind !== 'fields' ||
			prepared === undefined
		)
			return;
		// Text typed over the field patch while it saved keeps the source the
		// person saw, which may lack a change the save merged from storage.
		// Rebase that source by what the patch sent, so the landed fields are
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
			setInput(path, state, { ...now, from: rebased.content, fromAsOf: at });
	}

	async function drain(path: string, state: PathState) {
		do {
			state.again = false;
			const input = state.input;
			if (input === undefined) return;
			setInput(
				path,
				state,
				withState(input, { saving: true, error: input.pending.error }),
			);
			const sent = await send(path, input);
			const { error, prepared } = sent;
			// The commit this save landed as: reads started from it on show it.
			// Unknown only for a save no notice named; then every commit so far.
			const at = sent.at ?? commits;
			const settled = state.input;
			if (settled === undefined) return;
			if (error !== null) {
				const same = settled.revision === input.revision;
				// The error belongs to the input that was sent; newer input has
				// not been tried.
				setInput(
					path,
					state,
					withState(settled, { saving: false, error: same ? error : undefined }),
				);
				// A second request for the same failed input is not a retry loop.
				if (same) return;
				continue;
			}
			await commit(path, state, input, at);
			const after = state.input;
			if (after === undefined) return;
			if (after.revision === input.revision) setInput(path, state, undefined);
			else await landed(path, state, input, prepared, at);
		} while (state.again);
	}

	/**
	 * Send each path once, after fenced actions; answers the input that did
	 * not save. A failed field patch is sent again as `retry` says.
	 */
	async function settle(retry: Retry = 'none'): Promise<Pending[]> {
		await Promise.allSettled([...actions]);
		await Promise.allSettled([...held].map((path) => flush(path, retry)));
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
		if (fenced)
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
			if (!taken) throw new Error('This exclusive change of the file has ended');
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
					await flush(path, 'none', true);
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

	/** Delete the file as `action` finds it stored, forgetting own saves once it went. */
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
		const removed = outcome.data;
		const state = states.get(path);
		// A file kept because it changed meanwhile keeps what this handle saved.
		if (removed.error === null && removed.data.deleted && state !== undefined) {
			state.retained = undefined;
			publish(path);
		}
		return removed;
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
	 * Up to which commit a source shown over a read started at `read` holds or
	 * supersedes own saves: the read, or the newest own save shown over it.
	 */
	function asOfShown(state: PathState | undefined, read: number) {
		let asOf = read;
		const retained = state?.retained;
		if (retained === undefined) return asOf;
		if (retained.text !== undefined) asOf = Math.max(asOf, retained.text.commit);
		if (retained.body !== undefined) asOf = Math.max(asOf, retained.body.commit);
		for (const unit of retained.fields.values())
			asOf = Math.max(asOf, unit.commit);
		return asOf;
	}

	/** What `shown` answers for `observed`, computed once per read, input, and own save. */
	function remembered<T>(
		path: string,
		observed: object | undefined,
		compute: (state: PathState | undefined, read: number) => T,
	): T {
		const state = states.get(path);
		const read = readOf(observed, self);
		const version = state?.version ?? 0;
		const memo = observed === undefined ? state?.missing : memos.get(observed);
		if (
			memo !== undefined &&
			memo.path === path &&
			memo.version === version &&
			memo.read === read
		)
			return memo.value as T;
		const value = compute(state, read);
		const next = { path, version, read, value };
		if (observed !== undefined) memos.set(observed, next);
		else if (state !== undefined) state.missing = next;
		return value;
	}

	function row(table: string, id: string): RowEdit {
		const path = rowPath(table, id);
		const schema: TSchema | undefined = schemas[table];
		if (schema === undefined) throw new Error(`No table ${table}`);
		const heldRow = () => {
			const input = states.get(path)?.input;
			return input?.kind === 'row' ? input : undefined;
		};
		return {
			path,
			get pending() {
				return heldRow()?.pending;
			},
			get locked() {
				return isLocked(states.get(path));
			},
			subscribe,
			shown<TRow extends Row>(observed: TRow) {
				return remembered(path, observed, (state, read) => {
					const own = ownOver(path, state?.retained, observed.text, read);
					const source = (
						own === undefined
							? { ...observed }
							: readRow(observed.id, own, schema)
					) as TRow;
					const input = state?.input;
					const shownRow =
						input?.kind === 'row'
							? ({
									...source,
									fields: { ...fieldsOf(source), ...input.pending.fields },
									body: input.pending.body ?? source.body,
								} as TRow)
							: source;
					presentations.set(source, {
						kind: 'row',
						path,
						asOf: asOfShown(state, read),
						fields: fieldsOf(shownRow),
						body: shownRow.body,
					});
					return { source, row: shownRow };
				});
			},
			change(source, change) {
				const state = states.get(path);
				if (isLocked(state)) return false;
				const input = state?.input;
				if (input !== undefined && input.kind !== 'row') return false;
				const typed = (change.fields ?? {}) as Record<string, unknown>;
				const keys = Object.keys(typed);
				if (keys.length === 0 && change.body === undefined) return true;
				const presented = presentations.get(source);
				const seen =
					presented?.kind === 'row' && presented.path === path
						? presented
						: {
								fields: fieldsOf(source),
								body: source.body,
								asOf: readOf(source, self),
							};
				let fields: Record<string, unknown> = input?.pending.fields ?? {};
				let baseFields = input?.bases.fields ?? {};
				for (const key of keys) {
					if (!Object.hasOwn(fields, key))
						baseFields = withValue(baseFields, key, valueOf(seen.fields, key));
					fields = withValue(fields, key, typed[key]);
				}
				let body = input?.pending.body;
				let baseBody = input?.bases.body;
				let bodyAsOf = input?.bases.bodyAsOf ?? -1;
				if (change.body !== undefined) {
					if (body === undefined) {
						baseBody = seen.body;
						bodyAsOf = seen.asOf;
						body = change.body;
					} else
						// A view that showed older input changed that, not what is held.
						body =
							seen.body === body
								? change.body
								: mergeText(seen.body, body, change.body);
				}
				const typedSource = ownSource(source);
				const next = stateOf(path);
				setInput(path, next, {
					kind: 'row',
					pending: {
						kind: 'row',
						path,
						table,
						id,
						fields,
						body,
						saving: input?.pending.saving ?? false,
						error: input?.pending.error,
					},
					source:
						input === undefined ||
						parses(typedSource) ||
						!parses(input.source)
							? typedSource
							: input.source,
					bases: { fields: baseFields, body: baseBody, bodyAsOf },
					revision: ++revisions,
				});
				schedule(path, next);
				return true;
			},
			save: () =>
				heldRow() === undefined ? Promise.resolve() : requested(path, 'any'),
			discard() {
				if (heldRow() === undefined) return undefined;
				const pending = discard(path);
				return pending?.kind === 'row' ? pending : undefined;
			},
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
		const heldText = () => {
			const input = states.get(path)?.input;
			return input?.kind === 'text' || input?.kind === 'fields'
				? input
				: undefined;
		};
		return {
			path,
			get pending() {
				return heldText()?.pending;
			},
			get locked() {
				return isLocked(states.get(path));
			},
			subscribe,
			shown(observed) {
				if (observed === undefined && !states.has(path)) return NOTHING_SHOWN;
				return remembered(path, observed, (state, read) => {
					const input = state?.input;
					if (observed === undefined) {
						// Nothing observed is no source to type over; own saved text
						// stays readable.
						const own = ownOver(path, state?.retained, undefined);
						return {
							source: undefined,
							text:
								input?.kind === 'text'
									? input.pending.text
									: own === undefined
										? undefined
										: textOf(own),
						};
					}
					const own = ownOver(path, state?.retained, observed, read);
					const source =
						own === undefined ? observed.subarray() : bytesOf(own).slice();
					let shownText: string | undefined;
					let from: FileContent | undefined;
					if (input?.kind === 'text') shownText = from = input.pending.text;
					else if (input?.kind === 'fields') {
						const put = changed(path, source, { fields: input.pending.fields });
						shownText = from = put.error === null ? put.data.text : undefined;
					} else {
						shownText = decoder.decode(source);
						from = source;
					}
					presentations.set(source, {
						kind: 'text',
						path,
						asOf: asOfShown(state, read),
						text: shownText,
						from,
					});
					return { source, text: shownText };
				});
			},
			change(source, typed) {
				const state = states.get(path);
				if (isLocked(state)) return false;
				const input = state?.input;
				if (input?.kind === 'row') return false;
				const presented =
					source === undefined ? undefined : presentations.get(source);
				const seen =
					presented?.kind === 'text' && presented.path === path
						? presented
						: undefined;
				// What the person saw: the text a shown source's view showed, or
				// other bytes as they decode. A view that saw other text than is
				// held changed that text; its change is merged into what is held.
				const seenText =
					seen?.text ??
					(source === undefined ? undefined : decoder.decode(source));
				const over = (held: string) =>
					seenText === undefined || seenText === held
						? typed
						: mergeText(seenText, held, typed);
				let from: FileContent;
				let fromAsOf: number;
				let next = typed;
				if (input?.kind === 'text') {
					({ from, fromAsOf } = input);
					next = over(input.pending.text);
				} else {
					if (source === undefined) return false;
					fromAsOf = seen?.asOf ?? readOf(source, self);
					if (input?.kind === 'fields') {
						// Failed fields are recovered first: retried or discarded.
						if (input.pending.error !== undefined) return false;
						const preview = changed(path, source, {
							fields: input.pending.fields,
						});
						if (preview.error !== null) {
							setInput(
								path,
								stateOf(path),
								withState(input, {
									saving: input.pending.saving,
									error: SaveError.Unparseable({
										reason: preview.error.reason,
									}).error,
								}),
							);
							return false;
						}
						// The held fields stay: a view that did not show them changed
						// the text without them.
						next = over(preview.data.text);
						from = source.slice();
					} else from = owned(seen?.from ?? source);
				}
				const target = stateOf(path);
				setInput(path, target, {
					kind: 'text',
					pending: {
						kind: 'text',
						path,
						text: next,
						saving: input?.pending.saving ?? false,
						error: input?.kind === 'text' ? input.pending.error : undefined,
					},
					from,
					fromAsOf,
					revision: ++revisions,
				});
				schedule(path, target);
				return true;
			},
			changeFields(source, fields) {
				const state = states.get(path);
				if (isLocked(state)) return false;
				const input = state?.input;
				if (input?.kind === 'row') return false;
				const target = stateOf(path);
				if (input?.kind === 'text') {
					const put = changed(path, input.pending.text, { fields });
					if (put.error !== null) return false;
					setInput(path, target, {
						...input,
						pending: { ...input.pending, text: put.data.text },
						revision: ++revisions,
					});
				} else {
					if (source === undefined) return false;
					let patch: Record<string, unknown> = input?.pending.fields ?? {};
					for (const [key, value] of Object.entries(fields))
						patch = withValue(patch, key, value);
					if (changed(path, source, { fields: patch }).error !== null) {
						prune(path);
						return false;
					}
					setInput(path, target, {
						kind: 'fields',
						pending: {
							kind: 'fields',
							path,
							fields: patch,
							saving: input?.pending.saving ?? false,
							error: undefined,
						},
						revision: ++revisions,
					});
				}
				schedule(path, target);
				return true;
			},
			save: () =>
				heldText() === undefined ? Promise.resolve() : requested(path, 'none'),
			retry: () =>
				heldText() === undefined ? Promise.resolve() : requested(path, 'any'),
			discard() {
				if (heldText() === undefined) return undefined;
				const pending = discard(path);
				return pending?.kind === 'row' ? undefined : pending;
			},
			delete: () =>
				remove(path, async () => {
					const stored = await files.read(path);
					if (stored.error !== null) return stored;
					if (stored.data === undefined) return Ok({ deleted: false });
					const bytes = new Uint8Array(
						await stored.data.content.arrayBuffer(),
					);
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
		fenced = true;
		publish(undefined);
		settle('storage').then(completion.resolve, completion.reject);
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
		/** The commit count a read starting now notes. */
		get commits() {
			return commits;
		},
		/** A save of this handle landed: reads starting from now show it. Answers its commit. */
		committed() {
			return ++commits;
		},
		/** Note that a read of this handle started at commit count `read` answered `value`. */
		noteRead(value: object, read: number) {
			noteRead(value, self, read);
		},
	};
}

export type EditOwner = ReturnType<typeof createEditOwner>;
