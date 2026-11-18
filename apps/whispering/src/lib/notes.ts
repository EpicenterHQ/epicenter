/**
 * Whispering's notes (`recordings/{id}.md` and the like) over `Files`
 * (ADR-0894), every kind through one service: the kind is part of each
 * call. It keeps nothing between calls: `list()` lists a kind's directory
 * and reads every note in it in one `readMany`, and the query layer
 * (`folder-query.ts`) lists again after every write and when the window
 * regains focus. There is no watcher.
 *
 * Notes are read and written in the home's Markdown grammar
 * (`format/note.ts`, from `@epicenter/app/markdown`); each kind's fields
 * are declared in `format/folder.ts`.
 *
 * Another program may write the folder (a file syncer, a Git command in a
 * home). A change to a note's fields rewrites only those lines of the file
 * as it is now, so it never loses what another program wrote. Only a write
 * that replaces text the person typed (a body, or a repair's whole text)
 * says what it replaces (`seen`), and when the file differs it writes
 * nothing and answers `NoteError.Changed`; the next listing shows the
 * newer text.
 */
import type { Static, TObject } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	encode,
	type Files,
	type FilesError,
} from './files/files.js';
import {
	checkNote,
	fieldNamesOf,
	NOTES,
	type NoteIssue,
} from './format/folder.js';
import { changeNote, newNote, parseNote } from './format/note.js';

export const NoteError = defineErrors({
	/** The text being replaced changed since it was shown, so nothing was written; the newer text is shown now. */
	Changed: ({ path }: { path: string }) => ({
		message: `${path} changed since it was shown, so this change was not saved. The newer text is shown now.`,
		path,
	}),
	/** The note does not read, so a change to its fields has nothing to change. */
	Unreadable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} does not read (${reason}), so this change was not saved. Repair it first.`,
		path,
		reason,
	}),
});
export type NoteError = InferErrors<typeof NoteError>;

/** Why a note write did not happen. */
export type NoteWriteError = NoteError | FilesError;

type Collections = typeof NOTES;

/** The kinds of note with an id, by name. */
export type NoteName = keyof Collections;

/** A kind of note with an id: its notes are `<dir>/<id>.md`, with `fields`. */
export type IdCollection = { readonly dir: string; readonly fields: TObject };

/** One object type from an intersection, so a hover shows its keys. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** A note as read: its id, its fields, and its body. */
export type NoteOf<C extends IdCollection> = Flat<
	{ id: string } & Static<C['fields']> & { body: string }
>;

/** Fields of a note to change: those named take these values, and `undefined` removes one. */
export type FieldPatch<C extends IdCollection> = Partial<Static<C['fields']>>;

/** What an editor changes: some fields, the body, or both. */
export type NotePatch<C extends IdCollection> = Partial<
	Static<C['fields']> & { body: string }
>;

/**
 * A new body for a note, and the body it replaces as the person saw it:
 * null when there was no note.
 */
export type BodyChange = {
	readonly seen: string | null;
	readonly text: string;
};

/**
 * A note at one of a kind's paths that does not read: its front matter does
 * not parse, its fields do not fit, or it is not UTF-8. Its id, why, and its
 * text as it is (null when not UTF-8), so it can be repaired or deleted.
 */
export type InvalidNote = {
	readonly id: string;
	readonly path: string;
	readonly issues: readonly NoteIssue[];
	readonly text: string | null;
};

/** A kind's notes as listed: those that read, and those that do not. */
export type NoteListing<C extends IdCollection> = {
	readonly items: readonly NoteOf<C>[];
	readonly invalid: readonly InvalidNote[];
};

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** A note's text, or null when its bytes are not UTF-8. */
function textOf(bytes: Uint8Array): string | null {
	try {
		return strict.decode(bytes);
	} catch {
		return null;
	}
}

/** What a note's bytes read as, with `fields`: its fields and body, or why not. */
export function readNote(
	fields: TObject,
	bytes: Uint8Array,
):
	| { kind: 'note'; fields: Record<string, unknown>; body: string }
	| { kind: 'invalid'; text: string | null; issues: NoteIssue[] } {
	const text = textOf(bytes);
	if (text === null)
		return {
			kind: 'invalid',
			text: null,
			issues: [{ field: '', message: 'The note is not UTF-8 text' }],
		};
	const checked = checkNote(fields, text);
	if (checked.error !== null)
		return { kind: 'invalid', text, issues: checked.error };
	return { kind: 'note', ...checked.data };
}

/** The fields `collection` declares, in its order. */
export const fieldNamesFor = (collection: NoteName) =>
	fieldNamesOf(NOTES[collection].fields);

/** The id a listed name in a kind's directory is the note of, or null. A listing holds only plain names, so the stem is one. */
const idOf = (name: string) =>
	name.endsWith('.md') ? name.slice(0, -'.md'.length) : null;

/** A note's path: `<dir>/<id>.md`. */
const pathOf = (collection: NoteName, id: string) =>
	`${NOTES[collection].dir}/${id}.md`;

/** Every kind's notes over `files`. */
export function createNotes(files: Files) {
	async function write(path: string, text: string | null) {
		const done =
			text === null
				? await files.remove(path)
				: await files.write(path, encode(text));
		if (done.error !== null) return Err(done.error);
		return Ok(undefined);
	}

	return {
		/**
		 * List `collection`'s directory and read every note in it, in one
		 * `readMany`. `listed` is the directory's listing when the caller has it.
		 */
		async list<K extends NoteName>(
			collection: K,
			listed?: readonly Entry[],
		): Promise<Result<NoteListing<Collections[K]>, FilesError>> {
			let entries = listed;
			if (entries === undefined) {
				const list = await files.list(NOTES[collection].dir);
				if (list.error !== null) return Err(list.error);
				entries = list.data;
			}
			const ids = entries.flatMap((entry) => idOf(entry.name) ?? []);
			const read = await files.readMany(
				ids.map((id) => pathOf(collection, id)),
			);
			if (read.error !== null) return Err(read.error);
			const items: NoteOf<Collections[K]>[] = [];
			const invalid: InvalidNote[] = [];
			for (const id of ids) {
				const path = pathOf(collection, id);
				const bytes = read.data.get(path);
				// Removed between the listing and the read.
				if (bytes === undefined) continue;
				const note = readNote(NOTES[collection].fields, bytes);
				if (note.kind === 'note')
					items.push({ ...note.fields, id, body: note.body } as NoteOf<
						Collections[K]
					>);
				else invalid.push({ id, path, issues: note.issues, text: note.text });
			}
			return Ok({ items, invalid });
		},
		/**
		 * Give note `id` of `collection` `fields` (`undefined` removes one),
		 * over the file as it is now; the rest stay. `body` replaces its body
		 * when that is still the body seen, and is refused otherwise. The note
		 * is made when none is there.
		 */
		async set<K extends NoteName>({
			collection,
			id,
			fields = {},
			body,
		}: {
			collection: K;
			id: string;
			fields?: FieldPatch<Collections[K]>;
			body?: BodyChange;
		}): Promise<Result<undefined, NoteWriteError>> {
			const path = pathOf(collection, id);
			const read = await files.read(path);
			if (read.error !== null) return Err(read.error);
			const named = fields as Record<string, unknown>;
			if (read.data === null) {
				if (body !== undefined && body.seen !== null)
					return NoteError.Changed({ path });
				return write(
					path,
					newNote(named, body?.text ?? '', fieldNamesFor(collection)),
				);
			}
			// A note whose fields do not fit still reads, and takes the change.
			const text = textOf(read.data);
			if (text === null)
				return NoteError.Unreadable({
					path,
					reason: 'The note is not UTF-8 text',
				});
			const parsed = parseNote(text);
			if (parsed.error !== null)
				return NoteError.Unreadable({ path, reason: parsed.error.reason });
			if (body !== undefined && parsed.data.body !== body.seen)
				return NoteError.Changed({ path });
			return write(path, changeNote(text, named, body?.text));
		},
		/**
		 * Write `text` as note `id`, as typed: a repair. Refused when the file
		 * is no longer the text `seen` (null for a note that is not UTF-8). It
		 * lists as invalid while it does not read.
		 */
		async replace({
			collection,
			id,
			seen,
			text,
		}: {
			collection: NoteName;
			id: string;
			seen: string | null;
			text: string;
		}): Promise<Result<undefined, NoteWriteError>> {
			const path = pathOf(collection, id);
			const read = await files.read(path);
			if (read.error !== null) return Err(read.error);
			if (read.data === null || textOf(read.data) !== seen)
				return NoteError.Changed({ path });
			return write(path, text);
		},
		/** Remove note `id` of `collection`. One already gone is gone. */
		async delete({
			collection,
			id,
		}: {
			collection: NoteName;
			id: string;
		}): Promise<Result<undefined, FilesError>> {
			return write(pathOf(collection, id), null);
		},
	};
}

export type Notes = ReturnType<typeof createNotes>;
