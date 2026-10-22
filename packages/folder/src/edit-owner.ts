/**
 * One owner per opened Folder: each path's one source, the editors that view
 * it through a schema, and the path's command lane, which every write and
 * delete of the path enters: editor saves, direct file writes, row sets and
 * deletes alike. The owner composes and publishes each of them.
 *
 * A source holds two things: the last text known to be stored, kept for the
 * folder's whole life once known, and the latest accepted local input, an
 * intent with its own identity. An editor shows the intent's text, or the
 * known text when there is no intent. Only accepted local input starts an
 * automatic save; observations of storage never write, and a direct command
 * never becomes input or retries itself.
 *
 * The lane runs a path's commands one at a time in call order, and each one
 * admitted finishes and reports its own outcome. A successful command
 * acknowledges only the intent it captured at its call, compared by
 * identity, never by text, and updates what the source knows before its
 * promise resolves.
 *
 * Knowledge is ordered by one private clock. Every observation, the
 * owner's own reads, row lists and gets, and raw file reads, carries the
 * tick it started at; every command settling, reported change, and refresh
 * request carries the tick it happened at. An observation installs only
 * when nothing newer happened to its path since it started and no command
 * of the path is admitted; otherwise the owner's own read reads again,
 * until one applies.
 */
import { type Static, type TSchema, Type } from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { callObserver } from './observer.js';
import { ownFields, sameValue } from './shared/content/canonical.js';
import { type ReadError, SaveError } from './shared/errors.js';
import { changeMarkdown, readMarkdown } from './shared/markdown-codec.js';
import type { FileContent } from './shared/merge.js';
import type { MarkdownValue } from './shared/row.js';

/** How long after its last change input saves, unless the folder was opened with another pause. */
export const SAVE_AFTER_MS = 1000;

/** Why nothing starts while the folder closes. */
export const CLOSING = 'The folder is closing, so nothing was changed.';

/** An action refused before it started because the folder is closing. */
export const ActionError = defineErrors({
	Closing: () => ({ message: CLOSING }),
});
export type ActionError = InferErrors<typeof ActionError>;

/**
 * Why the latest applicable read could not supply editable text. Missing and
 * not-text files are reads that succeeded; the file just holds no text.
 */
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

/** Why new input was refused, before any of it was accepted. */
export const ChangeError = defineErrors({
	Closing: () => ({ message: CLOSING }),
	NoContent: () => ({
		message:
			'There is no text to change yet. It may still be loading, or it could not be read.',
	}),
	InvalidText: ({ reason }: { reason: string }) => ({
		message: `The text cannot be saved: ${reason}`,
		reason,
	}),
	InvalidFields: ({ reason }: { reason: string }) => ({
		message: `Fields cannot be applied: ${reason}`,
		reason,
	}),
});
export type ChangeError = InferErrors<typeof ChangeError>;

/** Accepted into memory, or refused. */
export type ChangeResult = Result<void, ChangeError>;

/** Why `save()` sent nothing. */
export const SaveRefusal = defineErrors({
	NoContent: () => ({ message: 'There is no text to save.' }),
	Closed: () => ({ message: 'The folder is closed, so nothing was saved.' }),
});
export type SaveRefusal = InferErrors<typeof SaveRefusal>;

/** Generic frontmatter, when no read schema is bound to an editor. */
const anyFields = Type.Record(Type.String(), Type.Unknown());
export type AnyFieldsSchema = typeof anyFields;

/** Fields and body contributed together; undefined removes a field. */
export type DocumentChange<TRowSchema extends TSchema = AnyFieldsSchema> = {
	readonly fields?: DeepReadonly<Partial<Static<TRowSchema>>>;
	readonly body?: string;
};

/** `T` with every nested object and array readonly, as frozen content is. */
export type DeepReadonly<T> = T extends
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	? T
	: T extends object
		? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
		: T;

/**
 * The exact text and its interpretation by an editor's schema: `fields`,
 * `body` and `issues`, where `issues === null` proves valid typed fields.
 * Frozen all the way down, so no reader can change what another sees.
 */
export type MarkdownContent<TRowSchema extends TSchema = AnyFieldsSchema> =
	DeepReadonly<MarkdownValue<TRowSchema>>;

/**
 * What an editor shows, immutable and cached: the same object until
 * something in it changes.
 */
export type EditorSnapshot<TRowSchema extends TSchema = AnyFieldsSchema> = {
	/**
	 * The text to edit: the latest accepted input, or the last text known to
	 * be stored. Absent with no `loadError` while awaiting text; absent with
	 * one when acquisition failed. Once present it stays for the folder's life.
	 */
	readonly content: MarkdownContent<TRowSchema> | undefined;
	/** Why the latest applicable observation supplied no text; a later text one clears it. */
	readonly loadError: LoadError | undefined;
	/** Accepted local input no successful command has acknowledged. */
	readonly isDirty: boolean;
	/** Publications of this path admitted and not yet settled, queued or running. */
	readonly isSaving: boolean;
	/** The editor's last applicable failed publication, until a success or `discard()`. */
	readonly saveError: SaveError | undefined;
};

/** A detached, copyable record of input that did not save. */
export type Recovery = {
	readonly path: string;
	readonly text: string;
	readonly error: SaveError | undefined;
};

/** One path's editor, viewed through one schema. */
export type FileEdit<TRowSchema extends TSchema = AnyFieldsSchema> = {
	readonly path: string;
	/** The current snapshot. Pure: reads nothing and starts nothing. */
	getSnapshot(): EditorSnapshot<TRowSchema>;
	/**
	 * Call `listener` with the current snapshot now and with each new one.
	 * The first subscription reads the file when nothing is known yet, or
	 * when it changed while nobody watched. Returns the stop, which cancels
	 * no accepted work.
	 */
	subscribe(
		listener: (snapshot: EditorSnapshot<TRowSchema>) => void,
	): () => void;
	/** Replace the whole text, even before anything is known. */
	replaceText(text: string): ChangeResult;
	/** Patch fields and body of the current text, held locally or known. */
	change(change: DocumentChange<TRowSchema>): ChangeResult;
	/**
	 * Publish the exact current text, even when nothing is dirty. Settles
	 * with that publication's outcome, after every command of the path
	 * admitted before it.
	 */
	save(): Promise<Result<void, SaveError | SaveRefusal>>;
	/**
	 * Read the file after the path's admitted commands, and again while
	 * anything newer overtakes the read, until one applies.
	 */
	refresh(): Promise<Result<void, LoadError>>;
	/**
	 * Drop accepted input not yet published, its pending automatic save, and
	 * the last save failure, which no older publication can bring back.
	 * Answers the dropped text. Writes nothing and cancels no admitted
	 * publication.
	 */
	discard(): string | undefined;
};

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

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Why `text` cannot be stored as text, or `undefined`. */
export function textProblem(text: string) {
	if (!text.isWellFormed()) return 'it contains a lone surrogate';
	if (text.includes('\0')) return 'it contains a NUL character';
	return undefined;
}

/** `bytes` as text: strict UTF-8 without NUL or lone surrogates, or `undefined`. */
function decode(bytes: Uint8Array): string | undefined {
	let text: string;
	try {
		text = strict.decode(bytes);
	} catch {
		return undefined;
	}
	return textProblem(text) === undefined ? text : undefined;
}

/** What one observation of a path found. */
export type Observation =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'missing' }
	| { readonly kind: 'not-text' }
	| { readonly kind: 'failed'; readonly cause: unknown };

/** An observation of `content`, `null` for no file. */
export const observationOf = (content: FileContent | null): Observation => {
	if (content === null) return { kind: 'missing' };
	const text = typeof content === 'string' ? content : decode(content);
	return text === undefined ? { kind: 'not-text' } : { kind: 'text', text };
};

/** `value` and everything it holds, frozen; a copy no caller holds. */
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Reflect.ownKeys(value))
			deepFreeze((value as Record<PropertyKey, unknown>)[key]);
	}
	return value;
}

/**
 * Accepted local input. Its identity, not its text, is what a command
 * acknowledges.
 */
type Ticket = {
	/** Resume the input's interrupted autosave if this command fails. */
	readonly resume: boolean;
};

type Intent = {
	readonly text: string;
	/**
	 * The latest admitted command that captured this input and owns it: an
	 * editor save, a direct write or row set, or a delete. While one owns it,
	 * no automatic save or close submits it again behind that command. Only
	 * the owning command's failure gives it back; lanes run in call order, so
	 * an older command failing never does. `undefined` when no command owns it.
	 */
	ticket: Ticket | undefined;
};

type Lane = {
	/** Settles when the last command admitted so far has finished. */
	tail: Promise<unknown>;
	/** Commands admitted and not finished. */
	pending: number;
	/** Of those, the ones that publish: every write but a delete. */
	publications: number;
	/** The command running now, and whether the engine reported its change. */
	running: { heard: boolean } | undefined;
};

type View = {
	readonly schema: TSchema;
	/** The source stamp `snapshot` was computed at. */
	stamp: number;
	snapshot: EditorSnapshot<TSchema> | undefined;
	content: MarkdownContent<TSchema> | undefined;
	handle: FileEdit<TSchema> | undefined;
};

type Subscription = {
	readonly view: View;
	readonly listener: (snapshot: EditorSnapshot<TSchema>) => void;
	last: EditorSnapshot<TSchema> | undefined;
};

type Source = {
	readonly path: string;
	/** The last text known to be stored, held for the folder's life. */
	known: string | undefined;
	/** The tick of the newest usable text, independent of later nontext observations. */
	textAt: number;
	intent: Intent | undefined;
	loadError: LoadError | undefined;
	saveError: SaveError | undefined;
	/** Bumped by `discard()`: older publications no longer touch `saveError`. */
	epoch: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The tick of the observation or command whose answer is installed. */
	knownAt: number;
	/** The tick of the last change or refresh request an observation must follow. */
	changedAt: number;
	/** Refreshed or given local input: raw reads keep it current. */
	activated: boolean;
	reading: Promise<Result<void, LoadError>> | undefined;
	/** Bumped with every change a snapshot shows. */
	stamp: number;
	readonly subscriptions: Set<Subscription>;
	readonly views: WeakMap<TSchema, View>;
};

/** What the owner tells the handle: input held, failures, and whether work runs. */
export type EditAggregate = {
	readonly unsaved: readonly string[];
	readonly failures: readonly Recovery[];
	readonly working: boolean;
};

const sameList = <T>(left: readonly T[], right: readonly T[]) =>
	left.length === right.length &&
	left.every((item, index) => item === right[index]);

const sameError = (
	left: { name: string; message: string } | undefined,
	right: { name: string; message: string } | undefined,
) =>
	left === right ||
	(left !== undefined &&
		right !== undefined &&
		left.name === right.name &&
		left.message === right.message);

/** A path hint without trailing slashes; `''` names the whole folder. */
const normalizeHint = (hint: string) => hint.replace(/\/+$/, '');

/** Whether the directory or file hint `hint` covers `path`. */
const covers = (hint: string, path: string) =>
	hint === '' || path === hint || path.startsWith(`${hint}/`);

/**
 * Make the owner over the engine's raw reads and writes. `track` registers
 * admitted work for close; `announce` reports a successful command whose
 * change the engine did not report itself, so readers reread.
 */
export function createEditOwner({
	read,
	write,
	saveAfterMs,
	onAggregate,
	track,
	drainWork,
	announce,
}: {
	readonly read: (
		path: string,
	) => Promise<Result<{ content: Blob } | undefined, ReadError>>;
	readonly write: (
		path: string,
		content: FileContent,
	) => Promise<Result<void, SaveError>>;
	readonly saveAfterMs?: number;
	/** Called after anything `getAggregate` reports, or a command's end, may have changed. */
	readonly onAggregate: () => void;
	readonly track: <T>(work: () => Promise<T>) => Promise<T>;
	readonly drainWork: () => Promise<void>;
	readonly announce: (path: string) => void;
}) {
	const pause = saveDelay(saveAfterMs);
	const sources = new Map<string, Source>();
	const lanes = new Map<string, Lane>();
	/** Paths with an intent, kept for the aggregate. */
	const dirty = new Set<string>();
	let commands = 0;
	let aggregate: EditAggregate = { unsaved: [], failures: [], working: false };
	let phase: 'open' | 'closing' | 'closed' = 'open';
	const recoveries = new WeakMap<Intent, Recovery>();

	/** The private order of observations and what overtakes them. */
	let clock = 0;
	/** Observations running now; `hints` matter only while one does. */
	let observations = 0;
	/** The tick of the last change reported for every path. */
	let allChangedAt = 0;
	/**
	 * Changes of paths no source holds yet, kept while observations run. A
	 * command of this owner records what it `stored` there, `null` for no
	 * file; a reported change knows no content.
	 */
	let hints: {
		readonly hint: string;
		readonly at: number;
		readonly stored?: FileContent | null;
	}[] = [];

	/** The tick of the newest change known of `path`, held or not. */
	function pathChangedAt(path: string) {
		let at = allChangedAt;
		for (const hint of hints)
			if (covers(hint.hint, path)) at = Math.max(at, hint.at);
		return at;
	}

	function beginObservation() {
		observations++;
		return ++clock;
	}

	function endObservation() {
		if (--observations === 0) hints = [];
	}

	/** Note a change of the paths `hint` covers, for observations of paths nobody holds. */
	function noteHint(hint: string, at: number) {
		if (observations > 0) hints.push({ hint, at });
	}

	/** What the newest command of this owner after tick `at` stored at `path`, if one did. */
	function publishedAfter(path: string, at: number) {
		let found:
			| { readonly at: number; readonly stored: FileContent | null }
			| undefined;
		for (const hint of hints)
			if (
				hint.stored !== undefined &&
				hint.hint === path &&
				hint.at > at &&
				(found === undefined || hint.at > found.at)
			)
				found = { at: hint.at, stored: hint.stored };
		return found;
	}

	/**
	 * Give captured input `intent` to a command admitted now: it owns it
	 * until it settles, and its pending automatic save is cancelled, as an
	 * explicit save cancels it. Answers the command's ticket.
	 */
	function own(
		source: Source | undefined,
		intent: Intent | undefined,
		kind: 'input' | 'command',
	) {
		if (intent === undefined) return undefined;
		const ticket: Ticket = {
			resume:
				kind === 'command' &&
				source?.intent === intent &&
				(source.timer !== undefined || intent.ticket?.resume === true),
		};
		if (source?.intent === intent) clearTimer(source);
		intent.ticket = ticket;
		return ticket;
	}

	/** A command that owned `intent` failed: give it back only if it still owns it. */
	function disown(
		source: Source | undefined,
		intent: Intent | undefined,
		ticket: Ticket | undefined,
	) {
		if (
			intent !== undefined &&
			ticket !== undefined &&
			intent.ticket === ticket
		) {
			intent.ticket = undefined;
			if (ticket.resume && source?.intent === intent) autosave(source);
		}
	}

	function sourceOf(path: string): Source {
		let source = sources.get(path);
		if (source === undefined) {
			source = {
				path,
				known: undefined,
				textAt: 0,
				intent: undefined,
				loadError: undefined,
				saveError: undefined,
				epoch: 0,
				timer: undefined,
				knownAt: 0,
				// An observation that started before a change it never saw stays out.
				changedAt: pathChangedAt(path),
				activated: false,
				reading: undefined,
				stamp: 0,
				subscriptions: new Set(),
				views: new WeakMap(),
			};
			sources.set(path, source);
		}
		return source;
	}

	const textOf = (source: Source) => source.intent?.text ?? source.known;

	/** Whether raw reads of the source's path should keep it current. */
	const engaged = (source: Source) =>
		source.activated ||
		source.knownAt > 0 ||
		source.textAt > 0 ||
		source.subscriptions.size > 0;

	function recoveryOf(source: Source): Recovery | undefined {
		const intent = source.intent;
		if (intent === undefined) return undefined;
		const previous = recoveries.get(intent);
		if (previous !== undefined && previous.error === source.saveError)
			return previous;
		const recovery = Object.freeze({
			path: source.path,
			text: intent.text,
			error: source.saveError,
		});
		recoveries.set(intent, recovery);
		return recovery;
	}

	function heldRecoveries(): Recovery[] {
		return [...dirty].sort().flatMap((path) => {
			const recovery = recoveryOf(sources.get(path)!);
			return recovery === undefined ? [] : [recovery];
		});
	}

	function updateAggregate() {
		const unsaved = [...dirty].sort();
		const failures = unsaved.flatMap((path) => {
			const source = sources.get(path)!;
			if (
				source.saveError === undefined ||
				source.intent === undefined ||
				source.intent.ticket !== undefined
			)
				return [];
			return [recoveryOf(source)!];
		});
		const working = commands > 0;
		if (
			sameList(unsaved, aggregate.unsaved) &&
			sameList(failures, aggregate.failures) &&
			working === aggregate.working
		)
			return;
		aggregate = { unsaved, failures, working };
		onAggregate();
	}

	function snapshotOf(source: Source, view: View): EditorSnapshot<TSchema> {
		const previous = view.snapshot;
		if (previous !== undefined && view.stamp === source.stamp) return previous;
		view.stamp = source.stamp;
		const text = textOf(source);
		if (text === undefined) view.content = undefined;
		else if (view.content?.text !== text)
			view.content = deepFreeze(
				readMarkdown(text, view.schema),
			) as MarkdownContent<TSchema>;
		const next: EditorSnapshot<TSchema> = {
			content: view.content,
			loadError: source.loadError,
			isDirty: source.intent !== undefined,
			isSaving: (lanes.get(source.path)?.publications ?? 0) > 0,
			saveError: source.saveError,
		};
		if (
			previous !== undefined &&
			previous.content === next.content &&
			previous.loadError === next.loadError &&
			previous.isDirty === next.isDirty &&
			previous.isSaving === next.isSaving &&
			previous.saveError === next.saveError
		)
			return previous;
		view.snapshot = Object.freeze(next);
		return view.snapshot;
	}

	/** Something a snapshot of `source` shows may have changed: tell its subscribers. */
	function touch(source: Source) {
		source.stamp++;
		if (source.intent === undefined) dirty.delete(source.path);
		else dirty.add(source.path);
		for (const subscription of [...source.subscriptions]) {
			if (!source.subscriptions.has(subscription)) continue;
			const snapshot = snapshotOf(source, subscription.view);
			if (snapshot === subscription.last) continue;
			subscription.last = snapshot;
			callObserver('edit listener', subscription.listener, snapshot);
		}
		updateAggregate();
	}

	function laneOf(path: string): Lane {
		let lane = lanes.get(path);
		if (lane === undefined) {
			lane = {
				tail: Promise.resolve(),
				pending: 0,
				publications: 0,
				running: undefined,
			};
			lanes.set(path, lane);
		}
		return lane;
	}

	const busy = (path: string) => (lanes.get(path)?.pending ?? 0) > 0;

	/** Settles once every command of `path` admitted so far, and since, has finished. */
	async function idle(path: string) {
		for (;;) {
			const lane = lanes.get(path);
			if (lane === undefined || lane.pending === 0) return;
			await lane.tail;
		}
	}

	/**
	 * Admit `work` to the lane of `path`, behind every command admitted
	 * before it. It is tracked for close from this call. `settle` runs in the
	 * lane, before the next command starts and before the command's promise
	 * resolves, with the tick the command settled at.
	 */
	function enqueue<T extends Result<unknown, SaveError>>(
		path: string,
		kind: 'publication' | 'delete',
		work: () => Promise<T>,
		settle: (result: T, at: number) => void,
	): Promise<T> {
		const lane = laneOf(path);
		const previous = lane.tail;
		lane.pending++;
		if (kind === 'publication') lane.publications++;
		commands++;
		const running = (async () => {
			await previous;
			const command = { heard: false };
			lane.running = command;
			let result: T;
			try {
				result = await work();
			} catch (cause) {
				result = SaveError.StorageFailed({ cause }) as T;
			}
			lane.running = undefined;
			lane.pending--;
			if (kind === 'publication') lane.publications--;
			commands--;
			if (lane.pending === 0 && lanes.get(path) === lane) lanes.delete(path);
			const at = ++clock;
			// `settle` tells held sources, or running observations, what landed.
			if (result.error === null && !command.heard) announce(path);
			settle(result, at);
			updateAggregate();
			// The handle's own status, such as its last storage failure, may have changed too.
			onAggregate();
			return result;
		})();
		lane.tail = running.then(
			() => {},
			() => {},
		);
		const tracked = track(() => running);
		const source = sources.get(path);
		if (source !== undefined) touch(source);
		else updateAggregate();
		return tracked;
	}

	/** Whether an observation started at `at` may install into `source`. */
	const applies = (source: Source, at: number) =>
		!busy(source.path) && source.changedAt < at && source.knownAt < at;

	/** Whether what `source` knows already answers everything asked of it. */
	const current = (source: Source) =>
		!busy(source.path) &&
		source.knownAt > 0 &&
		source.changedAt < source.knownAt;

	/**
	 * Something may have changed what `source` would read. A running read
	 * reads again; otherwise one starts for subscribers, or waits for the
	 * next subscription. A passive source is only marked.
	 */
	function invalidate(source: Source) {
		source.changedAt = ++clock;
		if (source.reading !== undefined) return;
		if (source.subscriptions.size > 0 && phase !== 'closed')
			void startRead(source);
	}

	/** Install what an observation started at `at` found, as what is stored. */
	function install(source: Source, observation: Observation, at: number) {
		const { path } = source;
		let error: LoadError | undefined;
		switch (observation.kind) {
			case 'text':
				source.known = observation.text;
				source.textAt = at;
				break;
			case 'missing':
				error = LoadError.Missing({ path }).error;
				break;
			case 'not-text':
				error = LoadError.NotText({ path }).error;
				break;
			case 'failed':
				error = LoadError.ReadFailed({ path, cause: observation.cause }).error;
				break;
		}
		if (!sameError(source.loadError, error))
			source.loadError = error === undefined ? undefined : Object.freeze(error);
		source.knownAt = at;
		touch(source);
	}

	const outcomeOf = (source: Source): Result<void, LoadError> =>
		source.loadError === undefined ? Ok(undefined) : Err(source.loadError);

	async function observe(path: string): Promise<Observation> {
		try {
			const found = await read(path);
			if (found.error !== null) return { kind: 'failed', cause: found.error };
			if (found.data === undefined) return { kind: 'missing' };
			return observationOf(
				new Uint8Array(await found.data.content.arrayBuffer()),
			);
		} catch (cause) {
			return { kind: 'failed', cause };
		}
	}

	/**
	 * Read `source`, or join the read running. Each attempt starts once the
	 * path's admitted commands finished; one that something newer overtook
	 * is read again, until one applies or what is known already answers.
	 */
	function startRead(source: Source): Promise<Result<void, LoadError>> {
		if (source.reading !== undefined) return source.reading;
		const reading = (async () => {
			for (;;) {
				await idle(source.path);
				if (current(source)) break;
				const at = beginObservation();
				try {
					const observation = await observe(source.path);
					if (applies(source, at)) {
						install(source, observation, at);
						break;
					}
				} finally {
					endObservation();
				}
			}
			source.reading = undefined;
			return outcomeOf(source);
		})();
		source.reading = reading;
		return reading;
	}

	function clearTimer(source: Source) {
		clearTimeout(source.timer);
		source.timer = undefined;
	}

	/**
	 * A command of `source` stored `text` (or removed the file, for `null`)
	 * at tick `at`: know it, acknowledge `captured` when it is still the
	 * input, and supersede the last failure unless a discard came between.
	 * Then ask subscribers for a fresh observation.
	 */
	function landed(
		source: Source,
		observation: Observation | undefined,
		captured: Intent | undefined,
		epoch: number,
		at: number,
	) {
		if (captured !== undefined && source.intent === captured) {
			// A delete leaves its input held as the content, as a save would.
			if (observation?.kind !== 'text') {
				source.known = captured.text;
				source.textAt = at;
			}
			source.intent = undefined;
			clearTimer(source);
		}
		if (observation !== undefined) install(source, observation, at);
		if (source.epoch === epoch) source.saveError = undefined;
		invalidate(source);
		touch(source);
	}

	/**
	 * A command stored `stored` at `path`, `null` for no file, at tick `at`.
	 * The source held then learns it, even one acquired while the command
	 * ran; with none held, observations still running learn what it stored.
	 */
	function landedAt(
		path: string,
		stored: FileContent | null,
		captured: Intent | undefined,
		epoch: number,
		at: number,
	) {
		const source = sources.get(path);
		if (source === undefined) {
			if (observations > 0) hints.push({ hint: path, at, stored });
			return;
		}
		landed(
			source,
			stored === null
				? { kind: 'missing' }
				: typeof stored === 'string' || engaged(source)
					? observationOf(stored)
					: undefined,
			captured,
			epoch,
			at,
		);
	}

	/**
	 * Publish `text` from `source`. It owns `intent` from now, and
	 * acknowledges it if it is still the input when it lands.
	 */
	function publish(
		source: Source,
		text: string,
		intent: Intent | undefined,
	): Promise<Result<void, SaveError>> {
		const epoch = source.epoch;
		const ticket = own(source, intent, 'input');
		return enqueue(
			source.path,
			'publication',
			() => write(source.path, text),
			(result, at) => {
				if (result.error === null)
					landedAt(source.path, text, intent, epoch, at);
				else {
					if (source.epoch === epoch)
						source.saveError = Object.freeze(result.error);
					disown(source, intent, ticket);
					touch(source);
				}
			},
		);
	}

	/** Submit the current input, unless an admitted command already owns it. */
	function autosave(source: Source) {
		const intent = source.intent;
		if (
			intent === undefined ||
			intent.ticket !== undefined ||
			phase === 'closed'
		)
			return;
		void publish(source, intent.text, intent);
	}

	function schedule(source: Source) {
		clearTimer(source);
		source.timer = setTimeout(() => {
			source.timer = undefined;
			autosave(source);
		}, pause);
	}

	/** Accept `text` as the latest local input. */
	function accept(source: Source, text: string): ChangeResult {
		if (phase !== 'open') return ChangeError.Closing();
		if (typeof text !== 'string')
			return ChangeError.InvalidText({ reason: 'it is not a string' });
		const problem = textProblem(text);
		if (problem !== undefined)
			return ChangeError.InvalidText({ reason: problem });
		source.activated = true;
		if (text === textOf(source)) return Ok(undefined);
		source.intent = { text, ticket: undefined };
		schedule(source);
		touch(source);
		return Ok(undefined);
	}

	function changeDocument(
		source: Source,
		change: DocumentChange<TSchema>,
	): ChangeResult {
		if (phase !== 'open') return ChangeError.Closing();
		const owned = ownFields(change.fields ?? {});
		if (owned.error !== null)
			return ChangeError.InvalidFields({ reason: owned.error.reason });
		const text = textOf(source);
		if (text === undefined) return ChangeError.NoContent();
		const parsed = readMarkdown(text, anyFields);
		const fields: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(owned.data)) {
			if (parsed.fields !== undefined && sameValue(parsed.fields[key], value))
				continue;
			Object.defineProperty(fields, key, { value, enumerable: true });
		}
		const body = change.body === parsed.body ? undefined : change.body;
		if (Object.keys(fields).length === 0 && body === undefined)
			return Ok(undefined);
		const changed = changeMarkdown(parsed, {
			fields: Object.keys(fields).length === 0 ? undefined : fields,
			body,
		});
		if (changed.error !== null)
			return ChangeError.InvalidFields({ reason: changed.error.reason });
		return accept(source, changed.data.text);
	}

	function save(
		source: Source,
	): Promise<Result<void, SaveError | SaveRefusal>> {
		if (phase === 'closed') return Promise.resolve(SaveRefusal.Closed());
		const text = textOf(source);
		if (text === undefined) return Promise.resolve(SaveRefusal.NoContent());
		return publish(source, text, source.intent);
	}

	function refresh(source: Source): Promise<Result<void, LoadError>> {
		if (phase === 'closed')
			return Promise.resolve(
				LoadError.ReadFailed({
					path: source.path,
					cause: new Error('The folder is closed'),
				}),
			);
		source.activated = true;
		// A read already running started before this request; it reads again.
		source.changedAt = ++clock;
		return startRead(source);
	}

	function discard(source: Source): string | undefined {
		clearTimer(source);
		const dropped = source.intent?.text;
		// Every older publication's feedback is superseded, dirty or not.
		source.epoch++;
		if (dropped === undefined && source.saveError === undefined)
			return undefined;
		source.intent = undefined;
		source.saveError = undefined;
		invalidate(source);
		touch(source);
		return dropped;
	}

	function subscribe(
		source: Source,
		view: View,
		listener: (snapshot: EditorSnapshot<TSchema>) => void,
	) {
		const subscription: Subscription = {
			view,
			listener,
			last: snapshotOf(source, view),
		};
		source.subscriptions.add(subscription);
		callObserver('edit listener', listener, subscription.last!);
		if (
			!current(source) &&
			source.reading === undefined &&
			phase !== 'closed' &&
			source.subscriptions.has(subscription)
		)
			void startRead(source);
		return () => {
			source.subscriptions.delete(subscription);
		};
	}

	function edit<TRowSchema extends TSchema = AnyFieldsSchema>(
		path: string,
		schema?: TRowSchema,
	): FileEdit<TRowSchema> {
		const readSchema: TSchema = schema ?? anyFields;
		const source = sourceOf(path);
		let view = source.views.get(readSchema);
		if (view === undefined) {
			const created: View = {
				schema: readSchema,
				stamp: -1,
				snapshot: undefined,
				content: undefined,
				handle: undefined,
			};
			created.handle = Object.freeze({
				path,
				getSnapshot: () => snapshotOf(source, created),
				subscribe: (listener) => subscribe(source, created, listener),
				replaceText: (text) => accept(source, text),
				change: (value) => changeDocument(source, value),
				save: () => save(source),
				refresh: () => refresh(source),
				discard: () => discard(source),
			} satisfies FileEdit<TSchema>);
			source.views.set(readSchema, created);
			view = created;
		}
		return view.handle as unknown as FileEdit<TRowSchema>;
	}

	/**
	 * Submit every input no admitted command owns, failed ones included.
	 * Input an admitted command owns is that command's to publish.
	 */
	function submitHeld() {
		return [...dirty].flatMap((path) => {
			const source = sources.get(path)!;
			const intent = source.intent;
			if (intent === undefined || intent.ticket !== undefined) return [];
			return [publish(source, intent.text, intent)];
		});
	}

	/**
	 * Take what an observation started at `at` found at `path`. A source is
	 * made for it when `create`; nothing reads or subscribes because of it.
	 */
	function ingest(
		path: string,
		at: number,
		observation: Observation,
		create: boolean,
	) {
		let source = sources.get(path);
		if (source === undefined) {
			if (!create) return;
			if (!busy(path) && pathChangedAt(path) < at)
				return install(sourceOf(path), observation, at);
			// Something overtook it before any source was held. A command of
			// this owner that stored the path meanwhile is newer knowledge.
			const published = publishedAfter(path, at);
			if (published !== undefined) {
				source = sourceOf(path);
				install(source, observationOf(published.stored), published.at);
			} else {
				if (observation.kind !== 'text') return;
				source = sourceOf(path);
			}
		} else if (applies(source, at)) return install(source, observation, at);
		// Overtaken text can advance knowledge without claiming freshness or
		// clearing a load error. A later applicable observation reconciles it.
		if (observation.kind === 'text' && source.textAt < at) {
			source.known = observation.text;
			source.textAt = at;
			source.changedAt = Math.max(source.changedAt, at);
			touch(source);
		}
	}

	return {
		edit,
		/**
		 * Reconcile known editors of `paths`, every one when omitted, `''` or a
		 * directory covering its descendants: subscribed ones read now, and
		 * this answers once they did; others read when subscribed again.
		 * Never publishes input.
		 */
		async refreshKnown(paths?: readonly string[]): Promise<void> {
			if (phase === 'closed') return;
			const scope = paths?.map(normalizeHint);
			const reads: Promise<Result<void, LoadError>>[] = [];
			for (const source of sources.values()) {
				if (
					scope !== undefined &&
					!scope.some((hint) => covers(hint, source.path))
				)
					continue;
				source.changedAt = ++clock;
				if (source.subscriptions.size > 0) {
					reads.push(startRead(source));
				}
			}
			await Promise.all(reads);
		},
		/** An observation of the handle starts: answers its tick. */
		beginObservation,
		/** An observation of the handle ended, installed or not. */
		endObservation,
		/**
		 * A raw read started at `at` found `content` at `path`. It keeps an
		 * engaged source current; a passive editor's path is not even decoded.
		 * Answers whether `content` was wanted, so the caller decodes only then.
		 */
		wantsRaw(path: string) {
			const source = sources.get(path);
			return source !== undefined && engaged(source);
		},
		readRaw(path: string, at: number, observation: Observation) {
			ingest(path, at, observation, false);
		},
		/**
		 * A list of the table under `prefix`, started at `at`, found these
		 * rows: each one's exact text is known, held or not, and a held row it
		 * did not find is missing. Starts no read.
		 */
		listed(
			prefix: string,
			at: number,
			rows: readonly {
				readonly path: string;
				readonly observation: Observation;
			}[],
		) {
			const found = new Set<string>();
			for (const { path, observation } of rows) {
				found.add(path);
				ingest(path, at, observation, true);
			}
			for (const [path] of sources)
				if (
					path.startsWith(prefix) &&
					path.endsWith('.md') &&
					!path.slice(prefix.length).includes('/') &&
					!found.has(path)
				)
					ingest(path, at, { kind: 'missing' }, false);
		},
		/** A get of one row, started at `at`, found `observation` there. */
		got(path: string, at: number, observation: Observation) {
			ingest(path, at, observation, observation.kind !== 'failed');
		},
		/**
		 * Admit a structured change of `path`, composed by `compose` from the
		 * text held at this call: the input, or the known text, even when the
		 * file is missing. With no text known, it reads the file inside the
		 * lane, after the path's earlier commands, and composes from that, or
		 * from `null` for no file. On success the source knows the composed
		 * text and the input captured at the call is acknowledged, before
		 * this resolves; newer input stays. A failure changes nothing held.
		 */
		compose(
			path: string,
			compose: (text: string | null) => Result<string, SaveError>,
		): Promise<Result<string, SaveError>> {
			const source = sourceOf(path);
			const captured = source.intent;
			const epoch = source.epoch;
			const held = textOf(source);
			let composed: string | undefined;
			if (held !== undefined) {
				const result = compose(held);
				if (result.error !== null) return Promise.resolve(result);
				composed = result.data;
			}
			// The captured input is this command's to publish now, composed.
			const ticket = own(source, captured, 'command');
			return enqueue(
				path,
				'publication',
				async (): Promise<Result<string, SaveError>> => {
					let text = composed;
					if (text === undefined) {
						const found = await observe(path);
						if (found.kind === 'failed')
							return SaveError.StorageFailed({ cause: found.cause });
						if (found.kind === 'not-text') return SaveError.NotText();
						const result = compose(found.kind === 'text' ? found.text : null);
						if (result.error !== null) return result;
						text = result.data;
					}
					const written = await write(path, text);
					return written.error === null ? Ok(text) : written;
				},
				(result, at) => {
					if (result.error === null)
						landedAt(path, result.data, captured, epoch, at);
					else {
						// The original input stays held; the composed text is never kept.
						disown(source, captured, ticket);
						touch(source);
					}
				},
			);
		},
		/**
		 * Admit a raw write of `content` at `path`. On success a held editor
		 * knows it before this resolves, and the input captured at the call is
		 * acknowledged; newer input stays. A failure changes nothing held.
		 */
		write(
			path: string,
			content: FileContent,
		): Promise<Result<void, SaveError>> {
			const source = sources.get(path);
			const captured = source?.intent;
			const epoch = source?.epoch ?? 0;
			const ticket = own(source, captured, 'command');
			return enqueue(
				path,
				'publication',
				() => write(path, content),
				(result, at) => {
					// A source acquired while it ran learns it too.
					if (result.error === null)
						return landedAt(path, content, captured, epoch, at);
					disown(source, captured, ticket);
					if (source !== undefined) touch(source);
				},
			);
		},
		/**
		 * Admit a delete of `path`. It captures the editor's current intent and
		 * defers its automatic save, never new input. Success acknowledges
		 * only that captured intent and knows the file is missing before this
		 * resolves; failure leaves whatever is pending.
		 */
		remove<T extends Result<unknown, SaveError>>(
			path: string,
			work: () => Promise<T>,
		): Promise<T> {
			const source = sources.get(path);
			const intent = source?.intent;
			const epoch = source?.epoch ?? 0;
			const ticket = own(source, intent, 'command');
			return enqueue(path, 'delete', work, (result, at) => {
				if (result.error === null) landedAt(path, null, intent, epoch, at);
				else {
					disown(source, intent, ticket);
					if (source !== undefined) touch(source);
				}
			});
		},
		/**
		 * The engine reported `paths` changed, `null` for any: files, or
		 * directories covering their descendants, `''` the whole folder. This
		 * is the observation seam for another handle, a sync, or a watcher.
		 * Subscribed editors read again; passive ones are only marked.
		 */
		changed(paths: readonly string[] | null) {
			if (paths === null) {
				allChangedAt = ++clock;
				for (const source of sources.values()) invalidate(source);
				return;
			}
			for (const raw of paths) {
				const hint = normalizeHint(raw);
				noteHint(hint, ++clock);
				for (const source of sources.values())
					if (covers(hint, source.path)) invalidate(source);
			}
		},
		/**
		 * The engine reported its own change of `paths`. Answers those no
		 * running command of this owner explains.
		 */
		heard(paths: readonly string[]) {
			return paths.filter((path) => {
				const running = lanes.get(path)?.running;
				if (running === undefined) return true;
				running.heard = true;
				return false;
			});
		},
		/** Submit held input, failed input included, then drain admitted work. */
		async settle(): Promise<Recovery[]> {
			await Promise.allSettled(submitHeld());
			await drainWork();
			return heldRecoveries();
		},
		/** Close begins: refuse new input and submit what is held once. */
		async close(): Promise<void> {
			phase = 'closing';
			onAggregate();
			await Promise.allSettled(submitHeld());
		},
		/** Nothing is left to wait for: from now on nothing starts. Answers input still held. */
		release(): Recovery[] {
			phase = 'closed';
			for (const source of sources.values()) clearTimer(source);
			return heldRecoveries();
		},
		getAggregate(): EditAggregate {
			return aggregate;
		},
	};
}

export type EditOwner = ReturnType<typeof createEditOwner>;
