/**
 * One kind of Whispering's notes (`recordings/{id}.md` and the like) over
 * `Files` (ADR-0894). It keeps nothing between calls: `list()` lists the
 * kind's directory and reads every note in it in one `readMany`, and the
 * query layer (`folder-query.ts`) lists again after every write and when
 * the window regains focus. There is no watcher.
 *
 * Notes are read and written in the home's Markdown grammar
 * (`format/note.ts`, from `@epicenter/app/markdown`); each kind's fields
 * are declared in `format/folder.ts`.
 *
 * Another program may write the folder (a file syncer, a Git command in a
 * home), so a write never replaces what the person has not seen: it carries
 * the text that was shown (`seen`, from the listing's `texts`), reads the
 * file again first, and when the file differs it writes nothing and
 * answers `NoteError.Changed`; the next listing shows the newer text.
 *
 * The service does not order writes: callers write through the query
 * layer, whose mutations of one kind share a scope and so run one at a
 * time, in the order made.
 */
import type { Static, TObject } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	decode,
	type Entry,
	encode,
	type Files,
	type FilesError,
} from './files/files.js';
import { checkNote, fieldNamesOf, type NoteIssue } from './format/folder.js';
import { changeNote, newNote, parseNote } from './format/note.js';

export const NoteError = defineErrors({
	/** The file changed since it was shown, so nothing was written; the newer text is shown now. */
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

/** A kind of note with an id: its notes are `<dir>/<id>.md`, with `fields`. */
export type IdCollection = { readonly dir: string; readonly fields: TObject };

/** One object type from an intersection, so a hover shows its keys. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** A note as read: its id, its fields, and its body. */
export type NoteOf<C extends IdCollection> = Flat<
	{ id: string } & Static<C['fields']> & { body: string }
>;

/** What a note write changes: some fields (`undefined` removes one), the body, or both. */
export type NotePatch<C extends IdCollection> = Partial<
	Static<C['fields']> & { body: string }
>;

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

/** A kind's notes as listed: those that read, those that do not, and the text of each. */
export type NoteListing<C extends IdCollection> = {
	readonly items: readonly NoteOf<C>[];
	readonly invalid: readonly InvalidNote[];
	/** Each note's text as read, by id: what a write of it says was seen. */
	readonly texts: Readonly<Record<string, string>>;
};

/** A note write's `seen`: the note's text as the person saw it, or null when none was shown. */
type Seen = { seen: string | null };

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

/** The notes of `collection` over `files`. */
export function createNotes<const C extends IdCollection>(
	files: Files,
	collection: C,
) {
	const { dir, fields } = collection;
	const fieldNames = fieldNamesOf(fields);
	const pathOf = (id: string) => `${dir}/${id}.md`;

	/** The id a listed name in the directory is the note of, or null. A listing holds only plain names, so the stem is one. */
	const idOf = (name: string) =>
		name.endsWith('.md') ? name.slice(0, -'.md'.length) : null;

	/**
	 * Read note `id` again, and refuse when it is not what was `seen`:
	 * the file's bytes now, or `Changed`.
	 */
	async function unchanged(
		id: string,
		seen: string | null,
	): Promise<Result<Uint8Array | null, NoteWriteError>> {
		const path = pathOf(id);
		const read = await files.read(path);
		if (read.error !== null) return Err(read.error);
		const now = read.data === null ? null : decode(read.data);
		if (now !== seen) return NoteError.Changed({ path });
		return Ok(read.data);
	}

	async function write(id: string, bytes: Uint8Array | null) {
		const path = pathOf(id);
		const done =
			bytes === null
				? await files.remove(path)
				: await files.write(path, bytes);
		if (done.error !== null) return Err(done.error);
		return Ok(undefined);
	}

	return {
		/** The fields the kind declares, in its order. */
		fieldNames,
		/**
		 * List the directory and read every note in it, in one `readMany`.
		 * `listed` is the directory's listing when the caller has it.
		 */
		async list(
			listed?: readonly Entry[],
		): Promise<Result<NoteListing<C>, FilesError>> {
			let entries = listed;
			if (entries === undefined) {
				const list = await files.list(dir);
				if (list.error !== null) return Err(list.error);
				entries = list.data;
			}
			const ids = entries.flatMap((entry) => idOf(entry.name) ?? []);
			const read = await files.readMany(ids.map(pathOf));
			if (read.error !== null) return Err(read.error);
			const items: NoteOf<C>[] = [];
			const invalid: InvalidNote[] = [];
			const texts: Record<string, string> = {};
			for (const id of ids) {
				const path = pathOf(id);
				const bytes = read.data.get(path);
				// Removed between the listing and the read.
				if (bytes === undefined) continue;
				texts[id] = decode(bytes);
				const note = readNote(fields, bytes);
				if (note.kind === 'note')
					items.push({ ...note.fields, id, body: note.body } as NoteOf<C>);
				else invalid.push({ id, path, issues: note.issues, text: note.text });
			}
			return Ok({ items, invalid, texts });
		},
		/**
		 * Give note `id` `changes`: the fields named take these values
		 * (`undefined` removes one), the body is replaced when given, and the
		 * rest stay. The note is made when none is there. Refused when the
		 * file is not what was `seen`.
		 */
		async set({
			id,
			seen,
			changes,
		}: Seen & {
			id: string;
			changes: NotePatch<C>;
		}): Promise<Result<undefined, NoteWriteError>> {
			const path = pathOf(id);
			const now = await unchanged(id, seen);
			if (now.error !== null) return now;
			const { body: newBody, ...named } = changes as Record<string, unknown>;
			const body = typeof newBody === 'string' ? newBody : undefined;
			if (now.data === null)
				return write(id, encode(newNote(named, body ?? '', fieldNames)));
			// A note whose fields do not fit still reads, and takes the change.
			const text = textOf(now.data);
			const parsed = text === null ? null : parseNote(text);
			if (text === null || parsed === null)
				return NoteError.Unreadable({
					path,
					reason: 'The note is not UTF-8 text',
				});
			if (parsed.error !== null)
				return NoteError.Unreadable({ path, reason: parsed.error.reason });
			return write(id, encode(changeNote(text, named, body)));
		},
		/** Write `text` as note `id`, as typed: a repair. It lists as invalid while it does not read. */
		async replace({
			id,
			seen,
			text,
		}: Seen & {
			id: string;
			text: string;
		}): Promise<Result<undefined, NoteWriteError>> {
			const now = await unchanged(id, seen);
			if (now.error !== null) return now;
			return write(id, encode(text));
		},
		/** Remove note `id`. One already gone is gone. */
		async delete({
			id,
			seen,
		}: Seen & { id: string }): Promise<Result<undefined, NoteWriteError>> {
			const now = await unchanged(id, seen);
			if (now.error !== null) return now;
			if (now.data === null) return Ok(undefined);
			return write(id, null);
		},
	};
}

export type Notes<C extends IdCollection> = ReturnType<typeof createNotes<C>>;
