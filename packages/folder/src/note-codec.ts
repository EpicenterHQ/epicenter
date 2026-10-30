/**
 * How every client of a contract turns a note's bytes into a value and a
 * value into bytes, shared by the device client and the remote one so a note
 * reads and writes the same wherever it lives.
 *
 * Writes are in house style (decision 29): the contract's keys first in its
 * order, any other keys after them sorted, block YAML, the body untouched.
 * Reads are lenient: a hand-written note in any key order reads, and its
 * next write formats it.
 */
import {
	ClientError,
	type CompiledCollection,
	type Version,
} from '@epicenter/definition/contract';
import {
	type CanonicalDocument,
	formatRowSource,
	parseRowSource,
} from '@epicenter/definition/note';
import { Err, Ok, type Result } from 'wellcrafted/result';

export type Params = Record<string, string>;
export type Value = Record<string, unknown>;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

/** The path `value`'s placeholders name, or `Invalid` naming the placeholder that cannot. */
export function pathOf(collection: CompiledCollection, value: Value) {
	const filled = collection.pathOf(value);
	if (filled.error === null) return filled;
	const field = filled.error.name === 'InvalidValue' ? filled.error.param : '';
	return ClientError.Invalid({
		path: null,
		issues: [{ field, message: filled.error.message }],
	});
}

/**
 * A note as read: its fields, then its placeholders, body and version,
 * which a front matter key of the same name cannot shadow.
 */
export const noteValue = (
	params: Params,
	document: CanonicalDocument,
	version: Version,
) => ({ ...document.fields, ...params, body: document.body, version });

/** `fields` without the keys whose value is `undefined`, which means absent. */
export const defined = (fields: Value) =>
	Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as CanonicalDocument['fields'];

/**
 * The front matter a `create` value holds: a read value spread back in
 * carries its placeholders and version, which name the file and are never
 * front matter.
 */
export function createdFields(collection: CompiledCollection, value: Value) {
	const { version: _version, ...fields } = value;
	for (const param of collection.template.params) delete fields[param];
	return defined(fields);
}

/** Reading and writing one note collection's notes. */
export function noteCodec(collection: CompiledCollection) {
	const invalid = (path: string, field: string | undefined, message: string) =>
		ClientError.Invalid({ path, issues: [{ field: field ?? '', message }] });

	/** The document in `text`, parsed but not checked against the fields. */
	function parse(path: string, text: string) {
		const parsed = parseRowSource(text);
		if (parsed.error !== null)
			return invalid(path, parsed.error.field, parsed.error.reason);
		return Ok(parsed.data.document);
	}

	return {
		invalid,
		parse,
		/** The note text in `bytes`, or `Invalid` when it is not UTF-8. */
		text(path: string, bytes: Uint8Array) {
			const text = decodeNote(bytes);
			if (text.error !== null) return invalid(path, undefined, text.error);
			return Ok(text.data);
		},
		/** The document in `text`, when it parses and its fields fit. */
		decode(path: string, text: string) {
			const parsed = parse(path, text);
			if (parsed.error !== null) return parsed;
			const issues = collection.checkFields(parsed.data.fields);
			if (issues.length > 0) return ClientError.Invalid({ path, issues });
			return parsed;
		},
		/** `document` in house style, when its fields fit. */
		encode(path: string, document: CanonicalDocument) {
			const issues = collection.checkFields(document.fields);
			if (issues.length > 0) return ClientError.Invalid({ path, issues });
			const formatted = formatRowSource(document, collection.keys);
			if (formatted.error !== null)
				return invalid(path, formatted.error.field, formatted.error.reason);
			return Ok(formatted.data);
		},
	};
}
