/**
 * A note as text, both ways, for an app that lets a person edit a whole
 * note (front matter and body) as text:
 *
 * - `noteText(collection, note)`: the text a note as read is written as:
 *   the contract's keys first in its order, each `key: <JSON>` on its own
 *   line (`format/note.ts`).
 * - `readNoteText(collection, text)`: `text` read as a note of the
 *   collection, so an editor can say, as the person types, whether the
 *   note it saves will read, and why not. Saving never refuses it: a note
 *   that does not read is written as typed and shows as invalid.
 *
 * Both take the collection as the contract declares it. An invalid note's
 * own text is in `list().invalid[].text`; these are for the notes that read.
 *
 * @example
 * ```ts
 * const shown = noteText(capture.collections.captures, note);
 * const typed = readNoteText(capture.collections.captures, draft);
 * if (typed.error !== null) showIssues(typed.error.issues);
 * editor.text = draft; // saved either way
 * ```
 */
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { newNote, parseNote } from '../note.js';
import { ClientError, type FieldsOf, type NoteOf } from './client.js';
import {
	type Collection,
	type CompiledCollection,
	compileContract,
} from './contract.js';

type Invalid = InferError<typeof ClientError.Invalid>;

const compiled = new WeakMap<Collection, CompiledCollection>();

/** `collection` compiled once. One that is not well formed throws: it is written in code. */
function compiledOf(collection: Collection): CompiledCollection {
	const known = compiled.get(collection);
	if (known !== undefined) return known;
	const contract = compileContract({
		collections: { notes: collection },
	});
	if (contract.error !== null)
		throw new Error(contract.error.message, { cause: contract.error });
	const [one] = contract.data.collections;
	if (one === undefined || one.kind !== 'note')
		throw new Error(`${collection.path} does not hold notes`);
	compiled.set(collection, one);
	return one;
}

const invalid = (field: string | undefined, message: string) =>
	ClientError.Invalid({
		path: null,
		issues: [{ field: field ?? '', message }],
	});

/**
 * The text of `note`, a note of `collection` as read: its fields
 * (placeholders are its path, not front matter) and its body. Every value
 * a note as read holds is JSON, so this never refuses; it answers a
 * `Result` for the editor that shows it.
 */
export function noteText<TCollection extends Collection>(
	collection: TCollection,
	note: NoteOf<TCollection>,
): Result<string, Invalid> {
	const { keys, template } = compiledOf(collection);
	const { body, ...rest } = note as Record<string, unknown> & {
		body: string;
	};
	const fields = Object.fromEntries(
		Object.entries(rest).filter(
			([key, value]) => !template.params.includes(key) && value !== undefined,
		),
	);
	return Ok(newNote(fields, body, keys));
}

/**
 * `text` read as a note of `collection`: its
 * front matter fields and its body when the front matter parses and the
 * fields fit, else `Invalid` with every issue (`path` null: no file is
 * named yet).
 */
export function readNoteText<TCollection extends Collection>(
	collection: TCollection,
	text: string,
): Result<
	{ fields: FieldsOf<TCollection> & Record<string, unknown>; body: string },
	Invalid
> {
	const parsed = parseNote(text);
	if (parsed.error !== null)
		return invalid(parsed.error.field, parsed.error.reason);
	const { fields, body } = parsed.data;
	const issues = compiledOf(collection).checkFields(fields);
	if (issues.length > 0) return ClientError.Invalid({ path: null, issues });
	return Ok({
		fields: fields as FieldsOf<TCollection> & Record<string, unknown>,
		body,
	});
}
