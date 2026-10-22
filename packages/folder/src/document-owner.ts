/**
 * One owner per opened Folder: each path's working source, schema-specific
 * document handles, and command lane. Document saves, detached writes and
 * deletes all enter that lane. The owner composes and publishes each of them.
 *
 * A source holds two things: the last text known to be stored, kept for the
 * folder's whole life once known, and the latest accepted local input, an
 * intent with its own identity. A document shows the intent's text, or the
 * known text when there is no intent. Only accepted local input starts an
 * automatic save; observations of storage never write. Structured changes
 * accept input before publishing, just like typing followed by save.
 *
 * The lane runs a path's commands one at a time in call order, and each one
 * admitted finishes and reports its own outcome. A successful command
 * acknowledges only the intent it captured at its call, compared by
 * identity, never by text, and updates what the source knows before its
 * promise resolves.
 *
 * Each source orders its own reads against changes and publications. Lists,
 * row gets, and raw file reads return data without acquiring working documents.
 * A read that something newer overtook still shows its text when it is newer
 * than anything installed, without claiming to be current, and subscribed
 * documents read again; `refresh` settles with the first read to start after
 * it, so a file that keeps changing cannot hold either off.
 */
import { type Static, type TSchema, Type } from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStatus } from './folder.js';
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
			'There is no text yet. It may still be loading, or it could not be read.',
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

/** Generic frontmatter, when no read schema is bound to a document. */
const anyFields = Type.Record(Type.String(), Type.Unknown());
export type AnyFieldsSchema = typeof anyFields;

/** Patch fields and body together. Undefined removes a field. */
export type DocumentPatch<TRowSchema extends TSchema = AnyFieldsSchema> = {
	fields?: DeepReadonly<Partial<Static<TRowSchema>>>;
	body?: string;
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
 * The exact text and its interpretation by a document's schema: `fields`,
 * `body` and `issues`, where `issues === null` proves valid typed fields.
 * Frozen all the way down, so no reader can change what another sees.
 */
export type MarkdownContent<TRowSchema extends TSchema = AnyFieldsSchema> =
	DeepReadonly<MarkdownValue<TRowSchema>>;

/**
 * What a document shows, immutable and cached: the same object until
 * something in it changes.
 */
export type DocumentSnapshot<TRowSchema extends TSchema = AnyFieldsSchema> = {
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
	/** The document's last applicable failed publication, until a success or `discard()`. */
	readonly saveError: SaveError | undefined;
};

/** The last applicable failed publication of one path. */
export type SaveFailure = {
	readonly path: string;
	readonly error: SaveError;
};

/** One path's shared working document, viewed through one schema. */
export type FileDocument<TRowSchema extends TSchema = AnyFieldsSchema> = {
	readonly path: string;
	/** The current snapshot. Pure: reads nothing and starts nothing. */
	getSnapshot(): DocumentSnapshot<TRowSchema>;
	/**
	 * Call `listener` with the current snapshot now and with each new one.
	 * The first subscription reads the file when nothing is known yet, or
	 * when it changed while nobody watched. Returns the stop, which cancels
	 * no accepted work. After close, reports the snapshot once without reading
	 * or registering a listener.
	 */
	subscribe(
		listener: (snapshot: DocumentSnapshot<TRowSchema>) => void,
	): () => void;
	/**
	 * Accept complete source, even before acquisition. Autosave follows changed
	 * input. Refusal accepts nothing.
	 */
	replace(text: string): ChangeResult;
	/** Patch acquired source. Autosave follows changed input; refusal accepts nothing. */
	patch(patch: DocumentPatch<TRowSchema>): ChangeResult;
	/**
	 * Publish current content, even when clean. A string replaces complete source;
	 * an object patches acquired source. Accept input and admit its publication
	 * before observers run. Answers the exact captured content,
	 * interpreted through this document's schema, even if newer input exists.
	 * Refused input admits nothing; a failed publication retains accepted input.
	 */
	save(
		input?: string | DocumentPatch<TRowSchema>,
	): Promise<Result<MarkdownContent<TRowSchema>, ChangeError | SaveError>>;
	/**
	 * Read the file after the path's admitted commands. Settles with what the
	 * first read to start after this call found; a file that keeps changing
	 * cannot hold it off, and subscribers keep reading until one applies.
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

/** An observation of `content`, `null` for no file. */
function observationOf(
	path: string,
	content: FileContent | null,
): Result<string, LoadError> {
	if (content === null) return LoadError.Missing({ path });
	const text = typeof content === 'string' ? content : decode(content);
	return text === undefined ? LoadError.NotText({ path }) : Ok(text);
}

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
type Intent = {
	readonly text: string;
	/** Its last admitted owner, used so an older command cannot release it. */
	owner: Command | undefined;
	/** Its own publication failed, so only an explicit retry or flush submits it. */
	failed: boolean;
};

type Command = {
	readonly captured: Intent | undefined;
	readonly epoch: number;
	readonly payload: FileContent | null;
	readonly ofInput: boolean;
	heard: boolean;
};

type Lane = {
	/** Settles when the last command admitted so far has finished. */
	tail: Promise<unknown>;
	/** Commands admitted and not finished. */
	pending: number;
	/** Of those, the ones that publish: every write but a delete. */
	publications: number;
	/** The command running now, and whether the engine reported its change. */
	running: Command | undefined;
};

type View = {
	readonly schema: TSchema;
	snapshot: DocumentSnapshot<TSchema> | undefined;
	content: MarkdownContent<TSchema> | undefined;
	handle: FileDocument<TSchema> | undefined;
};

type Subscription = {
	readonly view: View;
	readonly listener: (snapshot: DocumentSnapshot<TSchema>) => void;
	last: DocumentSnapshot<TSchema> | undefined;
};

type Source = {
	readonly path: string;
	/** The last text known to be stored, held for the folder's life. */
	known: string | undefined;
	intent: Intent | undefined;
	loadError: LoadError | undefined;
	failure: SaveFailure | undefined;
	/** Bumped by `discard()`: older publications no longer touch `failure`. */
	epoch: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The tick of the observation or command whose answer is installed. */
	knownAt: number;
	/** The tick of the last change or refresh request an observation must follow. */
	changedAt: number;
	/** Whether the read loop runs. */
	reading: boolean;
	/** Callers waiting for the next read to start, settled once it is taken. */
	nextRead: PromiseWithResolvers<Result<void, LoadError>> | undefined;
	readonly subscriptions: Set<Subscription>;
	readonly views: WeakMap<TSchema, View>;
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
 * Make the owner over the engine's raw reads and writes. Its lanes order
 * all writes; `announce` reports a successful command whose change the
 * engine did not report itself, so readers reread.
 */
export function createDocumentOwner({
	read,
	write,
	saveAfterMs,
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
	readonly announce: (path: string) => void;
}) {
	const pause = saveDelay(saveAfterMs);
	const sources = new Map<string, Source>();
	const lanes = new Map<string, Lane>();
	/** Paths with an intent, kept for passive save status and failure reporting. */
	const dirty = new Set<string>();
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
	let closed = false;

	/** The private order of observations and what overtakes them. */
	let clock = 0;
	function sourceOf(path: string): Source {
		let source = sources.get(path);
		if (source === undefined) {
			source = {
				path,
				known: undefined,
				intent: undefined,
				loadError: undefined,
				failure: undefined,
				epoch: 0,
				timer: undefined,
				knownAt: 0,
				changedAt: 0,
				reading: false,
				nextRead: undefined,
				subscriptions: new Set(),
				views: new WeakMap(),
			};
			sources.set(path, source);
		}
		return source;
	}

	const textOf = (source: Source) => source.intent?.text ?? source.known;

	function publishStatus() {
		const unsaved = [...dirty].sort();
		const failures = unsaved.flatMap((path) => {
			const source = sources.get(path)!;
			if (
				source.failure === undefined ||
				source.intent === undefined ||
				source.intent.owner !== undefined
			)
				return [];
			return [source.failure];
		});
		const savingPaths = [...lanes.keys()].sort();
		if (
			sameList(unsaved, status.unsaved) &&
			sameList(failures, status.failures) &&
			sameList(savingPaths, status.savingPaths) &&
			storageFailure === status.storageFailure &&
			closed === status.closing
		)
			return;
		const next: FolderStatus = {
			saving: savingPaths.length > 0,
			savingPaths,
			storageFailure,
			unsaved,
			failures,
			closing: closed,
		};
		status = next;
		for (const listener of [...statusListeners]) {
			// A listener may publish a newer status; its dispatch replaces this one.
			if (status !== next) break;
			if (statusListeners.has(listener))
				callObserver('status listener', listener, next);
		}
	}

	function snapshotOf(source: Source, view: View): DocumentSnapshot<TSchema> {
		const previous = view.snapshot;
		const text = textOf(source);
		if (text === undefined) view.content = undefined;
		else if (view.content?.text !== text)
			view.content = deepFreeze(
				readMarkdown(text, view.schema),
			) as MarkdownContent<TSchema>;
		const content = view.content;
		const isDirty = source.intent !== undefined;
		const isSaving = (lanes.get(source.path)?.publications ?? 0) > 0;
		const saveError = source.failure?.error;
		if (
			previous !== undefined &&
			previous.content === content &&
			previous.loadError === source.loadError &&
			previous.isDirty === isDirty &&
			previous.isSaving === isSaving &&
			previous.saveError === saveError
		)
			return previous;
		const next: DocumentSnapshot<TSchema> = {
			content,
			loadError: source.loadError,
			isDirty,
			isSaving,
			saveError,
		};
		view.snapshot = Object.freeze(next);
		return view.snapshot;
	}

	/** Something a snapshot of `source` shows may have changed: tell its subscribers. */
	function touch(source: Source) {
		if (source.intent === undefined) dirty.delete(source.path);
		else dirty.add(source.path);
		for (const subscription of [...source.subscriptions]) {
			if (!source.subscriptions.has(subscription)) continue;
			const snapshot = snapshotOf(source, subscription.view);
			if (snapshot === subscription.last) continue;
			subscription.last = snapshot;
			callObserver('edit listener', subscription.listener, snapshot);
		}
		publishStatus();
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
	 * Admit `work` to the lane of `path`, capturing its current input. The
	 * command owns that input until it settles, including across later commands.
	 */
	function enqueue<T extends Result<unknown, SaveError>>(
		path: string,
		payload: FileContent | null,
		work: () => Promise<T>,
		ofInput: boolean,
	): Promise<T> {
		const admittedSource = sources.get(path);
		const command: Command = {
			captured: admittedSource?.intent,
			epoch: admittedSource?.epoch ?? 0,
			payload,
			ofInput,
			heard: false,
		};
		if (admittedSource !== undefined && command.captured !== undefined) {
			clearTimer(admittedSource);
			command.captured.owner = command;
		}
		const lane = laneOf(path);
		const previous = lane.tail;
		lane.pending++;
		if (command.payload !== null) lane.publications++;
		const running = (async () => {
			await previous;
			lane.running = command;
			let result: T;
			try {
				result = await work();
			} catch (cause) {
				result = SaveError.StorageFailed({ cause }) as T;
			}
			// A synthesized notice observes the command before its settlement.
			if (result.error === null && !command.heard) announce(path);
			lane.running = undefined;
			lane.pending--;
			if (command.payload !== null) lane.publications--;
			const at = ++clock;
			if (result.error === null) storageFailure = null;
			else if (result.error.name === 'StorageFailed')
				storageFailure = result.error;
			const source = sources.get(path);
			try {
				if (result.error === null) {
					if (source !== undefined)
						landed(source, command, observationOf(path, command.payload), at);
				} else {
					if (command.ofInput && command.captured !== undefined)
						command.captured.failed = true;
					if (command.ofInput && source?.epoch === command.epoch)
						source.failure = Object.freeze({
							path,
							error: Object.freeze(result.error),
						});
					if (command.captured?.owner === command) {
						command.captured.owner = undefined;
						if (!command.captured.failed && source?.intent === command.captured)
							autosave(source);
					}
					if (source !== undefined) touch(source);
				}
			} finally {
				// Keep the lane through settlement so observers see the command order.
				if (lane.pending === 0 && lanes.get(path) === lane) lanes.delete(path);
				publishStatus();
			}
			return result;
		})();
		lane.tail = running.then(
			() => {},
			() => {},
		);
		if (admittedSource !== undefined) touch(admittedSource);
		else publishStatus();
		return running;
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
		if (source.subscriptions.size > 0) keepReading(source);
	}

	/** Install what an observation started at `at` found, as what is stored. */
	function install(
		source: Source,
		observation: Result<string, LoadError>,
		at: number,
	) {
		if (observation.error === null) source.known = observation.data;
		const error = observation.error ?? undefined;
		if (!sameError(source.loadError, error))
			source.loadError = error === undefined ? undefined : Object.freeze(error);
		source.knownAt = at;
	}

	/**
	 * Text a read started at `at` found after something newer overtook it.
	 * It is newer than anything installed, so it shows and supersedes an older
	 * load error, but it does not claim to be current: `knownAt` stays, and
	 * subscribers read again. Overtaken non-text answers wait for a read that
	 * applies, so a file briefly missing while it is replaced reports nothing.
	 */
	function showOvertaken(
		source: Source,
		observation: Result<string, LoadError>,
		at: number,
	) {
		if (observation.error !== null || source.knownAt >= at) return;
		source.known = observation.data;
		source.loadError = undefined;
		touch(source);
	}

	/** A read refused because the folder closed before it could answer. */
	const closedRead = (source: Source) =>
		LoadError.ReadFailed({
			path: source.path,
			cause: new Error('The folder is closed'),
		});

	async function observe(path: string): Promise<Result<string, LoadError>> {
		try {
			const found = await read(path);
			if (found.error !== null)
				return LoadError.ReadFailed({ path, cause: found.error });
			if (found.data === undefined) return LoadError.Missing({ path });
			return observationOf(
				path,
				new Uint8Array(await found.data.content.arrayBuffer()),
			);
		} catch (cause) {
			return LoadError.ReadFailed({ path, cause });
		}
	}

	/** Start the read loop of `source` unless it runs or the folder closed. */
	function keepReading(source: Source) {
		if (!source.reading && !closed) void readLoop(source);
	}

	/**
	 * Settles with what the next read of `source` to start finds, once it is
	 * taken: a read that started before this call never answers it, and a
	 * file that keeps changing cannot hold it off.
	 */
	function readAfterNow(source: Source): Promise<Result<void, LoadError>> {
		source.nextRead ??= Promise.withResolvers();
		const { promise } = source.nextRead;
		keepReading(source);
		return promise;
	}

	/**
	 * Read `source` while a subscriber needs it current or a caller waits.
	 * Each attempt starts once the path's admitted commands finished. One
	 * that applies is installed; one something newer overtook still shows its
	 * text, and subscribers read again.
	 */
	async function readLoop(source: Source) {
		// A call, so a check after an await is not narrowed away.
		const isClosed = () => closed;
		source.reading = true;
		while (!isClosed()) {
			await idle(source.path);
			if (isClosed()) break;
			const waiting = source.nextRead;
			source.nextRead = undefined;
			if (waiting === undefined && current(source)) break;
			const at = ++clock;
			const observation = await observe(source.path);
			if (isClosed()) {
				waiting?.resolve(closedRead(source));
				break;
			}
			let result: Result<void, LoadError>;
			if (applies(source, at)) {
				install(source, observation, at);
				result =
					source.loadError === undefined
						? Ok(undefined)
						: Err(source.loadError);
				touch(source);
			} else {
				showOvertaken(source, observation, at);
				result =
					observation.error === null ? Ok(undefined) : Err(observation.error);
			}
			waiting?.resolve(result);
			if (source.subscriptions.size === 0 && source.nextRead === undefined)
				break;
		}
		source.reading = false;
		// Closed while a caller waited: its read never happened.
		source.nextRead?.resolve(closedRead(source));
		source.nextRead = undefined;
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
		command: Command,
		observation: Result<string, LoadError>,
		at: number,
	) {
		if (command.captured !== undefined && source.intent === command.captured) {
			// A delete leaves its input held as the content, as a save would.
			if (observation.error !== null) {
				source.known = command.captured.text;
			}
			source.intent = undefined;
			clearTimer(source);
		}
		install(source, observation, at);
		if (source.epoch === command.epoch) source.failure = undefined;
		invalidate(source);
		touch(source);
	}

	/**
	 * Publish the accepted input; its command acknowledges only that identity.
	 */
	function publish(
		source: Source,
		intent: Intent,
	): Promise<Result<void, SaveError>> {
		const text = intent.text;
		return enqueue(source.path, text, () => write(source.path, text), true);
	}

	/** Submit the current input, unless an admitted command already owns it. */
	function autosave(source: Source) {
		const intent = source.intent;
		if (intent === undefined || intent.owner !== undefined || closed) return;
		void publish(source, intent);
	}

	function schedule(source: Source) {
		clearTimer(source);
		source.timer = setTimeout(() => {
			source.timer = undefined;
			autosave(source);
		}, pause);
	}

	/** Validate complete source before any input changes. */
	function composeText(text: unknown): Result<string, ChangeError> {
		if (typeof text !== 'string')
			return ChangeError.InvalidText({ reason: 'it is not a string' });
		const problem = textProblem(text);
		if (problem !== undefined)
			return ChangeError.InvalidText({ reason: problem });
		return Ok(text);
	}

	/** Accept source without deciding when observers see it or when it saves. */
	function commitInput(source: Source, text: string): boolean {
		if (text === textOf(source)) return false;
		source.intent = { text, owner: undefined, failed: false };
		return true;
	}

	function replace(source: Source, text: unknown): ChangeResult {
		if (closed) return ChangeError.Closing();
		const composed = composeText(text);
		if (composed.error !== null) return composed;
		if (!commitInput(source, composed.data)) return Ok(undefined);
		schedule(source);
		touch(source);
		return Ok(undefined);
	}

	/** Compose a structured edit over the currently held source. */
	function composePatch(
		source: Source,
		patch: DocumentPatch<TSchema>,
	): Result<string, ChangeError> {
		const owned = ownFields(patch.fields ?? {});
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
		const body = patch.body === parsed.body ? undefined : patch.body;
		if (Object.keys(fields).length === 0 && body === undefined) return Ok(text);
		const changed = changeMarkdown(parsed, {
			fields: Object.keys(fields).length === 0 ? undefined : fields,
			body,
		});
		if (changed.error !== null)
			return ChangeError.InvalidFields({ reason: changed.error.reason });
		return composeText(changed.data.text);
	}

	function patchDocument(
		source: Source,
		patch: DocumentPatch<TSchema>,
	): ChangeResult {
		if (closed) return ChangeError.Closing();
		const composed = composePatch(source, patch);
		if (composed.error !== null) return composed;
		if (!commitInput(source, composed.data)) return Ok(undefined);
		schedule(source);
		touch(source);
		return Ok(undefined);
	}

	async function save(
		source: Source,
		view: View,
		input?: string | DocumentPatch<TSchema>,
	): Promise<Result<MarkdownContent<TSchema>, ChangeError | SaveError>> {
		if (closed) return ChangeError.Closing();
		if (input !== undefined) {
			const composed =
				typeof input === 'string'
					? composeText(input)
					: composePatch(source, input);
			if (composed.error !== null) return composed;
			commitInput(source, composed.data);
		}
		const content = snapshotOf(source, view).content;
		if (content === undefined) return ChangeError.NoContent();
		// Keep an explicit clean save as held input until storage acknowledges it.
		const intent = (source.intent ??= {
			text: content.text,
			owner: undefined,
			failed: false,
		});
		const saved = await publish(source, intent);
		return saved.error === null ? Ok(content) : saved;
	}

	async function refresh(source: Source): Promise<Result<void, LoadError>> {
		if (closed) return closedRead(source);
		// What is known, or a read already running, predates this request.
		source.changedAt = ++clock;
		return readAfterNow(source);
	}

	function discard(source: Source): string | undefined {
		clearTimer(source);
		const dropped = source.intent?.text;
		// Every older publication's feedback is superseded, dirty or not.
		source.epoch++;
		if (dropped === undefined && source.failure === undefined) return undefined;
		source.intent = undefined;
		source.failure = undefined;
		invalidate(source);
		touch(source);
		return dropped;
	}

	function subscribe(
		source: Source,
		view: View,
		listener: (snapshot: DocumentSnapshot<TSchema>) => void,
	) {
		if (closed) {
			callObserver('edit listener', listener, snapshotOf(source, view));
			return () => {};
		}
		const subscription: Subscription = {
			view,
			listener,
			last: snapshotOf(source, view),
		};
		source.subscriptions.add(subscription);
		callObserver('edit listener', listener, subscription.last!);
		if (!current(source) && source.subscriptions.has(subscription))
			keepReading(source);
		return () => {
			source.subscriptions.delete(subscription);
		};
	}

	function document<TRowSchema extends TSchema = AnyFieldsSchema>(
		path: string,
		schema?: TRowSchema,
	): FileDocument<TRowSchema> {
		const readSchema: TSchema = schema ?? anyFields;
		const source = sourceOf(path);
		let view = source.views.get(readSchema);
		if (view === undefined) {
			const created: View = {
				schema: readSchema,
				snapshot: undefined,
				content: undefined,
				handle: undefined,
			};
			created.handle = Object.freeze({
				path,
				getSnapshot: () => snapshotOf(source, created),
				subscribe: (listener) => subscribe(source, created, listener),
				replace: (text) => replace(source, text),
				patch: (value) => patchDocument(source, value),
				save: (value) => save(source, created, value),
				refresh: () => refresh(source),
				discard: () => discard(source),
			} satisfies FileDocument<TSchema>);
			source.views.set(readSchema, created);
			view = created;
		}
		return view.handle as unknown as FileDocument<TRowSchema>;
	}

	/**
	 * Submit held input no admitted command owns, failed input included, now
	 * without waiting. Input an admitted command owns is that command's to publish.
	 */
	function flush(): void {
		for (const path of [...dirty]) {
			const source = sources.get(path)!;
			const intent = source.intent;
			if (intent === undefined || intent.owner !== undefined) continue;
			void publish(source, intent);
		}
	}

	return {
		document,
		/**
		 * Reconcile known documents of `paths`, every one when omitted, `''` or a
		 * directory covering its descendants: subscribed ones read now, and
		 * this answers once they did; others read when subscribed again.
		 * Never publishes input.
		 */
		async refreshKnown(paths?: readonly string[]): Promise<void> {
			if (closed) return;
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
					reads.push(readAfterNow(source));
				}
			}
			await Promise.all(reads);
		},
		/**
		 * Admit a raw write of `content` at `path`. On success a held document
		 * knows it before this resolves, and the input captured at the call is
		 * acknowledged; newer input stays. A failure changes nothing held.
		 */
		write(
			path: string,
			content: FileContent,
		): Promise<Result<void, SaveError>> {
			return enqueue(path, content, () => write(path, content), false);
		},
		/**
		 * Admit a delete of `path`. It captures the document's current intent and
		 * defers its automatic save, never new input. Success acknowledges
		 * only that captured intent and knows the file is missing before this
		 * resolves; failure leaves whatever is pending.
		 */
		remove<T extends Result<unknown, SaveError>>(
			path: string,
			work: () => Promise<T>,
		): Promise<T> {
			return enqueue(path, null, work, false);
		},
		/**
		 * The engine reported `paths` changed, `null` for any: files, or
		 * directories covering their descendants, `''` the whole folder. This
		 * is the observation seam for another handle, a sync, or a watcher.
		 * Subscribed documents read again; passive ones are only marked.
		 */
		changed(paths: readonly string[] | null) {
			if (paths === null) {
				for (const source of sources.values()) invalidate(source);
				return;
			}
			for (const raw of paths) {
				const hint = normalizeHint(raw);
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
		flush,
		/** Refuse new work and release listeners synchronously, without submitting input. */
		close(): void {
			if (closed) return;
			closed = true;
			for (const source of sources.values()) {
				clearTimer(source);
				source.subscriptions.clear();
			}
			publishStatus();
			statusListeners.clear();
		},
		/** Passive, cached save status; acquiring or observing it reads no file content. */
		getStatus(): FolderStatus {
			return status;
		},
		onStatusChange(listener: (status: FolderStatus) => void): () => void {
			if (closed) throw new Error('The folder is closed');
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
	};
}
