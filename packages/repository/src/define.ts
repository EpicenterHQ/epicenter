/**
 * Today's app API over an app's lens (core/lens): the handle types apps
 * call, what a write or a send answers, notices and sync states.
 */
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Definitions } from './core/lens.js';
import type { Params, ParamsArg } from './core/templates.js';
import type { ChangeOutcome, Overlap } from './protocol.js';

// ============================================================================
// Handle types
// ============================================================================

export const WriteError = defineErrors({
	/** A parameter value cannot be a path segment. */
	InvalidParams: ({ handle, reason }: { handle: string; reason: string }) => ({
		message: `Invalid parameters for '${handle}': ${reason}`,
		handle,
		reason,
	}),
	/** `create` found a file already there. */
	Exists: ({ path }: { path: string }) => ({
		message: `A file already exists at '${path}'`,
		path,
	}),
	/** The change needs a file that is not there. */
	NotFound: ({ path }: { path: string }) => ({
		message: `There is no file at '${path}'`,
		path,
	}),
	/**
	 * The file's frontmatter does not parse, so its fields cannot change; or
	 * the change, which is not a whole text a person typed, would turn
	 * frontmatter that parses into frontmatter that does not.
	 */
	Unparseable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The frontmatter of '${path}' does not parse: ${reason}`,
		path,
		reason,
	}),
	/** A path given as a file's path cannot hold a synced Markdown file. */
	InvalidPath: ({ path, reason }: { path: string; reason: string }) => ({
		message: `'${path}' cannot be written as text: ${reason}`,
		path,
		reason,
	}),
	/** The text cannot be stored: binary text outside Git LFS, or a note over 1 MB. */
	NotStorable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `'${path}' cannot be stored: ${reason}`,
		path,
		reason,
	}),
	/** A blob is not one of its template's declared types or is too large. */
	BlobRefused: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The blob for '${path}' was refused: ${reason}`,
		path,
		reason,
	}),
	/** The blob store did not take the bytes, so no pointer was written. */
	BlobUploadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `The blob for '${path}' could not be stored`,
		path,
		cause,
	}),
	/** The repository was closed before the change settled. */
	Closed: () => ({ message: 'The repository is closed' }),
});
export type WriteError = InferErrors<typeof WriteError>;

export const SendError = defineErrors({
	/** The server is not reachable. Nothing was queued, so the caller may do the change another way. */
	Offline: () => ({ message: 'The server is not reachable; nothing was sent' }),
	/**
	 * The batch may have reached the server, but its verdict did not arrive
	 * here. Its numbered row stays, and the device sends it again when it can;
	 * the server answers that retry from its receipt, so it never lands twice,
	 * and the device stores the outcome: `repo.verdict(id)` answers it later,
	 * across restarts.
	 */
	Unknown: ({ id }: { id: number }) => ({
		message: `Send ${id} may have reached the server; repo.verdict(${id}) answers once it is sent again`,
		id,
	}),
	/**
	 * This device holds text of its own for the path that the server does
	 * not have, which is not sent until its frontmatter parses. A send would
	 * start from text the person is still repairing, so repair or replace it
	 * first.
	 */
	Held: ({ path, reason }: { path: string; reason: HoldReason }) => ({
		message: `'${path}' has text saved on this device that waits for its frontmatter to parse`,
		path,
		reason,
	}),
});
export type SendError = InferErrors<typeof SendError>;

/** The server's verdict on a `send`: an expected answer, so it is data, not an error. */
export type Verdict =
	/**
	 * `seq` is null and `changes` empty for a retry whose receipt left with
	 * its commit: such a verdict promises only that the send applied, not
	 * where its changes landed or what they overlapped.
	 */
	| { kind: 'applied'; seq: number | null; changes: ChangeOutcome[] }
	| { kind: 'refused'; path: string; reason: string; overlaps: Overlap[] };

/** What `repo.verdict(id)` answers for a send that failed with `Unknown`: its verdict, or that the server has not answered it yet. */
export type LaterVerdict = Verdict | { kind: 'unanswered' };

/**
 * A person's write: it resolves once the change is saved in this device's
 * database, and reads see it from then on. It never waits for the server.
 * What the server later does with it, when that is something the person
 * should know, becomes a `Notice`.
 */
export type Saved = Promise<Result<undefined, WriteError>>;

/**
 * Something that happened to a person's change after it was saved, kept on
 * this device until the person dismisses it. Notices never sync.
 *
 * - `refused`: the change, or a value in it, was not applied: a field
 *   another device changed meanwhile (the current value wins), a rename of a
 *   note renamed elsewhere, or onto a name another note holds (the current
 *   name wins and the note stays where the server has it), or a `send`
 *   refused after its caller stopped waiting.
 * - `dropped`: the change had nothing left to apply to, such as a move of a
 *   note deleted elsewhere.
 * - `relocated`: the note's path was deleted and reused by another note, so
 *   the change was saved in a copy at `path`.
 * - `protocol`: the server could not apply the change, which is a bug. The
 *   device shows the server's text again, and `kept` holds what it showed.
 */
export type Notice = {
	id: number;
	/** When this device learned of it, in milliseconds since the epoch. */
	at: number;
	kind: 'refused' | 'dropped' | 'relocated' | 'protocol';
	/** Where the person should look. */
	path: string;
	reason: string;
	/** The text this device showed when the change was taken back, so nothing typed is lost. */
	kept: string | null;
};

/**
 * A query that re-runs after any change on this device. `subscribe` calls
 * back with the first result and then only when the result differs; it
 * returns the function that stops it.
 */
export type Live<T> = { subscribe(onChange: (value: T) => void): () => void };

export type NoteInput<TSchema extends TSchema_> = {
	fields?: Partial<Static<TSchema>>;
	body?: string;
};
type TSchema_ = TSchema;

/** Why this device holds a file's text back from the server: today only that its frontmatter does not parse. */
export type HoldReason = 'unparseable';

/**
 * Where this device's text of a file stands with the server: `synced`, the
 * server has it; `sending`, a change of this device's to it is queued or in
 * flight; `held`, it is saved here and not sent until `reason` clears (for
 * `'unparseable'`, until its frontmatter parses, or a merge makes it parse,
 * when it is queued at once). Held wins over sending.
 */
export type Sync = { state: 'synced' } | { state: 'sending' } | { state: 'held'; reason: HoldReason };

/** A note as read. Fields that fail the schema are returned raw, with issues. */
export type Note<TPath extends string, TSchema extends TSchema_> = {
	path: string;
	params: Params<TPath>;
	text: string;
	body: string;
	sync: Sync;
	/**
	 * The hash of `text` (its Git blob hash), whatever the server holds. A
	 * `send` names the note as read, `{ from: note }`, so that a change is
	 * refused where the note is no longer what was read.
	 */
	version: string;
} & (
	| { valid: true; fields: Static<TSchema> }
	| { valid: false; fields: Record<string, unknown>; issues: string[] }
);

/**
 * One note held open for editing. `read` answers synchronously and is
 * current: a write through the handle shows at once, and changes from
 * elsewhere arrive through `subscribe`.
 */
export type OpenNote<TPath extends string, TSchema extends TSchema_> = {
	params: Params<TPath>;
	/** The note as this device shows it, or null when there is none. */
	read(): Note<TPath, TSchema> | null;
	/** Call back whenever `read` would answer differently. */
	subscribe(onChange: (note: Note<TPath, TSchema> | null) => void): () => void;
	/** Change some fields and or the body of the note there; NotFound when there is none, which only `create` makes. */
	write(input: NoteInput<TSchema>): Saved;
	/**
	 * Replace the body with `body`, an edit of the body this handle last
	 * showed. A change that reached this device meanwhile, but that the
	 * handle had not shown yet, is kept: the edit is merged onto it. An
	 * editor writes each change this way, so text typed while a change from
	 * elsewhere was arriving never takes that change back.
	 */
	edit(body: string): Saved;
	set<TKey extends keyof Static<TSchema> & string>(key: TKey, value: Static<TSchema>[TKey]): Saved;
	append(text: string): Saved;
	delete(): Saved;
	/** Stop following changes. */
	close(): void;
};

/**
 * Any synced Markdown file held open by its path, as text, for an editor
 * of its whole source. As with an open note, `read` answers synchronously,
 * a write shows at once, and changes from elsewhere arrive through
 * `subscribe`.
 */
export type OpenFile = {
	path: string;
	/** The file as this device shows it, or null when there is none. */
	read(): TextFile | null;
	/** Call back whenever `read` would answer differently, its sync state included. */
	subscribe(onChange: (file: TextFile | null) => void): () => void;
	/**
	 * Replace the whole text with `text`, an edit of the text this handle
	 * last showed: a change that reached this device meanwhile is kept, merged
	 * under it. A text that would turn frontmatter that parses into
	 * frontmatter that does not is saved and held (see `Sync`).
	 */
	writeText(text: string): Saved;
	/** Stop following changes. */
	close(): void;
};

export type NoteHandle<TPath extends string, TSchema extends TSchema_> = {
	get(...params: ParamsArg<TPath>): Promise<Note<TPath, TSchema> | null>;
	list(filter?: Partial<Params<TPath>>): Promise<Note<TPath, TSchema>[]>;
	/** `list`, re-run after every change. */
	live(filter?: Partial<Params<TPath>>): Live<Note<TPath, TSchema>[]>;
	/** Hold one note open: reads are synchronous and follow every change. */
	open(...params: ParamsArg<TPath>): Promise<OpenNote<TPath, TSchema>>;
	/** The only way to make a note; refused locally when the file exists on this device. */
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Saved;
	/** Change some fields and or the body of the note there; NotFound when there is none, which only `create` makes. */
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): Saved;
	/** Set one frontmatter field of the note there; NotFound when there is none. */
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey]]
	): Saved;
	/** Append text to the end; needs no base, so concurrent appends both land. */
	append(...args: [...ParamsArg<TPath>, text: string]): Saved;
	move(from: Params<TPath>, to: Params<TPath>): Saved;
	delete(...params: ParamsArg<TPath>): Saved;
};

export type BlobEntry<TPath extends string> = {
	path: string;
	params: Params<TPath>;
	oid: string;
	size: number;
};

export type BlobHandle<TPath extends string> = {
	/** Store the bytes, then write the pointer: a pointer never names missing bytes. */
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string }]): Saved;
	get(...params: ParamsArg<TPath>): Promise<Uint8Array | null>;
	url(...params: ParamsArg<TPath>): Promise<string | null>;
	list(filter?: Partial<Params<TPath>>): Promise<BlobEntry<TPath>[]>;
	live(filter?: Partial<Params<TPath>>): Live<BlobEntry<TPath>[]>;
	delete(...params: ParamsArg<TPath>): Saved;
};

/** Write-only note handles inside `repo.batch`: nothing to read, nothing to await. */
export type BatchNoteHandle<TPath extends string, TSchema extends TSchema_> = {
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey]]
	): void;
	append(...args: [...ParamsArg<TPath>, text: string]): void;
	move(from: Params<TPath>, to: Params<TPath>): void;
	delete(...params: ParamsArg<TPath>): void;
};

export type BatchBlobHandle<TPath extends string> = {
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string }]): void;
	delete(...params: ParamsArg<TPath>): void;
};

/** A file as read: a `Note`, or any `{ path, text, version }` with `version` the hash of `text`. */
export type Snapshot = { path: string; text: string; version: string };

/** Any synced Markdown file as `repo.files` reads it: its whole text, its version, and where it stands with the server. */
export type TextFile = Snapshot & { sync: Sync };

/**
 * What a `send` change to an existing path starts from: the note as the
 * caller read it, whose text is sent along so the server merges from exactly
 * that, or `'latest'`, the text the server last acknowledged to this device,
 * named explicitly because it can hold changes the caller never saw.
 */
export type SendOptions = { from: Snapshot | 'latest' };

/** Write-only note handles inside `repo.send`; each change to an existing path names what it starts from. */
export type SendNoteHandle<TPath extends string, TSchema extends TSchema_> = {
	create(...args: [...ParamsArg<TPath>, NoteInput<TSchema>]): void;
	write(...args: [...ParamsArg<TPath>, NoteInput<TSchema>, options: SendOptions]): void;
	set<TKey extends keyof Static<TSchema> & string>(
		...args: [...ParamsArg<TPath>, key: TKey, value: Static<TSchema>[TKey], options: SendOptions]
	): void;
	append(...args: [...ParamsArg<TPath>, text: string, options: SendOptions]): void;
	move(from: Params<TPath>, to: Params<TPath>): void;
	delete(...args: [...ParamsArg<TPath>, options: SendOptions]): void;
};

export type SendBlobHandle<TPath extends string> = {
	put(...args: [...ParamsArg<TPath>, bytes: Uint8Array, options: { type: string } & SendOptions]): void;
	delete(...args: [...ParamsArg<TPath>, options: SendOptions]): void;
};

export type Handles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? NoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? BlobHandle<TPath>
			: never;
};

export type BatchHandles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? BatchNoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? BatchBlobHandle<TPath>
			: never;
};

export type SendHandles<TDefs extends Definitions> = {
	[K in keyof TDefs]: TDefs[K] extends { path: infer TPath extends string; schema: infer TSchema extends TSchema_ }
		? SendNoteHandle<TPath, TSchema>
		: TDefs[K] extends { path: infer TPath extends string }
			? SendBlobHandle<TPath>
			: never;
};
