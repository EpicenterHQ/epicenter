/**
 * One note `@epicenter/ai` keeps on this computer: a collection with no
 * placeholders, at the top of the app's place for such state
 * (`localFile(name)` from `@epicenter/local`), read and written in house
 * style like any note. It answers as much of a note client as the settings
 * need (`get`, `create`, `update`, `subscribe`), so `createKeychainConnections`
 * and `modelChoices` read the same notes on the desktop and the web.
 */
import {
	ClientError,
	type Collection,
	type NoteClient,
	type NoteOf,
	noteText,
	readNoteText,
	type Version,
} from '@epicenter/definition/contract';
import type { LocalFile } from '@epicenter/local';
import { Ok } from 'wellcrafted/result';

/** The part of a note client a setting note answers. */
export type LocalNote<TCollection extends Collection> = Pick<
	NoteClient<TCollection>,
	'get' | 'create' | 'update' | 'subscribe'
>;

/** The note of `collection`, whose path names no placeholder, kept in `file`. */
export function localNote<TCollection extends Collection>(
	collection: TCollection,
	file: LocalFile,
): LocalNote<TCollection> {
	type Note = NoteOf<TCollection>;
	const path = collection.path;
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	/** `fields` and `body` as the note written at `version`, after house style. */
	function noteOf(value: Record<string, unknown>, version: string): Note {
		return { ...value, version: version as Version } as Note;
	}

	/** Write `value` (its fields and body) over `over`. */
	async function write(value: Record<string, unknown>, over: string) {
		const text = noteText(collection, noteOf(value, ''));
		if (text.error !== null) return text;
		const written = await file.write(text.data, over);
		if (written.error !== null) return unavailable(written.error);
		if (written.data === 'stale') return null;
		const read = readNoteText(collection, text.data);
		if (read.error !== null) return read;
		return Ok(
			noteOf(
				{ ...read.data.fields, body: read.data.body },
				written.data.version,
			),
		);
	}

	return {
		async get() {
			const read = await file.read();
			if (read.error !== null) return unavailable(read.error);
			if (read.data === null) return ClientError.NotFound({ path });
			const note = readNoteText(collection, read.data.text);
			if (note.error !== null) return note;
			return Ok(
				noteOf(
					{ ...note.data.fields, body: note.data.body },
					read.data.version,
				),
			);
		},
		async create({ body = '', ...fields }) {
			const written = await write({ ...fields, body }, 'absent');
			return written ?? ClientError.Occupied({ path });
		},
		async update(_args, patch, { over }) {
			const read = await file.read();
			if (read.error !== null) return unavailable(read.error);
			if (read.data === null || read.data.version !== over)
				return ClientError.Conflict({
					path,
					current: (read.data?.version ?? null) as Version | null,
				});
			const note = readNoteText(collection, read.data.text);
			if (note.error !== null) return note;
			const written = await write(
				{ ...note.data.fields, body: note.data.body, ...patch },
				over,
			);
			if (written !== null) return written;
			const now = await file.read();
			return ClientError.Conflict({
				path,
				current: (now.data?.version ?? null) as Version | null,
			});
		},
		subscribe: (listener) => file.subscribe(listener),
	};
}
