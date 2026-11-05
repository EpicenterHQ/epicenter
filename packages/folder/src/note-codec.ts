/**
 * How a folder turns a note's bytes into what it shows, and a change into
 * the text it writes.
 *
 * Writes are in house style (decision 29): the contract's keys first in its
 * order, any other keys after them sorted, block YAML, the body untouched.
 * A write never refuses a value that does not fit the contract: it is
 * written, and the note shows in `invalid()` as one another program wrote
 * would (ADR-0775). Reads are lenient: a hand-written note in any key order
 * reads, and its next write formats it.
 *
 * A change made over a note that moved since the folder showed it is
 * settled as sync settles it (`settle` from `@epicenter/definition/merge`,
 * ADR-0774): the fields the change names take this write, a body or whole
 * text the change replaces merges by lines against what the folder showed,
 * and a change to a note whose front matter does not parse keeps the note
 * and adds the change as a conflict block.
 */

import {
	ClientError,
	type CompiledCollection,
} from '@epicenter/definition/contract';
import { type Parties, settle } from '@epicenter/definition/merge';
import {
	type CanonicalDocument,
	formatRowSource,
	frameRowText,
	parseRowSource,
} from '@epicenter/definition/note';
import { Err, Ok, type Result } from 'wellcrafted/result';

export type Params = Record<string, string>;
export type Value = Record<string, unknown>;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The note text in `bytes`, or why it is not UTF-8. */
export function decodeNote(bytes: Uint8Array): Result<string, string> {
	try {
		return Ok(decoder.decode(bytes));
	} catch {
		return Err('The note is not UTF-8 text');
	}
}

/** The placeholder values of `value`, read by the collection's template. */
export function paramsOf(collection: CompiledCollection, value: Value): Params {
	return Object.fromEntries(
		collection.template.params.map((param) => [param, value[param]]),
	) as Params;
}

/** `fields` without the keys whose value is `undefined`, which means absent. */
const defined = (fields: Value) =>
	Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as CanonicalDocument['fields'];

/** The body of `text` by position alone: after its header's closing fence, or all of it. */
function bodyOf(text: string): string {
	const frame = frameRowText(text);
	return frame.kind === 'frontmatter'
		? text.slice(frame.bodyStart)
		: text.slice(frame.bom.length);
}

/** Who wrote each side of a block the folder writes: what was there, and this write. */
const parties = (): Parties => ({
	current: { author: 'folder', time: '-' },
	incoming: { author: 'this-write', time: new Date().toISOString() },
});

/** Reading and writing one note collection's notes. */
export function noteCodec(collection: CompiledCollection) {
	const { keys } = collection;

	/** `fields` and `body` in house style. Throws for a value front matter cannot hold: a bug in the caller. */
	function format(fields: Value, body: string): string {
		const formatted = formatRowSource({ fields: defined(fields), body }, keys);
		if (formatted.error !== null)
			throw new Error(
				`A note of ${collection.template.source} cannot be written: ${formatted.error.reason}`,
				{ cause: formatted.error },
			);
		return formatted.data.text;
	}

	/** A note's front matter as named in a change: everything but its placeholders and body. */
	function fieldsOf(change: Value): Value {
		const { body: _body, ...fields } = change;
		for (const param of collection.template.params) delete fields[param];
		return fields;
	}

	return {
		/** The note text in `bytes`, or null when it is not UTF-8. */
		text(bytes: Uint8Array): string | null {
			const text = decodeNote(bytes);
			return text.error === null ? text.data : null;
		},
		/** Why a note that is not UTF-8 does not read. */
		unreadable() {
			return ClientError.Invalid({
				path: null,
				issues: [{ field: '', message: 'The note is not UTF-8 text' }],
			});
		},
		/** The document in `text`, when it parses and its fields fit. */
		decode(path: string, text: string) {
			const parsed = parseRowSource(text);
			if (parsed.error !== null)
				return ClientError.Invalid({
					path,
					issues: [
						{ field: parsed.error.field ?? '', message: parsed.error.reason },
					],
				});
			const issues = collection.checkFields(parsed.data.document.fields);
			if (issues.length > 0) return ClientError.Invalid({ path, issues });
			return Ok(parsed.data.document);
		},
		/**
		 * The text `set` writes over `current` (null where nothing is):
		 * `change`'s fields over the note's, and its body, when it has one,
		 * settled against `base`, the note's text as the folder showed it
		 * when the change began (null: the change began from no note).
		 */
		set(current: string | null, base: string | null, change: Value): string {
			const fields = fieldsOf(change);
			const body = typeof change.body === 'string' ? change.body : undefined;
			if (current === null) return format(fields, body ?? '');
			const parsed = parseRowSource(current);
			// A note that does not read keeps its text; the change is another note beside it.
			if (parsed.error !== null)
				return (
					settle(null, current, format(fields, body ?? ''), {
						parties: parties(),
						keys,
					}).text ?? current
				);
			const now = parsed.data.document;
			const next = { ...now.fields, ...fields };
			if (body === undefined || body === now.body)
				return format(next, now.body);
			// A note begun from nothing merges as one whose body was empty.
			const shown = base === null ? '' : bodyOf(base);
			if (shown === now.body) return format(next, body);
			// The body moved since it was shown: merge it, the named fields taking this write.
			const header = current.slice(0, current.length - bodyOf(current).length);
			return (
				settle(header + shown, current, format(next, body), {
					parties: parties(),
					keys,
				}).text ?? current
			);
		},
		/**
		 * The text an editor of the whole note writes over `current` (null
		 * where nothing is): `typed`, settled against `began`, the text the
		 * editor began from (null when it began from nothing).
		 */
		edit(current: string | null, began: string | null, typed: string): string {
			return (
				settle(began, current, typed, { parties: parties(), keys }).text ??
				typed
			);
		},
		/** `text` as bytes. */
		bytes: (text: string) => encoder.encode(text),
	};
}
