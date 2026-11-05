/**
 * The shapes a contract gives an app's reads and writes (decision 6): what
 * a note or a file is as read, what a write changes, and the error
 * vocabulary every reader of a note shares. Types only; the folder
 * (`@epicenter/folder`) owns storage and writes.
 *
 * A note reads as `{ ...placeholders, ...fields, body }`; a file as
 * `{ ...placeholders }`, with its bytes when read whole. Placeholders are
 * the path's (`recordings/{id}.{ext}` gives `id` and `ext`), and they are
 * part of a file name the app chooses: nothing is minted (ADR-0776).
 *
 * No read carries a version and no write takes one (ADR-0774): the folder
 * reads a file just before it writes it, and settles a change made since.
 */
import type { XStatic } from 'typebox/schema';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Collection } from './contract.js';
import type { ConformanceIssue } from './issues.js';
import type { Params } from './templates.js';

export const ClientError = defineErrors({
	/** The fields or text given do not fit the contract, or the note read does not. */
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
	/** The files could not be reached or written now: the network, the disk, or the account. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The files could not be reached: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ClientError = InferErrors<typeof ClientError>;

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

/** A note as read: its placeholders, its fields and its body. */
export type NoteOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & FieldsOf<TCollection> & { body: string }
>;

/** A file as read whole: its placeholders and its bytes. */
export type FileOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & { bytes: Uint8Array }
>;

/** A file as listed: its placeholders, without its bytes. */
export type FileEntryOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection>
>;

/** What a note write changes: some fields (`undefined` removes one), the body, or both. */
export type NotePatch<TCollection extends Collection> = Partial<
	FieldsOf<TCollection> & { body: string }
>;

/**
 * A note at one of a collection's paths that does not read as one: its
 * front matter does not parse, its fields do not fit, or it is not UTF-8.
 * Its placeholders, why, and its text as it is (null when not UTF-8), so
 * an app can show it and repair it, or delete it.
 */
export type InvalidNoteOf<TCollection extends Collection> = Flat<
	PlaceholdersOf<TCollection> & {
		path: string;
		issues: ConformanceIssue[];
		text: string | null;
	}
>;
