/**
 * The editor hint a schema may carry, and the editor a field resolves to.
 *
 * A field is one native TypeBox schema, and the schema alone decides whether a
 * value conforms. {@link FIELD_KEYWORD} is an optional annotation beside it
 * that says which editor the author meant. It is plain JSON, so it survives
 * `JSON.stringify`, and it holds intent only: a kind, and for a reference the
 * table it names.
 *
 * Everything else an editor needs is read off the schema. Select options are
 * the schema's declared `enum`. A hint that is absent, unknown, malformed, or
 * that names a widget the schema's shape or `format` does not fit resolves to
 * the JSON editor. It never changes validation.
 *
 * Whether a field admits `null` is not here. Only a validator can say, so a
 * reader checks `null` against the prepared field where it needs to know.
 */

import type { TSchema } from 'typebox';
import { Memory } from 'typebox/system';
import { isTableName } from '../table-name.js';

/** The annotation keyword. TypeBox ignores it; editors read it. */
export const FIELD_KEYWORD = 'x-field';

/**
 * The editor kinds. `number` and `integer` stay distinct even where one widget
 * serves both.
 */
export type Kind =
	| 'string'
	| 'reference'
	| 'url'
	| 'number'
	| 'integer'
	| 'boolean'
	| 'date'
	| 'instant'
	| 'datetime'
	| 'select'
	| 'multiSelect'
	| 'tags'
	| 'json';

/** What `x-field` holds: the intended editor, and a reference's target table. */
export type FieldHint =
	| { readonly kind: Exclude<Kind, 'reference'> }
	| { readonly kind: 'reference'; readonly target: string };

/**
 * The editor one field gets, resolved from its schema and hint.
 *
 * Null is not a kind: a nullable select is still a select, and whether the
 * field admits `null` is asked of its validator, not recorded here.
 *
 * `options` is the schema's declared `enum`. The check never admits a value
 * outside it, but it may admit fewer: another keyword on the same schema can
 * refuse an option, and nothing filters the list by running the check.
 */
export type FieldEditor =
	| { readonly kind: Exclude<Kind, 'select' | 'multiSelect' | 'reference'> }
	| {
			readonly kind: 'select' | 'multiSelect';
			readonly options: readonly string[];
	  }
	| { readonly kind: 'reference'; readonly target: string };

/**
 * A native schema `S` whose `x-field` is typed as the hint `H`.
 *
 * This is what a `field.*` helper returns, so a caller reads the literal kind
 * and reference target without narrowing. It grants nothing: a declaration
 * takes any `TSchema`, annotated or not.
 */
export type Annotated<
	S extends TSchema = TSchema,
	H extends FieldHint = FieldHint,
> = S & { readonly [FIELD_KEYWORD]: H };

/**
 * A native copy of `schema` carrying `hint`.
 *
 * `Memory.Update` is how TypeBox itself adds a keyword (`Type.Refine` is one
 * call to it). It clones `schema` with its hidden keywords, so whatever the
 * helper was given is left as it was.
 *
 * A hint already there is dropped from the copy first, with `Memory.Discard`,
 * rather than overwritten. A clone keeps each property's descriptor, so the
 * clone of a frozen schema holds a hint that cannot be redefined.
 *
 * `S` differs from what `schema` is only where no native constructor can say
 * it: a branded `Static` over a plain string.
 */
export function annotate<S extends TSchema, const H extends FieldHint>(
	schema: TSchema & object,
	hint: H,
): Annotated<S, H> {
	return Memory.Update(
		Memory.Discard(schema, [FIELD_KEYWORD]),
		{},
		{ [FIELD_KEYWORD]: { ...hint } },
	) as Annotated<S, H>;
}

/** A schema node, read one own keyword at a time. */
type Keywords = object;

function isKeywords(value: unknown): value is Keywords {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own data property, so an accessor or an inherited keyword has no value. */
function own(schema: Keywords, keyword: string): unknown {
	return Object.getOwnPropertyDescriptor(schema, keyword)?.value;
}

/**
 * Keywords that compose a schema from other schemas. A node with one of these
 * is not a single widget's shape, whatever else it says.
 */
const COMPOSITION: readonly string[] = [
	'anyOf',
	'allOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
	'$ref',
];

function isComposed(schema: Keywords): boolean {
	return COMPOSITION.some((keyword) => Object.hasOwn(schema, keyword));
}

/** Keywords that say nothing about which values a schema admits. */
const ANNOTATIONS: readonly string[] = [
	'title',
	'description',
	'default',
	'examples',
	FIELD_KEYWORD,
];

/** The keywords of a node that could constrain a value, TypeBox's `~` ones aside. */
function constraints(schema: Keywords): string[] {
	return Object.getOwnPropertyNames(schema).filter(
		(keyword) => !keyword.startsWith('~') && !ANNOTATIONS.includes(keyword),
	);
}

/** Whether a `type` keyword is absent or says `expected`. */
function typeAllows(schema: Keywords, expected: string): boolean {
	return !Object.hasOwn(schema, 'type') || own(schema, 'type') === expected;
}

/**
 * The `enum` of an uncomposed schema when it is a nonempty list of strings and
 * no `type` beside it says the values are something else.
 */
function stringOptions(schema: unknown): readonly string[] | undefined {
	if (!isKeywords(schema) || isComposed(schema)) return undefined;
	const options = own(schema, 'enum');
	return Array.isArray(options) &&
		options.length > 0 &&
		options.every((option) => typeof option === 'string') &&
		typeAllows(schema, 'string')
		? options
		: undefined;
}

/**
 * The other member of a union with `null` that says nothing else: `anyOf` of
 * exactly `{ type: 'null' }` and one more schema, with only annotations beside
 * it. This is what `field.nullable` and `Type.Union([inner, Type.Null()])`
 * build.
 *
 * A validation keyword beside the `anyOf` (`type`, `enum`, `allOf`, ...) also
 * decides what the field admits, so such a union is not read through.
 */
function nullableMember(schema: Keywords): Keywords | undefined {
	const members = own(schema, 'anyOf');
	if (!Array.isArray(members) || members.length !== 2) return undefined;
	if (constraints(schema).some((keyword) => keyword !== 'anyOf'))
		return undefined;
	const rest = members.filter(
		(member) =>
			!(
				isKeywords(member) &&
				own(member, 'type') === 'null' &&
				constraints(member).length === 1
			),
	);
	return rest.length === 1 && isKeywords(rest[0]) ? rest[0] : undefined;
}

/**
 * The `format` each formatted string helper sets, by kind: the text its widget
 * reads and writes.
 */
const FORMATS = {
	url: 'uri',
	date: 'date',
	instant: 'date-time',
	datetime: 'date-time',
} as const;

/**
 * Whether a string schema's `format` leaves room for `expected`: it declares
 * that format or none. A schema that declares another one refuses what the
 * widget writes, so `{ format: 'email' }` under a `date` hint is not a date.
 * This compares one keyword. It does not ask what the rest of the schema admits.
 */
function formatAllows(schema: Keywords, expected: string): boolean {
	return !Object.hasOwn(schema, 'format') || own(schema, 'format') === expected;
}

/**
 * The editor a hint asks for, when `subject` has the shape that widget edits.
 *
 * These are conservative shape checks for the widgets that exist, not a schema
 * recognizer. Each asks a keyword or two of one uncomposed schema node, and
 * anything composed or exotic fails them and gets the JSON editor. They do not
 * decide what the schema admits: other keywords on the same node can narrow
 * it further.
 */
function hinted(hint: unknown, subject: Keywords): FieldEditor | undefined {
	if (!isKeywords(hint)) return undefined;
	const kind = own(hint, 'kind');
	if (kind === 'json') return { kind };
	if (isComposed(subject)) return undefined;
	const type = own(subject, 'type');
	switch (kind) {
		case 'string':
			return type === 'string' ? { kind } : undefined;
		case 'url':
		case 'date':
		case 'instant':
		case 'datetime':
			return type === 'string' && formatAllows(subject, FORMATS[kind])
				? { kind }
				: undefined;
		case 'reference': {
			const target = own(hint, 'target');
			return type === 'string' &&
				typeof target === 'string' &&
				isTableName(target)
				? { kind, target }
				: undefined;
		}
		case 'number':
		case 'integer':
		case 'boolean':
			return type === kind ? { kind } : undefined;
		case 'select': {
			const options = stringOptions(subject);
			return options === undefined ? undefined : { kind, options };
		}
		case 'multiSelect': {
			const options = stringOptions(own(subject, 'items'));
			return type === 'array' && options !== undefined
				? { kind, options }
				: undefined;
		}
		case 'tags': {
			const items = own(subject, 'items');
			return type === 'array' &&
				isKeywords(items) &&
				!isComposed(items) &&
				own(items, 'type') === 'string'
				? { kind }
				: undefined;
		}
		default:
			return undefined;
	}
}

/**
 * The editor for a schema: the one its hint names when the schema has that
 * widget's shape, and the JSON editor otherwise.
 *
 * `field.nullable(inner)` is the native union with `null`, which leaves the
 * hint on `inner`. So a plain union with `null` (see {@link nullableMember})
 * that has no `x-field` of its own takes its other member's hint. A union that
 * has one uses it, and a malformed one is not replaced by the member's. No
 * other composition is looked into, and a schema without a hint is never
 * guessed at.
 *
 * This reads keywords and nothing else: it keeps no state and runs no
 * validator. So it does not say whether the field admits `null`. Reading
 * through the union finds the hint; it is not evidence about `null`, which a
 * keyword beside the union may still refuse. A reader that needs to know
 * checks `null` against the prepared field.
 *
 * Any schema can be read, prepared or not. A prepared field is frozen JSON,
 * so the editor read from one agrees with what its validator checks.
 */
export function fieldEditorOf(schema: TSchema & object): FieldEditor {
	const member = nullableMember(schema);
	const hintOwner =
		member === undefined || Object.hasOwn(schema, FIELD_KEYWORD)
			? schema
			: member;
	return Object.freeze(
		hinted(own(hintOwner, FIELD_KEYWORD), member ?? schema) ?? {
			kind: 'json',
		},
	);
}
