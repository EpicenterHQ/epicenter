/**
 * A note as text, both ways, for an app that lets a person edit a whole
 * note (front matter and body) as text:
 *
 * - `noteText(collection, note)`: the text a note as read is written as, in
 *   house style (decision 29). A note an Epicenter tool wrote holds exactly
 *   this; one written by hand may differ in key order, quoting or comments,
 *   which its next write normalizes anyway.
 * - `readNoteText(collection, text)`: `text` read the way `replace` reads
 *   it, so an editor can say, as the person types, whether saving it would
 *   be accepted and why not.
 *
 * Both take the collection as the contract declares it. An invalid note's
 * own text is in `list().invalid[].text`; these are for the notes that read.
 *
 * @example
 * ```ts
 * const shown = noteText(capture.collections.captures, note);
 * const typed = readNoteText(capture.collections.captures, draft);
 * if (typed.error !== null) showIssues(typed.error.issues);
 * else await notes.replace({ id }, draft);
 * ```
 */
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { formatRowSource, parseRowSource } from '../note/canonical.js';
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
		name: 'note-text',
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
 * The house-style text of `note`, a note of `collection` as read: its
 * fields (placeholders and version are its path and state, not front
 * matter) and its body. `Invalid` only when a field holds a value front
 * matter cannot, which a note as read never does.
 */
export function noteText<TCollection extends Collection>(
	collection: TCollection,
	note: NoteOf<TCollection>,
): Result<string, Invalid> {
	const { keys, template } = compiledOf(collection);
	const {
		body,
		version: _version,
		...rest
	} = note as Record<string, unknown> & { body: string };
	const fields = Object.fromEntries(
		Object.entries(rest).filter(
			([key, value]) => !template.params.includes(key) && value !== undefined,
		),
	);
	const formatted = formatRowSource({ fields, body }, keys);
	if (formatted.error !== null)
		return invalid(formatted.error.field, formatted.error.reason);
	return Ok(formatted.data.text);
}

/**
 * `text` read as a note of `collection`, the way `replace` reads it: its
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
	const parsed = parseRowSource(text);
	if (parsed.error !== null)
		return invalid(parsed.error.field, parsed.error.reason);
	const { fields, body } = parsed.data.document;
	const issues = compiledOf(collection).checkFields(fields);
	if (issues.length > 0) return ClientError.Invalid({ path: null, issues });
	return Ok({
		fields: fields as FieldsOf<TCollection> & Record<string, unknown>,
		body,
	});
}
