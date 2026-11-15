/**
 * The fields a collection's files and an action's input are made of. Each is
 * a TypeBox schema, which is JSON Schema, so raw TypeBox sits beside them. The
 * CLI reads a field as a flag named for its key, and as a positional when the
 * action lists it; MCP shows it as a property of the tool's input.
 *
 * A field is required unless it says `optional`. A switch (`boolean`) and a
 * list (`list`, `tags`) are never required: an absent switch is `false`, an
 * absent list is empty. A collection's field that says `readOnly` is written
 * only by the app's own actions: the exposed `add` and `set` leave it out.
 * Fields describe data; an action declares private input handling separately.
 */
import {
	type Static,
	type TArray,
	type TBoolean,
	type TLiteral,
	type TOptional,
	type TSchema,
	type TString,
	type TUnion,
	Type,
} from 'typebox';
import { Value } from 'typebox/value';
import type { AnyCollection } from './collection.ts';
import { isLocalPath } from './context.ts';
import { template } from './path.ts';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const FILE_REFERENCE_PREFIX = 'epicenter-file:';

/**
 * A run's file input. Its path, bytes, and text are valid only while the run runs.
 */
export type UploadedFile = {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	/** Absolute path in the host's private runtime directory; valid only while the run runs. */
	path(): string;
	bytes(): Promise<Uint8Array>;
	text(): Promise<string>;
};

/** Read a file field's host metadata, including from an optional field. */
export function fileFieldOf(
	schema: unknown,
): { accept?: string[]; maxBytes: number } | undefined {
	if (typeof schema !== 'object' || schema === null) return undefined;
	const metadata = (schema as Record<string, unknown>)['x-epicenter-file'];
	if (typeof metadata !== 'object' || metadata === null) return undefined;
	const { accept, maxBytes } = metadata as Record<string, unknown>;
	if (typeof maxBytes !== 'number') return undefined;
	if (
		accept !== undefined &&
		(!Array.isArray(accept) ||
			!accept.every((value) => typeof value === 'string'))
	)
		return undefined;
	return { ...(accept === undefined ? {} : { accept: [...accept] }), maxBytes };
}

type Options = {
	description?: string;
	/** JSON Schema's `readOnly`: in a collection, only the app's own actions write it. */
	readOnly?: boolean;
};

type MaybeOptional = Options & { optional?: boolean };

/** `T` marked as JSON Schema's `readOnly` when the options say so, so types can read the mark. */
type Marked<T extends TSchema, O> = O extends { readOnly: true }
	? T & { readOnly: true }
	: T;

type Optionally<T extends TSchema, O> = Marked<
	O extends { optional: true } ? TOptional<T> : T,
	O
>;

/** A switch: `false` unless its flag is given. */
export type TSwitch = TOptional<TBoolean> & { default: false };

/** A list of `T`: every time its flag is given, or every word left when it is the last positional; empty unless given. */
export type TList<T extends TSchema> = TOptional<TArray<T>> & {
	default: Static<T>[];
};

/** A list of text, as `field.tags()` makes it. */
export type TTags = TList<TString>;

/** The JSON Schema keyword a reference carries: `{ "x-epicenter-ref": { "path": "<the target's path>" } }`. */
const REF = 'x-epicenter-ref';

/** `collection`'s path, refusing a collection a key cannot name one record of. */
function refPath(collection: AnyCollection): string {
	const { path, holds } = (collection ?? {}) as Partial<AnyCollection>;
	if (typeof path !== 'string' || typeof holds !== 'function')
		throw new Error(
			'field.ref takes a collection made by defineCollection(...)',
		);
	if (isLocalPath(path))
		throw new Error(
			`field.ref cannot refer to ${path}: it never leaves this computer, so a key to one of its records would be read where the record is not`,
		);
	const { placeholders } = template(path);
	if (placeholders.length !== 1)
		throw new Error(
			`field.ref names a record by its key, the one placeholder in its collection's path, and ${path} has ${placeholders.length === 0 ? 'none' : placeholders.length}`,
		);
	return path;
}

/** The path of the collection a `field.ref` schema names, or `undefined` for any other schema. */
export function refPathOf(schema: unknown): string | undefined {
	if (typeof schema !== 'object' || schema === null) return undefined;
	const annotation = (schema as Record<string, unknown>)[REF];
	const path = (annotation as { path?: unknown } | undefined)?.path;
	return typeof path === 'string' ? path : undefined;
}

/** A list of `item`, optional and empty unless given. */
function list<const T extends TSchema, const O extends Options>(
	item: T,
	options?: O,
) {
	return Type.Optional(
		Type.Array(item, { ...schemaOptions(options), default: [] }),
	) as unknown as Marked<TList<T>, O>;
}

function maybeOptional<T extends TSchema, O extends MaybeOptional>(
	schema: T,
	options: O | undefined,
): Optionally<T, O> {
	return (options?.optional ? Type.Optional(schema) : schema) as Optionally<
		T,
		O
	>;
}

/** The schema options a field carries: its description, and whether it is read-only. */
function schemaOptions(options: Options | undefined) {
	return {
		...(options?.description === undefined
			? {}
			: { description: options.description }),
		...(options?.readOnly ? { readOnly: true } : {}),
	};
}

type Bounds = { min?: number; max?: number };

/** JSON Schema's `minimum` and `maximum` for the bounds given. */
function bounds(options: Bounds | undefined) {
	return {
		...(options?.min === undefined ? {} : { minimum: options.min }),
		...(options?.max === undefined ? {} : { maximum: options.max }),
	};
}

export const field = {
	/**
	 * A top-level action file input. The wire value is an opaque
	 * reference the host issued; `run` receives `UploadedFile`. A browser
	 * caller passes a Blob or File through the run controls. CLI, MCP, routines, direct
	 * POST calls, and collections refuse it.
	 * Persistent files in collections are a separate, undecided feature.
	 */
	file: <
		const O extends {
			description?: string;
			optional?: boolean;
			accept?: readonly string[];
			maxBytes?: number;
		},
	>(
		options?: O,
	) => {
		const maxBytes =
			options?.maxBytes === undefined ? MAX_FILE_BYTES : options.maxBytes;
		if (
			!Number.isInteger(maxBytes) ||
			maxBytes <= 0 ||
			maxBytes > MAX_FILE_BYTES
		)
			throw new Error(
				`A file's maxBytes must be a positive integer at most ${MAX_FILE_BYTES}`,
			);
		const accept = options?.accept;
		const mime = /^[a-z0-9!#$%&'+.^_`|~-]+\/(?:[a-z0-9!#$%&'+.^_`|~-]+|\*)$/i;
		if (accept?.some((entry) => !mime.test(entry)))
			throw new Error('A file accept entry must be a MIME type or type/*');
		return maybeOptional(
			Type.Unsafe<UploadedFile>({
				type: 'string',
				pattern: '^epicenter-file:',
				...(options?.description === undefined
					? {}
					: { description: options.description }),
				'x-epicenter-file': {
					...(accept ? { accept: [...accept] } : {}),
					maxBytes,
				},
			}),
			options,
		);
	},

	/**
	 * Text. `pattern` is a regular expression the whole value must match; give
	 * a `description` that reads after "must be", since that is how a refusal
	 * names it: `{ pattern: '^\\S.*$', description: 'one line, not blank' }`.
	 */
	text: <const O extends MaybeOptional & { pattern?: string }>(options?: O) =>
		maybeOptional(
			Type.String({
				...schemaOptions(options),
				...(options?.pattern === undefined ? {} : { pattern: options.pattern }),
			}),
			options,
		),

	/** A number, at least `min` and at most `max` when they are given. */
	number: <const O extends MaybeOptional & Bounds>(options?: O) =>
		maybeOptional(
			Type.Number({ ...schemaOptions(options), ...bounds(options) }),
			options,
		),

	/** A whole number, at least `min` and at most `max` when they are given. */
	integer: <const O extends MaybeOptional & Bounds>(options?: O) =>
		maybeOptional(
			Type.Integer({ ...schemaOptions(options), ...bounds(options) }),
			options,
		),

	/** A moment, written RFC 3339 with an offset (`2026-11-10T22:41:05+08:00`): JSON Schema's `format: 'date-time'`. */
	datetime: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date-time' }),
			options,
		),

	/** A day, written `2026-11-08`: JSON Schema's `format: 'date'`, which TypeBox checks, so `2026-13-45` is refused. */
	date: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(
			Type.String({ ...schemaOptions(options), format: 'date' }),
			options,
		),

	/** One of `values`, as `field.select(['archive', 'trash'])`. */
	select: <
		const V extends readonly [string, ...string[]],
		const O extends MaybeOptional,
	>(
		values: V,
		options?: O,
	) =>
		maybeOptional(
			Type.Union(
				values.map((value) => Type.Literal(value)),
				schemaOptions(options),
			) as unknown as TUnion<{ -readonly [K in keyof V]: TLiteral<V[K]> }>,
			options,
		),

	boolean: <const O extends Options>(options?: O) =>
		Type.Optional(
			Type.Boolean({ ...schemaOptions(options), default: false }),
		) as Marked<TSwitch, O>,

	/**
	 * A list of any field: `field.list(field.select(['x', 'threads']))`. It is
	 * never required, reads as `[]` when absent, and takes a repeated flag on
	 * the command line. A list of an item the command line cannot spell, such
	 * as a `Type.Object`, is given as JSON.
	 */
	list,

	/** A list of text: `field.list(field.text())`. */
	tags: <const O extends Options>(options?: O) => list(Type.String(), options),

	/**
	 * The key of a record in `collection`: the value of the one placeholder in
	 * its path, so `field.ref(essays)` for `data/essays/{slug}.md` holds a slug
	 * such as `"dune"`. `collection` is declared before the field that names
	 * it. A collection's `add` and `set` refuse a key with no record, or one
	 * that is not exactly the key its file would carry; a read returns the key
	 * and opens no other file.
	 */
	ref: <const O extends MaybeOptional>(
		collection: AnyCollection,
		options?: O,
	) =>
		maybeOptional(
			Type.String({
				...schemaOptions(options),
				[REF]: { path: refPath(collection) },
			}) as TString,
			options,
		),
};

type Described = {
	type?: string;
	format?: string;
	pattern?: string;
	description?: string;
	minimum?: number;
	maximum?: number;
	items?: Described;
	anyOf?: Described[];
	const?: unknown;
	enum?: unknown[];
};

const FORMATS: Record<string, string> = {
	date: 'a day like 2026-11-12',
	'date-time': 'a date and time like 2026-11-12T09:30:00Z',
	uri: 'a URL like https://example.com',
	email: 'an email address',
};

const TYPES: Record<string, string> = {
	string: 'text',
	number: 'a number',
	integer: 'a whole number',
	boolean: 'true or false',
	array: 'a list',
	object: 'an object',
};

/** The checks `whatFits` says in words; another, such as `maxLength`, keeps TypeBox's message. */
const SAID = new Set([
	'type',
	'format',
	'const',
	'anyOf',
	'enum',
	'pattern',
	'minimum',
	'maximum',
]);

/** The schema a field takes besides `null`: `X | null`, as `set` takes a field, is `X`. */
function withoutNull(field: TSchema): TSchema {
	const { anyOf } = field as Described;
	const nonNull = anyOf?.filter((choice) => choice.type !== 'null');
	return anyOf?.length === 2 && nonNull?.length === 1 && nonNull[0]
		? (nonNull[0] as TSchema)
		: field;
}

/** What `schema` takes, as the end of "<value> is not …". */
function wanted(schema: Described): string | undefined {
	const choices =
		schema.enum ??
		(schema.anyOf?.every((choice) => 'const' in choice)
			? schema.anyOf.map((choice) => choice.const)
			: undefined);
	if (choices) return `one of ${choices.map(String).join(', ')}`;
	// A pattern is a regular expression; the field's description says it in words.
	if (schema.pattern !== undefined) return schema.description;
	if (schema.format !== undefined) return FORMATS[schema.format];
	if (schema.type === 'array' && schema.items) {
		const each = wanted(schema.items);
		if (each === 'text') return 'a list of text';
		if (each) return `a list, each ${each}`;
	}
	const kind = schema.type === undefined ? undefined : TYPES[schema.type];
	if (!kind) return kind;
	const { minimum: min, maximum: max } = schema;
	if (min !== undefined && max !== undefined)
		return `${kind} from ${min} to ${max}`;
	if (min !== undefined) return `${kind} of at least ${min}`;
	if (max !== undefined) return `${kind} of at most ${max}`;
	return kind;
}

/**
 * What a field takes, in words such as `a day like 2026-11-12` or `a whole
 * number from 1 to 5`, when `value` does not fit it for a reason those words
 * say; `undefined` when it fits, or when they would not say why (a text too
 * long). The CLI says it of a flag and a collection of a file's front matter,
 * so both say it alike.
 */
export function whatFits(field: TSchema, value: unknown): string | undefined {
	if (Value.Check(field, value)) return undefined;
	const schema = withoutNull(field);
	const [error] = Value.Errors(schema, value);
	if (!error || !SAID.has(error.keyword)) return undefined;
	return wanted(schema as Described);
}
