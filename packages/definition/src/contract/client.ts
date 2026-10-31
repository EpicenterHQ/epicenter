/**
 * The typed client a contract derives (decision 6): what every opener
 * returns, whether it works on a device folder (`openDevice`) or through the
 * server (`openRemote`). Types and the error vocabulary only; the openers
 * own storage.
 *
 * Per collection: `list`, `get`, `create`, `update`, `delete`, and
 * `subscribe` to hear that its files changed. A read carries the `version` it
 * saw, and every update or delete passes it back as `over`, so a write never
 * lands on a file it did not see (`Conflict`); `updateNote` is the one rule
 * for carrying a person's edit over such a change. A version is opaque: a
 * device holds a sha256 capture of the bytes, the server a Git blob id, and a
 * caller only compares them and hands them back.
 *
 * A note reads as `{ ...placeholders, ...fields, body, version }`; a file as
 * `{ ...placeholders, bytes, version }`. Placeholders are the path's
 * (`recordings/{id}.{ext}` gives `id` and `ext`), and creating a file means
 * naming it: nothing is minted (decision 5).
 *
 * @example
 * ```ts
 * const device: Client<typeof recorder> = openDevice(recorder);
 * const created = await device.recordings.create({ id: timeId(), title: 'Standup' });
 * if (created.error !== null) return created;
 * const { id, version } = created.data;
 * await device.recordings.update({ id }, { title: 'Daily standup' }, { over: version });
 * ```
 */
import type { XStatic } from 'typebox/schema';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Collection, Contract } from './contract.js';
import type { ConformanceIssue } from './issues.js';
import type { Params } from './templates.js';

/**
 * The version of a file a read saw: a device's sha256 capture or the
 * server's Git blob id. Opaque: compare it and pass it back as `over`.
 */
export type Version = string & Brand<'Version'>;

export const ClientError = defineErrors({
	/** No file is at the path the placeholders name. */
	NotFound: ({ path }: { path: string }) => ({
		message: `Nothing is at ${path}`,
		path,
	}),
	/** `create` named a path that already holds a file. */
	Occupied: ({ path }: { path: string }) => ({
		message: `${path} already exists`,
		path,
	}),
	/** The file changed since the version passed as `over`; `current` is null when it was deleted. */
	Conflict: ({ path, current }: { path: string; current: Version | null }) => ({
		message: `${path} changed since it was read`,
		path,
		current,
	}),
	/** The placeholders or fields given do not fit the contract, or the note read does not. */
	Invalid: ({
		path,
		issues,
	}: {
		path: string | null;
		issues: ConformanceIssue[];
	}) => ({
		message: `${path ?? 'This value'} does not fit the contract: ${issues.map((issue) => issue.message).join('; ')}`,
		path,
		issues,
	}),
	/** The folder or the server could not be reached or read. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The files could not be reached: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ClientError = InferErrors<typeof ClientError>;
type NotFound = InferError<typeof ClientError.NotFound>;
type Occupied = InferError<typeof ClientError.Occupied>;
type Conflict = InferError<typeof ClientError.Conflict>;
type Invalid = InferError<typeof ClientError.Invalid>;
type Unavailable = InferError<typeof ClientError.Unavailable>;

/** One object type from an intersection, so a hover shows its keys. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** The placeholder values that name one file of a collection. */
export type PlaceholdersOf<TCollection extends Collection> = Params<
	TCollection['path']
>;

/** A note collection's front matter, as JSON Schema reads its `fields` and `required`. */
export type FieldsOf<TCollection extends Collection> = TCollection extends {
	fields: infer TFields extends object;
}
	? XStatic<{
			type: 'object';
			properties: TFields;
			required: TCollection extends { required: infer TRequired }
				? TRequired
				: [];
		}>
	: {};

/** A note as read: its placeholders, its fields, its body and the version read. */
export type NoteOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> &
		FieldsOf<TCollection> & { body: string; version: Version }
>;

/** A file as read: its placeholders, its bytes and the version read. */
export type FileOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & { bytes: Uint8Array; version: Version }
>;

/** A file as listed or written: its placeholders and version, without its bytes. */
export type FileEntryOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & { version: Version }
>;

/** What every write passes back: the version its writer read. */
export type Over = { over: Version };

/** What a note `update` changes: some fields (`undefined` removes one), the body, or both. */
export type NotePatch<TCollection extends Collection> = Partial<
	FieldsOf<TCollection> & { body: string }
>;

/**
 * A note at one of a collection's paths that does not read as one: its
 * front matter does not parse, its fields do not fit, or it is not UTF-8.
 * Its placeholders, why, its text as it is (null when not UTF-8), and the
 * version read, so an app can show it and repair it (`update` when the
 * front matter parses, else `replace`) or delete it.
 */
export type InvalidNoteOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & {
		path: string;
		issues: ConformanceIssue[];
		text: string | null;
		version: Version;
	}
>;

/**
 * Hear that a collection's files changed: `listener` runs, with nothing to
 * say what, after any change to them, made here, by another tab or program
 * on the same files, or by another writer of the repository. Read again to
 * see it. It may run when nothing the collection holds changed, and runs for
 * this client's own writes before their promises resolve. Returns the
 * function that stops it.
 */
export type Subscribe = (listener: () => void) => () => void;

export type NoteClient<TCollection extends Collection> = {
	/**
	 * Every note the collection holds. A note at one of its paths whose front
	 * matter does not parse or fit the contract is listed in `invalid`, with
	 * why, not dropped.
	 */
	list(): Promise<
		Result<
			{ items: NoteOf<TCollection>[]; invalid: InvalidNoteOf<TCollection>[] },
			Unavailable
		>
	>;
	get(
		args: PlaceholdersOf<TCollection>,
	): Promise<Result<NoteOf<TCollection>, NotFound | Invalid | Unavailable>>;
	/** Write a new note, in house style. Refused where a file already is. */
	create(
		value: Flat<
			PlaceholdersOf<TCollection> & FieldsOf<TCollection> & { body?: string }
		>,
	): Promise<Result<NoteOf<TCollection>, Occupied | Invalid | Unavailable>>;
	/** Change the fields named in `patch` (a field set to `undefined` is removed) or the body. */
	update(
		args: PlaceholdersOf<TCollection>,
		patch: NotePatch<TCollection>,
		options: Over,
	): Promise<
		Result<NoteOf<TCollection>, NotFound | Conflict | Invalid | Unavailable>
	>;
	/**
	 * Replace the whole note with `text`, which must read as a note whose
	 * fields fit (else `Invalid`, and nothing is written); it is written in
	 * house style. How an app repairs a note whose front matter does not
	 * parse, from the `text` its `list` gave.
	 */
	replace(
		args: PlaceholdersOf<TCollection>,
		text: string,
		options: Over,
	): Promise<
		Result<NoteOf<TCollection>, NotFound | Conflict | Invalid | Unavailable>
	>;
	delete(
		args: PlaceholdersOf<TCollection>,
		options: Over,
	): Promise<Result<undefined, NotFound | Conflict | Unavailable>>;
	subscribe: Subscribe;
};

export type FileClient<TCollection extends Collection> = {
	/** Every file the collection holds, without its bytes. */
	list(): Promise<Result<{ items: FileEntryOf<TCollection>[] }, Unavailable>>;
	get(
		args: PlaceholdersOf<TCollection>,
	): Promise<Result<FileOf<TCollection>, NotFound | Unavailable>>;
	/** Write a new file. Refused where a file already is. */
	create(
		value: Flat<PlaceholdersOf<TCollection> & { bytes: Uint8Array }>,
	): Promise<
		Result<FileEntryOf<TCollection>, Occupied | Invalid | Unavailable>
	>;
	update(
		args: PlaceholdersOf<TCollection>,
		patch: { bytes: Uint8Array },
		options: Over,
	): Promise<
		Result<FileEntryOf<TCollection>, NotFound | Conflict | Unavailable>
	>;
	delete(
		args: PlaceholdersOf<TCollection>,
		options: Over,
	): Promise<Result<undefined, NotFound | Conflict | Unavailable>>;
	subscribe: Subscribe;
};

/** A collection's client: notes for a path ending in `.md`, files for any other. */
export type CollectionClient<TCollection extends Collection> =
	TCollection['path'] extends `${string}.md`
		? NoteClient<TCollection>
		: FileClient<TCollection>;

/** The client a contract derives: one collection client per collection. */
export type Client<TContract extends Contract> = {
	[K in keyof TContract['collections']]: CollectionClient<
		TContract['collections'][K]
	>;
};
