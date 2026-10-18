/**
 * Whether one definition contains another (ADR-0538).
 *
 * An app opens a folder with its definition: the tables and fields it reads.
 * A folder has its own definition. The app can open the folder when every
 * value the folder's definition admits for a field the app reads is one the
 * app's field accepts, so the app never reads a value its types do not
 * describe. The folder may define more tables and fields than the app reads.
 *
 * Below, and in the reasons this gives, `shape` is the reader's definition
 * and `declared` is the folder's.
 *
 * Containment of two JSON Schemas is not decidable in general, so this asks
 * a fixed, conservative set of questions. A pair it cannot decide is refused
 * with the reason, never accepted: an app that meets one widens its field.
 * Two schemas that are the same apart from annotations always match.
 *
 * Like `fieldEditorOf`, this reads keywords. The one validator it runs is the
 * shape's own, over the finite list of values a folder's `enum` or `const`
 * admits.
 */

import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { Definition, FieldMap, TableDeclaration } from './declaration.js';
import { FIELD_KEYWORD } from './field/editor.js';
import { isOptional } from './prepare.js';

/** One way a folder's definition does not contain a reader's, in the table named `table`. */
export type Mismatch =
	| {
			readonly kind: 'missingTable';
			readonly table: string;
			readonly message: string;
	  }
	| {
			readonly kind: 'incompatibleTable';
			readonly table: string;
			readonly reason: string;
			readonly message: string;
	  }
	| {
			readonly kind: 'missingField';
			readonly table: string;
			readonly field: string;
			readonly message: string;
	  }
	| {
			readonly kind: 'incompatibleField';
			readonly table: string;
			readonly field: string;
			readonly reason: string;
			readonly message: string;
	  };

/**
 * Every way the folder's definition `declared` does not contain the reader's
 * definition `shape`; empty when it does.
 *
 * - Every table of the shape is a table of the declaration.
 * - Every field the shape reads is declared in that table with a schema the
 *   shape's field accepts (see {@link containment}).
 * - A field the shape requires is required by the declaration too; a field
 *   the shape leaves optional may be either.
 * - A shape table that is closed (`additionalProperties: false`) reads only
 *   from a closed table that declares no field the shape does not. A closed
 *   declared table holds no keys beyond its fields, so it contains any shape
 *   that reads a subset of them.
 *
 * Both are prepared schemas, or native ones: only keywords and TypeBox's
 * optional marker are read.
 */
export function mismatches(
	declared: Definition,
	shape: Definition,
): Mismatch[] {
	const problems: Mismatch[] = [];
	for (const [table, wanted] of Object.entries(shape.tables)) {
		const found = Object.hasOwn(declared.tables, table)
			? declared.tables[table]
			: undefined;
		if (found === undefined) {
			problems.push({
				kind: 'missingTable',
				table,
				message: `The folder declares no '${table}' table`,
			});
			continue;
		}
		const closure = closureProblem(found, wanted);
		if (closure !== undefined)
			problems.push({
				kind: 'incompatibleTable',
				table,
				reason: closure,
				message: `The '${table}' table does not fit: ${closure}`,
			});
		fieldProblems(table, found.fields, wanted.fields, problems);
	}
	return problems;
}

/**
 * The fields the folder's table `declared` requires that the reader's table
 * `shape` does not define. A row cannot be added through the reader's table
 * unless this is empty: it could not supply them.
 */
export function requiredOutside(
	declared: TableDeclaration,
	shape: TableDeclaration,
): string[] {
	return Object.entries(declared.fields)
		.filter(
			([name, schema]) =>
				!isOptional(schema) && !Object.hasOwn(shape.fields, name),
		)
		.map(([name]) => name);
}

function closureProblem(
	declared: TableDeclaration,
	shape: TableDeclaration,
): string | undefined {
	if (shape.additionalProperties !== false) return undefined;
	if (declared.additionalProperties !== false)
		return 'the shape closes it, and the folder lets its rows hold other keys';
	const extra = Object.keys(declared.fields).filter(
		(name) => !Object.hasOwn(shape.fields, name),
	);
	return extra.length === 0
		? undefined
		: `the shape closes it, and the folder declares ${extra.map((name) => `'${name}'`).join(', ')} beside the shape's fields`;
}

function fieldProblems(
	table: string,
	declared: FieldMap,
	shape: FieldMap,
	problems: Mismatch[],
): void {
	for (const [field, wanted] of Object.entries(shape)) {
		const name = `field '${table}.${field}'`;
		const found = Object.hasOwn(declared, field) ? declared[field] : undefined;
		if (found === undefined) {
			problems.push({
				kind: 'missingField',
				table,
				field,
				message: `The folder declares no ${name}`,
			});
			continue;
		}
		const reason =
			!isOptional(wanted) && isOptional(found)
				? 'the shape requires it, and the folder lets a row leave it out'
				: containment(wanted, found);
		if (reason !== undefined)
			problems.push({
				kind: 'incompatibleField',
				table,
				field,
				reason,
				message: `The folder's ${name} does not fit: ${reason}`,
			});
	}
}

/** A JSON Schema node: an object of keywords, or `true` or `false`. */
type Node = Readonly<Record<string, unknown>> | boolean;

/** Keywords that say nothing about which values a schema admits. */
const ANNOTATIONS = new Set([
	'title',
	'description',
	'default',
	'examples',
	'$comment',
	'deprecated',
	'readOnly',
	'writeOnly',
	FIELD_KEYWORD,
]);

/**
 * Why `shape` may refuse a value `declared` admits, or `undefined` when every
 * value `declared` admits is one `shape` accepts.
 *
 * The questions, in order:
 *
 * 1. A shape that constrains nothing accepts everything; a declaration that
 *    admits nothing is contained by anything.
 * 2. Two schemas whose keywords match, annotations aside, contain each other;
 *    inside a field, only when neither holds a `$ref`.
 * 3. A declaration with `enum` or `const` admits at most those values, so it
 *    is contained when the shape's validator accepts each one.
 * 4. A declared `anyOf` or `oneOf` is contained when each member is, and a
 *    declared `allOf` when one member is. `field.nullable` is such a union.
 * 5. A shape that is only an `anyOf` contains a declaration one of its members
 *    contains; one that is only an `allOf`, a declaration all of them do.
 * 6. Otherwise both say one `type`, the declared one the shape's or, for a
 *    shape `number`, `integer`; and each other keyword of the shape is one
 *    this knows, implied by the declaration's own: string length, pattern,
 *    and format; numeric bounds and `multipleOf`; array items, bounds, and
 *    uniqueness; object properties, `required`, and `additionalProperties`.
 *
 * A keyword of the declaration this does not compare only narrows what it
 * admits, so it is ignored. A keyword of the shape this does not know is a
 * refusal, as are a shape `oneOf`, `not`, conditional, or `$ref`.
 */
export function containment(
	shape: TSchema & object,
	declared: TSchema & object,
): string | undefined {
	// Whole fields that match mean the same, `$ref`s and all: a reference
	// resolves inside its own field.
	const [wanted, found] = [shape as Node, declared as Node];
	if (
		typeof wanted === 'object' &&
		typeof found === 'object' &&
		sameConstraints(wanted, found)
	)
		return undefined;
	return contained(wanted, found);
}

function contained(shape: Node, declared: Node): string | undefined {
	if (shape === true || (shape !== false && constraints(shape).length === 0))
		return undefined;
	if (declared === false) return undefined;
	if (shape === false) return 'the shape admits no value';
	if (declared === true || constraints(declared).length === 0)
		return 'the folder admits any value';
	// Inside a field, a `$ref` resolves against the field around it, which
	// can differ between two otherwise equal nodes.
	if (!canonical(shape).includes('"$ref"') && sameConstraints(shape, declared))
		return undefined;

	const listed = Object.hasOwn(declared, 'const')
		? [declared.const]
		: Array.isArray(declared.enum)
			? declared.enum
			: undefined;
	if (listed !== undefined) return listedProblem(shape, listed);

	for (const keyword of ['anyOf', 'oneOf'] as const) {
		const members = declared[keyword];
		if (!Array.isArray(members)) continue;
		const problem = members
			.map((member) => contained(shape, member as Node))
			.find((found) => found !== undefined);
		if (problem === undefined) return undefined;
		// A keyword beside the union may still decide it below.
		if (constraints(declared).length === 1) return problem;
	}
	if (
		Array.isArray(declared.allOf) &&
		declared.allOf.some(
			(member) => contained(shape, member as Node) === undefined,
		)
	)
		return undefined;

	const composed = constraints(shape).filter((keyword) =>
		COMPOSITION.has(keyword),
	);
	if (composed.length > 0) {
		if (composed.length !== 1 || constraints(shape).length !== 1)
			return `cannot decide a shape that combines '${composed[0]}' with other keywords`;
		const [keyword] = composed as [string];
		const members = shape[keyword];
		if (keyword === 'anyOf' && Array.isArray(members)) {
			const reasons = members.map((member) =>
				contained(member as Node, declared),
			);
			return reasons.includes(undefined)
				? undefined
				: (reasons.find((reason) => reason !== undefined) ??
						'the shape admits no value');
		}
		if (keyword === 'allOf' && Array.isArray(members))
			return members
				.map((member) => contained(member as Node, declared))
				.find((reason) => reason !== undefined);
		return `cannot decide whether the folder's schema satisfies the shape's '${keyword}'`;
	}
	if (Object.hasOwn(shape, 'enum') || Object.hasOwn(shape, 'const'))
		return "the folder's values are not limited to the shape's options";
	return typedProblem(shape, declared);
}

const COMPOSITION = new Set([
	'anyOf',
	'allOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
	'$ref',
	'$dynamicRef',
]);

/** Why the shape refuses one of the values a declaration lists, if it does. */
function listedProblem(
	shape: Readonly<Record<string, unknown>>,
	values: readonly unknown[],
): string | undefined {
	let accepts: (value: unknown) => boolean;
	try {
		const validator = Compile(shape as TSchema);
		accepts = (value) => validator.Check(value);
	} catch {
		return "cannot decide: the shape's schema does not compile by itself";
	}
	for (const value of values)
		if (!accepts(value))
			return `the folder admits ${JSON.stringify(value)}, which the shape refuses`;
	return undefined;
}

/** Both say one `type`; compare the shape's keywords for that type. */
function typedProblem(
	shape: Readonly<Record<string, unknown>>,
	declared: Readonly<Record<string, unknown>>,
): string | undefined {
	const wanted = shape.type;
	if (typeof wanted !== 'string')
		return 'cannot decide a shape that does not name one type';
	const found = declared.type;
	if (typeof found !== 'string')
		return `the folder does not limit the value to ${article(wanted)}`;
	if (found !== wanted && !(wanted === 'number' && found === 'integer'))
		return `the folder's value is ${article(found)}, not ${article(wanted)}`;
	for (const keyword of constraints(shape)) {
		if (keyword === 'type') continue;
		const problem = keywordProblem(keyword, shape, declared);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

function article(type: string): string {
	return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/** Whether the declaration implies one keyword of the shape, for the shape's type. */
function keywordProblem(
	keyword: string,
	shape: Readonly<Record<string, unknown>>,
	declared: Readonly<Record<string, unknown>>,
): string | undefined {
	const want = shape[keyword];
	const have = declared[keyword];
	const type = shape.type as string;
	const lower = (floor: string) =>
		typeof want === 'number' && typeof have === 'number' && have >= want
			? undefined
			: `the shape requires ${keyword} ${String(want)}, and the folder's ${floor}`;
	const upper = (ceiling: string) =>
		typeof want === 'number' && typeof have === 'number' && have <= want
			? undefined
			: `the shape requires ${keyword} ${String(want)}, and the folder's ${ceiling}`;
	switch (`${type}.${keyword}`) {
		case 'string.minLength':
			return typeof want === 'number' && want <= 0
				? undefined
				: lower(
						have === undefined
							? 'strings may be shorter'
							: `minLength is ${String(have)}`,
					);
		case 'string.maxLength':
			return upper(
				have === undefined
					? 'strings may be longer'
					: `maxLength is ${String(have)}`,
			);
		case 'string.pattern':
		case 'string.format':
			return have === want
				? undefined
				: `the shape requires ${keyword} '${String(want)}', and the folder's ${keyword} is ${have === undefined ? 'absent' : `'${String(have)}'`}`;
		case 'array.minItems':
			return typeof want === 'number' && want <= 0
				? undefined
				: lower(
						have === undefined
							? 'lists may be shorter'
							: `minItems is ${String(have)}`,
					);
		case 'array.maxItems':
			return upper(
				have === undefined
					? 'lists may be longer'
					: `maxItems is ${String(have)}`,
			);
		case 'array.uniqueItems':
			return want !== true || have === true
				? undefined
				: "the shape requires unique items, and the folder's list may repeat one";
		case 'array.items': {
			const problem = contained(want as Node, (have ?? true) as Node);
			return problem === undefined
				? undefined
				: `an item does not fit: ${problem}`;
		}
		case 'number.minimum':
		case 'integer.minimum':
			return boundProblem(want, declared, 'lower', false);
		case 'number.exclusiveMinimum':
		case 'integer.exclusiveMinimum':
			return boundProblem(want, declared, 'lower', true);
		case 'number.maximum':
		case 'integer.maximum':
			return boundProblem(want, declared, 'upper', false);
		case 'number.exclusiveMaximum':
		case 'integer.exclusiveMaximum':
			return boundProblem(want, declared, 'upper', true);
		case 'number.multipleOf':
		case 'integer.multipleOf': {
			const step =
				typeof have === 'number'
					? have
					: declared.type === 'integer'
						? 1
						: undefined;
			return typeof want === 'number' &&
				step !== undefined &&
				Number.isInteger(step / want)
				? undefined
				: `the shape requires multiples of ${String(want)}, and the folder's values are not limited to them`;
		}
		case 'object.required': {
			const required = Array.isArray(have) ? have : [];
			const missing = (Array.isArray(want) ? want : []).filter(
				(name) => !required.includes(name),
			);
			return missing.length === 0
				? undefined
				: `the shape requires ${missing.map((name) => `'${String(name)}'`).join(', ')}, which the folder's objects may leave out`;
		}
		case 'object.properties':
			return propertiesProblem(want, declared);
		case 'object.additionalProperties':
			return additionalProblem(shape, declared);
		default:
			return `cannot decide whether the folder's schema satisfies the shape's '${keyword}'`;
	}
}

/**
 * Whether the declaration's numeric bound is at least as tight as the
 * shape's: a declared `minimum` of 3 implies a shape `minimum` of 2, and a
 * declared `exclusiveMinimum` of 2 implies a shape `minimum` of 2.
 */
function boundProblem(
	want: unknown,
	declared: Readonly<Record<string, unknown>>,
	side: 'lower' | 'upper',
	exclusive: boolean,
): string | undefined {
	const [inclusiveKey, exclusiveKey] =
		side === 'lower'
			? ['minimum', 'exclusiveMinimum']
			: ['maximum', 'exclusiveMaximum'];
	const inclusive = declared[inclusiveKey];
	const strict = declared[exclusiveKey];
	const tighter = (bound: unknown, boundExclusive: boolean) => {
		if (typeof want !== 'number' || typeof bound !== 'number') return false;
		const ahead = side === 'lower' ? bound - want : want - bound;
		return ahead > 0 || (ahead === 0 && (boundExclusive || !exclusive));
	};
	if (tighter(inclusive, false) || tighter(strict, true)) return undefined;
	const keyword = exclusive ? exclusiveKey : inclusiveKey;
	return `the shape requires ${keyword} ${String(want)}, and the folder's values are not bounded by it`;
}

/** Each property the shape names, against what the declaration admits there. */
function propertiesProblem(
	want: unknown,
	declared: Readonly<Record<string, unknown>>,
): string | undefined {
	if (typeof want !== 'object' || want === null)
		return "cannot decide the shape's properties";
	const have = isRecord(declared.properties) ? declared.properties : {};
	for (const [name, schema] of Object.entries(want)) {
		let problem: string | undefined;
		if (Object.hasOwn(have, name))
			problem = contained(schema as Node, have[name] as Node);
		else if (declared.additionalProperties === false) continue;
		else if (Object.hasOwn(declared, 'patternProperties'))
			problem = `cannot decide what the folder's patternProperties admit at '${name}'`;
		else
			problem = contained(
				schema as Node,
				(declared.additionalProperties ?? true) as Node,
			);
		if (problem !== undefined)
			return `property '${name}' does not fit: ${problem}`;
	}
	return undefined;
}

/** The shape's `additionalProperties`, against the keys the declaration admits. */
function additionalProblem(
	shape: Readonly<Record<string, unknown>>,
	declared: Readonly<Record<string, unknown>>,
): string | undefined {
	const want = shape.additionalProperties;
	if (want === true) return undefined;
	if (
		declared.additionalProperties !== false ||
		Object.hasOwn(declared, 'patternProperties')
	)
		return "the shape limits other keys, and the folder's objects may hold any";
	const named = isRecord(shape.properties) ? shape.properties : {};
	const have = isRecord(declared.properties) ? declared.properties : {};
	for (const [name, schema] of Object.entries(have)) {
		if (Object.hasOwn(named, name)) continue;
		const problem = contained(want as Node, schema as Node);
		if (problem !== undefined)
			return `the folder's property '${name}' is not one the shape admits: ${problem}`;
	}
	return undefined;
}

/** The keywords of a node that could constrain a value, TypeBox's `~` ones aside. */
function constraints(node: Readonly<Record<string, unknown>>): string[] {
	return Object.keys(node).filter(
		(keyword) => !keyword.startsWith('~') && !ANNOTATIONS.has(keyword),
	);
}

/** Whether two nodes have the same constraining keywords with equal values. */
function sameConstraints(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): boolean {
	const keys = constraints(a);
	const others = constraints(b);
	return (
		keys.length === others.length &&
		keys.every(
			(key) => Object.hasOwn(b, key) && canonical(a[key]) === canonical(b[key]),
		)
	);
}

/** JSON with object keys sorted, so key order does not decide equality. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		isRecord(inner)
			? Object.fromEntries(
					Object.keys(inner)
						.sort()
						.map((key) => [key, inner[key]]),
				)
			: inner,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
