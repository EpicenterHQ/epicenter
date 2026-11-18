/**
 * One collection of Whispering's notes (`recordings/{id}.md` and the like)
 * over `Files`, as Svelte state (ADR-0894). It holds what it last read or
 * wrote: `load()` lists the collection's directory and reads its notes in
 * one `readMany`, at start and when the window regains focus, and a write
 * that succeeds updates what it holds. On a later load it reads again only
 * the notes whose size or modified time changed. There is no watcher and
 * no cache beyond that.
 *
 * Notes are read and written in the home's Markdown grammar
 * (`format/note.ts`, from `@epicenter/app/markdown`), so a note Whispering
 * writes is one `epicenter check` reads.
 *
 * Another program may write the folder (a file syncer, a Git command in a
 * home), so a write never replaces what it has not shown: it reads the file
 * again first, and when its bytes differ from what was shown it writes
 * nothing, shows the newer text, and answers `NoteError.Changed`. Writes of
 * one collection run one at a time, in the order made.
 *
 * Every write answers a `Result`: a failed one changes nothing shown, and
 * an editor keeps what was typed and offers to try again (`editNote`).
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	decode,
	type Entry,
	encode,
	type Files,
	type FilesError,
} from './files/files.js';
import {
	type Collection,
	type CompiledCollection,
	compileContract,
	type FieldsOf,
	type InvalidNoteOf,
	type NoteOf,
	type NotePatch,
} from './format/contract/index.js';
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

/** A note collection whose one placeholder is `{id}`, the file's stem. */
export type IdCollection = Collection & { readonly path: `${string}/{id}.md` };

/** One note as held: its text, what it reads as, and the listing it was read at. */
type Held<C extends IdCollection> = {
	/** The file's text, read leniently, to tell whether it changed since. */
	readonly seen: string;
	/** Its size and modified time when a load read it; null after a write, so the next load reads it again. */
	readonly stamp: string | null;
	readonly note: NoteOf<C> | null;
	readonly invalid: InvalidNoteOf<C> | null;
};

/** A listed file's size and modified time, which change when another program writes it. */
const stampOf = (entry: Entry) => `${entry.size}:${entry.modifiedMs}`;

/** A file's bytes as text that compares, UTF-8 or not. */
const seenOf = decode;

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** A note's text, or null when its bytes are not UTF-8. */
function textOf(bytes: Uint8Array): string | null {
	try {
		return strict.decode(bytes);
	} catch {
		return null;
	}
}

/** `collection` compiled once. It is written in code, so one that does not compile throws. */
export function compiledOf(name: string, collection: Collection) {
	const compiled = compileContract({ collections: { [name]: collection } });
	if (compiled.error !== null)
		throw new Error(compiled.error.message, { cause: compiled.error });
	const [one] = compiled.data.collections;
	if (one === undefined) throw new Error(`${collection.path} is not compiled`);
	return one;
}

/** What a note's bytes read as: its fields and body, or why not. */
export function readNote(
	compiled: CompiledCollection,
	bytes: Uint8Array,
):
	| { kind: 'note'; fields: Record<string, unknown>; body: string }
	| {
			kind: 'invalid';
			text: string | null;
			issues: { field: string; message: string }[];
	  } {
	const text = textOf(bytes);
	if (text === null)
		return {
			kind: 'invalid',
			text: null,
			issues: [{ field: '', message: 'The note is not UTF-8 text' }],
		};
	const parsed = parseNote(text);
	if (parsed.error !== null)
		return {
			kind: 'invalid',
			text,
			issues: [
				{ field: parsed.error.field ?? '', message: parsed.error.reason },
			],
		};
	const { fields, body } = parsed.data;
	const issues = compiled.checkFields(fields);
	if (issues.length > 0) return { kind: 'invalid', text, issues };
	return { kind: 'note', fields: { ...fields }, body };
}

/**
 * Run `steps` in the order made, one at a time, each answering what it
 * answers; a step that throws does not stop the next.
 */
export function oneAtATime() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(step: () => Promise<T>): Promise<T> => {
		const run = tail.then(step);
		tail = run.catch(() => {});
		return run;
	};
}

/** The notes of `collection`, named `name` in the contract, over `files`. */
export function noteList<const C extends IdCollection>(
	files: Files,
	name: string,
	collection: C,
) {
	const compiled = compiledOf(name, collection);
	const dir = collection.path.slice(0, collection.path.lastIndexOf('/'));
	const pathOf = (id: string) => `${dir}/${id}.md`;
	/** Every note by path. Replaced whole, so a read of it tracks. */
	let held = $state.raw(new Map<string, Held<C>>());
	/** Writes made since each path was last read by a load, so a load never answers older than a write. */
	let written = 0;
	const writtenAt = new Map<string, number>();
	const run = oneAtATime();

	function hold(path: string, id: string, bytes: Uint8Array | null) {
		const next = new Map(held);
		if (bytes === null) next.delete(path);
		else next.set(path, heldOf(path, id, bytes, null));
		held = next;
	}

	function heldOf(
		path: string,
		id: string,
		bytes: Uint8Array,
		stamp: string | null,
	): Held<C> {
		const read = readNote(compiled, bytes);
		const seen = seenOf(bytes);
		if (read.kind === 'note')
			return {
				seen,
				stamp,
				note: { ...read.fields, id, body: read.body } as NoteOf<C>,
				invalid: null,
			};
		return {
			seen,
			stamp,
			note: null,
			invalid: {
				id,
				path,
				issues: read.issues,
				text: read.text,
			} as unknown as InvalidNoteOf<C>,
		};
	}

	/** The id a listed name in the directory is the note of, or null. */
	function idOf(name: string): string | null {
		if (!name.endsWith('.md')) return null;
		const id = name.slice(0, -'.md'.length);
		const path = compiled.pathOf({ id });
		return path.error === null && path.data === pathOf(id) ? id : null;
	}

	const items = $derived(
		[...held.values()].flatMap((entry) => (entry.note ? [entry.note] : [])),
	);
	const invalid = $derived(
		[...held.values()].flatMap((entry) =>
			entry.invalid ? [entry.invalid] : [],
		),
	);

	/**
	 * Read the file at `path` again, and refuse when it is not what was
	 * shown: then it shows the newer text and answers `Changed`.
	 */
	async function unchanged(
		id: string,
	): Promise<Result<Uint8Array | null, NoteWriteError>> {
		const path = pathOf(id);
		const read = await files.read(path);
		if (read.error !== null) return Err(read.error);
		const now = read.data === null ? null : seenOf(read.data);
		if (now === (held.get(path)?.seen ?? null)) return Ok(read.data);
		hold(path, id, read.data);
		return NoteError.Changed({ path });
	}

	async function write(id: string, bytes: Uint8Array | null) {
		const path = pathOf(id);
		const done =
			bytes === null
				? await files.remove(path)
				: await files.write(path, bytes);
		if (done.error !== null) return Err(done.error);
		writtenAt.set(path, ++written);
		hold(path, id, bytes);
		return Ok(undefined);
	}

	return {
		/** The directory the collection's notes are in. */
		dir,
		/** The fields the contract declares, in its order. */
		fieldNames: compiled.keys as readonly string[],
		/** The notes that read. */
		items(): readonly NoteOf<C>[] {
			return items;
		},
		/** The notes at the collection's paths that do not read, with their text. */
		invalid(): readonly InvalidNoteOf<C>[] {
			return invalid;
		},
		/** The note `id`, when it reads. */
		get({ id }: { id: string }): NoteOf<C> | undefined {
			return held.get(pathOf(id))?.note ?? undefined;
		},
		/** Whether a file, read or not, is held at note `id`'s path. */
		has({ id }: { id: string }): boolean {
			return held.has(pathOf(id));
		},
		/**
		 * List the directory and read the notes in it, replacing what is
		 * held: one `readMany` for every note whose size or modified time
		 * changed since it was read, the rest kept. A note written while it
		 * ran keeps what that write left. `listed` is the directory's
		 * listing when the caller has it.
		 */
		async load(
			listed?: readonly Entry[],
		): Promise<Result<undefined, FilesError>> {
			const began = written;
			let entries = listed;
			if (entries === undefined) {
				const list = await files.list(dir);
				if (list.error !== null) return Err(list.error);
				entries = list.data;
			}
			const notes = entries.flatMap((entry) => {
				const id = idOf(entry.name);
				return id === null
					? []
					: [{ id, path: pathOf(id), stamp: stampOf(entry) }];
			});
			const stale = notes.filter(
				({ path, stamp }) => held.get(path)?.stamp !== stamp,
			);
			const read = await files.readMany(stale.map(({ path }) => path));
			if (read.error !== null) return Err(read.error);
			const next = new Map<string, Held<C>>();
			for (const { id, path, stamp } of notes) {
				const same = held.get(path);
				if (same !== undefined && same.stamp === stamp) {
					next.set(path, same);
					continue;
				}
				const bytes = read.data.get(path);
				// Removed between the listing and the read.
				if (bytes === undefined) continue;
				next.set(
					path,
					same !== undefined && same.seen === seenOf(bytes)
						? { ...same, stamp }
						: heldOf(path, id, bytes, stamp),
				);
			}
			// What a write left since this load began stands over what it read.
			for (const [path, at] of writtenAt) {
				if (at <= began) continue;
				const now = held.get(path);
				if (now === undefined) next.delete(path);
				else next.set(path, now);
			}
			held = next;
			return Ok(undefined);
		},
		/**
		 * Give note `id` `changes`: the fields named take these values
		 * (`undefined` removes one), the body is replaced when given, and the
		 * rest stay. The note is made when none is there.
		 */
		set(
			{ id }: { id: string },
			changes: NotePatch<C>,
		): Promise<Result<undefined, NoteWriteError>> {
			return run(async () => {
				const path = pathOf(id);
				const now = await unchanged(id);
				if (now.error !== null) return now;
				const { body: newBody, ...named } = changes as Record<string, unknown>;
				const body = typeof newBody === 'string' ? newBody : undefined;
				if (now.data === null)
					return write(id, encode(newNote(named, body ?? '', compiled.keys)));
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
			});
		},
		/** Write `text` as note `id`, as typed: a repair. It shows as invalid while it does not read. */
		replace(
			{ id }: { id: string },
			text: string,
		): Promise<Result<undefined, NoteWriteError>> {
			return run(async () => {
				const now = await unchanged(id);
				if (now.error !== null) return now;
				return write(id, encode(text));
			});
		},
		/** Remove note `id`. One already gone is gone. */
		delete({ id }: { id: string }): Promise<Result<undefined, NoteWriteError>> {
			return run(async () => {
				const now = await unchanged(id);
				if (now.error !== null) return now;
				if (now.data === null) return Ok(undefined);
				return write(id, null);
			});
		},
		/** Note `id` as an editor: see `editNote`. */
		edit({ id }: { id: string }, options: EditOptions<C> = {}): NoteEditor<C> {
			return editNote(this, id, options);
		},
	};
}

export type NoteList<C extends IdCollection> = ReturnType<typeof noteList<C>>;

/** What `edit` takes beside the note's id. */
export type EditOptions<C extends IdCollection> = {
	/** The fields a save gives the note when none is there yet, beside what was typed. */
	create?: () => FieldsOf<C> & { body?: string };
};

/** Typing waits this long for more before it saves. */
const SAVE_AFTER_MS = 300;

/** Every editor with typing not yet saved, so leaving the page can ask first. */
const unsavedEditors = new Set<object>();
let unsavedCount = $state(0);

/** How many editors hold typing not yet saved. */
export function unsaved(): number {
	return unsavedCount;
}

function markUnsaved(editor: object, has: boolean) {
	if (has) unsavedEditors.add(editor);
	else unsavedEditors.delete(editor);
	unsavedCount = unsavedEditors.size;
}

/**
 * One note as an editor (`folder.recordings.edit({ id })`): each declared
 * field and the body, as typed until its save lands, else as the note
 * holds it. Setting one saves it a moment later; saves run one at a time,
 * each sending everything typed since the last.
 *
 * A save that fails keeps what was typed and says why (`problem()`). When
 * the note changed elsewhere since it was shown, the newer note is shown
 * under what was typed, and nothing more is saved until the person keeps
 * theirs (`retry()`, which writes the typing over the newer note) or
 * discards it (`discard()`).
 */
export type NoteEditor<C extends IdCollection> = {
	readonly fields: NotePatch<C>;
	/** Whether the note reads and is listed. */
	exists(): boolean;
	/** Whether typing is waiting to be saved or a save is out. */
	saving(): boolean;
	/** Why the last save did not happen, or null. */
	problem(): NoteWriteError | null;
	/** Save what was typed again, over the note as shown now. */
	retry(): void;
	/** Drop what was typed, and show the note. */
	discard(): void;
};

function editNote<C extends IdCollection>(
	list: Pick<NoteList<C>, 'get' | 'set' | 'fieldNames'>,
	id: string,
	{ create }: EditOptions<C>,
): NoteEditor<C> {
	let typed = $state<Record<string, unknown>>({});
	let out = $state(false);
	let waiting = $state(false);
	let problem = $state.raw<NoteWriteError | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const editor = {};

	const pending = () => Object.keys(typed).length > 0;
	const mark = () => markUnsaved(editor, pending() || out);

	function schedule() {
		mark();
		// After a change elsewhere, nothing saves until the person chooses.
		if (problem?.name === 'Changed') return;
		clearTimeout(timer);
		waiting = true;
		timer = setTimeout(() => {
			waiting = false;
			void save();
		}, SAVE_AFTER_MS);
	}

	async function save() {
		if (out || !pending()) return;
		out = true;
		const sent = { ...typed };
		const changes =
			list.get({ id }) === undefined && create
				? { ...create(), ...sent }
				: sent;
		const saved = await list.set({ id }, changes as NotePatch<C>);
		out = false;
		if (saved.error !== null) problem = saved.error;
		else {
			problem = null;
			const next = { ...typed };
			for (const [field, value] of Object.entries(sent))
				if (Object.is(next[field], value)) delete next[field];
			typed = next;
		}
		mark();
		// Typing that arrived while this save was out goes next.
		if (problem === null && pending()) schedule();
	}

	const fields = {};
	for (const field of [...list.fieldNames, 'body'])
		Object.defineProperty(fields, field, {
			enumerable: true,
			get() {
				if (field in typed) return typed[field];
				return (list.get({ id }) as Record<string, unknown> | undefined)?.[
					field
				];
			},
			set(value: unknown) {
				typed = { ...typed, [field]: value };
				schedule();
			},
		});

	return {
		fields: fields as NotePatch<C>,
		exists: () => list.get({ id }) !== undefined,
		saving: () => out || waiting,
		problem: () => problem,
		retry() {
			problem = null;
			clearTimeout(timer);
			waiting = false;
			void save();
		},
		discard() {
			clearTimeout(timer);
			waiting = false;
			typed = {};
			problem = null;
			mark();
		},
	};
}
