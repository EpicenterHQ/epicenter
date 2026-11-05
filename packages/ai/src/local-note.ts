/**
 * One note `@epicenter/ai` keeps on this computer: a collection with no
 * placeholders, at the top of the app's place for such state
 * (`localFile(name)` from `@epicenter/local`), read and written in house
 * style like any note. It is not a folder's: it never syncs, so it keeps
 * its own small shape, a read that carries the file's version and a write
 * over it, which `createKeychainConnections` and `modelChoices` read and
 * write again over when another window wrote first.
 */
import {
	ClientError,
	type Collection,
	type FieldsOf,
	type NoteOf,
	noteText,
	readNoteText,
} from '@epicenter/definition/contract';
import type { LocalFile } from '@epicenter/local';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

type Invalid = InferError<typeof ClientError.Invalid>;
type Unavailable = InferError<typeof ClientError.Unavailable>;

/** The note as read, with the version of the file it was read from, to write over. */
export type LocalNoteRead<TCollection extends Collection> =
	NoteOf<TCollection> & {
		version: string;
	};

/** A setting note kept on this computer. */
export type LocalNote<TCollection extends Collection> = {
	/** The note, or null when none is there; `Invalid` when it does not read. */
	get(): Promise<
		Result<LocalNoteRead<TCollection> | null, Invalid | Unavailable>
	>;
	/**
	 * Write the note with `fields` (and `body`, empty when absent) over
	 * `over`, the version read (null: none was there): the note written, or
	 * `'stale'` when the file changed since, and nothing was written.
	 */
	write(
		fields: FieldsOf<TCollection> & { body?: string },
		over: string | null,
	): Promise<
		Result<LocalNoteRead<TCollection> | 'stale', Invalid | Unavailable>
	>;
	/** Hear that the file changed; returns the stop. */
	subscribe(listener: () => void): () => void;
};

/** The note of `collection`, whose path names no placeholder, kept in `file`. */
export function localNote<TCollection extends Collection>(
	collection: TCollection,
	file: LocalFile,
): LocalNote<TCollection> {
	type Read = LocalNoteRead<TCollection>;
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	return {
		async get() {
			const read = await file.read();
			if (read.error !== null) return unavailable(read.error);
			if (read.data === null) return Ok(null);
			const note = readNoteText(collection, read.data.text);
			if (note.error !== null) return note;
			return Ok({
				...note.data.fields,
				body: note.data.body,
				version: read.data.version,
			} as Read);
		},
		async write({ body = '', ...fields }, over) {
			const text = noteText(collection, {
				...fields,
				body,
			} as NoteOf<TCollection>);
			if (text.error !== null) return text;
			const written = await file.write(text.data, over ?? 'absent');
			if (written.error !== null) return unavailable(written.error);
			if (written.data === 'stale') return Ok('stale');
			const read = readNoteText(collection, text.data);
			if (read.error !== null) return read;
			return Ok({
				...read.data.fields,
				body: read.data.body,
				version: written.data.version,
			} as Read);
		},
		subscribe: (listener) => file.subscribe(listener),
	};
}
